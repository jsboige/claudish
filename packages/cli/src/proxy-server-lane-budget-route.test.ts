/**
 * #1055 g2 — route-level pins for the harness-lane budget + emergency stop.
 * Same discipline as proxy-server-session-budget-route.test.ts (#317): the
 * module tests pin the instrument, THESE pin that the ROUTE carries it.
 *
 * Mutation table (each was run):
 *  - drop the `/v1/messages` lane admission ⇒ L1/L2 red (200 upstream instead
 *    of the typed 429);
 *  - drop the attempt-open in the cascade loop ⇒ L1 red at the consumed
 *    assert (usage never lands, nothing ever refuses);
 *  - neutralize the ComposedHandler sink (`recordLaneBudgetOutput` in
 *    onTokenUpdate) ⇒ L1 red (consumed stays 0);
 *  - remove the `x-claudish-lane-refusal` header from the refusal ⇒ L1/L2 red
 *    at the header assert.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { isQuotaExhaustion } from "./fork/failover.js";
import { laneBudgetConsumed, resetLaneBudgetForTests } from "./fork/lane-budget.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19907, 19917 is
// delegation-walk-route's, 19951…) — enforced by port-allocation.test.ts.
const PROXY_PORT = 19927;
const UPSTREAM_PORT = 20027;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_SESSION_BUDGET_CEILING", "CLAUDISH_SESSION_BUDGET_WARN",
  "CLAUDISH_LANE_BUDGETS", "CLAUDISH_LANE_STOP_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
let nmCompletion = 350;

function usageSSE(completionTokens: number, promptTokens = 10): Response {
  const chunk = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake-c" };
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

const SONNET_NOMINAL = "nom-ep@fake-nom";

/** Anthropic-wire SSE for the native lane stub — 400 output tokens. */
function nativeUsageSSE(outputTokens = 400): Response {
  const enc = new TextEncoder();
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_n", type: "message", role: "assistant", model: "claude-haiku-5-1", content: [], usage: { input_tokens: 5, output_tokens: 1 } } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } as any)}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } } as any)}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n") + "\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function writeTestConfig(): void {
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "nom-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/nm/v1`,
          format: "openai",
          apiKey: "test-key",
        },
      },
    }),
    "utf-8"
  );
}

interface PostOpts {
  lane?: string;
  session?: string;
}

async function postMessage(model: string, o: PostOpts = {}): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "connection": "close",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(o.lane ? { "x-claudish-lane": o.lane } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      ...(o.session ? { metadata: { user_id: o.session } } : {}),
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0 };
  nmCompletion = 350;
  resetLaneBudgetForTests();
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeTestConfig();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com")) {
      calls.native = (calls.native ?? 0) + 1;
      return nativeUsageSSE();
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    calls.nm = (calls.nm ?? 0) + 1;
    return usageSSE(nmCompletion);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
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
  resetLaneBudgetForTests();
});

async function spin(map?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    map ?? { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

describe("#1055 g2 — harness-lane budget + emergency stop wired through the route", () => {
  test("L1: over the daily bar → typed local 429, ZERO upstream, quota-word-free", async () => {
    // The lane is orthogonal to routing: a mapped claude-sonnet-5 carrying the
    // lane header is a harness request. Bar keyed on the (lane, model) pair.
    process.env.CLAUDISH_LANE_BUDGETS = "nb-coder/claude-sonnet-5:700";
    await spin();
    nmCompletion = 400;

    const r1 = await postMessage("claude-sonnet-5", { lane: "nb-coder", session: "s1" });
    expect(r1.status).toBe(200);
    const r2 = await postMessage("claude-sonnet-5", { lane: "nb-coder", session: "s2" });
    expect(r2.status).toBe(200);
    // The sink + attempt-open wiring: two paid attempts, summed per (lane, model).
    expect(laneBudgetConsumed("nb-coder", "claude-sonnet-5")).toBe(800);

    const fetchesBefore = calls.nm ?? 0;
    const r3 = await postMessage("claude-sonnet-5", { lane: "nb-coder", session: "s3" });
    expect(r3.status).toBe(429);
    const body = await r3.text();
    expect(body).toContain("[LaneBudget]");
    expect(isQuotaExhaustion(429, body)).toBe(false);
    // THE typed refusal: the header is what the harness defers on (AC2).
    expect(r3.headers.get("x-claudish-lane-refusal")).toBe("budget");
    expect(Number(r3.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls.nm).toBe(fetchesBefore); // refused pre-upstream
  }, 30_000);

  test("L2: emergency stop file → immediate typed refusal, THAT lane only (AC3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-stop-route-"));
    process.env.CLAUDISH_LANE_STOP_DIR = dir;
    writeFileSync(join(dir, "nb-coder"), "");
    await spin();

    const r1 = await postMessage("claude-sonnet-5", { lane: "nb-coder", session: "s1" });
    expect(r1.status).toBe(429);
    expect(r1.headers.get("x-claudish-lane-refusal")).toBe("stop");
    expect((await r1.text()).length).toBeGreaterThan(0);
    expect(calls.nm).toBe(0); // immediate, no upstream paid

    // Other lanes and lane-less traffic are NOT touched by the stop.
    const r2 = await postMessage("claude-sonnet-5", { lane: "other-lane", session: "s2" });
    expect(r2.status).toBe(200);
    const r3 = await postMessage("claude-sonnet-5", { session: "s3" });
    expect(r3.status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("L3: no lane header → byte-identical pre-#1055 path even with bars armed", async () => {
    process.env.CLAUDISH_LANE_BUDGETS = "nb-coder:1"; // would refuse anything lane'd
    await spin();
    const r1 = await postMessage("claude-sonnet-5", { session: "s1" });
    expect(r1.status).toBe(200);
    expect(laneBudgetConsumed("nb-coder", "claude-sonnet-5")).toBe(0);
  }, 30_000);

  // CR B1 — the native lane with the #218 role pin. Fleet clients send the
  // ROLE (claude-haiku-5); the pin rewrites body.model to the pinned version
  // (claude-haiku-5-1) BEFORE the attempt-open used to read it, splitting the
  // ledger key from the admission key (measured 200,200,200 against a bar of
  // 700). Both must key on the CLIENT's spelling.
  test("L4: native lane, #218 role pin — ledger keys on the requested model, budget still refuses (CR B1)", async () => {
    process.env.CLAUDISH_LANE_BUDGETS = "nb-coder:700";
    process.env.ANTHROPIC_API_KEY = "test-key"; // #296 shape A: the native lane needs a credential (stub-intercepted)
    await spin({ haiku: "claude-haiku-5-1" }); // bare claude target ⇒ native lane + pin
    const post = (session: string) => realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "connection": "close",
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claudish-lane": "nb-coder",
        // #296 shape A: the native lane needs the CLIENT's own Anthropic-shaped
        // credential — never substituted, forwarded as-is (stub-intercepted).
        "x-api-key": "sk-ant-api03-l4-route-pin",
      },
      body: JSON.stringify({
        model: "claude-haiku-5",
        max_tokens: 64,
        stream: true,
        metadata: { user_id: session },
        messages: [{ role: "user", content: "say hi" }],
      }),
    });

    const r1 = await post("s1");
    expect(r1.status).toBe(200);
    await r1.text();
    const r2 = await post("s2");
    expect(r2.status).toBe(200);
    await r2.text();
    // The ledger books under the REQUESTED spelling (what admission reads) —
    // pre-fix this read 0: consumption lived under claude-haiku-5-1.
    expect(laneBudgetConsumed("nb-coder", "claude-haiku-5")).toBe(800);
    expect(laneBudgetConsumed("nb-coder", "claude-haiku-5-1")).toBe(0);

    const nativeCallsBefore = calls.native ?? 0;
    const r3 = await post("s3");
    expect(r3.status).toBe(429);
    expect(r3.headers.get("x-claudish-lane-refusal")).toBe("budget");
    expect(calls.native).toBe(nativeCallsBefore); // refused pre-upstream
  }, 30_000);

  // CR B3 — the OpenAI ingress is the repo's named sk-agent ingress, and
  // #1055's harness IS an sk-agent agent: the admission (and the emergency
  // stop) must work on BOTH wires.
  test("L5: /v1/chat/completions — same lane admission, OpenAI-shaped typed 429 (CR B3)", async () => {
    process.env.CLAUDISH_LANE_BUDGETS = "nb-coder/claude-sonnet-5:700";
    await spin();
    nmCompletion = 400;

    const postChat = (session: string) => realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "connection": "close",
        "Content-Type": "application/json",
        "x-claudish-lane": "nb-coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 64,
        stream: false,
        user: session,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });

    const r1 = await postChat("s1");
    expect(r1.status).toBe(200);
    const r2 = await postChat("s2");
    expect(r2.status).toBe(200);
    expect(laneBudgetConsumed("nb-coder", "claude-sonnet-5")).toBe(800);

    const fetchesBefore = calls.nm ?? 0;
    const r3 = await postChat("s3");
    expect(r3.status).toBe(429);
    const body = JSON.parse(await r3.text());
    expect(body.error?.type).toBe("rate_limit_error");
    expect(body.error?.message).toContain("[LaneBudget]");
    expect(r3.headers.get("x-claudish-lane-refusal")).toBe("budget");
    expect(Number(r3.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls.nm).toBe(fetchesBefore); // refused pre-upstream on this wire too
  }, 30_000);
});
