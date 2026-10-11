/**
 * #439 route pins — during a CLAUDISH_PROXY_KEY_PREVIOUS rotation window,
 * every request authenticated by the RETIRING key is counted per bucket
 * (X-Claudish-Machine, else UA product token) and exposed on /health, with a
 * rate-limited forceConsole marker so docker logs can count after a restart
 * reset the in-memory state.
 *
 * Same harness contract as proxy-server-keyless-exempt-route.test.ts: the
 * real createProxyServer in-process, the real middleware, the real native
 * swap — the marker capture reuses the stderr wrapper pattern.
 *
 * Matrix (issue #439 acceptance):
 *   U1  bucket derivation — machine header, UA token, hostile UA → unknown
 *   R1  previous key on non-native ingress ⇒ counted under the machine bucket,
 *       visible on /health; primary key ⇒ NOT counted
 *   R2  no machine header ⇒ counted under the UA product-token bucket
 *   R3  _PREVIOUS unset ⇒ the retiring key is refused (401) and /health
 *       omits the fields entirely
 *   R4  native swap (/v1/messages) with the previous key ⇒ counted there
 *       (the middleware exemption path must not double-count)
 *   R5  native count_tokens swap ⇒ counted
 *   R6  the forceConsole marker fires once per bucket per hour — a second
 *       hit inside the window is counted but stays silent
 *
 * Mutation proof (executed against this file, recorded in the PR):
 *   - remove the `noteProxyKeyAuthentication` call in the fork auth
 *     middleware ⇒ R1, R2 red (no bucket ever appears on /health).
 *   - remove the call in NativeHandler's swap ⇒ R4 red alone (R1/R2 green:
 *     the middleware site is intact) — proving the two sites are separately
 *     pinned.
 *   - drop the `lastMarkerAt` rate-limit check ⇒ R6 red (two markers).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  initProxyKeyRotationTracking,
  noteProxyKeyAuthentication,
  previousKeyHitsSnapshot,
  proxyKeyAuthBucket,
} from "./handlers/shared/proxy-key-rotation.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19921, 19961).
const PROXY_PORT = 19971;
const UPSTREAM_PORT = 19972;
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
];
const savedEnv: Record<string, string | undefined> = {};

const PRIMARY_KEY = "fake-cluster-key-439-primary";
const PREVIOUS_KEY = "fake-cluster-key-439-previous";
/** A stored Anthropic key so the native swap substitutes instead of
 * refusing shape A — the swap's counting must be observable end-to-end. */
const STORED_ANTHROPIC_KEY = "sk-ant-api03-fake-439";

const OPUS = "claude-opus-5-5";
/** Non-native target: the fake custom endpoint (server-held credential). */
const BUDGET_TARGET = "bud-ep@fake-bud";

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
/** Every [ProxyKey] stderr line — the countable marker. */
let markers: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

function budgetMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model: "fake-bud",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function anthropicMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_439",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: OPUS,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

beforeEach(() => {
  markers = [];
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "bud-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/bud/v1`,
          format: "openai",
          apiKey: "server-held-key",
        },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(UPSTREAM_BASE)) return budgetMessage();
    if (url.startsWith("https://api.anthropic.com/")) {
      if (url.endsWith("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicMessage();
    }
    return realFetch(input, init);
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[ProxyKey]")) markers.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
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
  // Leave the tracker inert for any test that runs after this file.
  initProxyKeyRotationTracking(undefined);
});

/** Spin the real proxy with both keys (rotation window open). */
async function spinWindowOpen(): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PRIMARY_KEY;
  process.env.CLAUDISH_PROXY_KEY_PREVIOUS = PREVIOUS_KEY;
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    STORED_ANTHROPIC_KEY,
    undefined,
    { quiet: true }
  );
}

/** Spin with the primary key only (no rotation window). */
async function spinWindowClosed(): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PRIMARY_KEY;
  delete process.env.CLAUDISH_PROXY_KEY_PREVIOUS;
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    STORED_ANTHROPIC_KEY,
    undefined,
    { quiet: true }
  );
}

async function post(
  path: string,
  model: string,
  auth: Record<string, string>
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...auth },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      metadata: { user_id: JSON.stringify({ session_id: "sess-439" }) },
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

async function health(): Promise<any> {
  const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  return res.json();
}

// ---- U1: bucket derivation (pure module) -----------------------------------------

describe("#439 U1 — bucket derivation", () => {
  beforeEach(() => initProxyKeyRotationTracking(PREVIOUS_KEY));

  test("machine header wins; UA token otherwise; hostile UA collapses to unknown", () => {
    expect(proxyKeyAuthBucket({ "x-claudish-machine": "myia-po-2027", "user-agent": "claude-cli/2.1.293" })).toBe("myia-po-2027");
    expect(proxyKeyAuthBucket({ "user-agent": "AsyncOpenAI/Python 3.24.0" })).toBe("AsyncOpenAI");
    expect(proxyKeyAuthBucket({ "user-agent": "open-code-review/v1.12.13" })).toBe("open-code-review");
    expect(proxyKeyAuthBucket({ "user-agent": "bad\u001b[2J/e Vil" })).toBe("unknown");
    expect(proxyKeyAuthBucket({})).toBe("unknown");
  });

  test("no snapshot fields without a window; hostile bucket never keyed", () => {
    initProxyKeyRotationTracking(undefined);
    noteProxyKeyAuthentication(PREVIOUS_KEY, { "user-agent": "bad\u001b[2J/e Vil" });
    expect(previousKeyHitsSnapshot()).toBeNull();
    initProxyKeyRotationTracking(PREVIOUS_KEY);
    noteProxyKeyAuthentication(PREVIOUS_KEY, { "user-agent": "bad\u001b[2J/e Vil" });
    const snap = previousKeyHitsSnapshot();
    expect(snap).not.toBeNull();
    expect(Object.keys(snap!.proxyKeyPreviousHits)).toEqual(["unknown"]);
    expect(snap!.proxyKeyPreviousHits["unknown"]).toBe(1);
  });
});

// ---- R1/R2/R6: the middleware site (non-native ingress) --------------------------

describe("#439 R1/R2/R6 — middleware site counts previous-key hits per bucket", () => {
  test("previous ⇒ machine bucket on /health; primary ⇒ nothing; marker rate-limited", async () => {
    await spinWindowOpen();
    const machine = { "x-proxy-key": PREVIOUS_KEY, "X-Claudish-Machine": "myia-po-2027" };

    const r1 = await post("/v1/messages", BUDGET_TARGET, machine);
    expect(r1.status).toBe(200);

    let h = await health();
    expect(h.proxyKeyPreviousHits).toEqual({ "myia-po-2027": 1 });
    expect(typeof h.proxyKeyPreviousLastAt["myia-po-2027"]).toBe("string");
    // No key material anywhere on the health surface.
    expect(JSON.stringify(h)).not.toContain(PREVIOUS_KEY);

    // R2 — no machine header: the UA product token becomes the bucket.
    const r2 = await post("/v1/messages", BUDGET_TARGET, {
      "x-proxy-key": PREVIOUS_KEY,
      "User-Agent": "open-code-review/v1.12.13",
    });
    expect(r2.status).toBe(200);
    h = await health();
    expect(h.proxyKeyPreviousHits).toEqual({ "myia-po-2027": 1, "open-code-review": 1 });

    // R6 — a second hit on the same bucket inside the hour: counted, silent.
    await post("/v1/messages", BUDGET_TARGET, machine);
    h = await health();
    expect(h.proxyKeyPreviousHits["myia-po-2027"]).toBe(2);
    const byBucket = markers.filter((m) => m.includes("myia-po-2027"));
    expect(byBucket).toHaveLength(1);
    expect(byBucket[0]).toContain("(n=1)");
    expect(markers.filter((m) => m.includes("open-code-review"))).toHaveLength(1);

    // Primary key: authenticated, counted nowhere.
    const rPrim = await post("/v1/messages", BUDGET_TARGET, {
      "x-proxy-key": PRIMARY_KEY,
      "X-Claudish-Machine": "myia-po-2027",
    });
    expect(rPrim.status).toBe(200);
    h = await health();
    expect(h.proxyKeyPreviousHits).toEqual({ "myia-po-2027": 2, "open-code-review": 1 });
  });
});

// ---- R3: no window ⇒ fields absent, retiring key refused --------------------------

describe("#439 R3 — no _PREVIOUS ⇒ /health omits the fields, old key refused", () => {
  test("previous key gets 401 and nothing is exposed", async () => {
    await spinWindowClosed();
    const res = await post("/v1/messages", BUDGET_TARGET, {
      "x-proxy-key": PREVIOUS_KEY,
      "X-Claudish-Machine": "myia-po-2027",
    });
    expect(res.status).toBe(401);
    const h = await health();
    expect(h.proxyKeyPreviousHits).toBeUndefined();
    expect(h.proxyKeyPreviousLastAt).toBeUndefined();
    expect(markers).toHaveLength(0);
  });
});

// ---- R4/R5: the native swap sites -------------------------------------------------

describe("#439 R4/R5 — native swap counts, exactly once per site", () => {
  test("/v1/messages native swap and count_tokens swap both count the machine bucket", async () => {
    await spinWindowOpen();
    const auth = { "x-api-key": PREVIOUS_KEY, "X-Claudish-Machine": "myia-ai-01" };

    // R4 — the native lane is EXEMPT from the middleware; the swap inside
    // NativeHandler is the only site that sees the key.
    const r4 = await post("/v1/messages", OPUS, auth);
    expect(r4.status).toBe(200);

    // R5 — the count_tokens native path has its own swap (proxy-server.ts).
    const r5 = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...auth },
      body: JSON.stringify({ model: OPUS, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r5.status).toBe(200);

    const h = await health();
    expect(h.proxyKeyPreviousHits).toEqual({ "myia-ai-01": 2 });
    expect(markers.filter((m) => m.includes("myia-ai-01"))).toHaveLength(1);
  });
});
