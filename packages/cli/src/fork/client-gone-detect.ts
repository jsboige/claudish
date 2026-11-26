/**
 * #1209 (2/2) — does THIS runtime surface a `stream:false` client's departure
 * before any write?
 *
 * The fix reads `c.req.raw.signal`, which @hono/node-server aborts from the
 * response's own 'close'. Whether that event ever fires while a `stream:false`
 * handler waits on its upstream is a property of the RUNTIME, not of this code.
 * Measured 2026-11-26 on the official images with identical deps (hono@4,
 * @hono/node-server@1.19.19 — the version the deployed image carries):
 *
 * - bun 1.3.14 (`oven/bun:1.3-alpine`, the image the fleet runs): FIN 0/3,
 *   RST 0/3 — NO event of any kind fires (incoming / socket / outgoing), the
 *   socket stays `open` and `destroyed=false` 1200 ms in, and forcing it to
 *   flow (`resume()` / a `data` listener / `readable`) reveals nothing. There is
 *   no pre-write detection on that runtime at any layer the handler can reach.
 * - bun 1.4.5 (`oven/bun:1.4-alpine`): FIN 3/3, RST 1/1 — the signal aborts
 *   190-200 ms after the client's destroy.
 *
 * So the capability depends on the Bun version alone (platform ruled out: linux
 * 1.4.5 and win32 1.4.3 both flip, linux 1.3.14 never does), and a proxy that
 * believes it cancels while it cannot is the worst shape: the deploy looks done
 * and the incident repeats unchanged. The process therefore MEASURES the
 * capability at boot, on its own adapter + runtime, and publishes the verdict —
 * `/health` `clientGoneDetect` plus one stderr line when the answer is not the
 * healthy one. A fleet-rollout verification artifact is then one grep per
 * container, never an assumption.
 *
 * Never throws, never blocks startup: fire-and-forget, bounded (≈ 2 s worst
 * case), `CLAUDISH_CLIENT_GONE_PROBE=0` disables it.
 */

import { connect } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { log } from "../logger.js";

export type ClientGoneDetection =
  | "pending"
  | "detected"
  | "undetected"
  | "disabled"
  | `error:${string}`;

const PROBE_PATH = "/__client_gone_probe";
const PROBE_TIMEOUT_MS = 1500;

let verdict: ClientGoneDetection = "pending";

/** The boot probe's verdict, published on `/health`. */
export function getClientGoneDetection(): ClientGoneDetection {
  return verdict;
}

/** Test seam only — production reads what the probe measured. */
export function setClientGoneDetectionForTests(v: ClientGoneDetection): void {
  verdict = v;
}

export interface ProbeOutcome {
  detected: boolean;
  /** The probe request REACHED the handler — a zero needs a witness: without
   * this, "listener never wired" and "signal never flips" look identical. */
  arrived: boolean;
}

/**
 * Pure: what ONE round trip means. Exposed for its pin — the "detected" and
 * "undetected" branches cannot both be exercised on a single runtime (a
 * runtime either surfaces the departure before the first write or does not),
 * so the classification is pinned here rather than through the probe alone.
 */
export function verdictOf(
  outcome: ProbeOutcome
): Exclude<ClientGoneDetection, "pending" | "disabled"> {
  if (!outcome.arrived) return "error:no-arrival";
  return outcome.detected ? "detected" : "undetected";
}

/**
 * One loopback round trip: a private `serve()` on port 0 (same adapter + runtime
 * as the proxy), a complete `stream:false`-shaped POST, then the client destroys
 * its socket before any answer. "detected" ⇔ the handler's own
 * `c.req.raw.signal` aborted. Exposed for the pin in
 * `proxy-server-client-gone.test.ts`.
 */
export async function probeClientGoneDetection(
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ClientGoneDetection> {
  let resolveOutcome: (o: ProbeOutcome) => void = () => {};
  const outcome = new Promise<ProbeOutcome>((res) => {
    resolveOutcome = res;
  });
  let arrived = false;
  let reported = false;
  const report = (detected: boolean) => {
    if (reported) return;
    reported = true;
    resolveOutcome({ detected, arrived });
  };

  const app = new Hono();
  app.post(PROBE_PATH, async (c) => {
    arrived = true;
    try {
      await c.req.json(); // consume the body, as the proxy's route does
    } catch {
      // an empty body still measures the signal — never a reason to fail
    }
    const signal = c.req.raw.signal;
    if (signal.aborted) {
      report(true);
      return c.body(null, 200);
    }
    const onAbort = () => report(true);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => report(false), timeoutMs);
    await outcome; // resolved by the abort listener or the timeout above
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    return c.body(null, 200);
  });

  let server: ReturnType<typeof serve> | undefined;
  try {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((res) => {
      const done = () => res();
      try {
        (server as unknown as { once?: (e: string, f: () => void) => void }).once?.(
          "listening",
          done
        );
      } catch {
        done();
      }
      setTimeout(done, 400); // already listening, or will never be
    });
    const addr = (server as unknown as { address?: () => unknown }).address?.();
    const port =
      typeof addr === "object" && addr && "port" in addr
        ? Number((addr as { port?: number }).port)
        : 0;
    if (!port) return "error:listen";

    await new Promise<void>((res) => {
      const payload = JSON.stringify({ probe: true });
      let sock: ReturnType<typeof connect> | undefined;
      const finish = () => res();
      try {
        sock = connect(port, "127.0.0.1", () => {
          sock?.write(
            `POST ${PROBE_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
          );
          // The departure: a client that leaves before its answer is written.
          setTimeout(() => {
            try {
              sock?.destroy();
            } catch {
              // already gone
            }
            finish();
          }, 50);
        });
        sock.on("error", finish);
      } catch {
        finish();
      }
      setTimeout(finish, 500); // the socket never holds the probe
    });

    const o = await Promise.race([
      outcome,
      new Promise<ProbeOutcome>((res) =>
        setTimeout(() => res({ detected: false, arrived }), timeoutMs + 250)
      ),
    ]);
    return verdictOf(o); // never reached the handler ⇒ an instrument error, not "undetected"
  } catch (e) {
    return `error:${String((e as Error)?.message ?? e).slice(0, 40)}`;
  } finally {
    try {
      (server as unknown as { close?: (cb?: () => void) => void })?.close?.();
    } catch {
      // already gone
    }
  }
}

/**
 * Boot entry: measure in the background, publish the verdict, say it out loud
 * only when the capability is missing (a healthy capability is not news; a
 * silent inertness is how #1209 survives a "fixed" deploy).
 */
export function startClientGoneDetectionProbe(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.CLAUDISH_CLIENT_GONE_PROBE || "").trim() === "0") {
    verdict = "disabled";
    return;
  }
  probeClientGoneDetection()
    .then((v) => {
      verdict = v;
      if (v === "detected") return;
      log(
        `[ClientGone] runtime capability ${v} — a stream:false client's departure is ${
          v === "undetected"
            ? "not visible before the first write on this runtime (bun < 1.4); cancellation is INERT until the image moves to bun >= 1.4"
            : "unmeasured"
        } (#1209 2/2)`,
        true // forceConsole — operational event, the fleet-verification grep
      );
    })
    .catch(() => {
      verdict = "error:probe";
    });
}
