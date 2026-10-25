/**
 * #317 (session budget) + #83 (capability vocabulary) — ROUTE-level pins for the
 * G6 grain on `replatform/v14`, based on the G2 shell (`05711ea4`).
 *
 * Why this file is not a copy of the fork's `proxy-server-session-budget-route`:
 * the fork's version pins sites that DO NOT EXIST on this base yet — the armed
 * cascade and the #299-B walk (G5), and the OpenAI-compatible ingress (a later
 * grain). Copying it would have meant either pinning dead code or silently
 * dropping cases. What exists here is pinned exhaustively, and the deferred
 * sites are named below so nothing looks covered when it is not.
 *
 * Mutation table — every row below was RUN against this file, not reasoned about:
 *  - drop the `/v1/messages` admission block ⇒ B1 red (the request goes upstream
 *    and answers 200 instead of 429);
 *  - hardcode `machineHeader = null` ⇒ B7 red (both machines land in one counter
 *    and the second request refuses);
 *  - remove `openSessionBudgetAttempt` before `handler.handle` ⇒ B2 red
 *    (consumed stays 0: the sink has no token to key on);
 *  - neutralize the ComposedHandler sink (`recordSessionBudgetOutput` in
 *    `onTokenUpdate`) ⇒ B1/B2/B6 red (consumed stays 0, nothing ever refuses);
 *  - remove the NativeHandler SSE line scan ⇒ B4 red (consumed stays 0);
 *  - remove the NativeHandler JSON branch tap ⇒ B5 red (consumed stays 0);
 *  - make the condensation rail a no-op (`return response` before the clone)
 *    ⇒ C2 red (no query is ever appended);
 *  - ignore the ask cap in `appendCapabilityQueryToMessage` ⇒ C2 red at the
 *    third request (module-level pin, `capability-vocabulary.test.ts`).
 *
 * MEASURED NON-MUTATION (kept because the obvious table would have been wrong):
 * removing `isCapabilityVocabEnabled` from the RAIL leaves C1 green. The module
 * re-checks the gate itself, so the route-side check is an optimisation (skip
 * the clone + parse when off), not the guard. The guard is pinned at module
 * level; the route pin carries the append, not the gate. An un-run mutation
 * table claimed otherwise for one round.
 *
 * DEFERRED (deliberately not pinned here): the armed-cascade attempt (G5), the
 * #299-B walk attempt (G5) and the OpenAI ingress envelope (later grain). Each
 * must arrive with its own route pin when its site lands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCapabilityVocabForTests } from "./fork/capability-vocabulary.js";
import { isQuotaExhaustion } from "./fork/failover.js";
import { resetSessionBudgetForTests, sessionBudgetConsumed } from "./fork/session-budget.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Everything the proxy's outbound calls can reach. No socket is opened by the
 *  test itself: the REAL proxy runs on an ephemeral port, and only its outbound
 *  legs are answered here (test-support pattern of #604). */
let calls: Record<string, number> = {};
/** Completion tokens each fake endpoint reports in its terminal usage chunk. */
let endpointCompletion: Record<string, number> = {};
/** Completion tokens the native stub reports (SSE and JSON variants). */
let nativeCompletion = 333;

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
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_SESSION_BUDGET_CEILING",
  "CLAUDISH_SESSION_BUDGET_WARN",
  "CLAUDISH_CAPABILITY_VOCAB",
  "CLAUDISH_CAPABILITY_QUERY_MAX_ASKS",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

function usageSSE(completionTokens: number, promptTokens = 10): Response {
  const chunk = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
  const base = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-c",
  };
  const sse =
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: { content: "Hello." } }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }) +
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

/** Anthropic-shaped SSE for the native lane: usage rides message_delta, where
 *  the NativeHandler's line scan reads it. */
function anthropicSSE(outputTokens: number): Response {
  const frame = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse =
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
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
      delta: { type: "text_delta", text: "Hello native." },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: outputTokens },
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

/** Anthropic-shaped JSON for the native lane's stream:false branch. */
function anthropicJSON(outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello native." }],
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: outputTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const SONNET_NOMINAL = "nom-ep@fake-nom";

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
      customEndpoints: { "nom-ep": ep("nm"), "s0-ep": ep("s0") },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

interface PostOpts {
  session?: string;
  machine?: string;
  stream?: boolean;
  nativeKey?: string;
}

async function postMessage(model: string, o: PostOpts = {}): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(o.machine ? { "x-claudish-machine": o.machine } : {}),
      ...(o.nativeKey ? { "x-api-key": o.nativeKey } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: o.stream ?? false,
      // The #91 p4 seam the budget keys on: metadata.user_id (string form).
      ...(o.session ? { metadata: { user_id: o.session } } : {}),
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, native: 0 };
  endpointCompletion = {};
  nativeCompletion = 333;
  resetSessionBudgetForTests();
  resetCapabilityVocabForTests();
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      const body = String(init?.body ?? "");
      const isStream = body.includes('"stream":true') || body.includes('"stream": true');
      return isStream ? anthropicSSE(nativeCompletion) : anthropicJSON(nativeCompletion);
    }
    if (!url.startsWith("http://fake.invalid/")) {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    calls[which] = (calls[which] ?? 0) + 1;
    return usageSSE(endpointCompletion[which] ?? 350);
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
  resetSessionBudgetForTests();
  resetCapabilityVocabForTests();
});

/** Default spin: sonnet → nom-ep (the fake custom endpoint). */
async function spin(map?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    0,
    undefined,
    undefined,
    false,
    undefined,
    map ?? { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

const totalUpstreamCalls = () => (calls.nm ?? 0) + (calls.s0 ?? 0) + (calls.native ?? 0);

describe("#317 — session budget ceiling wired through the /v1/messages route", () => {
  test("B1: over the ceiling → local 429 + retry-after, quota-word-free, ZERO upstream fetch", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    endpointCompletion.nm = 400;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r1.status).toBe(200);
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r2.status).toBe(200);
    expect(sessionBudgetConsumed(null, "sess-alpha")).toBe(800);

    const fetchesBefore = totalUpstreamCalls();
    const r3 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r3.status).toBe(429);
    const body = await r3.text();
    expect(body).toContain("[SessionBudgetCeiling]");
    // The wording contract at ROUTE level: the rendered body must never arm the
    // budget failover off our own ceiling.
    expect(isQuotaExhaustion(429, body)).toBe(false);
    const retryAfter = Number(r3.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter) && retryAfter > 0).toBe(true);
    // THE wiring pin: a refused request pays NOTHING upstream.
    expect(totalUpstreamCalls()).toBe(fetchesBefore);
  }, 30_000);

  test("B2: the SERVING attempt's usage reaches the counter (attempt token + ComposedHandler sink)", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    endpointCompletion.nm = 350;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-one" });
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    // Without the attempt token the sink has nothing to key on and stays at 0;
    // without the sink the token is never read. Both sites are load-bearing.
    expect(sessionBudgetConsumed(null, "sess-one")).toBe(350);
  }, 30_000);

  test("B6: a DIFFERENT session serves while the first is walled (key isolation)", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    endpointCompletion.nm = 750;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r1.status).toBe(200);
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r2.status).toBe(429);

    const r3 = await postMessage("claude-sonnet-5", { session: "sess-beta" });
    expect(r3.status).toBe(200); // the counter is per-session, not global
    expect(sessionBudgetConsumed(null, "sess-beta")).toBe(750);
  }, 30_000);

  test("B7: the machine header is the OTHER half of the key — two machines, two counters", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    endpointCompletion.nm = 500;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-one" });
    expect(r1.status).toBe(200);
    endpointCompletion.nm = 300;
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-two" });
    expect(r2.status).toBe(200);

    // Distinct counters. If machineHeader were hardcoded null, both attempts
    // would share one key (500+300=800 ≥ 700) and r3 would REFUSE — that is
    // exactly the mutation this pin kills.
    expect(sessionBudgetConsumed("m-one", "sess-m")).toBe(500);
    expect(sessionBudgetConsumed("m-two", "sess-m")).toBe(300);
    endpointCompletion.nm = 100;
    const r3 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-one" });
    expect(r3.status).toBe(200); // 500 < 700 on ITS counter
    expect(sessionBudgetConsumed("m-one", "sess-m")).toBe(600);
  }, 30_000);

  test("B4: native lane SSE tap — message_delta's output_tokens reaches the counter", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "300";
    await spin({}); // EMPTY modelMap → bare claude-sonnet-5 is native
    nativeCompletion = 333;

    const r1 = await postMessage("claude-sonnet-5", {
      session: "sess-nat",
      stream: true,
      nativeKey: "sk-ant-test-budget",
    });
    expect(r1.status).toBe(200);
    expect(calls.native).toBe(1);
    expect(sessionBudgetConsumed(null, "sess-nat")).toBe(333);

    // Second request on the same session: refused locally, native untouched.
    const r2 = await postMessage("claude-sonnet-5", {
      session: "sess-nat",
      nativeKey: "sk-ant-test-budget",
    });
    expect(r2.status).toBe(429);
    expect(calls.native).toBe(1);
  }, 30_000);

  test("B5: native lane JSON branch tap (stream:false) — usage.output_tokens reaches the counter", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "400";
    await spin({});
    nativeCompletion = 290;

    const r1 = await postMessage("claude-sonnet-5", {
      session: "sess-natj",
      nativeKey: "sk-ant-test-budget",
    });
    expect(r1.status).toBe(200);
    expect(calls.native).toBe(1);
    expect(sessionBudgetConsumed(null, "sess-natj")).toBe(290);
  }, 30_000);
});

describe("#83 — capability vocabulary on the condensation rail", () => {
  test("C1: the gate is OFF by default — the collected message carries no query", async () => {
    await spin();
    endpointCompletion.nm = 100;

    const r = await postMessage("claude-sonnet-5", { session: "sess-cap-off" });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain("Capability query");
  }, 30_000);

  test("C2: gate ON → the query is appended, and the ask cap stops it", async () => {
    process.env.CLAUDISH_CAPABILITY_VOCAB = "1";
    process.env.CLAUDISH_CAPABILITY_QUERY_MAX_ASKS = "2";
    await spin();
    endpointCompletion.nm = 100;

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Non-streaming: the condensation rail only touches collected messages.
      const r = await postMessage("claude-sonnet-5", { session: "sess-cap-on" });
      expect(r.status).toBe(200);
      bodies.push(await r.text());
    }
    expect(bodies[0]).toContain("[claudish] Capability query");
    expect(bodies[1]).toContain("[claudish] Capability query");
    // The cap is 2: the third condensation is served untouched (silence after
    // N asks means "nothing to declare").
    expect(bodies[2]).not.toContain("Capability query");
  }, 30_000);

  test("C3: a streaming request is never touched by the rail", async () => {
    process.env.CLAUDISH_CAPABILITY_VOCAB = "1";
    await spin();
    endpointCompletion.nm = 100;

    const r = await postMessage("claude-sonnet-5", { session: "sess-cap-stream", stream: true });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain("Capability query");
  }, 30_000);
});
