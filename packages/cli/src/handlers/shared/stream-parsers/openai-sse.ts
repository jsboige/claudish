/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Converts OpenAI-compatible Server-Sent Events to Claude SSE format.
 * Used by ComposedHandler to translate streaming responses from
 * OpenAI-compatible providers (OpenRouter, LiteLLM, local models, etc.)
 * into the format Claude Code expects.
 */

import type { Context } from "hono";
// Capture pipeline (#641 blocker-2 port): resp-*.sse tap + [ttft]/[resp]
// stdout markers, correlated by the request number frozen at ingestion.
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import type { RawStreamTap } from "../../../hooks/raw.js";
import { log } from "../../../logger.js";
import { redactForClient } from "../../../redact.js";
import { createResponseCapture } from "../response-capture.js";
import {
  type ToolSchema,
  extractToolCallsFromText,
  hasExtractableFunctionTag,
  validateAndRepairToolCall,
} from "../tool-call-recovery.js";
import { ttftMarkerLine } from "../traffic-markers.js";
import { isWebSearchToolCall } from "../web-search-detector.js";
import { executeWebSearch, extractSearchQuery } from "../web-search-executor.js";
import { type BlockRef, createBlockWriter } from "./block-writer.js";
import { messageStartUsage } from "./message-start-usage.js";
import { sseDataPayload } from "./sse-line.js";
import { type ThinkSplit, createThinkTagSplitter } from "./think-tag-splitter.js";
import { type UpstreamReaderSlot, cancelEndsUpstreamWork } from "./upstream-cancel.js";
import { splitPromptTokens } from "./usage-cache-split.js";

/**
 * Hard ceiling, in characters, on ONE logged raw SSE payload.
 *
 * The debug log is the source of record for test fixtures — `extract-sse-from-log.ts`
 * reads these very lines back and writes them out as `.sse` replay files — so the
 * payload has to reach the log VERBATIM. A payload cut mid-JSON yields a fixture that
 * `JSON.parse` rejects, and the parser's `catch` swallows that, so the corruption only
 * ever surfaces as a wrong `stop_reason` several layers away. That is exactly what the
 * previous 300-character cap did to `grok-4.6-openai-advisor-turn1.sse`.
 *
 * 1M characters is a backstop against a pathological provider, not a content limit: a
 * normal chunk is a few hundred bytes, and even a whole tool call with inlined arguments
 * is orders of magnitude under it. Nothing that fits in a real turn can be cut by it.
 */
export const SSE_LOG_MAX_CHARS = 1_000_000;

/**
 * Appended when — and only when — a payload exceeded {@link SSE_LOG_MAX_CHARS}.
 *
 * A cut payload is never left looking whole. This marker is not valid JSON and not
 * plausible content, so both a human reading the log and `extract-sse-from-log.ts`
 * can tell an incomplete line from a complete one.
 */
export const SSE_LOG_TRUNCATION_MARKER = "<<<CLAUDISH_SSE_TRUNCATED>>>";

/**
 * Render a raw SSE `data:` payload for the debug log: verbatim, unless it is
 * absurdly large, in which case it is cut and unmistakably flagged as cut.
 */
export function formatRawSseLogPayload(dataStr: string): string {
  if (dataStr.length <= SSE_LOG_MAX_CHARS) return dataStr;
  return `${dataStr.substring(0, SSE_LOG_MAX_CHARS)} ${SSE_LOG_TRUNCATION_MARKER} original_chars=${dataStr.length}`;
}

export interface StreamingState {
  usage: any;
  finalized: boolean;
  /**
   * Which content block is open, and every block index allocated this turn, are
   * owned by the {@link BlockWriter} — not by this state object. The five fields
   * that used to live here (`textStarted`, `textIdx`, `reasoningStarted`,
   * `reasoningIdx`, `curIdx`) were a second source of truth for the same thing
   * and were maintained by hand at 27 emit sites.
   */
  tools: Map<number, ToolState>;
  /**
   * Argument fragments that arrived for a `tool_calls` index BEFORE its
   * `function.name` did, keyed by that index.
   *
   * OpenAI's own streams put the name in the first fragment for an index, so
   * this map is empty on every capture in the tree. Providers that do not — and
   * they exist — used to have the head of their JSON object silently dropped by
   * an `&& t` guard, leaving arguments that begin mid-object and cannot parse.
   * A dropped head is indistinguishable downstream from a model that emitted
   * bad JSON.
   *
   * Drained into `ToolState.arguments` the moment the tool is created.
   */
  pendingToolArgs: Map<number, string>;
  /**
   * `function.name` fragments per `tool_calls` index, accumulated.
   *
   * A provider may split the name across chunks. The name is read from here
   * rather than from `tc.function.name` so that there is ONE place where a
   * complete name exists — which is where the truncated→original decode belongs
   * (decoding a fragment yields a miss, and the allowlist gate then drops the
   * call with no error).
   */
  pendingToolName: Map<number, string>;
  toolIds: Set<string>;
  lastActivity: number;
  accumulatedText: string; // Accumulated text for potential tool call extraction
  /**
   * Upstream `finish_reason` from the last chunk that carried one. Needed at
   * finalize() so a turn the provider CUT OFF is not reported as a turn the
   * model chose to end — see the stop_reason mapping in finalize().
   */
  finishReason: string | null;
}

/**
 * Whether the direct-HTTP SearXNG backend is configured at all. Read once at
 * module load, like the executor's per-call `searxngConfig()` reads its env —
 * a late container env injection changes the next process, not this one.
 */
const SEARXNG_AVAILABLE = !!process.env.SEARXNG_URL;

/**
 * Whether the client declared a WebSearch tool in this request.
 * When it did, provider-side web search calls (web_search tool calls, GLM
 * <searchWeb> tags) are remapped to a synthetic WebSearch tool_use with
 * stop_reason "tool_use" — the client then runs its own WebSearch, gets the
 * results as a tool_result, and the agentic loop continues.
 */
function clientDeclaresWebSearch(toolSchemas?: any[]): boolean {
  return !!toolSchemas?.some((s) => s?.name === "WebSearch");
}

/**
 * Whether the client declared a tool under this EXACT name (lane 1 of the
 * three-way disposition). A provider web-tool call the client declared
 * verbatim (`web_search`, `brave_web_search`, …) is the client's OWN tool:
 * the client can execute it itself, so the call forwards like any declared
 * tool instead of being intercepted. Interception (remap or
 * suppress-and-inject) only applies when the exact name is NOT declared —
 * measured 15/10 on Hermes (ai-01): its declared `web_search` tool was
 * suppressed, results injected as text with end_turn, and the run dumped
 * raw search results instead of continuing its loop.
 */
function clientDeclaresToolExactly(name: string, toolSchemas?: any[]): boolean {
  return !!toolSchemas?.some((s) => s?.name === name);
}

export interface ToolState {
  id: string;
  name: string;
  blockIndex: number;
  started: boolean; // Whether content_block_start has been sent
  closed: boolean;
  arguments: string; // Accumulated JSON arguments string
  buffered: boolean; // Whether we're buffering args until tool call completes
  /**
   * Web-search disposition (three-way): suppressed calls never emit a tool
   * block — their SearXNG results are injected as a text block instead; they
   * hold no client index (blockIndex -1). remapped calls are re-emitted as
   * the client's WebSearch tool_use.
   */
  suppressed: boolean;
  remapped: boolean;
  /**
   * The block this tool is currently streaming into, or null when it has none
   * (buffered and not yet flushed, or its block was superseded — see the
   * interleave degradation in the `tool_calls` delta handler).
   */
  ref: BlockRef | null;
}

/**
 * Render an error carried INSIDE a 200 stream into one readable line.
 *
 * ## Why this exists
 *
 * OpenRouter answers HTTP 200 and then reports the upstream's refusal as a
 * frame in the body:
 *
 *   data: {"id":"…","model":"unknown","provider":"Google AI Studio",
 *          "choices":[],"error":{"code":400,"message":"…",
 *          "metadata":{"error_type":"invalid_request","provider_code":"400"}}}
 *
 * The frame has an EMPTY `choices` array, so every field the parser reads
 * (`choices[0].delta`, `choices[0].finish_reason`) is undefined and the frame
 * matched nothing at all. It was dropped without a log line, the stream ended
 * with no content and no `finish_reason`, and the turn looked like a model that
 * simply had nothing to say. Measured 2026-09-16: a 105-second session ended
 * `exit 0` with zero bytes of output twice in a row, after billing the tokens
 * its earlier successful turns had spent.
 *
 * Claudish already learned this lesson twice on other wires —
 * `stream-head-sniffer.ts` for the Codex Responses backend and
 * `devin-stream-head-sniffer.ts` for Devin, both of which open by noting that
 * "every retry hook in claudish keys off the HTTP status". The OpenAI-shaped
 * wire, which is the most used one, never got the same treatment.
 *
 * Returns undefined when the frame carries no error, so the caller can test the
 * result directly rather than duplicating the shape-sniffing.
 */
export function describeInStreamError(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const error = (chunk as { error?: unknown }).error;
  if (!error) return undefined;

  // Some gateways send a bare string; most send an object.
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const e = error as Record<string, unknown>;
  const metadata = (e.metadata ?? {}) as Record<string, unknown>;

  const parts: string[] = [];
  // The vendor that actually refused, when the aggregator names it. Without
  // this the message reads as though the aggregator itself rejected the call.
  const provider = (chunk as { provider?: unknown }).provider;
  if (typeof provider === "string" && provider) parts.push(`[${provider}]`);

  const code = e.code ?? metadata.provider_code;
  const type = e.type ?? metadata.error_type;
  const label = [code, type].filter((v) => v !== undefined && v !== null && v !== "").join(" ");
  if (label) parts.push(label);

  const message = e.message ?? metadata.raw;
  parts.push(
    typeof message === "string" && message.trim() ? message : JSON.stringify(error).slice(0, 500)
  );

  return parts.join(" ");
}

/**
 * Validate tool call arguments against the tool schema
 * Now includes automatic repair of missing parameters
 */
export function validateToolArguments(
  toolName: string,
  argsStr: string,
  toolSchemas: any[],
  textContent?: string
): {
  valid: boolean;
  missingParams: string[];
  parsedArgs: any;
  repaired: boolean;
  repairedArgs?: any;
} {
  const result = validateAndRepairToolCall(
    toolName,
    argsStr,
    toolSchemas as ToolSchema[],
    textContent
  );

  if (result.repaired) {
    log(`[ToolValidation] Repaired tool call ${toolName} - inferred missing parameters`);
  }

  return {
    valid: result.valid,
    missingParams: result.missingParams,
    parsedArgs: result.args,
    repaired: result.repaired,
    repairedArgs: result.repaired ? result.args : undefined,
  };
}

/**
 * Create initial streaming state
 */
export function createStreamingState(): StreamingState {
  return {
    usage: null,
    finalized: false,
    tools: new Map(),
    pendingToolArgs: new Map(),
    pendingToolName: new Map(),
    toolIds: new Set(),
    lastActivity: Date.now(),
    accumulatedText: "",
    finishReason: null,
  };
}

/**
 * Handle streaming response conversion from OpenAI SSE to Claude SSE format
 */
export function createStreamingResponseHandler(
  c: Context,
  response: Response,
  adapter: any,
  target: string,
  /**
   * The raw-tier tap (`providerChunk` / `providerStreamEnd`), when a raw hook
   * applies to this route. `chunk()` returns the object to read from then on.
   */
  raw: RawStreamTap | null | undefined,
  /**
   * `input` is ALWAYS `prompt_tokens` — the full context size. The cached
   * breakdown rides in the third argument and is for COST ONLY; handing the
   * reduced wire figure to the tracker would report a nearly-full conversation
   * as almost empty and disarm auto-compaction (`context-window.md`).
   */
  onTokenUpdate?: (
    input: number,
    output: number,
    detail?: { cacheReadTokens: number; cacheCreationTokens: number }
  ) => void,
  toolSchemas?: any[], // Tool schemas for validation
  toolNameMap?: Map<string, string>, // Truncated → original tool name mapping
  priorInputTokens?: number, // Last request's context size — seeds message_start.usage
  /**
   * Observation callbacks, grouped into one object rather than another
   * positional parameter — this signature already carries nine.
   * `onToolCallObserved` feeds the token tracker's tool count. Tool-argument
   * interception is not this parser's job: it happens at the hook response
   * seam, above every parser.
   */
  observers?: {
    onToolCallObserved?: (name: string) => void;
  },
  /**
   * Dispatch → upstream-response-headers latency, threaded from
   * ComposedHandler when it measures one (for the [ttft] marker). Absent =
   * not measured: the marker then prints `headers=-1ms total=-1ms`, the
   * documented "no measurement" shape — never a bogus sum.
   */
  headerLatencyMs?: number
): Response {
  log(`[Streaming] ===== HANDLER STARTED for ${target} =====`);
  let isClosed = false;
  // Set by `cancel()` only: the client went away. `isClosed` alone cannot say
  // that, because teardown sets it on every normal end too.
  let cancelled = false;
  let ping: NodeJS.Timeout | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const upstream: UpstreamReaderSlot = {};

  // Capture pipeline (#641 blocker-2 port) — TTFT anchor and response capture.
  // Headers are in the moment this handler is built; the first upstream `data:`
  // line closes the measurement. reqN is resolved from the request object
  // (assigned at ingestion by logRequest): reading the global counter here
  // returns whichever request is CURRENT while this one waited for headers —
  // under concurrency handlers cross-label.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  const cap = createResponseCapture("openai", target, true, reqN);
  // The stop_reason of the terminal message_delta the client actually received
  // (#220). Every ending path emits it through `send`, so recording it there
  // keeps the [resp] marker in step with the stream instead of logging `stop=?`
  // on every response. Stays undefined when no message_delta went out, and the
  // marker then falls back to `?`: "the stream ended without one".
  let sentStopReason: string | undefined;
  let ttftLogged = false;

  return c.body(
    new ReadableStream(
      cancelEndsUpstreamWork<Uint8Array>(upstream, {
        async start(controller) {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              // Observe every tool call HERE, at the single frame writer, rather than at
              // the `content_block_start` sites. (Those now all run through
              // `block-writer.ts`, which is itself a single site — but this hook stays
              // here, one layer lower, because it must also see anything a future path
              // emits without going through the writer.)
              //
              // This parser declared `onToolCallObserved` and never called it — so on the
              // busiest wire in claudish (GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter,
              // LiteLLM) the session summary would have reported zero tools. Hooking the writer instead
              // of the emission sites makes that class of omission impossible: a new
              // tool_use path cannot forget to opt in, and because exactly one
              // `content_block_start` is emitted per tool call, it cannot double count
              // either. The `input_json_delta` frames deliberately do not match.
              if (e === "content_block_start" && d?.content_block?.type === "tool_use") {
                try {
                  observers?.onToolCallObserved?.(String(d.content_block.name ?? ""));
                } catch (err) {
                  log(`[Streaming] onToolCallObserved threw: ${err}`);
                }
              }
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
              // After the enqueue: a throw (controller closed under us) means the
              // client never got this value, so it must not be reported.
              if (e === "message_delta" && d?.delta?.stop_reason) {
                sentStopReason = d.delta.stop_reason;
              }
            }
          };

          // Capture pipeline (#641 blocker-2 port): mirror every outgoing byte
          // into the response capture — no-op unless CLAUDISH_CAPTURE_DIR is
          // set. Overriding enqueue makes the tap exhaustive across every emit
          // site (send, block-writer, [DONE] tail, error surfaces).
          const _origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = ((chunk: any) => {
            cap.tap(chunk);
            return _origEnqueue(chunk);
          }) as any;

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const state = createStreamingState();
          // Every content block for this turn is opened, appended to and closed
          // through here. It owns the block-index counter, so nothing else
          // allocates an index.
          const writer = createBlockWriter(send);
          const thinkSplitter = createThinkTagSplitter();

          /**
           * Route one splitter result to its blocks.
           *
           * Shared by the streaming path and by `finalize()`'s flush, so a fragment
           * released at the end of the turn takes exactly the same hold-back
           * decision as one released mid-stream — rather than bypassing it and
           * emitting a lone fragment of text that the hold-back is withholding the
           * rest of.
           */
          const emitSplitContent = ({ thinking, text }: ThinkSplit): void => {
            if (thinking) {
              writer.append(writer.openThinking(), thinking);
            }
            if (!text) return;

            // Accumulate text for potential tool call extraction
            state.accumulatedText += text;

            // Check if text contains STRUCTURED tool call patterns that we should hold back
            // Only hold back for patterns we can actually parse (XML, JSON), not natural language
            // Natural language patterns are extracted at finalization, not held back
            const hasStructuredToolPattern =
              // Qwen XML-style: <function=ToolName>. Same shape the
              // extractor accepts, so text held back here is always text
              // the extractor can act on. A looser test here withheld
              // text that nothing later emitted.
              hasExtractableFunctionTag(state.accumulatedText) ||
              // JSON tool call in text: {"name": "Task", "arguments":
              /\{\s*"(?:name|tool)"\s*:\s*"(?:Task|Read|Write|Edit|Bash|Grep|Glob)"/i.test(
                state.accumulatedText
              ) ||
              // XML tool_call tags: <tool_call>
              /<tool_call>/.test(state.accumulatedText);

            // Only hold back if we have a structured pattern AND haven't accumulated too much
            // (if we've accumulated > 1000 chars without a complete pattern, release the text)
            const shouldHoldBack = hasStructuredToolPattern && state.accumulatedText.length < 1000;

            if (shouldHoldBack) {
              log(
                `[Streaming] Text held back (structured tool pattern): ${state.accumulatedText.length} chars accumulated`
              );
              return;
            }

            writer.append(writer.openText(), text);
          };

          // Emit a synthetic WebSearch tool_use block. Used to remap provider
          // web search calls (web_search tool calls, GLM <searchWeb> tags) to
          // the client's own WebSearch tool so the agentic loop continues
          // (stop_reason "tool_use") instead of ending the turn on raw results.
          const emitWebSearchToolUse = (query: string, t?: ToolState) => {
            // -1 = suppressed at creation, holds no client index (review #485):
            // it is not nullish, so without this guard a -1 reaching the remap
            // path would emit content_block_start index:-1. Unreachable today
            // (a suppressed call never reaches the remap), but the sentinel
            // gets its guard at its one consumer.
            const blockIndex = t && t.blockIndex >= 0 ? t.blockIndex : writer.reserve();
            const id = t?.id ?? `tool_websearch_${Date.now()}_${blockIndex}`;
            const ref = writer.openTool({ id, name: "WebSearch", index: blockIndex });
            writer.append(ref, JSON.stringify({ query }));
            writer.close(ref);
            if (t) {
              t.ref = ref;
              t.started = true;
              t.closed = true;
            } else {
              // Register so hasStructuredTools counts it → stop_reason "tool_use".
              // Negative key avoids collisions with provider tool_call indices.
              state.tools.set(-(blockIndex + 1), {
                id,
                name: "WebSearch",
                blockIndex,
                started: true,
                closed: true,
                suppressed: false,
                remapped: true,
                arguments: JSON.stringify({ query }),
                buffered: false,
                ref,
              });
            }
            log(`[Stream] Remapped provider web search → WebSearch tool_use (query="${query}")`);
          };

          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: target,
              stop_reason: null,
              stop_sequence: null,
              usage: messageStartUsage(priorInputTokens),
            },
          });
          send("ping", { type: "ping" });

          ping = setInterval(() => {
            if (!isClosed && Date.now() - state.lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          // Teardown is separated from finalize() on purpose. finalize() guards
          // re-entry on state.finalized, so once it has started, a throw part-way
          // through used to mean the stream was never closed and the ping interval
          // was never cleared: the outer catch re-called finalize(), which returned
          // immediately at the guard. The client then sat on an open HTTP 200
          // forever. Teardown therefore runs from a `finally`, and stays safe to
          // call twice.
          const teardown = () => {
            if (!isClosed) {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
              } catch {}
              try {
                controller.close();
              } catch {}
              isClosed = true;
            }
            if (ping) {
              clearInterval(ping);
              ping = null;
            }
          };

          /** Report the usage the provider sent. Only called when `state.usage` is set. */
          const reportProviderUsage = () => {
            if (!onTokenUpdate || !state.usage) return;
            log(
              `[Streaming] Final usage: prompt=${state.usage.prompt_tokens || 0}, completion=${state.usage.completion_tokens || 0}`
            );
            // FIRST ARGUMENT STAYS `prompt_tokens`: the tracker's input number
            // is the context-occupancy figure the status line renders and the
            // billing baseline the delta strategy compares against. The split
            // goes in the third argument, where only the cost arithmetic sees
            // it.
            const costSplit = splitPromptTokens(state.usage);
            onTokenUpdate(state.usage.prompt_tokens || 0, state.usage.completion_tokens || 0, {
              cacheReadTokens: costSplit.cacheReadTokens,
              cacheCreationTokens: costSplit.cacheCreationTokens,
            });
          };

          const finalize = async (reason: string, err?: string) => {
            // A second call still has to tear down: the first may have thrown
            // before reaching its own `finally`.
            if (state.finalized) {
              teardown();
              return;
            }
            state.finalized = true;

            // The client cancelled: the upstream reader was cancelled under the
            // loop, so its read resolved `done` (or threw) without the provider
            // having ended anything. Not a truncation and not a failure, and the
            // user abandoned the turn, so no ending classification, no estimate,
            // no turn-end hook. Usage is recorded only when the provider sent it.
            if (cancelled) {
              try {
                log(
                  `[Streaming] Client cancelled the stream for ${target} (loop ended: ${reason}); usage ${state.usage ? "reported" : "not received, not recorded"}`
                );
                reportProviderUsage();
              } finally {
                teardown();
              }
              // Capture pipeline (#641 blocker-2 port): client abort —
              // `closed=false` is how a cancel reads in the [resp] marker.
              cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
              return;
            }

            try {
              // Release anything the think-tag splitter is still holding — at most
              // seven characters of a tag that never completed. Runs FIRST, before
              // text-based tool-call recovery reads `accumulatedText`, so a held
              // fragment is part of the text recovery scans rather than arriving
              // after it.
              emitSplitContent(thinkSplitter.flush());

              // Argument fragments whose `function.name` never arrived. A call with
              // no name is not a call — there is nothing to dispatch and no schema to
              // validate against — so they are discarded. Named in the log because
              // silently dropping them is precisely the defect this buffer fixes, and
              // a buffer that survives to here means the provider is doing something
              // the accumulator did not anticipate. "error" puts it in the always-on
              // structural log.
              for (const [idx, pending] of state.pendingToolArgs) {
                log(
                  `[Streaming] Tool argument error: discarding ${pending.length} buffered chars for tool_calls index ${idx} — function.name never arrived`
                );
              }
              state.pendingToolArgs.clear();

              // Debug: Log accumulated text for analysis
              if (state.accumulatedText.length > 0) {
                const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
                log(
                  `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
                );
              }

              // Check for text-based web search tags (GLM emits <searchWeb><query>...</query></searchWeb>)
              // These must be intercepted before text-based tool call extraction, since we want to
              // execute SearXNG and replace the search tags with results, not pass them through.
              // A tag has no called name, so lane 1 (exact-name forward) has no subject here —
              // tags keep lanes 2/3 only.
              let searchWebResults: string | null = null;
              let pendingSearchRemap: string | null = null;
              const searchWebMatch = state.accumulatedText.match(
                /<searchWeb>\s*<query>([\s\S]*?)<\/query>\s*<\/searchWeb>/i
              );
              if (searchWebMatch) {
                const searchQuery = searchWebMatch[1].trim();
                if (searchQuery && clientDeclaresWebSearch(toolSchemas)) {
                  // Remap to the client's WebSearch tool — emitted as a tool_use
                  // block after the text blocks close, keeping the agent loop alive.
                  log(
                    `[Stream] GLM searchWeb detected: "${searchQuery}" — remapping to client WebSearch tool_use`
                  );
                  pendingSearchRemap = searchQuery;
                } else {
                  log(
                    `[Stream] GLM searchWeb detected: "${searchQuery}" — intercepting via SearXNG`
                  );
                  if (searchQuery && SEARXNG_AVAILABLE) {
                    searchWebResults = await executeWebSearch(searchQuery);
                  } else {
                    searchWebResults = searchQuery
                      ? `[Web search for "${searchQuery}" could not be executed. SearXNG is not configured.]`
                      : "[Web search was requested but no query was provided.]";
                  }
                }
                // Remove the search tags from accumulated text so they don't appear in output
                state.accumulatedText = state.accumulatedText
                  .replace(/<searchWeb>[\s\S]*?<\/searchWeb>/i, "")
                  .trim();
              }

              // Check for text-based tool calls before finalizing
              // Some models (like Qwen) output tool calls as text instead of structured tool_calls
              //
              // Only when the model produced NO structured call. Recovery exists for
              // models that cannot emit `tool_calls` at all; against a model that
              // just did, it can only ADD calls, never repair one. Ungated, a turn
              // holding one real call plus prose mentioning a function tag dispatched
              // two tool_use blocks, and both were recorded.
              const textToolCalls =
                state.tools.size > 0
                  ? []
                  : extractToolCallsFromText(
                      state.accumulatedText,
                      toolSchemas?.map((t: any) => t?.name).filter((n: any): n is string => !!n),
                      // The `<function=NAME><parameter=P>` envelope carries no
                      // types, so every value arrives as a string. The schemas are
                      // what turn `"5"` back into 5 and `"true"` into true.
                      toolSchemas as ToolSchema[] | undefined,
                      // Recovery reads the name the MODEL wrote, which is the
                      // encoded one. The allowlist is built from the client's
                      // originals, so an undecoded name is dropped in silence.
                      toolNameMap ? (name: string) => toolNameMap.get(name) ?? name : undefined
                    );
              if (state.tools.size > 0 && state.accumulatedText.length > 0) {
                log(
                  `[Streaming] Skipping text-based tool extraction: ${state.tools.size} structured tool call(s) already present`
                );
              }
              log(`[Streaming] Text-based tool calls found: ${textToolCalls.length}`);

              // ── How this turn ENDED ────────────────────────────────────────────
              //
              // Classified HERE — after recovery has run but BEFORE anything it
              // found is emitted — because recovery adds both content and tools, and
              // a classification taken before it runs would read a pre-recovery
              // state. Local models, the population text recovery exists for, are
              // exactly the ones most likely to end with no finish_reason.
              //
              // `finish_reason` is the ONLY completion signal. Neither the `[DONE]`
              // sentinel nor a final usage object counts: both are transport
              // punctuation that a proxy, a load balancer or a truncated body can
              // produce without the model ever having finished.
              const producedContent =
                state.accumulatedText.length > 0 ||
                writer.anyBlockEmitted ||
                state.tools.size > 0 ||
                textToolCalls.length > 0;
              const toolInFlight =
                // Already on the wire, including text-recovered calls from earlier
                // turns of this same finalize — `state.tools` does not cover those.
                writer.emittedToolRefs.length > 0 ||
                // `&& !t.closed` is load-bearing: `buffered && !started` is TRUE for
                // a tool that already failed validation and was closed.
                Array.from(state.tools.values()).some(
                  (t) => !t.closed && (t.started || t.buffered)
                ) ||
                textToolCalls.length > 0;

              /**
               * `success`  — the provider said how it finished, or produced nothing.
               * `silent-truncation` — no finish_reason, content, but no tool: the
               *   partial prose is harmless and VISIBLE, and `max_tokens` is
               *   Anthropic's own "the turn was cut off" label. An `error` here would
               *   discard text the user can read.
               * `failure` — the turn cannot be presented as complete. Ends with an
               *   SSE `error` event, which Claude Code honours by discarding a
               *   partial `tool_use` and retrying (verified against a real client,
               *   reports/truncated-toolcall-live-verification.md).
               */
              const ending: "success" | "silent-truncation" | "failure" =
                reason === "error"
                  ? "failure"
                  : state.finishReason !== null || !producedContent
                    ? "success"
                    : toolInFlight
                      ? "failure"
                      : "silent-truncation";

              if (ending !== "success") {
                log(
                  `[Streaming] Stream ending error: reason=${reason} finish_reason=${state.finishReason ?? "null"} content=${producedContent} tool_in_flight=${toolInFlight} → ${ending}`
                );
              }

              // On a failure ending claudish emits NO NEW tool block and NO completed
              // tool call: the buffered flush below is skipped and recovered calls are
              // suppressed. It cannot recall a non-buffered tool block already on the
              // wire — `content_block_start` went out before a single argument byte
              // existed — but that partial is exactly the case the client-side
              // measurement covers.
              const emitToolCalls = ending !== "failure";

              if (textToolCalls.length > 0 && !emitToolCalls) {
                log(
                  `[Streaming] Suppressing ${textToolCalls.length} text-recovered tool call(s): the turn ended in failure`
                );
              } else if (textToolCalls.length > 0) {
                log(
                  `[Streaming] Found ${textToolCalls.length} text-based tool call(s), converting to structured format`
                );

                // Send each extracted tool call as a proper tool_use block.
                // `openTool` closes whatever is open first, which is where the
                // hand-written "close any open text block" used to live.
                for (const tc of textToolCalls) {
                  const toolIdx = writer.reserve();
                  const toolId = `tool_${Date.now()}_${toolIdx}`;
                  const ref = writer.openTool({ id: toolId, name: tc.name, index: toolIdx });
                  writer.append(ref, JSON.stringify(tc.arguments));
                  writer.close(ref);
                }
              }

              // GLM <searchWeb> remapped to the client's WebSearch tool —
              // emitted as a tool_use block so stop_reason becomes "tool_use".
              // Suppressed on a failure ending: no NEW tool block leaves a failed
              // turn.
              if (pendingSearchRemap && ending !== "failure") {
                emitWebSearchToolUse(pendingSearchRemap);
              }

              // Inject SearXNG results if we intercepted GLM <searchWeb> tags.
              // Sent as a separate text block after the (now-cleaned) model output.
              if (searchWebResults) {
                const ref = writer.openText();
                writer.append(ref, searchWebResults);
                writer.close(ref);
              }

              // Suppressed web-search tool calls on a NON-tool_calls ending (the
              // model asked to search but finished with "stop"): the finish_reason
              // spend path never ran, so the search would be silently dropped AND
              // its reserved index would leak a hole (Hermes IndexError, 15/10).
              // Same injection, same wording as the tool_calls path.
              for (const t of Array.from(state.tools.values())) {
                if (t.suppressed && !t.closed) {
                  const query = extractSearchQuery(t.arguments);
                  let resultText: string;
                  if (query && SEARXNG_AVAILABLE) {
                    resultText = await executeWebSearch(query);
                  } else {
                    resultText = query
                      ? `[Web search for "${query}" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
                      : "[Web search was requested but no query was provided.]";
                  }
                  const ref =
                    t.blockIndex >= 0
                      ? writer.openText({ index: t.blockIndex })
                      : writer.openText();
                  writer.append(ref, resultText);
                  writer.close(ref);
                  t.closed = true;
                }
              }

              // Whatever is still open — thinking, text, or a tool — closes here.
              // This replaces the hand-written reasoning-then-text pair, which could
              // only ever close the two kinds it named.
              writer.closeCurrent();

              // Remapped web search tools that never saw finish_reason="tool_calls"
              // (e.g. the provider ended with "stop") — emit them now so the
              // query isn't silently dropped and stop_reason becomes "tool_use".
              for (const t of Array.from(state.tools.values())) {
                if (t.remapped && !t.closed) {
                  const query = extractSearchQuery(t.arguments);
                  if (query) {
                    emitWebSearchToolUse(query, t);
                  } else {
                    t.closed = true;
                  }
                }
              }

              // Handle buffered-but-unsent structured tool calls.
              // Some models (e.g., Gemini via LiteLLM) send tool calls with finish_reason="stop"
              // instead of "tool_calls", so the normal validation path (line ~695) is never reached.
              // We must send these buffered tools here so Claude Code can execute them.
              //
              // SKIPPED ENTIRELY on a failure ending. Before this gate a failed turn
              // shipped a COMPLETE, parseable tool call and then an `error` event, so
              // the protection rested wholly on the client discarding it. Now only an
              // incomplete partial can reach the client on a failure ending, which is
              // precisely the case the client-side measurement covers.
              for (const t of emitToolCalls ? Array.from(state.tools.values()) : []) {
                if (!t.closed && t.buffered && !t.started) {
                  if (toolSchemas && toolSchemas.length > 0) {
                    const validation = validateToolArguments(
                      t.name,
                      t.arguments,
                      toolSchemas,
                      state.accumulatedText
                    );

                    if (validation.valid || (validation.repaired && validation.repairedArgs)) {
                      const argsJson = JSON.stringify(
                        validation.repaired ? validation.repairedArgs : validation.parsedArgs
                      );
                      log(
                        `[Streaming] Sending buffered tool call (finish_reason!=tool_calls): ${t.name} with args: ${argsJson}`
                      );
                      t.ref = writer.openTool({ id: t.id, name: t.name, index: t.blockIndex });
                      writer.append(t.ref, argsJson);
                      writer.close(t.ref);
                      t.started = true;
                      t.closed = true;
                    } else {
                      log(
                        `[Streaming] Buffered tool call ${t.name} failed validation, skipping: ${validation.missingParams.join(", ")}`
                      );
                      t.closed = true;
                    }
                  } else {
                    // No schemas to validate against — send as-is
                    const argsJson = t.arguments || "{}";
                    log(
                      `[Streaming] Sending buffered tool call (no validation): ${t.name} with args: ${argsJson}`
                    );
                    t.ref = writer.openTool({ id: t.id, name: t.name, index: t.blockIndex });
                    writer.append(t.ref, argsJson);
                    writer.close(t.ref);
                    t.started = true;
                    t.closed = true;
                  }
                }
              }

              // Close any remaining started-but-unclosed tool calls. Under the
              // one-open-block invariant at most one of these is still open; the
              // rest were closed when the block that superseded them opened, and
              // `writer.close` is a no-op for those.
              for (const t of Array.from(state.tools.values())) {
                if (t.started && !t.closed) {
                  if (t.ref) writer.close(t.ref);
                  t.closed = true;
                }
              }

              if (raw) await raw.streamEnd();

              if (ending === "failure") {
                // An SSE `error` event is the ONE ending Claude Code honours by
                // discarding a partial `tool_use` and retrying the turn. `end_turn`
                // means "the turn finished, run the tool" and made the client execute
                // truncated JSON; `max_tokens` was assumed to rescue it and measurably
                // does not (adapters.md, and the 2026-09-10 live verification).
                const message =
                  err ??
                  "Upstream stream ended with no finish_reason while a tool call was in flight. " +
                    "The tool call is incomplete and was not dispatched.";
                send("error", {
                  type: "error",
                  error: { type: "api_error", message: redactForClient(message) },
                });
              } else {
                // Set stop_reason based on whether we sent ANY tool calls (text-based or structured)
                // A suppressed web-search call is not a dispatched tool — its
                // results were injected as text. Only a started, non-suppressed
                // block makes the turn's stop_reason "tool_use".
                const hasStructuredTools = Array.from(state.tools.values()).some(
                  (t) => t.started && !t.suppressed
                );
                // A turn the PROVIDER cut off must not be reported as a turn the model
                // chose to end. Anthropic's contract for a cut-off turn is "max_tokens";
                // reporting "end_turn" presents a truncated (or, when reasoning consumed
                // the whole budget, an EMPTY) answer as the model's complete final word.
                // Mirrors openai-responses-sse.ts, which already does this.
                // `content_filter` is the same class: the provider refused, which is
                // Anthropic's "refusal", not a turn the model chose to end.
                // openai-responses-sse.ts already maps both this way.
                // `length` still OUTRANKS `tool_use` — a truncated turn is reported as
                // truncated even when it carries a tool call. A silent truncation (no
                // finish_reason, content produced, no tool in flight) takes the same
                // label: it IS a cut-off turn, and `max_tokens` is Anthropic's word
                // for one. Neither can collide with the other: `finishReason` is
                // non-null in the first case and null in the second.
                const truncated = state.finishReason === "length" || ending === "silent-truncation";
                const refused = state.finishReason === "content_filter";
                const stopReason = refused
                  ? "refusal"
                  : truncated
                    ? "max_tokens"
                    : textToolCalls.length > 0 || hasStructuredTools
                      ? "tool_use"
                      : "end_turn";
                if (truncated || refused) {
                  log(
                    `[Streaming] Upstream finish_reason=${state.finishReason} → stop_reason=${stopReason} (${state.accumulatedText.length} chars produced)`
                  );
                }

                // A turn that ended NORMALLY must carry at least one content block.
                // `stop_reason: "end_turn"` with an empty `content` array is not a
                // shape Anthropic's API produces, and a client that indexes the last
                // block, or renders the turn, has nothing to work with — the turn
                // reads as a success that delivered nothing, with no diagnostic.
                //
                // The test is `stop_reason === "end_turn"` rather than "the ending was
                // a success", because that single value already excludes every case
                // where emptiness is MEANINGFUL and must be preserved:
                //   • "max_tokens" — reasoning consumed the whole budget and the turn
                //     was cut off. `gemini-3.1-pro-or-maxtokens-empty.sse` is a real
                //     capture of exactly this; it must not be papered over.
                //   • "max_tokens" from a silent truncation (item 4) — same reasoning.
                //   • "refusal" — the provider refused. Emptiness IS the answer.
                //   • "tool_use" — a tool block was emitted, so it is not contentless.
                //
                // An EMPTY text block, not placeholder prose and not an error. Prose
                // would enter the conversation history as the assistant's words and be
                // replayed forever; an `error` would trigger the client's retry loop on
                // a deterministic outcome, which is adapters.md's stated reason for
                // keeping `max_tokens` over an error on the sibling case.
                if (stopReason === "end_turn" && !writer.anyBlockEmitted) {
                  log(
                    `[Streaming] Contentless turn error: end_turn with no content block emitted (finish_reason=${state.finishReason ?? "null"}) — emitting an empty text block`
                  );
                  writer.close(writer.openText());
                }

                // The three input counters are derived ONCE and used for both the
                // wire and the cost update below, so the two cannot disagree.
                const split = splitPromptTokens(state.usage);
                // One degenerate turn is sent UNSPLIT, and this is not a special
                // case so much as the merge rule read honestly.
                //
                // Claude Code only lets a delta value override its running total
                // when that value is GREATER THAN ZERO (2.1.273:
                // `n.input_tokens !== null && n.input_tokens > 0 ? n.input_tokens : e.input_tokens`).
                // So on a turn whose input is entirely cache — possible only when
                // the request repeats one already cached, i.e. a retry — an
                // `input_tokens: 0` is DISCARDED and the message_start seed (the
                // PREVIOUS turn's full context) survives beside a full-size
                // `cache_read_input_tokens`. The client would then sum the two and
                // believe the conversation is roughly twice its real size.
                //
                // Reporting that turn as ordinary input keeps the client's sum
                // exactly equal to `prompt_tokens`, which is the invariant that
                // matters. It costs nothing on the money side: the cost split is
                // taken from `splitPromptTokens` independently, below.
                const fullyCached = split.promptTokens > 0 && split.inputTokens === 0;
                const wireInput = fullyCached ? split.promptTokens : split.inputTokens;
                const wireCacheRead = fullyCached ? 0 : split.cacheReadTokens;
                const wireCacheCreation = fullyCached ? 0 : split.cacheCreationTokens;
                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  // input_tokens must ride the delta too: Claude Code takes the
                  // context size from the last assistant message, and message_start
                  // could only carry an estimate. Omitting it left the client
                  // believing every conversation was 100 tokens, which silently
                  // disabled auto-compaction on every openai-sse provider.
                  //
                  // All THREE keys ship TOGETHER, unconditionally, and that is not
                  // stylistic. Claude Code reconstructs the conversation size by
                  // summing them (verified in the 2.1.273 binary:
                  // `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
                  // read by both the context meter and the auto-compaction
                  // threshold), so a reduced `input_tokens` sent WITHOUT its two
                  // siblings understates the context by exactly the cached portion
                  // — on the measured xAI turn, 20352 of 20379 tokens. That is the
                  // one shape that reproduces the failure the paragraph above
                  // records. `splitPromptTokens` guarantees the three sum back to
                  // `prompt_tokens`.
                  //
                  // `input_tokens` is emitted even when it is 0 (a fully-cached
                  // turn), because omitting it is the same silent-omission bug in a
                  // different disguise.
                  usage: {
                    input_tokens: wireInput,
                    cache_read_input_tokens: wireCacheRead,
                    cache_creation_input_tokens: wireCacheCreation,
                    output_tokens: state.usage?.completion_tokens || 0,
                  },
                });
                send("message_stop", { type: "message_stop" });
              }

              // Update token counts - use actual usage if available, otherwise estimate
              if (onTokenUpdate) {
                if (state.usage) {
                  reportProviderUsage();
                } else {
                  // Estimate tokens for local models that don't return usage data
                  // Rough estimate: ~4 characters per token
                  const estimatedOutputTokens = Math.ceil(state.accumulatedText.length / 4);
                  log(
                    `[Streaming] No usage data from provider, estimating: ~${estimatedOutputTokens} output tokens`
                  );
                  // Carry the previous context size forward rather than a literal
                  // 100 — the status line reads this value, and 100 would make the
                  // bar collapse to "empty" on any turn the provider skips usage.
                  onTokenUpdate(priorInputTokens || 100, estimatedOutputTokens);
                }
              }
            } finally {
              teardown();
              // Capture pipeline (#641 blocker-2 port): normal/exception close —
              // in the finally so a part-way throw still closes the capture. The
              // enqueue override above stays installed while teardown emits the
              // `[DONE]` tail, so the capture records it too.
              try {
                cap.note(`close reason=${reason}`);
                cap.done({
                  closed: true,
                  stop_reason: sentStopReason,
                  reason,
                  text_len: state.accumulatedText.length,
                  err: err ?? null,
                });
              } catch {}
            }
          };

          try {
            const reader = response.body!.getReader();
            upstream.reader = reader;
            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const dataStr = line.trim() ? sseDataPayload(line) : null;
                if (dataStr === null) continue;
                // Capture pipeline (#641 blocker-2 port) — first-upstream-event
                // marker, once per stream, on the first `data:` line seen.
                if (!ttftLogged) {
                  ttftLogged = true;
                  process.stdout.write(
                    ttftMarkerLine(
                      "openai",
                      target,
                      reqN,
                      headerLatencyMs,
                      Math.round(performance.now() - tHeaders)
                    )
                  );
                }
                // Verbatim: this line IS the fixture source (see SSE_LOG_MAX_CHARS).
                log(`[SSE:openai] ${formatRawSseLogPayload(dataStr)}`);
                if (dataStr === "[DONE]") {
                  await finalize("done");
                  return;
                }

                try {
                  let chunk = JSON.parse(dataStr);
                  if (chunk.usage) {
                    state.usage = chunk.usage;
                    log(
                      `[Streaming] Usage data received: prompt=${chunk.usage.prompt_tokens}, completion=${chunk.usage.completion_tokens}, total=${chunk.usage.total_tokens}`
                    );
                  }

                  // An error carried inside the 200 body. Checked AFTER `usage`
                  // so the tokens the turn already spent are still reported, and
                  // BEFORE the `choices[0]` reads below, which an error frame's
                  // empty `choices` array silently fails to match.
                  //
                  // `finalize("error", …)` emits an SSE `error` event, which is
                  // the only thing that makes Claude Code surface the failure. The
                  // alternative — turning it into an assistant text block — is the
                  // mistake `stream-head-sniffer.ts` documents: it freezes a
                  // provider failure into the transcript as a successful answer.
                  const inStreamError = describeInStreamError(chunk);
                  if (inStreamError) {
                    log(`[Streaming] Upstream error inside a 200 stream: ${inStreamError}`);
                    await finalize("error", inStreamError);
                    return;
                  }

                  // The raw tap runs BEFORE anything is derived from the chunk:
                  // what it returns is the committed object (a hook's clone, or
                  // the chunk itself), and every read below is of it, deletions
                  // and a changed finish_reason included.
                  if (raw && chunk.choices?.[0]?.delta) {
                    chunk = raw.chunk(chunk, (c: any) => c.choices?.[0]?.delta);
                  }

                  const delta = chunk.choices?.[0]?.delta;
                  const finishReason = chunk.choices?.[0]?.finish_reason;
                  if (finishReason) state.finishReason = finishReason;

                  // Debug: Log chunk details for troubleshooting early termination
                  if (delta?.content || finishReason) {
                    log(
                      `[Streaming] Chunk: content=${delta?.content?.length || 0} chars, finish_reason=${finishReason || "null"}`
                    );
                  }

                  if (delta) {
                    // Reasoning arrives under two different field names on this one
                    // wire format: `reasoning_content` (Kimi, DeepSeek via LiteLLM)
                    // and `reasoning` (OpenRouter). Reading only the former silently
                    // dropped every OpenRouter thinking model's reasoning.
                    const reasoningText = delta.reasoning_content || delta.reasoning;
                    if (reasoningText) {
                      // This provider has a reasoning FIELD, so a `<think>` in its
                      // content is a model writing about tags, not speaking in them.
                      // Close-tag handling stays armed: these are exactly the
                      // providers whose chat template opens `<think>` server-side and
                      // leaks the bare close into the content.
                      thinkSplitter.disarmOpen();
                      state.lastActivity = Date.now();
                      // Reasoning arriving AFTER text used to open a thinking block
                      // while the text block was still open — two open blocks, which
                      // Anthropic's wire does not allow. `openThinking` closes the
                      // text block first. That difference is the point of this change.
                      writer.append(writer.openThinking(), reasoningText);
                    }

                    // Handle text content
                    const txt = delta.content || "";
                    log(
                      `[Streaming] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                    );
                    if (txt) {
                      state.lastActivity = Date.now();
                      // The thinking block is NOT closed here any more: it closes
                      // when `writer.openText()` actually runs below. A chunk that
                      // the adapter empties, or that is held back pending a tool
                      // pattern, no longer ends the thinking block on the strength
                      // of text that never reaches the client.
                      const res = adapter.processTextContent(txt, "");
                      log(
                        `[Streaming] After adapter: "${res.cleanedText.substring(0, 30).replace(/\n/g, "\\n")}" (${res.cleanedText.length} chars, transformed=${res.wasTransformed})`
                      );

                      // An adapter emptying a chunk is LEGITIMATE on this path, so
                      // there is deliberately no "non-empty in, non-empty out" guard
                      // here — unlike gemini-sse.ts, which has one. Two adapters
                      // return "" by design:
                      //   • QwenModelDialect — the chunk was entirely chat-template
                      //     special tokens (`<|im_start|>` &c.); passing the original
                      //     through would leak them to the user.
                      //   • GrokModelDialect — it is buffering a `<xai:function_call>`
                      //     XML block split across chunks; passing the original
                      //     through would emit half a tool call as visible text.
                      // Per-chunk emptiness is therefore not evidence of loss here.
                      // What WOULD be a bug is a whole turn arriving empty; that is
                      // caught at the turn level by the probe and by stop_reason.
                      if (txt.length > 0 && res.cleanedText.length === 0) {
                        log(`[Streaming] Text filtered out by adapter: "${txt.substring(0, 50)}"`);
                      }

                      if (res.cleanedText) {
                        // `<think>…</think>` carried in the ORDINARY content field is
                        // reasoning, not the answer. Split it out here, after the
                        // adapter, so the thinking half never enters
                        // `accumulatedText` (tool-call recovery scans that) and never
                        // renders as the assistant's words.
                        emitSplitContent(thinkSplitter.push(res.cleanedText));
                      }
                    }

                    // Handle tool calls
                    if (delta.tool_calls) {
                      log(
                        `[Streaming] Received ${delta.tool_calls.length} structured tool call(s) from model`
                      );
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index;
                        let t = state.tools.get(idx);
                        if (tc.function?.name) {
                          // Accumulate the name BEFORE anything reads it: a provider
                          // may split `function.name` across chunks, and this is the
                          // one place a complete name exists.
                          const accumulatedName =
                            (state.pendingToolName.get(idx) ?? "") + tc.function.name;
                          state.pendingToolName.set(idx, accumulatedName);
                          // THIS IS THE DECODE POINT: it reads the accumulated name,
                          // never a single chunk's fragment. Decoding a fragment
                          // misses the map, and the allowlist then drops the call
                          // in silence.
                          const restoredName = toolNameMap?.get(accumulatedName) || accumulatedName;
                          if (!t) {
                            // The hand-written "close thinking, then close text"
                            // pair that used to stand here is `openTool`'s job now.
                            // Three-way disposition (Hermes fix #2): lane 1 —
                            // exact-name declaration wins, the call forwards like
                            // any declared tool. Lanes 2/3 (remap to WebSearch,
                            // suppress-and-inject) only when the exact name is
                            // not declared.
                            const isWebSearch = isWebSearchToolCall(restoredName);
                            const declaredExactly =
                              isWebSearch && clientDeclaresToolExactly(restoredName, toolSchemas);
                            const remapToWebSearch =
                              isWebSearch &&
                              !declaredExactly &&
                              clientDeclaresWebSearch(toolSchemas);
                            const suppressWebSearch =
                              isWebSearch && !remapToWebSearch && !declaredExactly;
                            if (isWebSearch) {
                              log(
                                `[Stream] Web search tool call detected: "${restoredName}" — ${
                                  declaredExactly
                                    ? "forwarding verbatim (client declared this exact tool)"
                                    : remapToWebSearch
                                      ? "remapping to client WebSearch tool_use"
                                      : `intercepting via SearXNG (available=${SEARXNG_AVAILABLE})`
                                }`
                              );
                            }
                            t = {
                              id: tc.id || `tool_${Date.now()}_${idx}`,
                              name: restoredName,
                              // Reserved, not opened: a buffered tool keeps its place
                              // in the index order and emits at finish_reason time.
                              // Only a SUPPRESSED web-search call never emits a
                              // block, so it reserves nothing (-1): its index would
                              // otherwise leak a hole to the client when the turn
                              // ends without the finish_reason="tool_calls" spend
                              // path. The sentinel follows the disposition, not the
                              // name: lane 1 (exact-name declared) forwards and
                              // MUST own a real index (#498 CR, #484 class).
                              blockIndex: suppressWebSearch ? -1 : writer.reserve(),
                              started: false,
                              closed: false,
                              // Seeded, not empty: fragments that arrived for this
                              // index before the name did are drained in here.
                              arguments: state.pendingToolArgs.get(idx) ?? "",
                              ref: null,
                              // Buffer if we have schemas to validate the completed
                              // arguments against — lane 1 (exact-name declared)
                              // buffers like any declared tool, validation applies
                              // to it too; intercepted calls carry no client schema.
                              buffered:
                                !!toolSchemas &&
                                toolSchemas.length > 0 &&
                                (!isWebSearch || declaredExactly),
                              suppressed: suppressWebSearch,
                              remapped: remapToWebSearch,
                            };
                            if (t.arguments) {
                              log(
                                `[Streaming] tool ${t.name} (index ${idx}): seeded ${t.arguments.length} argument chars that arrived before function.name`
                              );
                            }
                            state.pendingToolArgs.delete(idx);
                            state.tools.set(idx, t);
                          } else if (t.name !== restoredName) {
                            // A LATER fragment completed the name. The tool was
                            // created from the first fragment, so its name is a
                            // prefix — and a prefix of an encoded name decodes to
                            // nothing, which is how a call gets dropped without a
                            // word anywhere.
                            if (t.started) {
                              // The block is already on the wire under the short
                              // name; it cannot be recalled. "error" is deliberate
                              // — it is what carries this to the structural log.
                              log(
                                `[Streaming] error: tool block ${t.blockIndex} was started as "${t.name}" but the full name is "${restoredName}" — the client sees the wrong name`
                              );
                            } else {
                              t.name = restoredName;
                              t.buffered = !!toolSchemas && toolSchemas.length > 0 && !t.remapped;
                              if (isWebSearchToolCall(restoredName)) {
                                log(
                                  `[Stream] Web search tool call detected: "${restoredName}" — name completed by a later fragment, re-evaluated at the decode point`
                                );
                              }
                            }
                          }
                          // Only send content_block_start immediately if NOT buffering.
                          // Suppressed and remapped tools never stream their blocks live.
                          if (!t.started && !t.buffered && !t.suppressed && !t.remapped) {
                            t.ref = writer.openTool({
                              id: t.id,
                              name: t.name,
                              index: t.blockIndex,
                            });
                            t.started = true;
                            // Flush the seed as ONE delta, right after the start.
                            // Skipped when the seed is empty, which is every capture
                            // in the tree — so the common case stays byte-identical.
                            if (t.arguments) writer.append(t.ref, t.arguments);
                          }
                        }
                        if (tc.function?.arguments && !t) {
                          // Arguments before the name. This used to be dropped by an
                          // `&& t` guard, so the head of the JSON object vanished and
                          // what survived began mid-object and could not parse —
                          // indistinguishable downstream from a model emitting bad
                          // JSON. Hold it until the name creates the tool.
                          state.pendingToolArgs.set(
                            idx,
                            (state.pendingToolArgs.get(idx) ?? "") + tc.function.arguments
                          );
                        }
                        if (tc.function?.arguments && t) {
                          // Always accumulate arguments — suppressed/remapped tools
                          // too: their disposition is decided, but the query lives
                          // in these arguments.
                          t.arguments += tc.function.arguments;
                          // Only stream immediately if NOT buffering/suppressed/remapped
                          if (!t.buffered && !t.suppressed && !t.remapped) {
                            if (!t.ref || !writer.append(t.ref, tc.function.arguments)) {
                              // OpenAI's wire lets `tool_calls[0]` and `tool_calls[1]`
                              // fragments interleave; Anthropic's allows one open
                              // block. So this tool's block is no longer the open one
                              // — something else (another tool, or text) took over and
                              // closed it. Degrade THIS tool to the buffered path: the
                              // complete arguments go out as one block when the call
                              // closes. Same recovery shape the repair path already
                              // uses when it supersedes a partially-streamed block.
                              log(
                                `[Streaming] tool ${t.name} (index ${idx}) lost its open block mid-arguments — buffering the rest`
                              );
                              t.buffered = true;
                              t.started = false;
                              t.ref = null;
                            }
                          }
                        }
                      }
                    }
                  }

                  if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
                    for (const t of Array.from(state.tools.values())) {
                      if (t.remapped) {
                        if (!t.closed) {
                          const query = extractSearchQuery(t.arguments);
                          if (query) {
                            emitWebSearchToolUse(query, t);
                          } else {
                            // No usable query — degrade to the suppression path
                            // (text injection below) rather than emit a broken tool_use.
                            t.remapped = false;
                            t.suppressed = true;
                          }
                        }
                        if (t.closed) continue;
                      }
                      if (t.suppressed) {
                        // Execute web search via SearXNG and inject results
                        if (!t.closed) {
                          const query = extractSearchQuery(t.arguments);
                          let resultText: string;
                          if (query && SEARXNG_AVAILABLE) {
                            resultText = await executeWebSearch(query);
                          } else {
                            resultText = query
                              ? `[Web search for "${query}" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
                              : "[Web search was requested but no query was provided.]";
                          }
                          // The suppressed tool never opened its block, so its
                          // reserved index is unspent — the text takes it.
                          // (-1 = suppressed at creation, nothing held: bare
                          // openText takes the next free index.)
                          const ref =
                            t.blockIndex >= 0
                              ? writer.openText({ index: t.blockIndex })
                              : writer.openText();
                          writer.append(ref, resultText);
                          writer.close(ref);
                          t.closed = true;
                        }
                        continue;
                      }
                      if (!t.closed) {
                        // Validate and potentially repair tool arguments
                        if (toolSchemas && toolSchemas.length > 0) {
                          const validation = validateToolArguments(
                            t.name,
                            t.arguments,
                            toolSchemas,
                            state.accumulatedText
                          );

                          if (validation.repaired && validation.repairedArgs) {
                            // Tool call was repaired - send the complete repaired arguments
                            log(
                              `[Streaming] Tool call ${t.name} was repaired with inferred parameters`
                            );
                            const repairedJson = JSON.stringify(validation.repairedArgs);
                            log(
                              `[Streaming] Sending repaired tool call: ${t.name} with args: ${repairedJson}`
                            );

                            // If buffered, this is the first time we're sending this tool call
                            // Send the complete repaired tool call as a single block
                            if (t.buffered && !t.started) {
                              t.ref = writer.openTool({
                                id: t.id,
                                name: t.name,
                                index: t.blockIndex,
                              });
                              writer.append(t.ref, repairedJson);
                              writer.close(t.ref);
                              t.started = true;
                              t.closed = true;
                              continue;
                            }

                            // If already started (non-buffered), close old and send new.
                            // This is the one path that mints a SECOND block for a tool
                            // that already has one — the partially-streamed original is
                            // closed and superseded, under a new id.
                            if (t.started) {
                              if (t.ref) writer.close(t.ref);
                              const repairedIdx = writer.reserve();
                              const repairedId = `tool_repaired_${Date.now()}_${repairedIdx}`;
                              const repairedRef = writer.openTool({
                                id: repairedId,
                                name: t.name,
                                index: repairedIdx,
                              });
                              writer.append(repairedRef, repairedJson);
                              writer.close(repairedRef);
                              t.ref = repairedRef;
                              t.closed = true;
                              continue;
                            }
                          }

                          if (!validation.valid) {
                            // Repair failed - send error message instead of invalid tool call
                            log(
                              `[Streaming] Tool call ${t.name} validation failed: ${validation.missingParams.join(", ")}`
                            );
                            // A buffered tool never emitted its block, so its reserved
                            // index is free and the warning text takes it. A
                            // non-buffered one already spent its index on the tool
                            // block, so the warning needs a fresh one.
                            const errorIdx = t.buffered ? t.blockIndex : undefined;
                            const errorMsg = `\n\n⚠️ Tool call "${t.name}" failed: missing required parameters: ${validation.missingParams.join(", ")}. Local models sometimes generate incomplete tool calls. Please try again or use a model with better tool support.`;
                            const errorRef = writer.openText({ index: errorIdx });
                            writer.append(errorRef, errorMsg);
                            writer.close(errorRef);
                            // Close the invalid tool if it was already started.
                            // `openText` above will already have closed it when it was
                            // the open block; this covers the case where it was not.
                            if (t.started && !t.buffered && t.ref) {
                              writer.close(t.ref);
                            }
                            t.closed = true;
                            continue;
                          }

                          // Valid tool call - send if buffered, close if not
                          if (t.buffered && !t.started) {
                            const argsJson = JSON.stringify(validation.parsedArgs);
                            t.ref = writer.openTool({
                              id: t.id,
                              name: t.name,
                              index: t.blockIndex,
                            });
                            writer.append(t.ref, argsJson);
                            writer.close(t.ref);
                            t.started = true;
                            t.closed = true;
                            continue;
                          }
                        }

                        // Non-buffered valid tool call or no validation - just close
                        if (t.started && !t.closed) {
                          if (t.ref) writer.close(t.ref);
                          t.closed = true;
                        }
                      }
                    }
                  }
                } catch (e) {
                  // NEVER swallow silently. Everything a chunk would have emitted —
                  // a content block, a tool call, the finish_reason — is lost here,
                  // and the turn still ends HTTP 200, so the only symptom is a
                  // missing block several layers away. The bare `catch {}` this
                  // replaces made every such fault undiagnosable from the log.
                  //
                  // "error" in the text is load-bearing: `isStructuralLogWorthy`
                  // (logger.ts) matches on it, so this reaches the always-on
                  // structural log, not just a `--debug` run. The payload itself
                  // was already logged verbatim above as `[SSE:openai]`, so only a
                  // short locator is repeated here.
                  log(
                    `[Streaming] Chunk processing error (chunk dropped): ${e} — payload starts: ${dataStr.slice(0, 120)}`
                  );
                }
              }
            }
            await finalize("unexpected");
          } catch (e) {
            await finalize("error", String(e));
          }
        },
        // Downstream went away: cancelEndsUpstreamWork cancels the upstream reader
        // after this and resolves only once the read loop above has settled.
        cancel() {
          cancelled = true;
          isClosed = true;
          if (ping) clearInterval(ping);
        },
      })
    ),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
