/**
 * #299-B — the one-shot overload walk, ported to `replatform/v14`.
 *
 * The defect it removes: a transient 529 (or a 429/503 whose body names an
 * overload, or the proxy's own 400 `connection_error` synthesis) on the
 * NOMINAL is a PROVIDER saying "unreachable / overloaded" — not the role's
 * plan being walled. Measured 2026-10-02 on the hub: 30 % of MiniMax attempts
 * failed so, and the client retried a dozen times against the same overloaded
 * provider before dropping the turn. The walk tries the FIRST SERVABLE
 * cascade step ONCE, for this request only, and writes NO failure state — no
 * arm, no step mark, no bucket wall, no dwell pin — so the moment the overload
 * lifts the next request re-probes the nominal instead of riding a cascade the
 * role was never exiled to.
 *
 * Harness: same contract as proxy-server-serving-note-route.test.ts — the REAL
 * proxy runs on an ephemeral port, the fake endpoints register through the
 * proxy's own entry point (no config file is written), and the outbound legs
 * are answered by a stubbed fetch. The instrument is the per-endpoint CALL
 * COUNT plus the state predicates: "the walk wrote nothing" is measured by
 * REQUEST 2 still trying (nominal, then the SAME first servable step) rather
 * than by the absence of a log line.
 *
 * v14 shape: no `forceTarget` seam exists on this base — `getHandlerForRequest`
 * is single-arg and the loop swaps the step in itself, so the walk serves its
 * concrete through the same construction path a step attempt uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  armFailover,
  isBucketWalled,
  isFailoverActive,
  markStepFailed,
  providerBucketOf,
  resetFailoverForTests,
  resolveTransientStep,
  setRoleNominalResolver,
} from "./fork/failover.js";
import {
  isConnectionWalkClass,
  isOverloadWalkClass,
  isTransientOverload,
} from "./handlers/composed-handler.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

let calls: Record<string, number> = {};
/** Per-endpoint HTTP status override. Absent ⇒ 200 healthy SSE. */
let endpointStatus: Record<string, number> = {};
/** Per-endpoint artificial latency, for the walk-budget pin. */
let endpointDelayMs: Record<string, number> = {};

const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODING_API_KEY",
  "LITELLM_API_KEY",
  "POE_API_KEY",
  "DEEPSEEK_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_DEFAULT_PROVIDER",
];
/** Plus a FULL CLAUDISH_FAILOVER_* wipe: this seat's interactive shells carry
 *  the real cascade env, and the switches under test must start absent. */
let sandboxedFailoverKeys: string[] = [];
let savedFailoverEnv: Record<string, string | undefined> = {};
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

function healthySSE(): Response {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-c",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "Hello from the cascade." }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/** The error shapes the walk answers to (and the ones it must NOT). */
function errorBodyFor(status: number): string {
  if (status === 529)
    return JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } });
  if (status === 503)
    return JSON.stringify({ error: { type: "overloaded_error", message: "service unavailable" } });
  if (status === 400)
    return JSON.stringify({
      type: "error",
      error: { type: "connection_error", message: "connect ECONNREFUSED" },
    });
  if (status === 429)
    return JSON.stringify({
      error: { type: "rate_limit_error", message: "Too many requests — slow down" },
    });
  return JSON.stringify({ error: { type: "internal_error", message: "boom" } });
}

const SONNET_NOMINAL = "nm-ep@fake-nm";

/** sonnet: nominal nm → two steps s0, s1. NOT armed by default — the walk is
 *  precisely the path that serves a substitute without arming the role. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_SONNET_LABEL: "S0 Fake",
  CLAUDISH_FAILOVER_SONNET_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** Re-init the module with the cascade env and re-inject the nominal resolver
 *  (resetFailoverForTests clears it; the proxy injected its own at startup). */
function armCascade(): void {
  resetFailoverForTests({ ...CASCADE_ENV });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

async function postMessage(
  opts: { model?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Register the fake providers through the SAME entry point the proxy uses,
 *  with an explicit config: no file is written, so a crashed run cannot leave
 *  a machine's real `~/.claudish/config.json` overwritten. */
function registerFakeEndpoints(): void {
  const ep = (name: string) => ({
    kind: "simple",
    url: `http://fake.invalid/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  ensureEndpointsRegistered({
    config: {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "nm-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
      },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, native: 0 };
  endpointStatus = { nm: 529, native: 529 };
  endpointDelayMs = {};
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sandboxedFailoverKeys = Object.keys(process.env).filter((k) =>
    k.startsWith("CLAUDISH_FAILOVER_")
  );
  savedFailoverEnv = {};
  for (const k of sandboxedFailoverKeys) {
    savedFailoverEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any) => {
    // Request / URL instances reach here too (the native lane builds a
    // Request); reading only `input.url` would silently fall through to the
    // catch-all 200 and make a native 529 look like a healthy answer.
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? "");
    let which: string;
    if (url.startsWith("http://fake.invalid/")) {
      which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    } else if (url.includes("api.anthropic.com")) {
      which = "native";
    } else {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    calls[which] = (calls[which] ?? 0) + 1;
    const delay = endpointDelayMs[which] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const status = endpointStatus[which] ?? 200;
    if (status === 200) return healthySSE();
    return new Response(errorBodyFor(status), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const k of sandboxedFailoverKeys) {
    const v = savedFailoverEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFailoverForTests();
});

/** Default spin: sonnet → the fake custom endpoint. The modelMap mirrors the
 *  hub wiring: the ROLE keyword picks the lane, so "claude-sonnet-5" resolves
 *  to the custom-endpoint nominal — without it the route hands the bare
 *  claude-* name to NativeHandler. W7 passes an EMPTY map plus a stub sk-ant
 *  key so the nominal IS native (the walk's own exclusion). */
async function spin(
  map: Record<string, string> | null = { sonnet: SONNET_NOMINAL },
  apiKey?: string
): Promise<void> {
  activeProxy = await createProxyServer(0, undefined, undefined, false, apiKey, map ?? {}, {
    quiet: true,
  });
}

// ─── module pins ─────────────────────────────────────────────────────────────

describe("#299-B — isOverloadWalkClass pins every clause the walk answers to", () => {
  test("529 and 503 are overload", () => {
    expect(isOverloadWalkClass(529, "")).toBe(true);
    expect(isOverloadWalkClass(529, '{"error":{"type":"overloaded_error"}}')).toBe(true);
    expect(isOverloadWalkClass(503, "")).toBe(true);
    expect(isOverloadWalkClass(503, "service unavailable")).toBe(true);
  });

  test("429 counts only when the body names an overload (never a plain burst)", () => {
    expect(isOverloadWalkClass(429, "The server cluster is overloaded")).toBe(true);
    expect(isOverloadWalkClass(429, "try again later")).toBe(true);
    expect(isOverloadWalkClass(429, "concurrency limit reached")).toBe(true);
    expect(isOverloadWalkClass(429, "Too many requests — slow down")).toBe(false);
    expect(isOverloadWalkClass(429, "")).toBe(false);
  });

  test("400 counts only for the proxy's own connection_error synthesis", () => {
    expect(isOverloadWalkClass(400, '{"type":"error","error":{"type":"connection_error"}}')).toBe(
      true
    );
    expect(isConnectionWalkClass(400, '{"type":"error","error":{"type":"connection_error"}}')).toBe(
      true
    );
    expect(
      isOverloadWalkClass(400, '{"type":"error","error":{"type":"invalid_request_error"}}')
    ).toBe(false);
    expect(isOverloadWalkClass(400, "")).toBe(false);
  });

  test("502/504 are NOT the walk's class (nothing names an overload)", () => {
    expect(isOverloadWalkClass(502, "")).toBe(false);
    expect(isOverloadWalkClass(504, "")).toBe(false);
    expect(isOverloadWalkClass(500, "internal error")).toBe(false);
    expect(isTransientOverload(500, "internal error")).toBe(false);
  });
});

describe("#299-B — resolveTransientStep is read-only resolution, no last-step fallback", () => {
  test("picks the first servable step and returns its concrete", async () => {
    armCascade();
    const walk = await resolveTransientStep("sonnet");
    expect(walk?.stepIndex).toBe(0);
    expect(walk?.concrete).toBe("s0-ep@fake-s0");
  });

  test("a step in per-step backoff is skipped — the walk never re-pays a known-dead target", async () => {
    armCascade();
    markStepFailed("sonnet", 0, "HTTP 500 (test)");
    const walk = await resolveTransientStep("sonnet");
    expect(walk?.stepIndex).toBe(1);
    // …and the mark it read is the ONLY state: resolution wrote nothing new.
    const again = await resolveTransientStep("sonnet");
    expect(again?.stepIndex).toBe(1);
  });

  test("a WALLED provider bucket is skipped, and so is the NOMINAL's own bucket", async () => {
    armCascade();
    armFailover("sonnet", "test: s0 bucket walled", providerBucketOf("s0-ep@fake-s0"));
    expect(isBucketWalled(providerBucketOf("s0-ep@fake-s0"))).toBe(true);
    expect((await resolveTransientStep("sonnet"))?.stepIndex).toBe(1);
    resetFailoverForTests({ ...CASCADE_ENV });
    setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
    const walk = await resolveTransientStep("sonnet", {
      nominalBucket: providerBucketOf("s0-ep@fake-s0"),
    });
    expect(walk?.stepIndex).toBe(1); // same bucket as the 529 that just refused
  });

  test("a role-step whose delegation cannot resolve is SKIPPED, never routed as a model id", async () => {
    resetFailoverForTests({ CLAUDISH_FAILOVER_SONNET: "role:haiku" });
    const walk = await resolveTransientStep("sonnet");
    expect(walk).toBeNull(); // no last-step fallback: surface the original overload
  });

  test("every step unservable ⇒ null, never the last step anyway", async () => {
    armCascade();
    markStepFailed("sonnet", 0, "HTTP 500 (test)");
    markStepFailed("sonnet", 1, "HTTP 500 (test)");
    expect(await resolveTransientStep("sonnet")).toBeNull();
  });
});

// ─── route pins ──────────────────────────────────────────────────────────────

describe("#299-B — a nominal overload walks the cascade ONCE, writing zero failure state", () => {
  test("W1: nominal 529 → step 0 serves; no arm, no bucket wall", async () => {
    await spin();
    armCascade();
    expect(isFailoverActive("sonnet")).toBe(false);

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);
    // A SERVED walk writes success bookkeeping, never failure state.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(providerBucketOf("s0-ep@fake-s0"))).toBe(false);
  }, 30_000);

  test("W2: the walk writes NO step mark — request 2 tries the nominal again, then the SAME step 0", async () => {
    await spin();
    armCascade();
    expect((await postMessage()).status).toBe(200);
    const r2 = await postMessage();
    expect(r2.status).toBe(200);
    // The nominal is re-probed (no arm, no dwell pin)…
    expect(calls.nm).toBe(2);
    // …and step 0 is still the FIRST servable step (a mark would have sent the
    // second walk to s1).
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W3: kill switch CLAUDISH_FAILOVER_OVERLOAD_WALK=0 → the 529 surfaces, no walk", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK = "0"; // read per request off process.env
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W4: nominal 529 arriving PAST the walk budget → skip, original surfaces", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_WALK_BUDGET_MS = "50";
    endpointDelayMs.nm = 120;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
  }, 30_000);

  test("W5: the walk step ALSO fails → the client gets the ORIGINAL overload, and nothing is marked", async () => {
    await spin();
    endpointStatus.s0 = 529;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(529); // the nominal's own shape, not the step's
    expect(calls.s0).toBe(1);
    // No mark on step 0: the next request walks there again rather than to s1.
    expect((await postMessage()).status).toBe(529);
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);

  test("W6: a NON-overload nominal failure (500) does not walk — the user's own model failing surfaces", async () => {
    await spin();
    endpointStatus.nm = 500;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W7: a NATIVE-lane 529 does NOT walk — the client's own credential, never a silent substitution", async () => {
    await spin({}, "sk-ant-test-walk");
    resetFailoverForTests({ ...CASCADE_ENV });
    setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));

    const r1 = await postMessage({ headers: { "x-api-key": "sk-ant-test-walk" } });
    expect(r1.status).not.toBe(200);
    expect(calls.native).toBe(1); // the nominal WAS reached and refused
    expect(calls.s0).toBe(0); // the walk is excluded on the native lane
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W8: HTTP 400 connection_error on the nominal walks (#298 A clause)", async () => {
    await spin();
    endpointStatus.nm = 400;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
  }, 30_000);

  test("W9: a 429 BURST (no overload wording) neither walks nor arms", async () => {
    await spin();
    endpointStatus.nm = 429; // body: "Too many requests — slow down"
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);
});
