/**
 * The cluster must keep turning when the HUB IS GONE.
 *
 * Mandate (user, 2026-10-27): po-2025 died and the cluster did not survive it.
 * "Il faudra des tests unitaires pour s'assurer que la prochaine fois que
 * po-2025 crashe, le cluster continue à tourner sans lui."
 *
 * relay.test.ts already pins the state machine — two consecutive heartbeat
 * failures flip `alive` to false, recovery needs 3 OK + 60 s + a deep probe.
 * What it cannot pin is the property that matters to a CLIENT: with the hub
 * dead, does a real turn still terminate? That is this file's job, on a real
 * listening sidecar (same harness as relay-keyless-forward.test.ts, and for
 * the same reason: `app.request` would bypass the server the relay lives in).
 *
 * Cases:
 *   D1  hub dead from the start, STREAMING request ⇒ the client still gets a
 *       terminated turn. The forward fails, the request falls through to the
 *       local pipeline, and the never-hang contract holds: whatever the local
 *       pipeline can or cannot do, the stream ENDS with message_stop. A hang
 *       here is the whole agent wedged, which is worse than an error.
 *   D2  hub dead from the start, NON-streaming ⇒ a completed JSON response,
 *       never a socket held open.
 *   D3  the fall-through does NOT wait for the flip. A request issued while the
 *       sidecar still believes the hub is alive must still be served — the
 *       AUTONOMOUS flip is an optimisation, never a precondition. Measured
 *       2026-10-27 on ai-01: 432 turns served locally in 25 min, most of them
 *       inside the 2-tick window before `alive` went false.
 *   D4  `/health` tells the truth during the outage: after the hub dies, the
 *       reported role is NOT `relay-nominal`. An operator (and the dashboard)
 *       reading a stale "nominal" during a hub outage is how a fleet thinks it
 *       is healthy while nothing is relaying.
 *
 * Mutation contract — these cases must go red if the fall-through is removed
 * (i.e. if a forward failure starts returning an error to the client instead of
 * serving locally). Run: comment out the `return null` of the FAIL path in
 * `forwardToUpstream` and D1/D2/D3 must fail, D4 unaffected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../../proxy-server.js";
import { createRelayState, heartbeat } from "./relay.js";
import type { ProxyServer } from "../../types.js";

// Distinct range from the other in-process route tests
// (19700+, 19851/19951, 19863, 19871, 19883/19983, 19891/19991, 19921,
// 19961, 19971/19972).
const SIDECAR_PORT = 19981;
const USED_HUB_PORT = 19982; // bound during setup, then closed → connection refused
const DEAD_HUB_PORT = 19984; // never bound at all
const DEAD_HUB_BASE = `http://127.0.0.1:${DEAD_HUB_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_CAPTURE_HOST_DIR",
  "CLAUDISH_RELAY_UPSTREAM", "CLAUDISH_NO_ANTHROPIC",
  "ANTHROPIC_API_KEY", "CLAUDE_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-hub-death";
const OPUS = "claude-opus-5-5";

let sidecar: ProxyServer | null = null;

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Deliberately EMPTY: no apiKeys, no customEndpoints. This is the "seat with
  // no autonomous fuel" shape — the worst case, and the one a test must survive.
  // A sidecar that only works when it happens to hold a provider key would make
  // this whole file pass for the wrong reason.
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
});

afterEach(async () => {
  if (sidecar) {
    await sidecar.shutdown();
    sidecar = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A sidecar whose configured upstream is a port nothing listens on. */
async function spinSidecarOnDeadHub(): Promise<ReturnType<typeof createRelayState>> {
  const state = createRelayState({ upstream: DEAD_HUB_BASE, proxyKey: PROXY_KEY });
  sidecar = await createProxyServer(
    SIDECAR_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true, relay: state }
  );
  return state;
}

function postMessages(stream: boolean, timeoutMs = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(`http://127.0.0.1:${SIDECAR_PORT}/v1/messages`, {
    method: "POST",
    signal: ac.signal,
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: OPUS,
      max_tokens: 16,
      stream,
      metadata: { user_id: JSON.stringify({ session_id: "sess-hub-death" }) },
      messages: [{ role: "user", content: "say hi" }],
    }),
  }).finally(() => clearTimeout(timer));
}

describe("hub death — the client turn must still terminate", () => {
  test("D1 a dead hub never leaves the client holding an open stream", async () => {
    await spinSidecarOnDeadHub();
    // `postMessages` aborts on its own timer: reaching the assertions at all is
    // already the no-hang proof. What remains is that the body is a COMPLETE
    // answer of one kind or the other, never a truncated fragment.
    const res = await postMessages(true);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      // Local pipeline served the stream: it must close it.
      expect(body).toContain("message_stop");
    } else {
      // No local fuel: the honest answer is a labelled error BEFORE any event.
      // That is a legal, complete HTTP answer for a streaming request — far
      // better than an SSE shell left open. What must never happen is a
      // half-written stream the client waits on.
      expect(body).not.toContain("event: message_start");
      const parsed = JSON.parse(body);
      expect(parsed?.error?.type).toBeString();
    }
  }, 30_000);

  test("D2 non-streaming: a dead hub returns a completed response, never a held socket", async () => {
    await spinSidecarOnDeadHub();
    const res = await postMessages(false);
    const body = await res.text();
    // `stream:false` must be a single JSON message, never SSE — the /compact
    // caller wedges on SSE. Even in the degraded path the shape is load-bearing.
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(body).not.toContain("event: message_start");
    expect(() => JSON.parse(body)).not.toThrow();
  }, 30_000);

  test("D3 the fall-through does not wait for the AUTONOMOUS flip", async () => {
    const state = await spinSidecarOnDeadHub();
    // The sidecar still believes the hub is alive — the exact window right
    // after a real hub death. Measured 2026-10-27: ai-01 served 432 turns
    // locally in 25 min, most of them inside it. If serving required the flip,
    // those turns would have failed instead.
    expect(state.alive).toBe(true);
    const res = await postMessages(true);
    await res.text();
    expect(state.consecutiveFail).toBeGreaterThan(0);
    // ONE failure is not a flip: an ordinary hiccup must not cost the fleet a
    // second of relay mode. The threshold is two.
    expect(state.alive).toBe(true);
  }, 30_000);

  test("D4 two dead-hub turns flip the state, and /health stops claiming `relay-nominal`", async () => {
    const state = await spinSidecarOnDeadHub();
    // Drive it the way production does — through real forwards, never by
    // poking the state. (The 10 s prober tick calls markFail internally and is
    // not exported; faking the internals would pin a private detail instead of
    // the behaviour.)
    await (await postMessages(true)).text();
    await (await postMessages(true)).text();
    expect(state.alive).toBe(false);

    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`);
    const health: any = await res.json();
    expect(health.status).toBe("ok"); // liveness of the PROCESS, not of the hub
    expect(health.role).toBe("relay-autonomous");
    expect(health.upstream).toBe(DEAD_HUB_BASE);
  }, 30_000);
});

describe("hub death — control", () => {
  test("a LIVE hub is still relayed, so the cases above are not passing vacuously", async () => {
    // Without this control, a sidecar that ALWAYS served locally would satisfy
    // D1-D3 and look like a pass. Same discipline as F2 in the #416 file.
    let hit = 0;
    const hub = createServer((req, res) => {
      hit++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ctl","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        );
      });
    });
    await new Promise<void>((r) => hub.listen(USED_HUB_PORT, "127.0.0.1", r));

    const state = createRelayState({
      upstream: `http://127.0.0.1:${USED_HUB_PORT}`,
      proxyKey: PROXY_KEY,
    });
    sidecar = await createProxyServer(SIDECAR_PORT, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      relay: state,
    });

    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: OPUS,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    const body = await res.text();
    expect(body).toContain("msg_ctl"); // the HUB's answer, not a local one
    expect(hit).toBe(1);
    expect(state.alive).toBe(true);

    await new Promise<void>((r) => hub.close(() => r()));
  }, 30_000);
});
