/**
 * Machine-scoped config arm — route-level pin.
 *
 * `CLAUDISH_FAILOVER_ACTIVE=haiku@<machine>` diverts the haiku role to its
 * cascade ONLY for requests whose X-Claudish-Machine names that machine; every
 * other machine (and a request without the header) stays on the nominal. The
 * route turns the match into a `machine:<name>` bucket, so the cascade loop and
 * the notices key on it — the diverted request carries the notice, the others
 * carry none.
 *
 * Drives the REAL /v1/messages and /v1/chat/completions routes in-process
 * (same harness contract as proxy-server-role-failover-route.test.ts).
 *
 * Mutation proof: make `requestBucketOf` ignore the header (return the
 * nominal's bucket only) ⇒ M1 and M5 go red (the nominal is paid, no notice).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetFailoverForTests } from "./fork/failover.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests.
const PROXY_PORT = 19885;
const UPSTREAM_PORT = 19985;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

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
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};

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
    chunk({ content: "Hello." }) +
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

/** haiku's nominal is `nm`; its single cascade step is `s0`, armed for m-cal only. */
const MACHINE_ARM_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0",
  CLAUDISH_FAILOVER_HAIKU_LABEL: "Small local model",
  CLAUDISH_FAILOVER_HAIKU_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_HAIKU_NOTE: "Much smaller than the nominal.",
  CLAUDISH_FAILOVER_ACTIVE: "haiku@m-cal",
} as Record<string, string>;

async function postMessage(machine?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(machine ? { "X-Claudish-Machine": machine } : {}),
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

async function postChat(machine?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(machine ? { "X-Claudish-Machine": machine } : {}),
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

const messageText = (msg: any): string =>
  (msg?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");

beforeEach(() => {
  calls = { nm: 0, s0: 0 };
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ep = (name: string) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({ customEndpoints: { "nom-ep": ep("nm"), "s0-ep": ep("s0") } }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    return healthySSE();
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
  resetFailoverForTests();
});

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    { haiku: "nom-ep@fake-nom" },
    { quiet: true }
  );
  resetFailoverForTests(MACHINE_ARM_ENV);
}

describe("machine-scoped config arm (role@machine) through the real routes", () => {
  test("M1: the armed machine's haiku request is served by the cascade step, with the notice", async () => {
    await spin();
    const r = await postMessage("m-cal");
    expect(r.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(calls.nm).toBe(0);
    const text = messageText(await r.json());
    expect(text).toContain("Small local model");
    expect(text).toContain("Much smaller than the nominal.");
  });

  test("M2: another machine's haiku request stays on the nominal, no notice", async () => {
    await spin();
    const r = await postMessage("m-other");
    expect(r.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
    expect(messageText(await r.json())).not.toContain("[claudish]");
  });

  test("M3: a request without X-Claudish-Machine stays on the nominal", async () => {
    await spin();
    const r = await postMessage();
    expect(r.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
  });

  test("M4: the header match is case-insensitive", async () => {
    await spin();
    const r = await postMessage("M-Cal");
    expect(r.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(calls.nm).toBe(0);
  });

  test("M5: the OpenAI-compatible ingress diverts the armed machine too, notice in the header", async () => {
    await spin();
    const mine = await postChat("m-cal");
    expect(mine.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(mine.headers.get("x-claudish-failover-notice")).toBeTruthy();
    const other = await postChat("m-other");
    expect(other.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(other.headers.get("x-claudish-failover-notice")).toBeNull();
  });
});
