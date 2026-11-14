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
});
