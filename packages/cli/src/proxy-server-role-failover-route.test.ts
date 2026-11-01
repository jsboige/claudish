/**
 * #641 G8 — ROUTE-level pins for the FIRST budget-failover wiring on
 * `replatform/v14`: both ingress routes now serve through `handleWithCascade`,
 * so a role substitution is real and `applyFailoverNotices` is live.
 *
 * Why this file is not a copy of the fork's `proxy-server-role-failover-route`:
 * the fork's version pins #609 in-request delegation walks, #331 concrete-keyed
 * revisit guards and #554 sync-twin decisions — sites that DO NOT EXIST in this
 * first wiring (the deliberately-narrower-than-main gap list lives with the
 * wiring block in proxy-server.ts). What exists here is pinned; the deferred
 * semantics are named so nothing looks covered when it is not.
 *
 * Harness: the G6 session-budget pattern — the REAL proxy on an ephemeral port,
 * custom endpoints registered through the proxy's own entry point (no config
 * file written), only the outbound legs answered by a stubbed fetch.
 *
 * Mutation table — every row was RUN against this file (throwaway copy), not
 * reasoned about:
 *  - serve the nominal on every attempt (drop the `serveModel` swap) ⇒ W1, W4,
 *    W5 and W6 red (the substitute never serves: 402 surfaces, s0 uncalled);
 *  - drop the `isQuotaExhaustion` gate (treat every !ok as a wall) ⇒ W3 red
 *    (a 500 arms the role and serves s0);
 *  - drop the #409 last-step relabel ⇒ W4 and W5 red (the raw 402 surfaces);
 *  - drop the whole `/v1/messages` cascade call (serve handler.handle
 *    directly) ⇒ W1/W2 stay green for the wrong reason only if the env is also
 *    dropped — W1 is the discriminator (402 vs 200);
 *  - remove `initFailover()` ⇒ **W6 only** — and that is a measured correction,
 *    not a typo: the first run of this table left ALL GREEN, because
 *    `armCascade()` goes through `resetFailoverForTests(env)`, which calls
 *    `initFailover(env)` itself. The startup init is covered by W6 alone;
 *  - skip the owner-side `onNominalRefusal` in the delegated quota path ⇒ W5
 *    red (the direct sonnet request re-pays the walled nominal: calls.nm=2).
 *
 * MEASURED SHAPE (two pins state what the module DOES, not what main does):
 * W4's second request re-probes the last step on purpose (`resolveSkippingFailed`
 * last-step fallback) and W5's delegated wall surfaces in-request because the
 * #609 walk is not ported. Both were read off a failing run before being pinned
 * — an assertion written from main's test file would have been red forever.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyNominalBucket,
  isBucketWalled,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Everything the proxy's outbound calls can reach. No socket is opened by the
 *  test itself: the REAL proxy runs on an ephemeral port, and only its outbound
 *  legs are answered here (test-support pattern of #604). */
let calls: Record<string, number> = {};
/** Endpoints answering the quota wall (402 + subscription body). */
let wallEndpoints = new Set<string>();
/** Endpoints answering a plain 500 (the non-quota pin W3). */
let errorEndpoints = new Set<string>();

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
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  // The failover family — the wiring under test reads these.
  "CLAUDISH_FAILOVER_SONNET",
  "CLAUDISH_FAILOVER_OPUS",
  "CLAUDISH_FAILOVER_HAIKU",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_FAILOVER_AUTO",
  "CLAUDISH_FAILOVER_ARM_AFTER",
  "CLAUDISH_FAILOVER_ARM_GRACE_MS",
];
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

/** The wall shape isQuotaExhaustion classifies on STATUS alone (402). */
function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

const SONNET_NOMINAL = "nom-ep@fake-nom";
const bucketOfNominal = () => {
  const nb = classifyNominalBucket(SONNET_NOMINAL, () => false);
  if (!("bucket" in nb))
    throw new Error("route test: custom-endpoint nominal must classify to a bucket");
  return nb.bucket;
};

/** The armed sonnet cascade: two concrete steps on two fake endpoints. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  // The module's DEFAULT arm-after is 2 consecutive refusals (burst
  // discrimination); these pins measure the walk, so the first refusal arms.
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** Re-init the module with the cascade env and re-inject the nominal resolver
 *  (resetFailoverForTests clears it; the proxy injected its own at startup). */
function armCascade(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...CASCADE_ENV, ...extra });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

async function postMessage(model: string): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
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
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
      },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0 };
  wallEndpoints = new Set(["nm"]);
  errorEndpoints = new Set();
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, _init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith("http://fake.invalid/")) {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    calls[which] = (calls[which] ?? 0) + 1;
    if (errorEndpoints.has(which)) return new Response("upstream exploded", { status: 500 });
    if (wallEndpoints.has(which)) return quotaWall();
    return healthySSE();
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
  resetFailoverForTests();
});

/** Default spin: sonnet → nom-ep (the fake custom endpoint). */
async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    0,
    undefined,
    undefined,
    false,
    undefined,
    { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("G8 — the first cascade wiring, through the real /v1/messages route", () => {
  test("W1: a quota wall on the nominal serves the first cascade step, walls the bucket, and the NEXT request never re-pays the nominal", async () => {
    await spin();
    armCascade();

    // Request 1: nominal (nm) walls 402 → the role arms in-request → the
    // re-resolution serves s0. The response is a collected message served by
    // the SUBSTITUTE, announced in content (#229: /v1/messages is the agent
    // loop's ingress).
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1); // paid exactly once
    expect(calls.s0).toBe(1); // the substitute served
    const body1 = await r1.json();
    const text1 = JSON.stringify(body1);
    expect(text1).toContain("Failover model active");
    expect(text1).toContain("s0-ep@fake-s0");
    // THE PIN: the wall was recorded against the NOMINAL's bucket — the meter
    // the 402 named.
    expect(isBucketWalled(bucketOfNominal())).toBe(true);

    // Request 2: the armed role resolves s0 on attempt 0 — the walled nominal
    // is never re-paid while its wall holds.
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(2);
  }, 30_000);

  test("W2: with NO CLAUDISH_FAILOVER_* env the route is byte-identical to the unwired behaviour — the 402 surfaces, no step is called", async () => {
    await spin();
    // No armCascade(): the module stays inert (initFailover read the sandboxed
    // empty env at startup).

    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(402); // the client's own wall surfaces, nothing substitutes
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W3: a NON-quota failure on the nominal surfaces and arms nothing (401/404/500 never exile a role)", async () => {
    await spin();
    armCascade();
    wallEndpoints = new Set();
    errorEndpoints = new Set(["nm"]);

    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(500); // the user's own model failing reaches the user
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // never substituted
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W4: nominal AND every step walled → each candidate paid exactly once, surfaced as a 429 rate_limit_error with a re-probe horizon (#409)", async () => {
    await spin();
    armCascade();
    wallEndpoints = new Set(["nm", "s0", "s1"]);

    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(429); // never the provider's own 402/403
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1); // each candidate exactly once
    const err = await r1.json();
    expect(err?.error?.type).toBe("rate_limit_error");
    expect(err?.error?.message).toContain("[Failover] sonnet: every step walled");
    expect(r1.headers.get("retry-after")).toBeTruthy();

    // The next request finds the nominal and s0 benched — and re-pays NEITHER.
    // The last step IS served again, and that is the module's documented bet,
    // not a wiring defect: `resolveSkippingFailed` ends with "Every step is
    // TTL-failed: serve the LAST step anyway — a PAYG target should not wall,
    // and its real error beats a synthetic one". The refusal re-marks it as
    // `count=1 (same episode)` (#553: a mark on an already-benched step
    // refreshes without climbing a rung), and the #409 relabel keeps the
    // client-visible surface a 429 — measured here, not assumed.
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(429);
    expect(calls.nm).toBe(1); // the walled nominal is never re-paid
    expect(calls.s0).toBe(1); // a benched intermediate step is never re-paid
    expect(calls.s1).toBe(2); // the PAYG tail is re-probed once per request
    expect((await r2.json())?.error?.type).toBe("rate_limit_error");
  }, 30_000);

  test("W6: the cascade is armed by the PROXY's own startup init — no test-side re-init", async () => {
    // Kills a mutation that survived the first run of the table: dropping
    // `initFailover()` from the proxy's startup left every other pin green,
    // because `armCascade()` goes through `resetFailoverForTests(env)`, which
    // calls `initFailover(env)` itself. The PRODUCTION path — env present at
    // boot, module initialised once, nobody re-arming it — was pinned by
    // nothing. Here the env is set BEFORE `spin()` and no test-side init runs.
    Object.assign(process.env, CASCADE_ENV);
    await spin();

    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1); // startup init loaded the rule and the arm happened
    expect(isBucketWalled(bucketOfNominal())).toBe(true);
  }, 30_000);

  test("W5: a delegated wall (opus → role:sonnet → sonnet's nominal) arms the TARGET's bucket — a later DIRECT sonnet request never re-pays it (#274 owner side)", async () => {
    await spin();
    armCascade({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });

    // Request 1: opus is config-armed, so attempt 0 IS the delegation, and it
    // resolves sonnet's healthy nominal (nm) — which walls. The owner-side
    // bookkeeping (onNominalRefusal on the TARGET's bucket) is what this pin
    // exists for. The in-request advance to s0 afterwards is #609's walk, named
    // in the wiring gap list and NOT ported: here the delegated step is marked
    // and the wall surfaces (the opus step is its own last step, and a native
    // nominal is exempt from the #409 relabel by design). Measured, so the pin
    // states the wall rather than a substitute main would have served.
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(402);
    expect(calls.nm).toBe(1); // the delegated target paid exactly once
    expect(calls.s0).toBe(0); // no in-request walk past the delegated step (#609)

    // THE PIN: the DELEGATED refusal armed the target's bucket. Without the
    // owner-side call, sonnet's nominal bucket is never walled by delegated
    // traffic and the direct request below re-pays nm.
    expect(isBucketWalled(bucketOfNominal())).toBe(true);

    // Request 2 (DIRECT sonnet): diverts under the wall the delegation armed —
    // lands on s0, never re-pays nm.
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
  }, 30_000);
});
