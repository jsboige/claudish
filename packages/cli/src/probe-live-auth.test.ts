/**
 * #930 — `claudish --probe` starts its OWN proxy (createProxyServer on an
 * ephemeral port) and that proxy composes the real ingress middlewares,
 * including proxy-auth. On a seat that enforces a proxy key
 * (CLAUDISH_PROXY_KEY / config proxyKey), the probe's own liveness POST
 * carried NO credential — the instrument 401'd itself
 * ("invalid proxy authentication") and every rung read dead (measured 08/11
 * on po-2028, `--probe ds@deepseek-flash` during the cascade-arming ACK).
 *
 * Fix under test: probeLink takes an optional proxyKey (resolved by the
 * caller exactly like a local client) and sends it as x-proxy-key.
 *
 * Matrix:
 *   U1  resolveProbeProxyKey — env primary wins over config; config fallback
 *       when env is absent; primary preferred over previous; undefined when
 *       nothing is configured (the keyless seat keeps today's behaviour).
 *   P1  probe WITH the resolved key against a key-enforcing proxy ⇒ live
 *       (the rung is measured, not the auth wall).
 *   P2  probe WITHOUT the key against the same proxy ⇒ auth-failed 401 with
 *       the middleware's own wording — the enforcement semantics are
 *       unchanged for a stranger without a key.
 *
 * Mutation proof (executed against this file, recorded in the PR):
 *   - remove the `...(proxyKey ? { "x-proxy-key": proxyKey } : {})` spread
 *     in probeLink ⇒ P1 red (auth-failed instead of live) while P2 stays
 *     green — the pin bites on exactly the defect, not on the middleware.
 *
 * Harness contract (CR on #938, #928 class): ONE proxy allocation for the
 * whole file — `beforeAll` / `afterAll`, never one per test — and every
 * request asks for `Connection: close`, so a rerun (`--rerun-each 3`) cannot
 * inherit a socket the previous run left in the keep-alive pool. Otherwise
 * this is proxy-key-rotation-route.test.ts's shape: the real
 * createProxyServer in-process on a fixed port, the real middleware, the
 * upstream stubbed by URL dispatch (local proxy URL passes through to the
 * real fetch; the provider call gets a healthy OpenAI SSE stream).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { probeLink, resolveProbeProxyKey } from "./providers/probe-live.js";
import type { ProxyServer } from "./types.js";

// One allocation per FILE (CR on #938): a port bound and released once per
// test is the flake itself. The scan in test-support/port-allocation.test.ts
// is the authority on what is already claimed (19993 is free as of this
// writing — verified against declaredPortClaims).
const PROXY_PORT = 19993;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

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
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-930";

/** Explicit non-native spec — parses provider "deepseek", crosses the
 * middleware's ENFORCE branch (never the native exemption). */
const LINK = {
  provider: "deepseek",
  modelSpec: "deepseek@deepseek-flash",
  hasCredentials: true,
} as const;

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** OpenAI-shaped SSE upstream — a content delta is what the probe accepts as
 * proof of life (a bare content_block_start is not, see isContentEvent). */
function deepseekSse(): Response {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-930",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "ok" }) +
    `data: [DONE]\n\n`;
  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(async () => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Minimal config: no customEndpoints, no inboundKeys — the proxyKeys under
  // test come from the env alone, so the hermetic shape is the default shape.
  writeFileSync(REAL_CONFIG_PATH, "{}", "utf-8");
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-deepseek-fake-930";
  // URL dispatch: the local proxy passes through to the real fetch (real
  // socket, real middleware); the provider call is answered by the stub.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(`${PROXY_BASE}/`)) return realFetch(input, init);
    if (url.includes("deepseek")) return deepseekSse();
    return realFetch(input, init);
  }) as typeof fetch;
  // The proxy is created ONCE, here, after the sandbox is in place; both P
  // tests and every rerun share it.
  activeProxy = await createProxyServer(
    PROXY_PORT,
    process.env.OPENROUTER_API_KEY,
    undefined,
    false,
    process.env.ANTHROPIC_API_KEY,
    undefined,
    { quiet: true }
  );
});

afterAll(async () => {
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  globalThis.fetch = realFetch;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (configBackup !== null) writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  else if (configExisted === false && existsSync(REAL_CONFIG_PATH)) {
    // A config that did not exist before must not exist after.
    writeFileSync(REAL_CONFIG_PATH, "", "utf-8");
  }
});

describe("resolveProbeProxyKey (#930)", () => {
  test("U1a — env primary wins over config", () => {
    const key = resolveProbeProxyKey(
      { CLAUDISH_PROXY_KEY: "env-key" },
      { proxyKey: "config-key", proxyKeyPrevious: "config-prev" }
    );
    expect(key).toBe("env-key");
  });

  test("U1b — config fallback when env absent; primary preferred over previous", () => {
    expect(resolveProbeProxyKey({}, { proxyKey: "config-key" })).toBe("config-key");
    expect(
      resolveProbeProxyKey({}, { proxyKeyPrevious: "only-prev" })
    ).toBe("only-prev");
    expect(resolveProbeProxyKey({}, {})).toBeUndefined();
  });
});

describe("probeLink against a key-enforcing proxy (#930)", () => {
  test("P1 — probe with the resolved key is LIVE, not auth-failed", async () => {
    const result = await probeLink(PROXY_BASE, { ...LINK }, 15000, PROXY_KEY);
    expect(result.state).toBe("live");
  });

  test("P2 — keyless probe still takes the middleware's 401", async () => {
    const result = await probeLink(PROXY_BASE, { ...LINK }, 15000);
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
    expect(result.errorMessage).toContain("invalid proxy authentication");
  });
});
