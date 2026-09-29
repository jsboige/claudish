/**
 * #263 — a concurrent nominal success must not make a request re-pay a cascade
 * step it has already watched wall.
 *
 * Production, hub po-2025, 2026-09-25 15:36Z: a `gpt-6-sol` request (aliased to
 * the sonnet role via CLAUDISH_FAILOVER_ROLE_MODELS) walled on its nominal, then
 * on Mistral (402), then on Kimi (403). Meanwhile a *different* sonnet request
 * succeeded on the role's other nominal (glm-5.3), and onNominalSuccess cleared
 * every step mark of the role. The walled request re-selected Mistral, spent its
 * last attempt there, and surfaced the raw 402 to the client — the healthy last
 * step (DeepSeek) was never tried.
 *
 * This file drives the REAL /v1/messages route in-process with a 3-step cascade
 * on fake custom endpoints: A and B answer 402 and, at the moment they are
 * called, simulate that concurrent success (onNominalSuccess("sonnet")); C is
 * healthy. Without the request-local guard the loop's `steps.length + 1`
 * attempts go A, B, A, B and the client gets B's 402. With it, the request
 * reaches C. Mutation proof: remove the `triedSteps` check in handleWithCascade
 * and this test goes red on both the status and the per-endpoint call counts.
 *
 * Harness: the proxy→endpoint leg is intercepted (the relay.test.ts /
 * proxy-server-openai-notice.test.ts pattern); the client→proxy leg is real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { onNominalSuccess, resetFailoverForTests } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951).
const PROXY_PORT = 19863;
const UPSTREAM_PORT = 19963;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-openai-notice.test.ts.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
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
    chunk({ content: "Hello from the last step." }) +
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

beforeEach(() => {
  calls = { a: 0, b: 0, c: 0 };
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
    JSON.stringify({ customEndpoints: { "a-ep": ep("a"), "b-ep": ep("b"), "c-ep": ep("c") } }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 2);
    calls[which] = (calls[which] ?? 0) + 1;
    if (which === "c") return healthySSE();
    // Another request of the role succeeds on its nominal WHILE this step is in
    // flight — the interleaving the hub produced.
    onNominalSuccess("sonnet");
    return new Response(
      JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
      { status: 402, headers: { "content-type": "application/json" } }
    );
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

describe("#263 — a concurrent nominal success does not make a request re-pay a walled step", () => {
  test("A and B wall while their marks are cleared underneath; the request still reaches C", async () => {
    activeProxy = await createProxyServer(
      PROXY_PORT,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      { quiet: true }
    );
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "a-ep@fake-a>b-ep@fake-b>c-ep@fake-c",
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });

    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });

    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("Hello from the last step.");
    // Each walled step paid exactly once; the healthy last step was reached.
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  }, 30_000);
});
