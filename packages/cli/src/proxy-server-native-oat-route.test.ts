/**
 * #641 step 4 — ROUTE pins: the credential the authority resolves leaves under
 * the header main's swap predicate would use.
 *
 * Before step 4, every fallback site wrote x-api-key unconditionally, so an
 * OAuth token (sk-ant-oat*, resolved from ANTHROPIC_AUTH_TOKEN by the native
 * credential authority) reached api.anthropic.com under the WRONG header name —
 * api.anthropic.com authenticates OAuth as `authorization: Bearer`. The unit
 * half lives in native-anthropic-credential.test.ts (the provider's shape);
 * THIS file pins the WIRING — that the serving lane and count_tokens actually
 * apply the shaped header to the wire. A fix that landed in the provider but
 * left a consumer reading only `auth.headers["x-api-key"]` keeps the unit green
 * and turns exactly these rows red — that is the point.
 *
 * Harness: the native-pin-route pattern — the REAL proxy on an ephemeral port,
 * only the outbound anthropic.com leg answered by a stubbed fetch that CAPTURES
 * the upstream headers. The credential is set AFTER boot (env at boot is
 * scrubbed), so `anthropicApiKey` is undefined at construction and the request
 * resolves through the credential authority — the exact path step 4 fixes.
 * `credentials.invalidate("native-anthropic")` between tests: resolution is
 * memoized per provider instance and the authority is a singleton.
 *
 * Mutation table — every row was RUN against these files (throwaway copies,
 * cp-restore; never git checkout). The defense is LAYERED, and the reds show
 * it: the provider shapes the credential AND writeNativeCredential re-shapes
 * at write time, so each layer alone keeps the wire correct.
 *  - provider emits x-api-key unconditionally (the pre-step-4 shape) ⇒ only
 *    the provider unit row red — the route rows stay GREEN because
 *    writeNativeCredential still reshapes the token before the wire;
 *  - writeNativeCredential ignores the oat prefix ⇒ the two oat ROUTE rows red
 *    (count_tokens + serving; the provider's Bearer arrives, the write
 *    degrades it), the api-key rows and the unit rows stay green.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { credentials } from "./auth/credentials/authority.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Upstream legs the stub captured: which host, the headers it left with. */
let upstream: Array<{ which: string; headers: Record<string, string> }> = [];

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
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

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

beforeEach(() => {
  upstream = [];
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Memoized resolution is per PROVIDER instance and the authority is a
  // singleton shared by every test file in the process — a file that ran
  // before this one (native-pin-route resolves "test-native-key") leaves its
  // key cached, and the first request here would sign with THAT. Invalidate
  // at the START too, not only in afterEach: both directions stay hermetic.
  credentials.invalidate("native-anthropic");
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? "");
    if (url.includes("api.anthropic.com")) {
      upstream.push({ which: "anthropic", headers: { ...(init?.headers ?? {}) } });
      return nativeJSON();
    }
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
  // The provider memoizes its resolution per instance and the authority is a
  // singleton — the next test's env must be re-read, not served from cache.
  credentials.invalidate("native-anthropic");
});

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
    quiet: true,
  });
}

const OAT = "sk-ant-oat01-test-oauth-token";
const APIKEY = "sk-ant-api03-test-key";

function postMessages(): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 64,
      stream: false,
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

function postCountTokens(): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "count me" }],
    }),
  });
}

describe("#641 step 4 — the authority-shaped credential reaches the wire", () => {
  test("count_tokens: an OAuth token set after boot leaves as authorization: Bearer", async () => {
    await spin();
    process.env.ANTHROPIC_AUTH_TOKEN = OAT;

    const res = await postCountTokens();
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].headers.authorization).toBe(`Bearer ${OAT}`);
    // THE CLAIM: the token is not duplicated (or displaced) under x-api-key.
    expect(upstream[0].headers["x-api-key"]).toBeUndefined();
  }, 30_000);

  test("serving lane: the same OAuth fallback leaves as authorization: Bearer", async () => {
    await spin();
    process.env.ANTHROPIC_AUTH_TOKEN = OAT;

    const res = await postMessages();
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].headers.authorization).toBe(`Bearer ${OAT}`);
    expect(upstream[0].headers["x-api-key"]).toBeUndefined();
  }, 30_000);

  test("count_tokens: an API key set after boot keeps x-api-key — classic form unchanged", async () => {
    await spin();
    process.env.ANTHROPIC_API_KEY = APIKEY;

    const res = await postCountTokens();
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].headers["x-api-key"]).toBe(APIKEY);
    expect(upstream[0].headers.authorization).toBeUndefined();
  }, 30_000);

  test("serving lane: the same API-key fallback keeps x-api-key", async () => {
    await spin();
    process.env.ANTHROPIC_API_KEY = APIKEY;

    const res = await postMessages();
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].headers["x-api-key"]).toBe(APIKEY);
    expect(upstream[0].headers.authorization).toBeUndefined();
  }, 30_000);
});
