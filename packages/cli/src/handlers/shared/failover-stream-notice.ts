/**
 * Prepend a one-time failover notice as the FIRST text block of an Anthropic SSE
 * stream, shifting every real content block's `index` by +1.
 *
 * Injected at the HEAD of the first streamed response a session receives under an
 * active budget failover (see fork/failover.ts `consumeStreamNotice`). The
 * substitute model then reads its own prior turn — starting with this notice — on
 * the next turn's history, so it knows it inherited a context built for a
 * different model and resumes its normal working scope. The condensation notice
 * (appendFailoverNoticeToMessage) reinforces this at every /compact.
 *
 * Why index-shift instead of append-at-tail: the notice must lead the message so
 * it is the first thing the model sees when re-reading its prior turn. Anthropic
 * SSE indexes content blocks 0,1,2…; injecting at 0 and rewriting every upstream
 * content_block_start/delta/stop `index` to `index+1` keeps the stream valid —
 * multi-block messages (text + tool_use, thinking + text) are routine.
 *
 * Never-throws (never-hang priority): a malformed stream or parse anomaly degrades
 * to passthrough of the bytes seen so far. A missing notice is a cosmetic loss;
 * a thrown error here would corrupt a working stream for 4 live agents.
 */

import {
  appendFailoverNoticeToMessage,
  buildFailoverNotice,
  consumeStreamNotice,
  type FailoverRole,
} from "../../fork/failover.js";

export function prependNoticeToAnthropicStream(
  source: ReadableStream<Uint8Array>,
  notice: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let noticeEmitted = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line (\n\n). Process only whole
          // events; keep the trailing partial in the buffer for the next chunk.
          let out = "";
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            out += transformEvent(rawEvent);
            out += "\n\n";
          }
          if (out) controller.enqueue(encoder.encode(out));
        }
        // Flush any trailing partial event (no closing blank line) verbatim.
        if (buffer) controller.enqueue(encoder.encode(buffer));
        controller.close();
      } catch {
        // Never hang: close cleanly on any error rather than leave the client
        // waiting. The upstream's own finalize still terminates its stream.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  function transformEvent(rawEvent: string): string {
    try {
      // Locate the `data:` line and parse its JSON payload (if any).
      const lines = rawEvent.split("\n");
      let dataIdx = -1;
      let payload: any = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith("data:")) {
          const jsonStr = lines[i].slice(lines[i].indexOf("data:") + 5).trim();
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              payload = JSON.parse(jsonStr);
              dataIdx = i;
            } catch {
              /* not JSON — leave untouched */
            }
          }
        }
      }

      const isContentBlock =
        payload &&
        (payload.type === "content_block_start" ||
          payload.type === "content_block_delta" ||
          payload.type === "content_block_stop");

      // Emit the notice once, immediately BEFORE the first real content block.
      // This places it after message_start and ahead of the model's first block.
      let prefix = "";
      if (isContentBlock && !noticeEmitted) {
        noticeEmitted = true;
        prefix = noticeFrames(notice);
      }

      // Shift the block's index by +1 so the notice can own index 0.
      if (isContentBlock && typeof payload.index === "number" && dataIdx >= 0) {
        lines[dataIdx] = `data: ${JSON.stringify({ ...payload, index: payload.index + 1 })}`;
        return prefix + lines.join("\n");
      }

      return prefix + rawEvent;
    } catch {
      return rawEvent;
    }
  }
}

function noticeFrames(notice: string): string {
  // Three complete SSE events (each terminated by \n\n). The `event:` line equals
  // the `data.type`, matching Anthropic's wire shape so clients that key on the
  // event name dispatch correctly.
  const start = JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  const delta = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: notice },
  });
  const stop = JSON.stringify({ type: "content_block_stop", index: 0 });
  return (
    `event: content_block_start\ndata: ${start}\n\n` +
    `event: content_block_delta\ndata: ${delta}\n\n` +
    `event: content_block_stop\ndata: ${stop}\n\n`
  );
}

// ─── #229: which ingress carries the notice in content ─────────────────────

/** Response header carrying the notice on the programmatic ingress (#229). */
export const NOTICE_HEADER = "x-claudish-failover-notice";

/**
 * How a route's consumers receive a failover notice (#229, option A amended).
 *
 * The notices are written for the Claude Code agent loop: an agent that knows its
 * model changed recalibrates (doctrine 2026-08-23 / #126). A programmatic
 * consumer cannot — for it a notice riding the content IS the answer, measured on
 * 2026-09-23 02:02Z: a sk-agent code-review step whose whole content was the
 * "[claudish] Nominal model restored." notice over an empty model output, so the
 * review "passed" while saying nothing about the code, and an empty-output guard
 * never fired because the content was not empty.
 *
 * The ingress route is the stable discriminator between the two consumer classes
 * — it is OUR contract, not a client-supplied string (a user-agent gate drifts
 * with client versions and is spoofable). Claude Code speaks `/v1/messages`
 * only; sk-agent-class consumers (any AsyncOpenAI client) speak
 * `/v1/chat/completions` only.
 */
export interface NoticeIngressPolicy {
  /** true: the notice rides the content (block 0 / appended text). */
  inContent: boolean;
}

/** The per-route notice policy. Data-driven so the wiring is testable. */
export function noticePolicyForIngress(path: string): NoticeIngressPolicy {
  return { inContent: path !== "/v1/chat/completions" };
}

/**
 * Header-safe encoding of a notice: base64 of the UTF-8 bytes. Header values are
 * single-line ASCII; the notice is multi-line markdown with non-ASCII punctuation
 * (—, ’). Consumers decode with base64 → UTF-8.
 */
export function noticeToHeaderValue(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/** The inverse of noticeToHeaderValue, for consumers and tests. */
export function noticeFromHeaderValue(value: string): string {
  return Buffer.from(value, "base64").toString("utf-8");
}

function responseWithNoticeHeader(response: Response, text: string): Response {
  const headers = new Headers(response.headers);
  headers.set(NOTICE_HEADER, noticeToHeaderValue(text));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Inject failover/recovery notices into a successful Anthropic-shape response,
 * per the route's NoticeIngressPolicy.
 *
 * Streaming (`inContent: true`): a one-time-per-session (per resolved depth)
 * notice prepended as block 0, so the substitute/back-to-nominal model reads it
 * from its own prior turn next time. Non-streaming: the condensation notice
 * appended to the collected message (fires every /compact while armed,
 * RECOVERY_CONDENSATIONS times while recovering).
 *
 * `inContent: false` (the OpenAI-compatible ingress, #229): the content is left
 * EXACTLY the model's own — the notice rides the NOTICE_HEADER response header
 * instead, so an empty model output stays visibly empty for a programmatic
 * consumer instead of being masked by the notice-as-answer.
 *
 * Centralized here (not in ComposedHandler) so it also covers NativeHandler
 * responses — the recovery case, where the nominal (Opus) is back, must be
 * announced even though NativeHandler is a thin passthrough. Never throws — a
 * malformed body passes through.
 */
export async function applyFailoverNotices(
  response: Response,
  role: FailoverRole | null,
  sessionKey: string | null,
  wantsStreaming: boolean,
  policy: NoticeIngressPolicy = { inContent: true }
): Promise<Response> {
  if (!role) return response;
  if (wantsStreaming) {
    const text = consumeStreamNotice(role, sessionKey);
    if (!text) return response;
    if (!policy.inContent) {
      return responseWithNoticeHeader(response, text);
    }
    if (response.body) {
      try {
        const wrapped = prependNoticeToAnthropicStream(response.body, text);
        const headers = new Headers(response.headers);
        return new Response(wrapped as any, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        // Never hang: fall through to the unmodified stream.
      }
    }
    return response;
  }
  if (!policy.inContent) {
    // Same notice text and side effects (recovery-budget decrement) as the
    // content path — only the channel differs.
    const text = buildFailoverNotice(role);
    if (text) return responseWithNoticeHeader(response, text);
    return response;
  }
  try {
    const message = await response.clone().json();
    appendFailoverNoticeToMessage(message, role);
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(message), { status: response.status, headers });
  } catch {
    return response;
  }
}
