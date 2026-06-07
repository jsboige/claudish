/**
 * Anthropic SSE passthrough stream parser.
 *
 * For providers that speak native Anthropic format (MiniMax, Kimi, Z.AI),
 * this is a near-identity transform — the response is already in Claude SSE format.
 * Only light fixups are needed (e.g., ensuring message IDs, merging usage data).
 *
 * When `filterThinking` is enabled (via adapter.shouldFilterThinking()), thinking
 * blocks are stripped from the stream and content block indices are re-numbered.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import { createResponseCapture } from "../response-capture.js";
import { executeWebFetch } from "../web-search-executor.js";

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
}

/**
 * Pass through an Anthropic-format SSE stream with minimal fixups.
 * The response body is already Claude-compatible SSE events.
 *
 * When adapter.shouldFilterThinking() returns true, thinking blocks are
 * stripped and content block indices are re-numbered so downstream consumers
 * see a contiguous sequence (0, 1, 2, ...).
 */
export function createAnthropicPassthroughStream(
  c: Context,
  response: Response,
  opts: AnthropicPassthroughOpts
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const filterThinking = opts.adapter?.shouldFilterThinking() ?? false;

  const cap = createResponseCapture("anthropic", opts.modelName);

  return c.body(
    new ReadableStream({
      async start(controller) {
        // Diagnostic tap: mirror every outgoing byte into the response capture.
        const _origEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = ((chunk: any) => {
          cap.tap(chunk);
          return _origEnqueue(chunk);
        }) as typeof controller.enqueue;
        const sendPing = () => {
          if (!isClosed) {
            controller.enqueue(encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"));
          }
        };

        sendPing();

        pingInterval = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) {
            sendPing();
          }
        }, 1000);

        try {
          const reader = response.body!.getReader();
          let buffer = "";
          let inputTokens = 0;
          let outputTokens = 0;

          let totalLines = 0;
          let textChunks = 0;
          let toolUseBlocks = 0;
          let stopReason: string | null = null;
          let sawMessageStop = false;
          let sawMessageStart = false;
          let suppressedServerTools = 0;
          /** Total server_tool blocks fully suppressed — used for index remapping. */
          let serverToolBlocksSuppressed = 0;

          // webReader interception state
          // Z.AI emits webReader as a text block containing "🌐 Z.ai Built-in Tool: webReader"
          // followed by a URL in JSON. We detect it during streaming, suppress the block,
          // and at finalize time, fetch the URL ourselves and inject the result.
          let webReaderUrl: string | null = null;
          let webReaderBlockIndex: number = -1;  // upstream index of the webReader text block
          let insideWebReaderBlock = false;       // currently inside the webReader text block
          let webReaderTextChunks: string[] = []; // accumulate text to extract URL
          let webReaderSuppressMessageStop = false; // suppress message_stop until we inject results

          // Thinking-block filtering state
          let insideThinkingBlock = false;
          /** How many thinking blocks have been suppressed so far. */
          let thinkingBlocksSuppressed = 0;

          // Content block index tracking — detect out-of-range indices
          // that would cause "Content block not found" on the client side.
          let highestSeenIndex = -1;
          const clampIndex = (idx: number, context: string): number => {
            if (idx > highestSeenIndex + 1) {
              log(
                `[AnthropicSSE] Index jump detected: ${idx} but expected <=${highestSeenIndex + 1} (${context}) — clamping to ${highestSeenIndex + 1}`
              );
              return highestSeenIndex + 1;
            }
            return idx;
          };
          const trackIndex = (idx: number) => {
            if (idx > highestSeenIndex) highestSeenIndex = idx;
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            lastActivity = Date.now();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              totalLines++;

              // ── Thinking-block filtering ──────────────────────────────
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));

                  // ── Non-Anthropic event suppression ──
                  // Z.AI sometimes injects proprietary SSE events that aren't valid
                  // Anthropic wire format. Suppress unknown event types.
                  const VALID_SSE_TYPES_FT = new Set([
                    "message_start", "content_block_start", "content_block_delta",
                    "content_block_stop", "message_delta", "message_stop", "ping",
                    "error",
                  ]);
                  if (data.type && !VALID_SSE_TYPES_FT.has(data.type)) {
                    log("[AnthropicSSE] Suppressing non-Anthropic SSE event type " + JSON.stringify(data.type) + " (filtered path, index=" + data.index + ")");
                    continue;
                  }

                  // ── In-stream error detection (GitHub #106) ──
                  // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return
                  // HTTP 200 with {"error":{...}} embedded in the SSE payload.
                  // Detect and surface as a proper error event.
                  if (data.error) {
                    const errMsg = data.error.message || JSON.stringify(data.error);
                    log(`[AnthropicSSE] In-stream error detected (filterThinking path): ${errMsg}`);
                    if (!isClosed) {
                      isClosed = true;
                      if (pingInterval) {
                        clearInterval(pingInterval);
                        pingInterval = null;
                      }
                      // Emit synthetic finalization so the client gets a properly
                      // terminated stream instead of "empty or malformed response".
                      try {
                        const synthId = `msg_${Date.now()}`;
                        controller.enqueue(encoder.encode(
                          "event: message_start\n" +
                          `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}\n\n`
                        ));
                        controller.enqueue(encoder.encode(
                          "event: content_block_start\n" +
                          `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
                        ));
                        controller.enqueue(encoder.encode(
                          "event: content_block_delta\n" +
                          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Error: ${errMsg}]"}}\n\n`
                        ));
                        controller.enqueue(encoder.encode(
                          "event: content_block_stop\n" +
                          `data: {"type":"content_block_stop","index":0}\n\n`
                        ));
                        controller.enqueue(encoder.encode(
                          "event: message_delta\n" +
                          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`
                        ));
                        controller.enqueue(encoder.encode(
                          "event: message_stop\n" +
                          `data: {"type":"message_stop"}\n\n`
                        ));
                      } catch (enqueueErr) {
                        log(`[AnthropicSSE] Failed to emit synthetic finalization (in-stream-error filtered): ${enqueueErr}`);
                      }
                      cap.note("in-stream-error(filtered)");
                      cap.done({ closed: true, stop_reason: "error", path: "in-stream-error-filtered" });
                      controller.close();
                    }
                    return; // stop processing further lines
                  }

                  // Track: entering a thinking block
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "thinking"
                  ) {
                    insideThinkingBlock = true;
                    thinkingBlocksSuppressed++;
                    log(`[AnthropicSSE] Filtering thinking block at index ${data.index}`);
                    continue; // suppress this line
                  }

                  // Track: exiting a thinking block
                  if (insideThinkingBlock && data.type === "content_block_stop") {
                    insideThinkingBlock = false;
                    continue; // suppress this line
                  }

                  // Suppress all deltas while inside a thinking block
                  // (thinking_delta, signature_delta)
                  if (insideThinkingBlock) {
                    continue;
                  }

                  // ── Suppress server_tool_use / server_tool_result blocks ──
                  // Z.AI built-in tools (analyze_image, webReader) emit these blocks.
                  // When they fail (local paths, unreachable URLs), Z.AI returns
                  // "Content block not found". Suppress + remap indices.
                  if (
                    data.type === "content_block_start" &&
                    (data.content_block?.type === "server_tool_use" || data.content_block?.type === "server_tool_result")
                  ) {
                    suppressedServerTools++;
                    serverToolBlocksSuppressed++;
                    log(`[AnthropicSSE] Suppressing ${data.content_block.type} block at index ${data.index} (total suppressed: ${serverToolBlocksSuppressed})`);
                    continue;
                  }
                  if (suppressedServerTools > 0 && data.type === "content_block_delta") {
                    continue;
                  }
                  if (data.type === "content_block_stop" && suppressedServerTools > 0) {
                    suppressedServerTools--;
                    continue;
                  }

                  // ── webReader text block detection (filtered path) ──
                  // Z.AI emits webReader as a text block: "🌐 Z.ai Built-in Tool: webReader"
                  // followed by URL in JSON. Detect, suppress, and intercept.
                  if (data.type === "content_block_start" && data.content_block?.type === "text") {
                    // Check if this might be a webReader block (initial text is empty, we check deltas)
                  }
                  if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && !insideWebReaderBlock) {
                    webReaderTextChunks.push(data.delta.text || "");
                    const accumulated = webReaderTextChunks.join("");
                    if (accumulated.includes("webReader") || accumulated.includes("Built-in Tool")) {
                      // Extract URL from the accumulated text
                      const urlMatch = accumulated.match(/"(https?:\/\/[^"]+)"/);
                      if (urlMatch) {
                        webReaderUrl = urlMatch[1];
                        webReaderBlockIndex = data.index;
                        insideWebReaderBlock = true;
                        serverToolBlocksSuppressed++;
                        log("[AnthropicSSE] webReader text block detected (filtered) — URL: " + webReaderUrl);
                        continue; // suppress this delta
                      }
                    }
                  }
                  if (insideWebReaderBlock) {
                    // Accumulate remaining text chunks to find URL if not yet found
                    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                      if (!webReaderUrl) {
                        webReaderTextChunks.push(data.delta.text || "");
                        const accumulated = webReaderTextChunks.join("");
                        const urlMatch = accumulated.match(/"(https?:\/\/[^"]+)"/);
                        if (urlMatch) {
                          webReaderUrl = urlMatch[1];
                          log("[AnthropicSSE] webReader URL extracted from delta (filtered): " + webReaderUrl);
                        }
                      }
                      continue; // suppress all deltas inside webReader block
                    }
                    if (data.type === "content_block_stop") {
                      insideWebReaderBlock = false;
                      log("[AnthropicSSE] webReader text block ended (filtered)");
                      continue; // suppress the stop event
                    }
                    continue; // suppress everything else inside webReader block
                  }
                  // Reset text chunks on new content block start (not webReader)
                  if (data.type === "content_block_start") {
                    webReaderTextChunks = [];
                  }

                  // Re-index non-thinking content blocks
                  // After suppressing N thinking blocks + M server_tool blocks,
                  // subtract (N+M) from the index
                  if (typeof data.index === "number" && (thinkingBlocksSuppressed > 0 || serverToolBlocksSuppressed > 0)) {
                    const totalSuppressed = thinkingBlocksSuppressed + serverToolBlocksSuppressed;
                    const reindexed = data.index - totalSuppressed;
                    const clamped = clampIndex(reindexed, `${data.type} (filtered, orig=${data.index})`);
                    trackIndex(clamped);
                    const modifiedLine =
                      "data: " + JSON.stringify({ ...data, index: clamped });

                    if (!isClosed) {
                      controller.enqueue(encoder.encode(modifiedLine + "\n"));
                    }

                    // Still do usage tracking below with the ORIGINAL data
                  } else {
                    // No filtering needed — track and pass through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        trackIndex(data.index);
                      } else {
                        const clamped = clampIndex(data.index, `${data.type} (unfiltered)`);
                        if (clamped !== data.index) {
                          const modifiedLine =
                            "data: " + JSON.stringify({ ...data, index: clamped });
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(modifiedLine + "\n"));
                          }
                          // Skip original enqueue below
                          continue;
                        }
                      }
                    }
                    // Suppress message_stop/message_delta if webReader was detected — we'll re-emit after injection
                    if ((data.type === "message_stop" || data.type === "message_delta") && webReaderUrl) {
                      if (data.type === "message_stop") {
                        webReaderSuppressMessageStop = true;
                        sawMessageStop = true;
                        log("[AnthropicSSE] Suppressing message_stop (webReader intercept pending, filtered)");
                      }
                      continue;
                    }
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  }
                } catch {
                  // Unparseable — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              } else {
                // Non-data lines (event: lines, blank lines) or no filtering
                if (!filterThinking && line.startsWith("data: ")) {
                  // Parse data lines BEFORE enqueuing to detect in-stream errors
                  try {
                    const data = JSON.parse(line.slice(6));

                    // ── Non-Anthropic event suppression ──
                    // Z.AI sometimes injects proprietary SSE events that aren't valid
                    // Anthropic wire format. These have types like "tool_result" at the
                    // top level (not inside content_block), or contain webReader output.
                    // Valid Anthropic SSE event types: message_start, content_block_start,
                    // content_block_delta, content_block_stop, message_delta, message_stop, ping.
                    const VALID_SSE_TYPES = new Set([
                      "message_start", "content_block_start", "content_block_delta",
                      "content_block_stop", "message_delta", "message_stop", "ping",
                      "error",
                    ]);
                    if (data.type && !VALID_SSE_TYPES.has(data.type)) {
                      log(`[AnthropicSSE] Suppressing non-Anthropic SSE event type "${data.type}" (index=${data.index})`);
                      continue;
                    }

                    // ── In-stream error detection (GitHub #106) ──
                    if (data.error) {
                      const errMsg = data.error.message || JSON.stringify(data.error);
                      log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                      if (!isClosed) {
                        isClosed = true;
                        if (pingInterval) {
                          clearInterval(pingInterval);
                          pingInterval = null;
                        }
                        // Emit synthetic finalization so the client gets a properly
                        // terminated stream instead of "empty or malformed response".
                        try {
                          const synthId = `msg_${Date.now()}`;
                          controller.enqueue(encoder.encode(
                            "event: message_start\n" +
                            `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}\n\n`
                          ));
                          controller.enqueue(encoder.encode(
                            "event: content_block_start\n" +
                            `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
                          ));
                          controller.enqueue(encoder.encode(
                            "event: content_block_delta\n" +
                            `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Error: ${errMsg}]"}}\n\n`
                          ));
                          controller.enqueue(encoder.encode(
                            "event: content_block_stop\n" +
                            `data: {"type":"content_block_stop","index":0}\n\n`
                          ));
                          controller.enqueue(encoder.encode(
                            "event: message_delta\n" +
                            `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`
                          ));
                          controller.enqueue(encoder.encode(
                            "event: message_stop\n" +
                            `data: {"type":"message_stop"}\n\n`
                          ));
                        } catch (enqueueErr) {
                          log(`[AnthropicSSE] Failed to emit synthetic finalization (in-stream-error): ${enqueueErr}`);
                        }
                        cap.note("in-stream-error");
                        cap.done({ closed: true, stop_reason: "error", path: "in-stream-error" });
                        controller.close();
                      }
                      return; // stop processing further lines
                    }

                    // ── Suppress server_tool_use / server_tool_result blocks ──
                    // Z.AI built-in tools (analyze_image, webReader) emit these blocks.
                    // When they fail (local paths, unreachable URLs), Z.AI returns
                    // "Content block not found". Suppress the entire block + remap indices.
                    if (
                      data.type === "content_block_start" &&
                      (data.content_block?.type === "server_tool_use" || data.content_block?.type === "server_tool_result")
                    ) {
                      suppressedServerTools++;
                      serverToolBlocksSuppressed++;
                      log(`[AnthropicSSE] Suppressing ${data.content_block.type} block at index ${data.index} (total suppressed: ${serverToolBlocksSuppressed})`);
                      continue;
                    }
                    // Suppress deltas while inside a suppressed server_tool block
                    if (suppressedServerTools > 0 && data.type === "content_block_delta") {
                      continue;
                    }
                    // Track end of suppressed server_tool block
                    if (data.type === "content_block_stop" && suppressedServerTools > 0) {
                      suppressedServerTools--;
                      continue;
                    }

                    // ── webReader text block detection (passthrough path) ──
                    // Z.AI emits webReader as a text block: "🌐 Z.ai Built-in Tool: webReader"
                    // followed by URL in JSON. Detect, suppress, and intercept.
                    if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && !insideWebReaderBlock) {
                      webReaderTextChunks.push(data.delta.text || "");
                      const accumulated = webReaderTextChunks.join("");
                      if (accumulated.includes("webReader") || accumulated.includes("Built-in Tool")) {
                        const urlMatch = accumulated.match(/"(https?:\/\/[^"]+)"/);
                        if (urlMatch) {
                          webReaderUrl = urlMatch[1];
                          webReaderBlockIndex = data.index;
                          insideWebReaderBlock = true;
                          serverToolBlocksSuppressed++;
                          log("[AnthropicSSE] webReader text block detected (passthrough) — URL: " + webReaderUrl);
                          continue;
                        }
                      }
                    }
                    if (insideWebReaderBlock) {
                      if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                        if (!webReaderUrl) {
                          webReaderTextChunks.push(data.delta.text || "");
                          const accumulated = webReaderTextChunks.join("");
                          const urlMatch = accumulated.match(/"(https?:\/\/[^"]+)"/);
                          if (urlMatch) {
                            webReaderUrl = urlMatch[1];
                            log("[AnthropicSSE] webReader URL extracted from delta (passthrough): " + webReaderUrl);
                          }
                        }
                        continue;
                      }
                      if (data.type === "content_block_stop") {
                        insideWebReaderBlock = false;
                        log("[AnthropicSSE] webReader text block ended (passthrough)");
                        continue;
                      }
                      continue;
                    }
                    // Reset text chunks on new content block start
                    if (data.type === "content_block_start") {
                      webReaderTextChunks = [];
                    }

                    // No error — check index bounds before passing through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        // z.ai sometimes sends content_block_start with an index
                        // that jumps (e.g., 0 → 2, skipping 1). This causes
                        // "Content block not found" on the client. Remap to
                        // sequential indices to keep the client happy.
                        const expected = highestSeenIndex + 1;
                        if (data.index !== expected) {
                          log(
                            `[AnthropicSSE] content_block_start index ${data.index} remapped to ${expected} (model=${opts.modelName})`
                          );
                          const remapped = { ...data, index: expected };
                          if (!isClosed) {
                            controller.enqueue(encoder.encode("data: " + JSON.stringify(remapped) + "\n"));
                          }
                        } else {
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(line + "\n"));
                          }
                        }
                        trackIndex(expected);
                      } else {
                        // delta / stop — clamp to highestSeenIndex
                        const clamped = clampIndex(data.index, `${data.type} (passthrough)`);
                        if (clamped !== data.index) {
                          const modified = { ...data, index: clamped };
                          if (!isClosed) {
                            controller.enqueue(encoder.encode("data: " + JSON.stringify(modified) + "\n"));
                          }
                        } else {
                          if (!isClosed) {
                            controller.enqueue(encoder.encode(line + "\n"));
                          }
                        }
                      }
                    } else {
                      // No index field — pass through as-is
                      // Suppress message_stop/message_delta if webReader was detected — we'll re-emit after injection
                      if ((data.type === "message_stop" || data.type === "message_delta") && webReaderUrl) {
                        if (data.type === "message_stop") {
                          webReaderSuppressMessageStop = true;
                          sawMessageStop = true;
                          log("[AnthropicSSE] Suppressing message_stop (webReader intercept pending, passthrough)");
                        }
                        // fall through to usage tracking below
                      } else if (!isClosed) {
                        controller.enqueue(encoder.encode(line + "\n"));
                      }
                    }

                    // Usage/debug tracking
                    if (data.message?.usage) {
                      inputTokens = data.message.usage.input_tokens || inputTokens;
                      outputTokens = data.message.usage.output_tokens || outputTokens;
                    }
                    if (data.usage) {
                      inputTokens = data.usage.input_tokens || inputTokens;
                      outputTokens = data.usage.output_tokens || outputTokens;
                    }
                    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                      const txt = data.delta.text || "";
                      textChunks++;
                      log(
                        `[AnthropicSSE] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                      );
                    }
                                        if (
                                          data.type === "content_block_start" &&
                                          data.content_block?.type === "tool_use"
                                        ) {
                                          toolUseBlocks++;
                                          log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                                        }
                                        if (data.type === "message_start") {
                                          sawMessageStart = true;

                    }
                    if (data.type === "message_delta" && data.delta?.stop_reason) {
                      stopReason = data.delta.stop_reason;
                    }
                    if (data.type === "message_stop") {
                      sawMessageStop = true;
                    }
                  } catch {
                    // Unparseable data line — pass through
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  }
                } else {
                  // Non-data lines (event: lines, blank lines) — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              }

              // ── Usage/debug tracking for filtered path ────────────────
              // We need this even when filtering, but the data was already parsed
              // above in the filterThinking branch. Re-parse for tracking only.
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                    outputTokens = data.message.usage.output_tokens || outputTokens;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                    textChunks++;
                  }
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "tool_use"
                  ) {
                    toolUseBlocks++;
                    log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                  }
                  if (data.type === "message_delta" && data.delta?.stop_reason) {
                    stopReason = data.delta.stop_reason;
                  }
                  if (data.type === "message_start") {
                    sawMessageStart = true;
                  }
                  if (data.type === "message_stop") {
                    sawMessageStop = true;
                  }
                } catch {}
              }
            }
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}` +
              (filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : "") +
              (webReaderUrl ? `, webReader intercepted: ${webReaderUrl}` : "")
          );
          cap.note(`upstream-done sawMessageStop=${sawMessageStop} stop_reason=${stopReason} toolUse=${toolUseBlocks}`);

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          // ── webReader finalize injection ──
          // If we detected a webReader text block during streaming, fetch the URL
          // and inject results as a new text block before closing the stream.
          if (webReaderUrl && !isClosed) {
            log(`[AnthropicSSE] webReader finalize: fetching "${webReaderUrl}"`);
            const fetchResults = await executeWebFetch(webReaderUrl);
            log(`[AnthropicSSE] webReader fetch complete: ${fetchResults.length} chars`);

            // Calculate the index for the injected block
            // After suppressing webReader block, the next index is highestSeenIndex + 1
            const injectIdx = highestSeenIndex + 1;

            // Emit a new text block with the fetch results
            controller.enqueue(encoder.encode(
              "event: content_block_start\n" +
              `data: ${JSON.stringify({
                type: "content_block_start",
                index: injectIdx,
                content_block: { type: "text", text: "" },
              })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              "event: content_block_delta\n" +
              `data: ${JSON.stringify({
                type: "content_block_delta",
                index: injectIdx,
                delta: { type: "text_delta", text: `[Web fetch results for "${webReaderUrl}"]\n\n${fetchResults}` },
              })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              "event: content_block_stop\n" +
              `data: ${JSON.stringify({ type: "content_block_stop", index: injectIdx })}\n\n`
            ));

            // If we suppressed message_stop, re-emit it now
            if (webReaderSuppressMessageStop) {
              if (!stopReason) stopReason = "end_turn";
              controller.enqueue(encoder.encode(
                "event: message_delta\n" +
                `data: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                })}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: message_stop\n" +
                `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
              ));
              log("[AnthropicSSE] webReader: re-emitted message_stop after injection");
            }

            cap.note("webReader-intercept");
          }

          // Finalization: if the upstream stream ended without sending
          // message_stop, emit it ourselves. Claude Code requires
          // message_stop as the terminal event — without it, the client
          // reports "API returned an empty or malformed response (HTTP 200)".
          if (!isClosed && !sawMessageStop) {
            log(`[AnthropicSSE] Stream ended without message_stop (stopReason=${stopReason}) — emitting synthetic finalization`);
            if (!sawMessageStart) {
              const synthId = `msg_${Date.now()}`;
              controller.enqueue(encoder.encode(
                "event: message_start\n" +
                `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_start\n" +
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_delta\n" +
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Error: The model returned an empty response. Try compacting the conversation or reducing the context size.]"}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_stop\n" +
                `data: {"type":"content_block_stop","index":0}\n\n`
              ));
            }
            if (!stopReason) {
              controller.enqueue(encoder.encode(
                "event: message_delta\n" +
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`
              ));
            }
            controller.enqueue(encoder.encode(
              "event: message_stop\n" +
              `data: {"type":"message_stop"}\n\n`
            ));
          }

          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "normal" });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "already-closed" });
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          cap.note(`stream-exception ${String(e)}`);
          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }

            // Emit synthetic finalization so the client gets a properly terminated
            // stream instead of a hard close ("JSON Parse error: Unexpected EOF").
            // Mirrors the normal-path finalization above (lines ~636-667).
            try {
              if (!sawMessageStart) {
                const synthId = `msg_${Date.now()}`;
                controller.enqueue(encoder.encode(
                  "event: message_start\n" +
                  `data: {"type":"message_start","message":{"id":"${synthId}","type":"message","role":"assistant","model":"${opts.modelName}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  "event: content_block_start\n" +
                  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  "event: content_block_delta\n" +
                  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Error: Stream interrupted. The upstream provider closed the connection prematurely.]"}}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  "event: content_block_stop\n" +
                  `data: {"type":"content_block_stop","index":0}\n\n`
                ));
              }
              if (!stopReason) stopReason = "end_turn";
              controller.enqueue(encoder.encode(
                "event: message_delta\n" +
                `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`
              ));
              controller.enqueue(encoder.encode(
                "event: message_stop\n" +
                `data: {"type":"message_stop"}\n\n`
              ));
            } catch (enqueueErr) {
              log(`[AnthropicSSE] Failed to emit synthetic finalization: ${enqueueErr}`);
            }

            cap.done({ closed: true, stop_reason: "exception", path: "catch", error: String(e) });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: "exception", path: "catch-already-closed", error: String(e) });
          }
        }
      },
      cancel(reason?: unknown) {
        cap.note(`client-cancel ${reason !== undefined ? String(reason) : ""}`);
        cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
        isClosed = true;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
