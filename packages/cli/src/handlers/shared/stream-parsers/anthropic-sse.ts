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
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import { log } from "../../../logger.js";
import { createResponseCapture } from "../response-capture.js";

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
            controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
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

          // Thinking-block filtering state
          let insideThinkingBlock = false;
          /** How many thinking blocks have been suppressed so far. */
          let thinkingBlocksSuppressed = 0;

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

                  // ── In-stream error detection (GitHub #106) ──
                  // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return
                  // HTTP 200 with {"error":{...}} embedded in the SSE payload.
                  // Detect and surface as a proper error event.
                  if (data.error) {
                    const errMsg = data.error.message || JSON.stringify(data.error);
                    log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                    if (!isClosed) {
                      controller.enqueue(
                        encoder.encode(
                          `event: error\ndata: ${JSON.stringify({
                            type: "error",
                            error: { type: "api_error", message: errMsg },
                          })}\n\n`
                        )
                      );
                      isClosed = true;
                      if (pingInterval) {
                        clearInterval(pingInterval);
                        pingInterval = null;
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

                  // Re-index non-thinking content blocks
                  // After suppressing N thinking blocks, subtract N from the index
                  if (typeof data.index === "number" && thinkingBlocksSuppressed > 0) {
                    const reindexed = data.index - thinkingBlocksSuppressed;
                    const modifiedLine = `data: ${JSON.stringify({ ...data, index: reindexed })}`;

                    if (!isClosed) {
                      controller.enqueue(encoder.encode(`${modifiedLine}\n`));
                    }

                    // Still do usage tracking below with the ORIGINAL data
                  } else {
                    // No filtering needed — pass through as-is
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(`${line}\n`));
                    }
                  }
                } catch {
                  // Unparseable — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                  }
                }
              } else {
                // Non-data lines (event: lines, blank lines) or no filtering
                if (!filterThinking && line.startsWith("data: ")) {
                  // Parse data lines BEFORE enqueuing to detect in-stream errors
                  try {
                    const data = JSON.parse(line.slice(6));

                    // ── In-stream error detection (GitHub #106) ──
                    if (data.error) {
                      const errMsg = data.error.message || JSON.stringify(data.error);
                      log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
                      if (!isClosed) {
                        controller.enqueue(
                          encoder.encode(
                            `event: error\ndata: ${JSON.stringify({
                              type: "error",
                              error: { type: "api_error", message: errMsg },
                            })}\n\n`
                          )
                        );
                        isClosed = true;
                        if (pingInterval) {
                          clearInterval(pingInterval);
                          pingInterval = null;
                        }
                        cap.note("in-stream-error");
                        cap.done({ closed: true, stop_reason: "error", path: "in-stream-error" });
                        controller.close();
                      }
                      return; // stop processing further lines
                    }

                    // No error — pass through the line
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(`${line}\n`));
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
                    if (data.type === "message_delta" && data.delta?.stop_reason) {
                      stopReason = data.delta.stop_reason;
                    }
                  } catch {
                    // Unparseable data line — pass through
                    if (!isClosed) {
                      controller.enqueue(encoder.encode(`${line}\n`));
                    }
                  }
                } else {
                  // Non-data lines (event: lines, blank lines) — pass through
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(`${line}\n`));
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
                } catch {}
              }
            }
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}${filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : ""}`
          );
          cap.note(`upstream-done sawMessageStop=${sawMessageStop} stop_reason=${stopReason} toolUse=${toolUseBlocks}`);

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
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
