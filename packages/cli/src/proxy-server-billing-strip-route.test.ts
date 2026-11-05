/**
 * Row 9 (#101) — ROUTE-level pins for the billing-header strip at the serving
 * seam of `replatform/v14`.
 *
 * WHAT IS AND IS NOT DISCRIMINATED HERE (measured, see the mutation table):
 * `transform.ts`'s stripBillingHeader runs inside transformOpenAIToClaude on
 * EVERY ComposedHandler request — anthropic-format endpoints included, because
 * step 1 of ComposedHandler normalizes the payload before any adapter shapes
 * it — and never for NativeHandler. So the OBSERVABLE these route pins hold
 * (non-native upstreams receive a clean system, native keeps the header) is
 * transform-guaranteed with or without the route-level call; removing the call
 * leaves all four green (M1). What the route call adds is parity with main's
 * fork layer and defense at the seam, and B3 is the pin that DOES depend on
 * it: NativeHandler forwards the SAME body object the loop mutates (no copy),
 * so a call site that strips for native too (M2: isNative flipped to false)
 * takes the header out of Anthropic's own traffic — B3 is the only pin that
 * goes red. That asymmetry is the reason the second argument exists.
 *
 * Why a `format: "anthropic"` endpoint is still the right harness leg: it is
 * the transport family the strip was BUILT for (AnthropicAPIFormat ships
 * `system` verbatim; a `format: "openai"` leg could never show a difference),
 * and it keeps these pins meaningful the day the transform-level strip moves
 * or narrows — they hold the property at the SEAM, not the mechanism.
 *
 * Harness: the classifier-passthrough / role-failover pattern — the REAL proxy
 * on an ephemeral port, custom endpoints registered through the proxy's own
 * entry point (no config file written), only the outbound legs answered by a
 * stubbed fetch that CAPTURES the upstream body.
 *
 * B4 is the seam claim of the call-site comment made checkable: the body is
 * parsed ONCE at the route and every cascade attempt reuses that object, so
 * the attempt-0 strip covers the whole chain — if a future edit re-reads the
 * raw request per attempt, B4 is the pin that goes red. The #747 serving
 * note's presence on the substitute's system is deliberately NOT asserted
 * here — see the comment at B4's tail for the measured reason.
 *
 * Mutation table — every row was RUN against these two files (throwaway
 * copies, cp-restore; never git checkout):
 *  - remove the proxy-server call site ⇒ all four GREEN (the transform covers
 *    every ComposedHandler leg — the honest reason the seam pins do not
 *    discriminate the call site's presence);
 *  - flip the call site's isNative to literal false ⇒ **B3 red**, B1/B2/B4
 *    green (native forwards the same object; the discriminator argument is
 *    pinned);
 *  - drop the `\n?` from both module regexes ⇒ 6/8 unit pins red (the two
 *    no-op pins — native, absent header — correctly stay green), route pins
 *    green (transform-backed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Upstream legs the stub captured: which fake endpoint (leg id, or
 *  "native"), and the parsed body it received. */
let upstream: Array<{ which: string; body: any }> = [];
/** Legs answering the quota wall (402 + subscription body) — B4 only. */
let wallEndpoints = new Set<string>();

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
  // The failover family — B4 arms a cascade; no other test wants one.
  "CLAUDISH_FAILOVER_SONNET",
  "CLAUDISH_FAILOVER_OPUS",
  "CLAUDISH_FAILOVER_HAIKU",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_FAILOVER_AUTO",
  "CLAUDISH_FAILOVER_ARM_AFTER",
  "CLAUDISH_FAILOVER_ARM_GRACE_MS",
  "CLAUDISH_FAILOVER_STEP_SKIP",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

/** Anthropic SSE, the dialect ComposedHandler's stream parsers consume. The
 *  handler always collects a stream internally and converts for a
 *  `stream:false` client, so the fake endpoint must answer SSE even though
 *  postMessage() sends stream:false. */
function anthropicSSE(): Response {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse =
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        model: "fake-m",
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello from the strip." },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 6 },
    }) +
    frame("message_stop", { type: "message_stop" });
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
    JSON.stringify({
      detail: "Check your subscription on https://example.invalid/subscription",
    }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** Plain JSON message — the native passthrough forwards it verbatim to the
 *  client (classifier-passthrough pattern, no stream involved). */
function nativeJSON(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_native",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "native says hi" }],
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const BILL_NOMINAL = "bill-ep@fake-m";

/** The anthropic-format fake endpoint — the transport the strip exists for:
 *  AnthropicAPIFormat ships `system` verbatim, so the ONLY thing that can
 *  remove the billing line is the route-level call under test. */
const fakeAnthropicEp = (leg: string) => ({
  kind: "simple",
  url: `http://fake.invalid/${leg}`,
  format: "anthropic",
  apiKey: "test-key",
});

/** Register through the proxy's OWN entry point, with an explicit config: no
 *  file is written, so a crashed run cannot touch a machine's real config. */
function registerFakeEndpoints(): void {
  ensureEndpointsRegistered({
    config: {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "bill-ep": fakeAnthropicEp("bl"),
        "s0-ep": fakeAnthropicEp("s0"),
      },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

beforeEach(() => {
  upstream = [];
  wallEndpoints = new Set();
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? "");
    if (url.includes("api.anthropic.com")) {
      upstream.push({ which: "native", body: JSON.parse(init?.body as string) });
      return nativeJSON();
    }
    if (url.startsWith("http://fake.invalid/")) {
      const which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
      upstream.push({ which, body: JSON.parse(init?.body as string) });
      if (wallEndpoints.has(which)) return quotaWall();
      return anthropicSSE();
    }
    // Background warmers (pricing / catalog / recommended) and anything else.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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

async function spin(nominal: string | undefined): Promise<void> {
  activeProxy = await createProxyServer(
    0,
    undefined,
    undefined,
    false,
    undefined,
    nominal ? { sonnet: nominal } : undefined,
    { quiet: true }
  );
}

async function postMessage(model: string, system: unknown): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      system,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

const BILLING_LINE = "x-anthropic-billing-header: cc_version=1.0.99; cch=route-pin-1;";

describe("row 9 — the billing-header strip at the serving seam", () => {
  test("B1: an anthropic-format endpoint receives a CLEAN string system — header line gone, other text intact", async () => {
    await spin(BILL_NOMINAL);

    const res = await postMessage("claude-sonnet-5", `${BILLING_LINE}\nYou are Claude Code.`);
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].which).toBe("bl");
    // THE PIN: the verbatim-shipping transport received the system WITHOUT
    // the billing line. Exact equality — the surviving text must be exactly
    // the prompt, not the prompt plus leftovers.
    expect(upstream[0].body.system).toBe("You are Claude Code.");
    // The leg actually served: the collected answer, not an error fallback.
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Hello from the strip.");
  }, 30_000);

  test("B2: array system — the header line leaves its text block, the sibling block is untouched", async () => {
    await spin(BILL_NOMINAL);

    const res = await postMessage("claude-sonnet-5", [
      { type: "text", text: `${BILLING_LINE}\nYou are Claude Code.` },
      { type: "text", text: "Second block, never touched." },
    ]);
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    const sent = JSON.stringify(upstream[0].body.system);
    expect(sent).not.toContain("x-anthropic-billing-header");
    expect(sent).not.toContain("cch=route-pin-1");
    expect(sent).toContain("You are Claude Code.");
    expect(sent).toContain("Second block, never touched.");
  }, 30_000);

  test("B3: the native passthrough KEEPS the header — it is the party the header is for", async () => {
    await spin(undefined);
    // The native lane needs no credential to reach the stub, but pin it so
    // the test does not depend on which keys the host machine happens to hold.
    process.env.ANTHROPIC_API_KEY = "test-native-key";

    const res = await postMessage("claude-opus-4-8", `${BILLING_LINE}\nYou are Claude Code.`);
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].which).toBe("native");
    // THE PIN: `instanceof NativeHandler` is the second argument of the call
    // under test — for native traffic the header must SURVIVE.
    expect(upstream[0].body.system).toBe(`${BILLING_LINE}\nYou are Claude Code.`);
  }, 30_000);

  test("B4: a cascade SUBSTITUTE also receives the clean body — the attempt-0 strip covers the whole chain", async () => {
    await spin(BILL_NOMINAL);
    // Arm the sonnet cascade: one step on the second anthropic endpoint.
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0",
      CLAUDISH_FAILOVER_AUTO: "1",
      CLAUDISH_FAILOVER_ARM_AFTER: "1",
    });
    setRoleNominalResolver((r) => (r === "sonnet" ? BILL_NOMINAL : undefined));
    // The nominal walls 402 → the request arms in-request → s0 serves.
    wallEndpoints = new Set(["bl"]);

    const res = await postMessage("claude-sonnet-5", `${BILLING_LINE}\nYou are Claude Code.`);
    expect(res.status).toBe(200);
    const legs = upstream.map((u) => u.which);
    expect(legs).toEqual(["bl", "s0"]);
    // The walled nominal leg (attempt 0) and the substitute leg (attempt 1)
    // BOTH saw the body — and the substitute's copy is clean of the billing
    // line, proving the strip of attempt 0 is the body every later attempt
    // reuses (one parse, one object at the route).
    expect(JSON.stringify(upstream[0].body.system)).not.toContain("x-anthropic-billing-header");
    expect(JSON.stringify(upstream[1].body.system)).not.toContain("x-anthropic-billing-header");
    expect(upstream[1].body.system).toContain("You are Claude Code.");
    // NOT re-pinned here, deliberately: whether the #747 serving note rides
    // the substitute's system is `proxy-server-serving-note-route.test.ts`'s
    // subject (T1: exactly once, request side, restored on failure). This
    // file pinned it once as a bonus assertion and macOS CI 3/3 answered
    // "no banner" where Windows and 5/5 local reruns answer "banner" — a
    // divergence this lane could not reproduce, on a mechanism this port
    // does not touch. `legs` above already proves the cascade served; the
    // strip claims above are what B4 exists for.
  }, 30_000);
});
