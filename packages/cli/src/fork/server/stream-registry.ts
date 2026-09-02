/**
 * Stream registry (fork extension) — counts in-flight SSE responses so an
 * operator can DRAIN before restarting the proxy, and reports whether those
 * streams are still MOVING so a wedged proxy can be told apart from a busy one.
 *
 * Why this exists. A `docker restart` kills every in-flight SSE stream
 * mid-body, and the client reports:
 *
 *     API Error: Connection lost mid-response. The response above may be
 *     incomplete.
 *
 * The agent turn is lost. The proxy itself never breaks a stream — there is not
 * a single `controller.error()` in the codebase, and every terminating path
 * (including `finalizeWithError` on an upstream socket death) emits the terminal
 * `message_stop`. So a client-visible drop means the socket died UNDER us: the
 * process went away, or the network reset.
 *
 * The main source of process death is our own operator tooling
 * (`scripts/claudish-watchdog.ps1`): a periodic proactive restart plus a restart
 * on a failed liveness probe. It restarts blind because it has no way to see
 * in-flight work. This registry is that missing signal — `/health` reports the
 * count, and the watchdog waits for it to reach zero.
 *
 * LIVENESS (2026-09-02). Counting alone says how much work is in flight, never
 * whether it is progressing, and `/health` used to report only the count plus an
 * uptime — four lines that touch nothing in the request pipeline. On 2026-09-02
 * the hub went silent at 03:20:45Z and served nothing until a manual reboot at
 * 05:47Z: 2h27, fleet-wide. Every sidecar kept relaying into it, because the
 * prober's whole notion of "hub alive" is a 200 from that endpoint, and a
 * process that still answers a constant-time JSON handler answers it while
 * serving nobody. `relay.ts` names this exact hole and calls it "never observed";
 * it has now been observed once, and it cost every machine its morning.
 *
 * So the tracker also stamps the last moment ANY byte reached ANY client. With
 * streams in flight and no byte for a long while, the pipeline is wedged — that
 * is a fact only this layer can see, and `/health` turns it into the 503 the
 * sidecars already know how to act on.
 *
 * What the stamp actually measures is ARRIVAL from upstream: the wrapper pulls
 * one chunk ahead, so it is refreshed when bytes land, not when the client
 * consumes them. That is the right signal — a wedged upstream stops producing —
 * with one known corner: a client that stops reading for longer than the
 * threshold while holding a stream open would read as stalled. At three minutes
 * that client is itself pathological, and the cost is one demotion.
 *
 * The asymmetry that sets the threshold: a false positive demotes the fleet to
 * AUTONOMOUS for ~a minute, a false negative is the outage above. But a demotion
 * is not free either (an unarmed sidecar cascade meets a provider wall), so the
 * bound is deliberately far above any legitimate silence. Measured on this hub:
 * upstream header waits reach ~23s (`[ttft] headers=22733ms`) and whole streams
 * run 50s, while bytes inside a live stream arrive continuously. `activeStreams`
 * is also required to be non-zero, so an idle hub is never called stalled.
 *
 * NEVER-HANG: the wrapper is a pure passthrough. No parsing, no buffering, and
 * it never calls `controller.error()` — a counting wrapper must not become a new
 * way for a stream to break. On a read exception it closes cleanly (the parsers
 * have already emitted their terminal events by then). The liveness stamp is a
 * single assignment on a path that already runs per chunk.
 */

import type { Context, MiddlewareHandler } from "hono";

export interface StreamTracker {
  /** Hono middleware — mount with `app.use("*", tracker.middleware)`. */
  middleware: MiddlewareHandler;
  /** Number of SSE responses currently streaming to clients. */
  getActiveStreams: () => number;
  /**
   * Milliseconds since the last byte was handed to any client stream. Seeded at
   * process start, so it is never null and needs no special-casing by callers.
   */
  getMsSinceLastByte: () => number;
  /**
   * True when work is in flight but nothing has moved for `thresholdMs`.
   * `thresholdMs <= 0` disables the verdict entirely (always false).
   */
  isStalled: (thresholdMs: number) => boolean;
}

const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * Default silence budget before a busy proxy is called wedged. Generous on
 * purpose — see the asymmetry note above. Override with
 * `CLAUDISH_STALL_THRESHOLD_MS`; `0` disables the 503.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 180_000;

/** Read per call, never cached: this is the knob an operator turns mid-incident. */
export function stallThresholdMs(): number {
  const raw = process.env.CLAUDISH_STALL_THRESHOLD_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_THRESHOLD_MS;
  const n = Number(raw);
  // Garbage must not silently disable the detector, nor invent a tiny threshold
  // that would flap the whole fleet: fall back to the documented default.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALL_THRESHOLD_MS;
  return n;
}

export function createStreamTracker(): StreamTracker {
  let activeStreams = 0;
  let lastByteAt = Date.now();

  const middleware: MiddlewareHandler = async (c: Context, next) => {
    await next();

    const res = c.res;
    const body = res.body;
    if (!body) return;
    if (!(res.headers.get("content-type") || "").includes(SSE_CONTENT_TYPE)) return;

    activeStreams++;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeStreams--;
      // A stream ending IS progress: without this, the last stream to finish
      // would leave a stale stamp behind for the next one to be judged on.
      lastByteAt = Date.now();
    };

    const reader = body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            finish();
            return;
          }
          lastByteAt = Date.now();
          controller.enqueue(value);
        } catch {
          controller.close();
          finish();
        }
      },
      cancel(reason) {
        try {
          void reader.cancel(reason);
        } catch {}
        finish();
      },
    });

    c.res = new Response(counted, { status: res.status, headers: res.headers });
  };

  return {
    middleware,
    getActiveStreams: () => activeStreams,
    getMsSinceLastByte: () => Date.now() - lastByteAt,
    isStalled: (thresholdMs: number) =>
      thresholdMs > 0 && activeStreams > 0 && Date.now() - lastByteAt > thresholdMs,
  };
}
