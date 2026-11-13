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
import { log, getLogLevel } from "../../../logger.js";
import { wrapAnthropicError } from "../anthropic-error.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import { overflowReportedTokens, overflowReportFloor } from "../overflow-report-floor.js";
import { createResponseCapture } from "../response-capture.js";
import { ttftMarkerLine } from "../traffic-markers.js";
import { isPolicyRefusal, logPolicyRefusal } from "./policy-refusal.js";
import { sseDataPayload } from "./sse-line.js";
import { toAnthropicUsage } from "./usage-cache-split.js";

/**
 * Extract the token counts named by a context-overflow error.
 *
 * The Responses backend states both numbers in prose, e.g. "This model's
 * maximum context length is 272000 tokens. However, your messages resulted in
 * 285000 tokens." We need the used count because the error path reports
 * `usage 0+0` (no `response.completed` ever arrives), and a zero tells Claude
 * Code the conversation is EMPTY: its context gauge resets, auto-compact never
 * fires, the session stays in overflow, and every later turn fails the same
 * way — which reads to the user as "the agent ignores my messages"
 * (gpt-5.6-sol lane report, 2026-08-27).
 *
 * When the used count is absent but the limit is stated, the limit is a valid
 * lower bound — we overflowed it by definition — and is enough to trip
 * auto-compact. Returns undefined for every other error, which keeps its
 * existing behavior untouched.
 */
export function parseContextOverflow(
  message: string,
  code?: string
): { used?: number; limit?: number } | undefined {
  const msg = message || "";
  const isOverflow =
    code === "context_length_exceeded" ||
    /context length|context window|maximum context|too many tokens/i.test(msg);
  if (!isOverflow) return undefined;

  const limitMatch =
    msg.match(/maximum context length is (\d+)/i) || msg.match(/context window of (\d+)/i);
  const usedMatch =
    msg.match(/resulted in (\d+) tokens/i) ||
    msg.match(/requested (\d+) tokens/i) ||
    msg.match(/input of (\d+) tokens/i);
  const limit = limitMatch ? Number(limitMatch[1]) : undefined;
  const used = usedMatch ? Number(usedMatch[1]) : limit;
  return { used, limit };
}

type StreamReadError = {
  isSocketClose: boolean;
  detail: string;
};

function classifyStreamReadError(error: unknown): StreamReadError {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 4 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      details.push(`${current.name}: ${current.message}`);
    } else {
      details.push(String(current));
    }

    const code =
      typeof current === "object" && current !== null && "code" in current
        ? String((current as { code?: unknown }).code || "")
        : "";
    if (code) details.push(`code=${code}`);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }

  const detail = details.join(" <- ").slice(0, 300);
  const isSocketClose =
    /socket.*closed|connection (?:was )?closed|connection reset/i.test(detail) ||
    /(?:^|\W)(?:ECONNRESET|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)(?:$|\W)/i.test(detail);
  return { isSocketClose, detail };
}

/**
 * #115: the Responses wire reports the cached share of the prompt inside
 * usage.input_tokens_details.cached_tokens. Mirror the chat-completions lane
 * (#99/#101): clamp to the prompt, net it out of input_tokens, surface it as
 * cache_read_input_tokens. A gross input double-counts on the client's context
 * gauge, which sums the fields.
 */
function readCacheReadTokens(
  usage: { input_tokens_details?: { cached_tokens?: unknown } },
  promptTokens: number
): number {
  const raw = Number(usage.input_tokens_details?.cached_tokens) || 0;
  return Math.min(Math.max(raw, 0), promptTokens);
}

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    toolNameMap?: Map<string, string>;
    /** dispatch → upstream headers latency, from ComposedHandler (for [ttft]). */
    headerLatencyMs?: number;
    /**
     * Transparent in-stream retry (2026-09-02 Sol crashes): re-issues the SAME
     * upstream request. Called ONLY when a retryable error event (server_error…)
     * arrives while ZERO content blocks have been emitted to the client — from
     * the client's perspective nothing happened (it saw only message_start +
     * pings). Returns null / throws → the original error is surfaced as before.
     */
    retryUpstream?: () => Promise<Response | null>;
    /** Backoff before each transparent-retry attempt (tests inject millisecond delays). */
    retryBackoffMs?: readonly number[];
    /** Provider id for the [PolicyRefusal] counting marker (#65 AC2, #41/#60). */
    providerName?: string;
  }
): Response {
  let reader = response.body?.getReader();
  if (!reader) {
    return c.json(wrapAnthropicError(500, "No response body"), 500) as any;
  }

  const encoder = new TextEncoder();
  // `let`: re-created on a transparent-retry reader swap — a TextDecoder keeps
  // partial multi-byte state across decode(stream:true) calls, and bytes from
  // the OLD stream must not leak into the first chunk of the new one.
  let decoder = new TextDecoder();
  // TTFT anchors — headers arrived when this handler was built; the first
  // upstream `data:` line completes the measurement. reqN resolved from the
  // request object itself (assigned at ingestion): the global counter read at
  // this point returns whichever request is CURRENT while this one waited for
  // headers — under concurrency every handler in a window would log the same
  // latest number.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  // Response capture for the Sol/Codex lane (#90). This parser used to emit its
  // own stdout marker but write NO resp-*.sse file, so every capture-based
  // analysis (traffic-summary, traffic-consumption, the #60 report) was blind to
  // the lane: the corpus had no rows for it at all. The [resp] marker now comes
  // from the capture, at CLOSE — the one position that also fires on a hung
  // stream, where the old completion-only marker never did.
  const cap = createResponseCapture("responses", opts.modelName, true, reqN);
  // Populated on a context-overflow refusal so the capture file carries the same
  // reported/synthetic counts the live marker prints.
  let overflowInfo: Record<string, unknown> | undefined;
  let ttftLogged = false;

  let buffer = "";
  // Block-index bookkeeping: one monotonic counter. Indices handed to the
  // client MUST be sequential (0,1,2,…) per message — the Anthropic SSE
  // contract keys content blocks by index and consumers rebuild them
  // positionally. The previous arithmetic (blockIndex + functionCalls.size +
  // (hasTextContent?1:0)) skipped an index on every parallel tool call after
  // the first (text at 0, tools at 1, 3, 4…), firing on nearly every agentic
  // turn of the Codex lane.
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let hasTextContent = false;
  let hasToolUse = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;
  let completed = false;
  let incompleteReason: string | null = null;
  let dataEvents = 0;
  let totalBytes = 0;
  // Transparent-retry state: bounded, and only while nothing is client-visible.
  let retryAttempts = 0;
  const FAST_RETRY_BACKOFF_MS = [1_000, 3_000];
  // Match the patient admission-overload budget in ComposedHandler. The Responses
  // backend may emit response.created before rejecting with server_is_overloaded,
  // which makes the start peek classify the stream as healthy. Five coordinators
  // hit that exact gap within five minutes on 2026-09-10.
  const OVERLOAD_RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 150_000];
  // server_error = the observed OpenAI transient (2026-09-02: 10 hits in 3h,
  // each one killing an agent turn). Deterministic codes are excluded — a
  // retry would fail identically and just burn the attempt.
  const RETRYABLE_ERROR_CODES = new Set([
    "server_error",
    "server_is_overloaded",
    "internal_error",
    "temporarily_unavailable",
    "overloaded_error",
    // invalid_prompt is OpenAI's usage-policy moderation flag and it is
    // probabilistic: the identical prompt usually passes a plain retry
    // (2026-09-10 02:10Z: a single flag on the opus cascade's cx@gpt-5.6-sol
    // step killed the session turn). A genuinely malformed prompt burns the
    // same two fast attempts (~4s) and then surfaces identically.
    "invalid_prompt",
  ]);

  // Track function calls being streamed
  interface FnCallState {
    name: string;
    arguments: string;
    index: number;
    claudeId?: string;
    /** `output_index` of the response's output array, when the wire states it. */
    outputIndex?: number;
  }
  const functionCalls: Map<string, FnCallState> = new Map();
  // #1039: the arguments events do not always carry a call id or an item id —
  // the documented `response.function_call_arguments.delta` carries
  // `item_id` + `output_index` and nothing else, and a compatible backend may
  // omit `item_id` too. Key the same FnCallState by output_index so a delta
  // whose only identity is its position still lands on its block.
  const functionCallsByOutputIndex: Map<number, FnCallState> = new Map();
  const closedFunctionBlocks = new Set<number>();
  // #1039: one line per unmatched identity — a dropped delta used to vanish
  // without a trace, which is how three tool calls were billed and delivered
  // empty. Deduped so a broken identity cannot flood the log per delta.
  const unmatchedArgumentDeltas = new Set<string>();

  // #1039: resolve the function call an upstream event refers to, whichever
  // identity field the provider filled in. The events do NOT share one form:
  // `output_item.added/done` carry `item.id` and `item.call_id`; the argument
  // events carry `item_id` (plus `output_index`), and some carry the position
  // alone. Main matched `call_id || item_id` only, so every multi-call turn
  // whose deltas used another form closed its blocks empty.
  const resolveFunctionCall = (ids: {
    callId?: unknown;
    itemId?: unknown;
    outputIndex?: unknown;
  }): FnCallState | undefined => {
    for (const key of [ids.callId, ids.itemId]) {
      if (typeof key === "string" && key) {
        const found = functionCalls.get(key);
        if (found) return found;
      }
    }
    if (typeof ids.outputIndex === "number") {
      return functionCallsByOutputIndex.get(ids.outputIndex);
    }
    return undefined;
  };

  // Terminal usage shape, ONE derivation point for all six emission sites
  // (#186). The parser accumulates the Responses wire's numbers into locals
  // as the events arrive (response.completed sets them, response.incomplete
  // updates them, an overflow error synthesizes them), so this rebuilds the
  // wire-shaped object and hands it to the shared shaper — `toAnthropicUsage`
  // owns the fullyCached rule and the three-key contract, same as the
  // chat-completions lane since #179. `cacheReadTokens` arrives here already
  // clamped by `readCacheReadTokens`; the shaper's own clamp is idempotent on
  // it. cache_creation stays 0 on this lane (the Responses API reports no
  // cache-write signal) — explicit, so the client's raw three-way sum can
  // never see `undefined`.
  const finalUsage = () =>
    toAnthropicUsage({
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: cacheReadTokens },
      output_tokens: outputTokens,
    });

  const stream = new ReadableStream({
    start: async (controller) => {
      // Diagnostic tap (no-op unless CLAUDISH_CAPTURE_DIR is set): mirror every
      // outgoing byte into the response capture, so the Sol/Codex lane lands in
      // the corpus and a hung stream stays visible offline.
      const _origEnqueue = controller.enqueue.bind(controller);
      controller.enqueue = ((chunk: any) => {
        cap.tap(chunk);
        return _origEnqueue(chunk);
      }) as typeof controller.enqueue;

      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const closeOpenBlocks = () => {
        if (textBlockIndex !== null) {
          send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = null;
        }
        for (const fnCall of new Set(functionCalls.values())) {
          if (!closedFunctionBlocks.has(fnCall.index)) {
            send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
            closedFunctionBlocks.add(fnCall.index);
          }
        }
      };

      const finishInterruptedStream = (error: unknown) => {
        if (isClosed) return;
        const { detail } = classifyStreamReadError(error);
        log(`[ResponsesSSE] Stream error model=${opts.modelName} reqN=${reqN}: ${detail}`, true);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        try {
          closeOpenBlocks();
          const errorIdx = nextBlockIndex++;
          send("content_block_start", {
            type: "content_block_start",
            index: errorIdx,
            content_block: { type: "text", text: "" },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index: errorIdx,
            delta: {
              type: "text_delta",
              text: "\n\n[The connection to the model provider was interrupted. This is usually temporary — please retry.]",
            },
          });
          send("content_block_stop", { type: "content_block_stop", index: errorIdx });
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: finalUsage(),
          });
          send("message_stop", { type: "message_stop" });
        } catch {
          // The downstream may already be gone. Never let finalization throw.
        }

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        cap.done({
          closed: true,
          stop_reason: "interrupted",
          path: "interrupted",
          detail,
          tools: functionCalls.size,
          usage: finalUsage(),
        });
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const retryBeforeVisibleContent = async (
        label: string,
        retryBackoff: readonly number[]
      ): Promise<boolean> => {
        if (
          !opts.retryUpstream ||
          retryAttempts >= retryBackoff.length ||
          nextBlockIndex !== 0 ||
          textBlockIndex !== null ||
          functionCalls.size !== 0
        ) {
          return false;
        }

        retryAttempts++;
        const configuredBackoff = opts.retryBackoffMs?.[retryAttempts - 1];
        const backoffMs =
          configuredBackoff ??
          retryBackoff[retryAttempts - 1] + Math.floor(Math.random() * 1_000);
        log(
          `[ResponsesSSE] ${label} before any client-visible block — transparent retry ${retryAttempts}/${retryBackoff.length} in ${backoffMs}ms (reqN=${reqN})`,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));

        let retryResp: Response | null = null;
        try {
          retryResp = await opts.retryUpstream();
        } catch (retryError) {
          log(
            `[ResponsesSSE] retry fetch failed (reqN=${reqN}): ${classifyStreamReadError(retryError).detail}`
          );
        }
        if (!retryResp?.ok || !retryResp.body) return false;

        try {
          await reader?.cancel();
        } catch {
          // old upstream body — best-effort release
        }
        reader = retryResp.body.getReader();
        buffer = "";
        decoder = new TextDecoder();
        return true;
      };

      send("message_start", {
        type: "message_start",
        message: {
          // Random suffix: Date.now() alone collides for handlers built in the
          // same millisecond (common under the parallel sub-agent bursts).
          id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.modelName,
          stop_reason: null,
          stop_sequence: null,
          // #186: the seed carries BOTH cache counters at an explicit 0. The
          // client's per-key usage merge takes a delta only when it is > 0 and
          // falls back to this seed otherwise — an absent key makes that
          // fallback `undefined`, and the raw three-way sum that feeds the
          // context meter and auto-compaction turns into NaN. NOT
          // messageStartUsage(): that helper seeds input_tokens to the prior
          // turn's count or 100 (S4-b) while this lane seeds 0 — #186's AC2
          // forbids changing that number as a side effect, so the divergence
          // stays until it is ruled on separately.
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
      send("ping", { type: "ping" });

      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      try {
        // readLoop: a transparent retry swaps the upstream reader and restarts here.
        readLoop: while (true) {
          // ReadableStreamReadResult isn't declared under the current lib —
          // the structural shape is identical.
          let readResult: { done: boolean; value?: Uint8Array };
          try {
            readResult = await reader!.read();
          } catch (readError) {
            const classified = classifyStreamReadError(readError);
            if (
              classified.isSocketClose &&
              (await retryBeforeVisibleContent("socket close", FAST_RETRY_BACKOFF_MS))
            ) {
              continue readLoop;
            }
            finishInterruptedStream(readError);
            return;
          }
          const { done, value } = readResult;
          if (done) break;
          lastActivity = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const data = sseDataPayload(line);
            if (data === null) continue;
            dataEvents++;
            totalBytes += line.length;
            if (!ttftLogged) {
              ttftLogged = true;
              process.stdout.write(
                ttftMarkerLine("responses", opts.modelName, reqN, opts.headerLatencyMs, Math.round(performance.now() - tHeaders))
              );
            }
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);

              if (getLogLevel() === "debug" && event.type) {
                log(`[ResponsesSSE] Event: ${event.type}`);
              }

              if (event.type === "response.output_text.delta") {
                if (textBlockIndex === null) {
                  textBlockIndex = nextBlockIndex++;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIndex,
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
                  // Close the text block (if open) BEFORE taking the next
                  // index, so text+tools yields 0,1,2,… with no gap and the
                  // text block is stopped exactly once.
                  if (textBlockIndex !== null) {
                    send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
                    textBlockIndex = null;
                  }
                  const fnIndex = nextBlockIndex++;

                  const fnCallData: FnCallState = {
                    name: fnName,
                    arguments: "",
                    index: fnIndex,
                    claudeId: callId,
                  };
                  if (typeof event.output_index === "number") {
                    fnCallData.outputIndex = event.output_index;
                    functionCallsByOutputIndex.set(event.output_index, fnCallData);
                  }

                  functionCalls.set(openaiCallId, fnCallData);
                  if (itemId && itemId !== openaiCallId) {
                    functionCalls.set(itemId, fnCallData);
                  }

                  send("content_block_start", {
                    type: "content_block_start",
                    index: fnIndex,
                    content_block: { type: "tool_use", id: callId, name: fnName, input: {} },
                  });
                  hasToolUse = true;
                  // #1039: some providers carry (part of) the argument string on
                  // the item itself. Whatever is already known at open time is
                  // owed to the client as a delta — the block's `input: {}` is
                  // syntax, not content.
                  const addedArgs =
                    typeof event.item.arguments === "string" ? event.item.arguments : "";
                  if (addedArgs) {
                    fnCallData.arguments = addedArgs;
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: fnIndex,
                      delta: { type: "input_json_delta", partial_json: addedArgs },
                    });
                  }
                }
              } else if (event.type === "response.reasoning_summary_text.delta") {
                if (textBlockIndex === null) {
                  textBlockIndex = nextBlockIndex++;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIndex,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.function_call_arguments.delta") {
                const fnCall = resolveFunctionCall({
                  callId: event.call_id,
                  itemId: event.item_id,
                  outputIndex: event.output_index,
                });
                if (fnCall && !closedFunctionBlocks.has(fnCall.index)) {
                  fnCall.arguments += event.delta || "";
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: fnCall.index,
                    delta: { type: "input_json_delta", partial_json: event.delta || "" },
                  });
                } else if (fnCall) {
                  // The block was already closed (out-of-order wire): a delta
                  // after content_block_stop is not legal on the Anthropic
                  // wire. Name it rather than emit a protocol violation — once
                  // per block, so a late tail cannot flood the log.
                  const identity = `after-stop:${fnCall.index}`;
                  if (!unmatchedArgumentDeltas.has(identity)) {
                    unmatchedArgumentDeltas.add(identity);
                    log(
                      `[ResponsesSSE] ARG-DELTA-AFTER-STOP model=${opts.modelName} reqN=${reqN} index=${fnCall.index} dropped=${String(event.delta || "").length}B`,
                      true
                    );
                  }
                } else {
                  // #1039: this used to be a silent drop. One line per identity,
                  // greppable: it is the field that names the wire shape a
                  // future occurrence actually used.
                  const identity = String(
                    event.call_id ?? event.item_id ?? `output_index:${event.output_index ?? "?"}`
                  );
                  if (!unmatchedArgumentDeltas.has(identity)) {
                    unmatchedArgumentDeltas.add(identity);
                    log(
                      `[ResponsesSSE] ARG-DELTA-UNMATCHED model=${opts.modelName} reqN=${reqN} id=${identity} output_index=${event.output_index ?? "?"} deltaLen=${String(event.delta || "").length} registered=${functionCalls.size}`,
                      true
                    );
                  }
                }
              } else if (event.type === "response.function_call_arguments.done") {
                // #1039: the event that carries the COMPLETE argument string —
                // this parser had no branch for it at all, so a provider that
                // streams nothing but this event delivered empty tool inputs.
                const fnCall = resolveFunctionCall({
                  callId: event.call_id,
                  itemId: event.item_id,
                  outputIndex: event.output_index,
                });
                const full = typeof event.arguments === "string" ? event.arguments : "";
                if (fnCall && full && !fnCall.arguments && !closedFunctionBlocks.has(fnCall.index)) {
                  fnCall.arguments = full;
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: fnCall.index,
                    delta: { type: "input_json_delta", partial_json: full },
                  });
                } else if (fnCall && full && fnCall.arguments && fnCall.arguments !== full) {
                  // Deltas are already client-visible and disagree with the
                  // terminal string; what the client holds is the stream.
                  log(
                    `[ResponsesSSE] ARG-DONE-MISMATCH model=${opts.modelName} reqN=${reqN} index=${fnCall.index} streamed=${fnCall.arguments.length}B done=${full.length}B`,
                    true
                  );
                }
              } else if (event.type === "response.output_item.done") {
                if (event.item?.type === "function_call") {
                  const fnCall = resolveFunctionCall({
                    callId: event.item.call_id,
                    itemId: event.item.id,
                    outputIndex: event.output_index ?? event.item.output_index,
                  });
                  if (fnCall && !closedFunctionBlocks.has(fnCall.index)) {
                    // #1039: the completed item carries the authoritative
                    // argument string, and main never read it. Emit what the
                    // client is owed BEFORE the stop — once the block is
                    // closed, a delta is not legal.
                    const itemArgs =
                      typeof event.item.arguments === "string" ? event.item.arguments : "";
                    if (!fnCall.arguments && itemArgs) {
                      fnCall.arguments = itemArgs;
                      send("content_block_delta", {
                        type: "content_block_delta",
                        index: fnCall.index,
                        delta: { type: "input_json_delta", partial_json: itemArgs },
                      });
                    }
                    send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                    closedFunctionBlocks.add(fnCall.index);
                  }
                }
              } else if (event.type === "response.incomplete") {
                const reason = event.reason || "unknown";
                incompleteReason = reason;
                log(
                  `[ResponsesSSE] INCOMPLETE model=${opts.modelName} reqN=${reqN} reason=${reason}`,
                  true
                );
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || inputTokens;
                  outputTokens = event.response.usage.output_tokens || outputTokens;
                  cacheReadTokens = readCacheReadTokens(event.response.usage, inputTokens);
                }
              } else if (event.type === "response.completed" || event.type === "response.done") {
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || 0;
                  outputTokens = event.response.usage.output_tokens || 0;
                  cacheReadTokens = readCacheReadTokens(event.response.usage, inputTokens);
                } else if (event.usage) {
                  inputTokens = event.usage.input_tokens || 0;
                  outputTokens = event.usage.output_tokens || 0;
                  cacheReadTokens = readCacheReadTokens(event.usage, inputTokens);
                }
                completed = true;
                // #1039: the response object carries the terminal output array —
                // the last place a function call's arguments can live. Main never
                // read it, so a provider that delivers arguments only here closed
                // every block empty. Fill what is still empty, then close every
                // block still open: `response.completed` is the terminal event,
                // and a started block must stop before message_stop.
                const completedOutput = event.response?.output ?? event.output;
                if (Array.isArray(completedOutput)) {
                  for (const item of completedOutput) {
                    if (item?.type !== "function_call") continue;
                    const fnCall = resolveFunctionCall({
                      callId: item.call_id,
                      itemId: item.id,
                      outputIndex: item.output_index,
                    });
                    if (!fnCall) continue;
                    const itemArgs = typeof item.arguments === "string" ? item.arguments : "";
                    if (!fnCall.arguments && itemArgs) {
                      if (closedFunctionBlocks.has(fnCall.index)) {
                        // Fourth shape: the block was already closed empty by a
                        // done item that carried no arguments. Nothing legal can
                        // re-open it — name it so the shape is visible.
                        log(
                          `[ResponsesSSE] ARG-LATE-COMPLETED model=${opts.modelName} reqN=${reqN} index=${fnCall.index} args=${itemArgs.length}B dropped-after-stop`,
                          true
                        );
                      } else {
                        fnCall.arguments = itemArgs;
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: fnCall.index,
                          delta: { type: "input_json_delta", partial_json: itemArgs },
                        });
                      }
                    }
                  }
                }
                closeOpenBlocks();
                // No [resp] marker here. The marker is emitted once, at CLOSE, by
                // the response capture: emitting one here as well would double
                // every count in traffic-live.ps1 ($responses matches /\[resp\]/),
                // and this site cannot report a hang — it only runs on success.
              } else if (event.type === "error" || event.type === "response.failed") {
                const err = event.error || event.response?.error || {};
                const errMsg = err.message || event.message || "Unknown API error";
                const errCode = err.code || event.code || "";
                log(
                  `[ResponsesSSE] API error model=${opts.modelName} reqN=${reqN} code=${errCode} msg=${errMsg}`,
                  true
                );

                // Transient upstream failure with nothing client-visible yet:
                // retry transparently. OpenAI server_error arrives 1-54s AFTER
                // the first event (measured 2026-09-02) — far outside the peek
                // window — and every surfaced one kills the agent turn, forcing
                // a manual relaunch that re-uploads the full ~100-190k-token
                // context. Safe ONLY while zero content blocks were emitted
                // (nextBlockIndex === 0, no open text block, no tool calls):
                // past that, a retry would duplicate client-visible content.
                const retryBackoff =
                  errCode === "server_is_overloaded" || errCode === "overloaded_error"
                    ? OVERLOAD_RETRY_BACKOFF_MS
                    : FAST_RETRY_BACKOFF_MS;

                // Policy-class refusal counting marker (#65 AC2): one line per
                // detected refusal, before the retry decision — retries surface
                // here too, so the count reflects upstream flags, not outcomes.
                if (isPolicyRefusal(errCode, errMsg)) {
                  const willRetry =
                    !!opts.retryUpstream &&
                    retryAttempts < retryBackoff.length &&
                    nextBlockIndex === 0 &&
                    textBlockIndex === null &&
                    functionCalls.size === 0;
                  logPolicyRefusal({
                    lane: "responses",
                    model: opts.modelName,
                    provider: opts.providerName,
                    attempt: retryAttempts + 1,
                    action: willRetry ? "retry" : "surface",
                  });
                }

                if (
                  RETRYABLE_ERROR_CODES.has(errCode) &&
                  (await retryBeforeVisibleContent(errCode, retryBackoff))
                ) {
                  continue readLoop;
                }

                // A context overflow must not be reported as `usage 0+0`: see
                // parseContextOverflow above — a zero wedges the client's
                // auto-compact and the session never recovers on its own.
                //
                // The provider does not always state the counts. OpenAI's
                // "…exceeds the context window of this model" names neither the
                // used count nor the limit (gpt-5.6-sol, 2026-09-11), so
                // extraction yields nothing — and a truthiness-guarded assignment
                // then left the report at its 0 initializer, reproducing the very
                // wedge this branch exists to prevent. The floor bounds the report
                // from below whatever the body does or does not say.
                const overflow = parseContextOverflow(errMsg, errCode);
                if (overflow) {
                  inputTokens = overflowReportedTokens(overflow.used, 0, overflowReportFloor());
                  // `synthetic` marks a count the floor (not the body) produced, so
                  // downstream aggregators of `usage` can exclude it in one grep.
                  const synthetic = inputTokens > (overflow.used ?? 0);
                  overflowInfo = {
                    used: overflow.used ?? null,
                    limit: overflow.limit ?? null,
                    reported: inputTokens,
                    synthetic,
                  };
                  // Deliberately NOT a `[resp]` line: traffic-live.ps1 counts
                  // /\[resp\]/ and this is one response, already counted once by
                  // the capture marker at close. `synthetic=` stays greppable,
                  // which is the contract that field exists for.
                  process.stdout.write(
                    `  [ResponsesSSE] CONTEXT-OVERFLOW model=${opts.modelName} reqN=${reqN} used=${overflow.used ?? "?"} limit=${overflow.limit ?? "?"} reported=${inputTokens} synthetic=${synthetic}
`
                  );
                }

                closeOpenBlocks();

                const errorIdx = nextBlockIndex++;
                send("content_block_start", {
                  type: "content_block_start",
                  index: errorIdx,
                  content_block: { type: "text", text: "" },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: errorIdx,
                  delta: { type: "text_delta", text: `\n\n[API Error: ${errCode} ${errMsg}]` },
                });
                send("content_block_stop", { type: "content_block_stop", index: errorIdx });

                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: finalUsage(),
                });
                send("message_stop", { type: "message_stop" });
                isClosed = true;
                if (pingInterval) {
                  clearInterval(pingInterval);
                  pingInterval = null;
                }
                if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
                cap.done({
                  closed: true,
                  stop_reason: "end_turn",
                  path: "api-error",
                  error: errCode,
                  tools: functionCalls.size,
                  overflow: overflowInfo,
                  usage: finalUsage(),
                });
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

        if (!completed && incompleteReason === null) {
          // Early EOF: OpenAI closed the body WITHOUT a response.completed/done,
          // response.incomplete, or error event. Previously this was silently
          // treated as a normal completion (empty end_turn message) — the
          // "Connection lost mid-response" class the client sees as a killed
          // turn. Inventory it now: success vs. premature end must be visible.
          log(
            `[ResponsesSSE] EOF-WITHOUT-COMPLETION model=${opts.modelName} reqN=${reqN} events=${dataEvents} bytes=${totalBytes} input=${inputTokens} output=${outputTokens} text=${hasTextContent} tools=${hasToolUse}`,
            true
          );
        }

        if (textBlockIndex !== null) {
          send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = null;
        }

        const stopReason = hasToolUse ? "tool_use" : "end_turn";
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: finalUsage(),
        });
        send("message_stop", { type: "message_stop" });

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        cap.done({
          closed: true,
          stop_reason: stopReason,
          path: "normal",
          tools: functionCalls.size,
          usage: finalUsage(),
        });
        controller.close();
      } catch (error) {
        finishInterruptedStream(error);
      }
    },
    // Client disconnected before the stream ended: no terminal event was sent, so
    // this is the one path that legitimately reports closed=false. The capture is
    // closed out anyway — a cancelled Sol/Codex stream belongs in the corpus, not
    // missing from it — and the ping interval is cleared here, which it was not
    // before (it kept firing for the life of the process).
    cancel() {
      cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
      isClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
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
