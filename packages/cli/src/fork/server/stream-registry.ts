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
 * uptime — four lines that touch nothing in the request pipeline. A process that
 * still answers a constant-time JSON handler answers it while serving nobody, and
 * `relay.ts` names that hole and calls it "never observed".
 *
 * It is STILL never observed, and this file was first written on the belief that
 * the 2026-09-02 outage had observed it. That belief was wrong, twice over, and
 * both corrections are worth keeping because each one looked convincing:
 *
 *   - The sidecars did NOT keep relaying into a hub that answered while serving
 *     nobody. ai-01 measured 94 requests served locally across the whole window,
 *     zero lost — its prober failed over correctly, because `/health` was not
 *     answering either. What died were interactive sessions pointed straight at
 *     the hub, which never consult a sidecar. That is topology, not liveness.
 *   - The hub did not wedge. The Windows event log records, 25 seconds before its
 *     last response, `Id 26: "Windows — insufficient virtual memory"`, then cmd.exe
 *     failing to launch, then Google Drive unmounting G:, then IIS pools unable to
 *     stop. The host ran out of commit charge; the proxy could not allocate, so
 *     nothing listened on :3000 and ai-01 measured `Connection refused`. A refused
 *     connection is not a blind health check.
 *
 * So this detector did not fix that outage and would not have caught it — no
 * endpoint answers when the process cannot allocate. It is kept on its own merit:
 * a wedged pipeline behind a live event loop is a real shape, cheap to detect
 * here and nowhere else, and the 503 is one the sidecars already know how to act
 * on. Claiming an incident it did not prevent would just make the next reader
 * trust the wrong signal.
 *
 * So the tracker also stamps the last moment anything PROGRESSED, and reports
 * whether work is in flight. Work in flight with no progress for a long while is
 * a wedged pipeline — a fact only this layer can see, and `/health` turns it into
 * the 503 the sidecars already know how to act on.
 *
 * "Work in flight" deliberately spans BOTH sides of `await next()`. Counting only
 * SSE bodies would miss the likelier shape of a wedge: a request that never gets
 * as far as producing a response at all (a dead upstream socket with no timeout,
 * a deadlock on a shared resource). Those requests are invisible to a body
 * wrapper — the middleware is still sitting in `next()` — yet they are exactly
 * the ones an operator would call "hung". So pending requests are counted from
 * entry, and progress is stamped on every byte, every stream end, and every
 * completed response.
 *
 * `/health` itself is excluded from both. Each sidecar polls it every 10s, so
 * counting it as progress would refresh the stamp forever and leave the detector
 * permanently blind — it would report a healthy hub precisely because it was
 * being asked whether it was healthy.
 *
 * The byte stamp measures ARRIVAL from upstream: the wrapper pulls one chunk
 * ahead, so it is refreshed when bytes land, not when the client consumes them.
 * That is the right signal — a wedged upstream stops producing.
 *
 * Two known corners, both costing at most one demotion: a client that stops
 * reading for longer than the threshold while holding a stream open, and a
 * single long non-streaming request (a `stream:false` condensation) on an
 * otherwise idle hub. Any other request completing refreshes the stamp, so on a
 * hub with traffic neither fires.
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
  /** Requests inside the handler chain that have not yet produced a response. */
  getPendingRequests: () => number;
  /**
   * Milliseconds since anything last progressed — a byte streamed, a stream
   * ended, or a response completed. Seeded at process start, so it is never null
   * and needs no special-casing by callers.
   */
  getMsSinceProgress: () => number;
  /**
   * True when work is in flight but nothing has progressed for `thresholdMs`.
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

/**
 * Paths that must not feed the detector. See the header: the prober's own poll
 * would otherwise stand in for the work it is asking about.
 */
const LIVENESS_EXEMPT_PATHS = new Set(["/health"]);

export function createStreamTracker(): StreamTracker {
  let activeStreams = 0;
  let pendingRequests = 0;
  let lastProgressAt = Date.now();

  const middleware: MiddlewareHandler = async (c: Context, next) => {
    if (LIVENESS_EXEMPT_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    pendingRequests++;
    try {
      await next();
    } finally {
      // `finally`, so a throwing handler cannot pin the counter above zero and
      // wedge the detector into a permanent stall verdict.
      pendingRequests--;
      lastProgressAt = Date.now();
    }

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
      lastProgressAt = Date.now();
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
          lastProgressAt = Date.now();
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
    getPendingRequests: () => pendingRequests,
    getMsSinceProgress: () => Date.now() - lastProgressAt,
    isStalled: (thresholdMs: number) =>
      thresholdMs > 0 &&
      (activeStreams > 0 || pendingRequests > 0) &&
      Date.now() - lastProgressAt > thresholdMs,
  };
}
