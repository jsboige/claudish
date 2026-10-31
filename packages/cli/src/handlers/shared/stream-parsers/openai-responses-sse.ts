/**
 * OpenAI Responses API SSE → Claude SSE stream parser (module entry point).
 *
 * Handles Codex models that use /v1/responses instead of /v1/chat/completions.
 * The work is split in three, under `responses/`:
 *   - `claude-sse-sink.ts`: the one writer of Claude SSE for one downstream
 *     message (lifecycle, block index, ping, tool block states, disconnect);
 *   - `responses-leg.ts`: one upstream body → Claude SSE events → LegOutcome;
 *   - `responses-turn.ts`: how the message ends, and the usage callback.
 * `composed-handler.ts` imports only this file.
 */

import type { Context } from "hono";
import {
  type CodeModeTurnHooks,
  type NestedToolUse,
  relayNestedInput,
} from "../../../code-mode/types.js";
// Capture pipeline (#641 blocker-2 port): resp-*.sse tap + [ttft]/[resp]
// stdout markers, correlated by the request number frozen at ingestion.
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import type { RawStreamTap } from "../../../hooks/raw.js";
import { wrapAnthropicError } from "../anthropic-error.js";
import { createResponseCapture } from "../response-capture.js";
import type { UsageCacheDetail } from "../token-tracker.js";
import { ttftMarkerLine } from "../traffic-markers.js";
import { ClaudeSseSink } from "./responses/claude-sse-sink.js";
import { type ResponsesRetryOptions, runResponsesTurn } from "./responses/responses-turn.js";
import { type ParserSource, cancelEndsUpstreamWork } from "./upstream-cancel.js";

export type { ResponsesRetryOptions } from "./responses/responses-turn.js";
export type { CodeModeTurnHooks, ExecTurnStep } from "../../../code-mode/types.js";
export { resolveStallPolicy, type StallPolicy } from "./responses/stall-guard.js";

/**
 * A code-mode script blocked again at step 5r: answer with its next batch as
 * tool_use blocks, with NO upstream call. Written by the same sink as a driver
 * batch (one `onToolCallObserved` per block, the raw `providerStreamEnd`
 * hooks). Tool-argument repair is the hook response seam's job, above every
 * parser, so a synthetic reply gets it exactly as a driver batch does.
 * `message_start` and `message_delta` carry the previous request's input and 0
 * output; nothing was billed, so no usage callback fires.
 */
export function createSyntheticToolUseReply(
  blocks: ReadonlyArray<NestedToolUse>,
  opts: {
    modelName: string;
    priorInputTokens?: number;
    onToolCallObserved?: (name: string) => void;
    raw?: RawStreamTap | null;
  }
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const sink = new ClaudeSseSink(controller, {
        modelName: opts.modelName,
        priorInputTokens: opts.priorInputTokens,
        onToolCallObserved: opts.onToolCallObserved,
      });
      try {
        sink.start();
        for (const block of blocks) {
          sink.emitToolUse(
            block.id,
            block.name,
            relayNestedInput(block, (_name, args) => args)
          );
        }
        sink.endMessage("tool_use", { input_tokens: opts.priorInputTokens ?? 0, output_tokens: 0 });
        if (opts.raw) await opts.raw.streamEnd();
      } catch (err) {
        // A throwing hook must not leave the downstream open.
        sink.endWithError(`claudish: the synthetic reply failed: ${err}`);
      } finally {
        sink.close();
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

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    /**
     * Fires the request's stats record, LAST at turn end: the final leg's input
     * (the context figure) and every leg's output.
     */
    onTokenUpdate?: (input: number, output: number) => void;
    /**
     * Retry a degenerate leg inside the same downstream message (see
     * responses/responses-turn.ts). Absent ⇒ one leg per turn, exactly as before.
     */
    retry?: ResponsesRetryOptions;
    /** Fires FIRST at turn end: input of earlier legs that reported usage (cost only). */
    onExtraBilledInput?: (inputTokens: number, detail?: UsageCacheDetail) => void;
    /** Fires after onExtraBilledInput, before onTokenUpdate. */
    onTurnSummary?: (s: { legs: number; legRetries: number }) => void;
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
    /**
     * Input tokens from the previous request on this handler. Seeds
     * `message_start.usage` so a turn that ends without upstream usage does
     * not report a 100-token context. See message-start-usage.ts.
     */
    priorInputTokens?: number;
    /**
     * The raw-tier tap (`providerChunk` / `providerStreamEnd`), so the Responses
     * path has the same raw hook points as the Chat Completions path. The
     * Responses API has no `delta` object of its own, so the event stands in for
     * both.
     */
    raw?: RawStreamTap | null;
    /**
     * Called once per `tool_use` block start, for the token tracker's tool
     * count. Tool-argument interception is not this parser's job: it happens at
     * the hook response seam, above every parser.
     */
    onToolCallObserved?: (name: string) => void;
    /**
     * The request's tool names as Claude Code sent them (decoded, not the
     * encoded wire names). A function_call named `parallel` is treated as the
     * parallel wrapper only when no declared tool has that name. Absent → the
     * values of `toolNameMap`.
     */
    declaredToolNames?: string[];
    /**
     * Code mode for this turn (`openai-codex`): exec calls are run through these
     * hooks (responses/responses-turn.ts). Absent ⇒ exec calls are ignored.
     */
    codeMode?: CodeModeTurnHooks;
    /**
     * Dispatch → upstream-response-headers latency, threaded from
     * ComposedHandler when it measures one (for the [ttft] marker). Absent =
     * not measured: the marker prints `headers=-1ms total=-1ms`.
     */
    headerLatencyMs?: number;
  }
): Response {
  if (!response.body) {
    // biome-ignore lint/suspicious/noExplicitAny: Hono's typed json response is not a plain Response
    return c.json(wrapAnthropicError(500, "No response body"), 500) as any;
  }

  let sink: ClaudeSseSink | undefined;
  // Capture pipeline (#641 blocker-2 port) — response capture + TTFT anchors.
  // reqN is resolved from the request object (assigned at ingestion by
  // logRequest) so the [ttft]/[resp] markers label the request that spawned
  // them even under concurrency. v14 note: this parser was refactored into
  // `responses/` submodules upstream — the ttft signal comes back through the
  // `onFirstUpstreamData` leg hook rather than an inline loop.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  let ttftLogged = false;
  const cap = createResponseCapture("responses", opts.modelName, true, reqN);
  const source: ParserSource<Uint8Array> = {
    start: async (controller) => {
      // Mirror every outgoing byte into the response capture — the override
      // makes the tap exhaustive across the sink's every emit site.
      const _origEnqueue = controller.enqueue.bind(controller);
      controller.enqueue = ((chunk: any) => {
        cap.tap(chunk);
        return _origEnqueue(chunk);
      }) as typeof controller.enqueue;
      sink = new ClaudeSseSink(controller, {
        modelName: opts.modelName,
        priorInputTokens: opts.priorInputTokens,
        onToolCallObserved: opts.onToolCallObserved,
      });
      sink.start();
      // runResponsesTurn never rejects and closes the sink when it resolves.
      await runResponsesTurn(sink, response, {
        modelName: opts.modelName,
        toolNameMap: opts.toolNameMap,
        declaredToolNames: opts.declaredToolNames ?? [...(opts.toolNameMap?.values() ?? [])],
        raw: opts.raw,
        contextWindow: opts.contextWindow,
        onApiError: opts.onApiError,
        onTokenUpdate: opts.onTokenUpdate,
        retry: opts.retry,
        onExtraBilledInput: opts.onExtraBilledInput,
        onTurnSummary: opts.onTurnSummary,
        codeMode: opts.codeMode,
        // Once per stream (a retried leg re-fires; the guard holds).
        onFirstUpstreamData: () => {
          if (!ttftLogged) {
            ttftLogged = true;
            process.stdout.write(
              ttftMarkerLine(
                "responses",
                opts.modelName,
                reqN,
                opts.headerLatencyMs,
                Math.round(performance.now() - tHeaders)
              )
            );
          }
        },
      });
      // Capture pipeline: normal close — `closed=true` unless the client had
      // already gone (the cancel() below owns that variant).
      cap.done({
        closed: !sink.isCancelled,
        stop_reason: sink.finalStopReason,
        path: sink.isCancelled ? "cancel" : "normal",
      });
    },
    // Downstream went away (client disconnect, abort, or timeout). The
    // controller is already closed here, but none of the normal close paths
    // ran — so the sink marks itself closed (the keep-alive ping would
    // otherwise enqueue on a closed controller and throw from a timer callback,
    // killing the proxy process), and aborts the turn: the upstream reader is
    // cancelled rather than left streaming to completion with nobody reading.
    // cancelEndsUpstreamWork then waits for runResponsesTurn to settle before
    // the cancel resolves, so the lease outlives everything the turn logs while
    // stopping. No upstream reader is passed: the turn's legs read their own.
    cancel() {
      sink?.cancel();
      // Capture pipeline: client abort — `closed=false` is how a cancel reads
      // in the [resp] marker (stop=client-cancel).
      cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
    },
  };
  const stream = new ReadableStream<Uint8Array>(cancelEndsUpstreamWork({}, source));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
