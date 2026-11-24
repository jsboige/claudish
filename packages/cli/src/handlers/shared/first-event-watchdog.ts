/**
 * First-useful-event watchdog (#108).
 *
 * Incident 14/09: a provider lane (deepseek-flash scheduler) admitted requests
 * with HTTP 200 and then emitted ONLY SSE comments (`: keep-alive`, 14-28
 * bytes) for ~900s before an empty response. Nothing in the pipeline bounds
 * the wait for the FIRST useful event, so each admitted-but-mute stream held a
 * hub slot open for the full ~900s and client retries piled on top — 46
 * streams / 19 pending at peak. This is confinement, not repair: the upstream
 * outage is the provider's, but the embolism is ours.
 *
 * Definition (per the issue): a `: keep-alive` comment, an `event:` line or a
 * blank line is NOT a useful event — only a `data:` line whose payload is more
 * than a ping frame is (#1030). The Anthropic wire's keep-alive is
 * `event: ping` / `data: {"type":"ping"}` — it has a payload, so the original
 * `/^data:\s*\S/m` test counted it as useful and cleared the timer for good;
 * a stream admitted and then mute was never confined. Any other non-empty
 * payload still counts (an unparseable one included: this guards a hang, it
 * does not audit JSON). The window applies to the FIRST useful event only:
 * once seen, the timer is cleared and never rearmed, so a legitimate long
 * thinking phase (whose deltas are themselves data events) can never trip it.
 * The parser re-emits its own pings down to the client, so an upstream ping
 * needs no forwarding to keep the client link alive.
 *
 * On expiry the upstream reader is cancelled (frees the provider slot and the
 * socket) and the wrapper closes. The downstream stream parsers already
 * finalize a stream that ends without message_stop with a synthetic terminal
 * message (see anthropic-sse.ts "emitting synthetic finalization"), so the
 * client gets a clean end-of-turn instead of a 900s hang — never-hang holds.
 *
 * Window: CLAUDISH_FIRST_EVENT_TIMEOUT_MS, re-read per request (crisis lever,
 * same rationale as CLAUDISH_QWEN_THINKING), default 300000ms — deliberately
 * conservative (healthy lanes emit their first data event in seconds; big
 * cache-miss prompts may take a while before the first token; the
 * pathological streams held ~900s). 0 or negative disables the watchdog.
 */

import { log } from "../../logger.js";

const DEFAULT_WINDOW_MS = 300_000;

/**
 * Does this scan buffer carry a useful `data:` event? (#1030)
 *
 * A `data:` line whose payload parses to `{"type":"ping"}` is the Anthropic
 * wire's keep-alive, not an event. Every other non-empty payload counts —
 * including one this function cannot parse, because the watchdog's job is to
 * confine a mute stream, not to validate JSON: a malformed-but-present payload
 * is still an upstream that speaks, and confining it would change behaviour
 * beyond the issue's scope.
 */
export function hasUsefulDataLine(buffer: string): boolean {
  // #1097 CR — judge COMPLETE lines only. A chunk that ends inside a frame
  // (TCP, TLS or the relay cuts bytes anywhere) leaves the trailing segment
  // without its `\n`; judging it made a split ping — `data: {"ty` — count as
  // useful (the truncated payload fails JSON.parse), clearing the timer for
  // good. The segment is not dropped: it stays in the caller's scanBuffer and
  // is judged the moment its newline arrives. An unparseable COMPLETE line
  // still counts as useful (the watchdog confines a hang, it does not audit
  // JSON).
  const completeLines = buffer.endsWith("\n")
    ? buffer
    : buffer.slice(0, buffer.lastIndexOf("\n") + 1);
  for (const line of completeLines.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload.startsWith("{")) {
      try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "ping") {
          continue;
        }
      } catch {
        /* unparseable payload: useful (see above) */
      }
    }
    return true;
  }
  return false;
}

export function firstEventWatchdogWindowMs(): number {
  const raw = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  if (!raw) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_MS;
  return n;
}

/**
 * Internal signal: the watchdog's timer ACTUALLY expired (#1098 CR).
 *
 * The wrapper returns synchronously and the timer fires asynchronously, so
 * the expiry cannot ride a header (a Response constructor COPIES its headers,
 * and a header value is a string snapshot — both measured 18/11). The record
 * lives in a module WeakMap keyed by the wrapped Response itself: object
 * identity survives the return, the timer fills the record before closing,
 * and the downstream parser — constructed synchronously at that close,
 * receiving THIS Response object from ComposedHandler — reads the filled
 * value. null = the watchdog never expired, however armed it was: a finite
 * pings-only close must never wear the confined label.
 */
export interface FirstEventExpiry {
  windowMs: number | null;
}
const expiryByResponse = new WeakMap<Response, FirstEventExpiry>();

/** The parser-side reader: the expiry window, or null when nothing expired. */
export function firstEventExpiryMs(response: Response): number | null {
  return expiryByResponse.get(response)?.windowMs ?? null;
}

/**
 * Wrap an upstream SSE `Response` so that a stream admitted with 200 but
 * producing no `data:` line within the watchdog window is closed instead of
 * being held open. Byte-for-byte passthrough otherwise; never throws.
 */
export function withFirstUsefulEventWatchdog(response: Response, label: string): Response {
  const windowMs = firstEventWatchdogWindowMs();
  const upstream = response.body;
  if (!upstream || windowMs <= 0) return response;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let sawUseful = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The expiry record, keyed by the returned Response (see firstEventExpiryMs).
  const expiry: FirstEventExpiry = { windowMs: null };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        if (sawUseful || finished) return;
        finished = true;
        // Fill the record in place BEFORE closing: the downstream parser is
        // constructed synchronously at the close and reads the filled value.
        expiry.windowMs = windowMs;
        clearTimer();
        log(
          `[FirstEvent] watchdog: no useful event within ${windowMs}ms (${label}) — cancelling upstream; downstream parser finalizes synthetically`,
          true
        );
        try {
          reader.cancel().catch(() => {});
        } catch {
          /* already released */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, windowMs);

      (async () => {
        try {
          let scanBuffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (finished) break;

            if (!sawUseful && value) {
              // Any `data:` line carrying more than a ping frame marks the
              // stream healthy: SSE comments (`: keep-alive`), `event:` lines
              // and `data: {"type":"ping"}` never do (#1030 — the ping form
              // used to disarm this timer for good). Keep the scan bounded —
              // a mute-but-chatty upstream may stream kilobytes of frames.
              scanBuffer += decoder.decode(value, { stream: true });
              if (hasUsefulDataLine(scanBuffer)) {
                sawUseful = true;
                clearTimer();
                scanBuffer = "";
              } else if (scanBuffer.length > 8192) {
                scanBuffer = scanBuffer.slice(-4096);
              }
            }

            controller.enqueue(value);
          }
          controller.close();
        } catch {
          // Never-hang: close cleanly. The parser downstream treats this like
          // an upstream socket error and finalizes with its own graceful path.
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        } finally {
          clearTimer();
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }
      })();
    },
    cancel(reason) {
      finished = true;
      clearTimer();
      try {
        reader.cancel(reason).catch(() => {});
      } catch {
        /* already released */
      }
    },
  });

  const wrapped = new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  expiryByResponse.set(wrapped, expiry);
  return wrapped;
}

/**
 * Wrap an in-stream retry closure so the REPLACEMENT stream carries its own
 * watchdog (#65 review). The original wrap has disarmed by the time a retry
 * fires — the triggering in-stream error chunk is itself a `data:` line, and
 * "once seen, the timer is cleared and never rearmed" — so a bare doFetch()
 * response would be unbounded: a mute-but-200 replacement upstream hangs the
 * client exactly as #108 confines. Non-ok / bodyless responses pass through
 * unchanged (the caller surfaces the original error for those).
 */
export function boundRetryUpstream(
  retryUpstream: () => Promise<Response | null>,
  label: string
): () => Promise<Response | null> {
  return async () => {
    const r = await retryUpstream();
    return r?.ok && r.body ? withFirstUsefulEventWatchdog(r, label) : r;
  };
}
