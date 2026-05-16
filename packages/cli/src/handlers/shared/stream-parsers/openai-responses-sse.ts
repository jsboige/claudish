/**
 * OpenAI Responses API SSE → Claude SSE stream parser.
 *
 * Handles Codex models that use /v1/responses instead of /v1/chat/completions.
 * The Responses API has different event types:
 *   response.output_text.delta → content text
 *   response.output_item.added → new item (function_call, reasoning)
 *   response.function_call_arguments.delta → tool argument streaming
 *   response.reasoning_summary_text.delta → thinking output
 *   response.output_item.done → close tool_use block
 *   response.completed / response.done → final usage
 */

import type { Context } from "hono";
import {
  type CachedReasoningItem,
  rememberReasoningForCall,
} from "../../../adapters/reasoning-cache.js";
import { getLogLevel, log } from "../../../logger.js";
import { wrapAnthropicError } from "../anthropic-error.js";

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    toolNameMap?: Map<string, string>;
    /**
     * Real per-provider context window (tokens) for the model on THIS backend,
     * resolved from the catalog by the caller. Used only to make the overflow
     * message specific ("caps at ~372K"); omit/0 → the number is left out.
     */
    contextWindow?: number;
    /**
     * Fired when the Responses backend returns an in-stream error event (e.g.
     * `context_length_exceeded`). The error arrives on an HTTP 200 stream, so the
     * caller can't see it from the status code — this signal lets it record the
     * turn as a failure instead of a success in telemetry.
     */
    onApiError?: (code: string, message: string) => void;
  }
): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    return c.json(wrapAnthropicError(500, "No response body"), 500) as any;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let buffer = "";
  // Monotonic content-block index. Every block (thinking, text, tool_use) takes
  // the next index — Claude's SSE contract requires contiguous indices, and a
  // block index must never be reused once its block is closed.
  let curIdx = 0;
  let textIdx = -1;
  let reasoningIdx = -1;
  // OpenAI splits a reasoning summary into parts (summary_index 0, 1, 2, …),
  // each a bolded section. The paragraph break between parts is structural —
  // it is NOT in the text deltas — so tracking the index lets us re-insert it,
  // otherwise "**A**" + "**B**" render as one smashed "**A****B**".
  let lastSummaryIndex = -1;
  // Set when OpenAI reports the response was cut short (response.incomplete).
  // Must reach the client as a truthful stop_reason: when the model runs out of
  // output budget mid-tool-call, OpenAI still emits the partial arguments, and
  // claiming stop_reason "tool_use" tells the client to execute a tool whose
  // JSON is truncated.
  let incompleteReason: string | null = null;
  // Reasoning items seen since the last function call. OpenAI emits them just
  // before the call they informed; we hand them to the cache keyed by that call
  // so the next request can replay them (see reasoning-cache.ts).
  let pendingReasoning: CachedReasoningItem[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let hasToolUse = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  type FnCall = { name: string; arguments: string; index: number; claudeId?: string };

  // Track function calls being streamed. Keyed by BOTH call_id and item_id, so
  // the same FnCall object appears under two keys — never derive a count from
  // this map's size; use openToolBlocks / hasToolUse instead.
  const functionCalls: Map<string, FnCall> = new Map();

  // Tool blocks that have been started but not yet stopped, in emission order.
  const openToolBlocks = new Set<FnCall>();

  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const closeReasoning = () => {
        if (reasoningIdx >= 0) {
          send("content_block_stop", { type: "content_block_stop", index: reasoningIdx });
          reasoningIdx = -1;
        }
      };
      const closeText = () => {
        if (textIdx >= 0) {
          send("content_block_stop", { type: "content_block_stop", index: textIdx });
          textIdx = -1;
        }
      };
      const closeTools = () => {
        for (const fnCall of openToolBlocks) {
          send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
        }
        openToolBlocks.clear();
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.modelName,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send("ping", { type: "ping" });

      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) continue;
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            // Raw capture, greppable into test fixtures — same contract as
            // [SSE:openai] / [SSE:anthropic] in the sibling parsers.
            if (getLogLevel() === "debug") {
              log(`[SSE:responses] ${data.substring(0, 300)}`);
            }

            try {
              const event = JSON.parse(data);

              if (getLogLevel() === "debug" && event.type) {
                log(`[ResponsesSSE] Event: ${event.type}`);
              }

              if (event.type === "response.output_text.delta") {
                closeReasoning();
                if (textIdx < 0) {
                  textIdx = curIdx++;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: textIdx,
                    content_block: { type: "text", text: "" },
                  });
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: textIdx,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.output_item.added") {
                if (event.item?.type === "function_call") {
                  const itemId = event.item.id;
                  const openaiCallId = event.item.call_id || itemId;
                  const callId = openaiCallId.startsWith("toolu_")
                    ? openaiCallId
                    : `toolu_${openaiCallId.replace(/^fc_/, "")}`;
                  const rawFnName = event.item.name || "";
                  const fnName = opts.toolNameMap?.get(rawFnName) || rawFnName;

                  closeReasoning();
                  closeText();

                  const fnCallData: FnCall = {
                    name: fnName,
                    arguments: "",
                    index: curIdx++,
                    claudeId: callId,
                  };

                  functionCalls.set(openaiCallId, fnCallData);
                  if (itemId && itemId !== openaiCallId) {
                    functionCalls.set(itemId, fnCallData);
                  }
                  openToolBlocks.add(fnCallData);

                  // Bind the reasoning that led to this call, keyed by the id the
                  // client will echo back, so the next request can replay it.
                  if (pendingReasoning.length > 0) {
                    rememberReasoningForCall(callId, pendingReasoning);
                    pendingReasoning = [];
                  }

                  send("content_block_start", {
                    type: "content_block_start",
                    index: fnCallData.index,
                    content_block: { type: "tool_use", id: callId, name: fnName, input: {} },
                  });
                  hasToolUse = true;
                }
              } else if (event.type === "response.reasoning_summary_text.delta") {
                // Reasoning is the model's chain of thought, not its answer — it
                // belongs in a thinking block, or Claude Code renders it as the reply.
                const summaryIndex =
                  typeof event.summary_index === "number" ? event.summary_index : 0;
                if (reasoningIdx < 0) {
                  closeText();
                  reasoningIdx = curIdx++;
                  lastSummaryIndex = summaryIndex;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: reasoningIdx,
                    content_block: { type: "thinking", thinking: "" },
                  });
                } else if (summaryIndex !== lastSummaryIndex) {
                  // New summary section — restore the paragraph break OpenAI
                  // represents structurally rather than in the text stream.
                  lastSummaryIndex = summaryIndex;
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: reasoningIdx,
                    delta: { type: "thinking_delta", thinking: "\n\n" },
                  });
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: reasoningIdx,
                  delta: { type: "thinking_delta", thinking: event.delta || "" },
                });
              } else if (event.type === "response.function_call_arguments.delta") {
                const callId = event.call_id || event.item_id;
                const fnCall = functionCalls.get(callId);
                if (fnCall) {
                  fnCall.arguments += event.delta || "";
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: fnCall.index,
                    delta: { type: "input_json_delta", partial_json: event.delta || "" },
                  });
                }
              } else if (event.type === "response.output_item.done") {
                if (event.item?.type === "reasoning" && event.item.encrypted_content) {
                  // Keep the item verbatim (minus the id, which the Responses API
                  // does not require on replay and which buildPayload strips).
                  pendingReasoning.push({
                    type: "reasoning",
                    content: event.item.content ?? [],
                    encrypted_content: event.item.encrypted_content,
                    summary: event.item.summary ?? [],
                  });
                }
                if (event.item?.type === "function_call") {
                  const callId = event.item.call_id || event.item.id;
                  const fnCall = functionCalls.get(callId) || functionCalls.get(event.item.id);
                  if (fnCall && openToolBlocks.has(fnCall)) {
                    send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                    openToolBlocks.delete(fnCall);
                  }
                }
              } else if (event.type === "response.incomplete") {
                // The reason lives at response.incomplete_details.reason — reading
                // event.reason always yielded "unknown".
                incompleteReason =
                  event.response?.incomplete_details?.reason ?? event.reason ?? "unknown";
                log(`[ResponsesSSE] Response incomplete: ${incompleteReason}`);
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || inputTokens;
                  outputTokens = event.response.usage.output_tokens || outputTokens;
                }
              } else if (event.type === "response.completed" || event.type === "response.done") {
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || 0;
                  outputTokens = event.response.usage.output_tokens || 0;
                } else if (event.usage) {
                  inputTokens = event.usage.input_tokens || 0;
                  outputTokens = event.usage.output_tokens || 0;
                }
              } else if (event.type === "error" || event.type === "response.failed") {
                const err = event.error || event.response?.error || {};
                const errMsg = err.message || event.message || "Unknown API error";
                const errCode = err.code || event.code || "";
                log(`[ResponsesSSE] API error: ${errCode} - ${errMsg}`);

                // Signal the terminal error so the caller records this turn as a
                // failure (the error rides an HTTP 200 stream, invisible to status).
                opts.onApiError?.(errCode, errMsg);

                closeReasoning();
                closeText();
                closeTools();

                // Context-overflow gets an actionable message (with the real
                // per-backend cap when known) instead of the bare error code —
                // otherwise the user just sees a cryptic `context_length_exceeded`
                // and a stuck session (/compact re-sends the same oversized input).
                const isCtxOverflow =
                  errCode === "context_length_exceeded" ||
                  /context (length|window)|exceeds? the context|too long|maximum context/i.test(
                    errMsg
                  );
                let errorText = `\n\n[API Error: ${errCode} ${errMsg}]`;
                if (isCtxOverflow) {
                  const cap =
                    opts.contextWindow && opts.contextWindow > 0
                      ? ` ~${Math.round(opts.contextWindow / 1000)}K tokens`
                      : "";
                  errorText =
                    `\n\n[Context limit reached] This model's backend enforces a smaller context window${cap} than its API spec. ` +
                    "Run /clear to start fresh (/compact will also fail — it re-sends the full conversation), " +
                    `or route the model via \`oai@${opts.modelName}\` to use the full-size window.`;
                }

                const errorIdx = curIdx++;
                send("content_block_start", {
                  type: "content_block_start",
                  index: errorIdx,
                  content_block: { type: "text", text: "" },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: errorIdx,
                  delta: { type: "text_delta", text: errorText },
                });
                send("content_block_stop", { type: "content_block_stop", index: errorIdx });

                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                });
                send("message_stop", { type: "message_stop" });
                isClosed = true;
                if (pingInterval) {
                  clearInterval(pingInterval);
                  pingInterval = null;
                }
                if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
                controller.close();
                return;
              }
            } catch (parseError) {
              log(`[ResponsesSSE] Parse error: ${parseError}`);
            }
          }
        }

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        closeReasoning();
        closeText();
        closeTools();

        // A truncated turn must NOT be reported as a finished tool call. OpenAI
        // emits the partial function_call arguments it managed to produce, so
        // "tool_use" makes the client execute a tool with malformed JSON
        // (InputValidationError). Anthropic's contract for a cut-off turn is
        // stop_reason "max_tokens" — the client then discards the partial block.
        const stopReason = incompleteReason
          ? incompleteReason === "content_filter"
            ? "refusal"
            : "max_tokens"
          : hasToolUse
            ? "tool_use"
            : "end_turn";
        if (incompleteReason) {
          log(
            `[ResponsesSSE] Truncated response (${incompleteReason}) → stop_reason=${stopReason}`
          );
        }
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        controller.close();
      } catch (error) {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        log(`[ResponsesSSE] Stream error: ${error}`);

        if (!isClosed) {
          try {
            closeReasoning();
            closeText();
            closeTools();

            const errorIdx = curIdx++;
            send("content_block_start", {
              type: "content_block_start",
              index: errorIdx,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: errorIdx,
              delta: { type: "text_delta", text: `\n\n[Stream error: ${error}]` },
            });
            send("content_block_stop", { type: "content_block_stop", index: errorIdx });

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            });
            send("message_stop", { type: "message_stop" });
          } catch {}

          isClosed = true;
          if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
          try {
            controller.close();
          } catch {}
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
