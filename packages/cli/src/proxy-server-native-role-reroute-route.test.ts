/**
 * #555 step 2b route pin — a request whose NOMINAL is the native lane but which
 * carries no Anthropic credential the native lane could send (#296 shape A/B)
 * resolves as the `sonnet` ROLE instead of being answered by a bare 403.
 *
 * Measured 20/10 on the hub, before this change: `opus` (bare) from a seat
 * without an Anthropic credential ⇒ 403 permission_error in 0.1 s, no cascade
 * (the refusal is deliberately not a quota class). The bare role names remove
 * the explicit non-native ids those seats used to name, so every opus turn of a
 * proxy-only seat would have been that 403.
 *
 * Drives the REAL /v1/messages, /count_tokens and /v1/chat/completions routes
 * in-process (same harness contract as proxy-server-keyless-exempt-route.test.ts:
 * the Request identity the keyless / inbound marks live on is the one the real
 * @hono/node-server built).
 *
 * Matrix:
 *   R1  hub shape — cluster key only, bare `opus` and versioned `claude-opus-5-5`
 *       ⇒ 200 from modelMap.sonnet, zero native fetch, decision logged
 *   R2  shape B — a foreign Bearer beside the cluster key ⇒ same reroute
 *   R3  the substitute's wall is recorded on the SONNET trajectory — never on
 *       the native bucket (that would divert the opus of ai-01, which has a
 *       credential) — and the sonnet cascade serves the turn
 *   R4  ai-01 shapes — sk-ant OAuth, keyless or beside the cluster key ⇒ native
 *   R5  kill switch `CLAUDISH_NATIVE_CREDENTIALLESS_REROUTE=0` ⇒ the bare 403
 *   R6  a sonnet nominal that is itself native ⇒ no servable role, 403 stays
 *   R7  keyless and scoped-inbound requests are never rerouted (#412 / #400)
 *   R8  count_tokens and the OpenAI-compatible ingress resolve the same way
 *   U   NativeHandler.credentialRefusalShape is a dry run of handle()'s swap
 *
 * Mutation proof — EXECUTED, red sets recorded in the PR body.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { NativeHandler } from "./handlers/native-handler.js";
import {
  getSessionDwellPinForTests,
  isBucketWalled,
  nativeBucketFor,
  resetFailoverForTests,
} from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (see their headers).
const PROXY_PORT = 20125;
const UPSTREAM_PORT = 20225;
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
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
  "CLAUDISH_NATIVE_MODEL_PIN", "CLAUDISH_FAILOVER_OVERLOAD_WALK",
  "CLAUDISH_NATIVE_CREDENTIALLESS_REROUTE",
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-555-test";
const OAUTH_BEARER = "Bearer sk-ant-oat01-555-test";
const SCOPED_KEY = "scoped-key-555";

const OPUS = "claude-opus-5-5";
const SONNET_NATIVE = "claude-sonnet-5-5";
/** modelMap.sonnet — a SERVER-held budget endpoint, like the hub's glm-5.3. */
const SONNET_TARGET = "bud-ep@fake-bud";
/** The sonnet cascade's step — a second endpoint, a different bucket. */
const SONNET_STEP = "bud2-ep@fake-bud2";

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: { anthropic: number; bud: number; bud2: number } = { anthropic: 0, bud: 0, bud2: 0 };
/** Whether the sonnet nominal answers a quota wall (402) instead of a message. */
let budWalls = false;
/** Every reroute decision line the route logs (console.log under force). */
let decisions: string[] = [];
const realConsoleLog = console.log;

function anthropicMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_555",
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

function budgetMessage(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-555",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function budgetWall(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Insufficient balance on this plan.", type: "insufficient_quota" } }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

function writeConfig(inboundAllow: string[]): void {
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "bud-ep": { kind: "simple", url: `${UPSTREAM_BASE}/bud/v1`, format: "openai", apiKey: "server-held-key" },
        "bud2-ep": { kind: "simple", url: `${UPSTREAM_BASE}/bud2/v1`, format: "openai", apiKey: "server-held-key-2" },
      },
      inboundKeys: { "ext-555": { key: SCOPED_KEY, allowModels: inboundAllow } },
    }),
    "utf-8"
  );
}

beforeEach(() => {
  calls = { anthropic: 0, bud: 0, bud2: 0 };
  budWalls = false;
  decisions = [];
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeConfig([OPUS]);
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.anthropic++;
      if (url.endsWith("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return anthropicMessage();
    }
    if (url.startsWith(`${UPSTREAM_BASE}/bud2/`)) {
      calls.bud2++;
      return budgetMessage("fake-bud2");
    }
    if (url.startsWith(`${UPSTREAM_BASE}/bud/`)) {
      calls.bud++;
      return budWalls ? budgetWall() : budgetMessage("fake-bud");
    }
    return realFetch(input, init);
  }) as typeof fetch;
  console.log = ((...args: any[]) => {
    const text = args.map(String).join(" ");
    if (text.includes("carries no Anthropic credential")) decisions.push(text);
    return realConsoleLog(...args);
  }) as typeof console.log;
});

afterEach(async () => {
  console.log = realConsoleLog;
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

/** The hub's shape: opus native, sonnet on a server-held budget endpoint. */
const HUB_MAP = { opus: OPUS, sonnet: SONNET_TARGET } as Record<string, string>;

async function spin(modelMap: Record<string, string> = HUB_MAP): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined, // the hub holds no Anthropic credential
    modelMap,
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
      metadata: { user_id: JSON.stringify({ session_id: "sess-555" }) },
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** A proxy-only seat: the cluster key, nothing Anthropic. */
const clusterOnly = { "x-proxy-key": PROXY_KEY };

// ---- R1: the hub shape ---------------------------------------------------------

describe("#555 R1 — a native nominal without an Anthropic credential resolves as the sonnet role", () => {
  test("bare `opus` ⇒ 200 from modelMap.sonnet, zero native fetch, decision logged", async () => {
    await spin();
    const res = await post("/v1/messages", "opus", clusterOnly);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain("native 'opus'");
    expect(decisions[0]).toContain("shape=A");
    expect(decisions[0]).toContain("role 'sonnet'");
  });

  test("versioned `claude-opus-5-5` (today's explicit native id) ⇒ same reroute", async () => {
    await spin();
    const res = await post("/v1/messages", OPUS, clusterOnly);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(1);
  });

  test("a request whose nominal is NOT native is untouched (no decision logged)", async () => {
    await spin();
    const res = await post("/v1/messages", "sonnet", clusterOnly);
    expect(res.status).toBe(200);
    expect(calls.bud).toBe(1);
    expect(decisions).toHaveLength(0);
  });
});

// ---- R2: shape B -------------------------------------------------------------------

describe("#555 R2 — a foreign credential (shape B) reroutes the same way", () => {
  test("foreign Bearer beside the cluster key ⇒ 200 on the sonnet role, shape=B logged", async () => {
    await spin();
    const res = await post("/v1/messages", "opus", {
      ...clusterOnly,
      authorization: "Bearer some-foreign-provider-token",
    });
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(1);
    expect(decisions[0]).toContain("shape=B");
  });
});

// ---- R3: failover state lands on the sonnet trajectory -----------------------------

describe("#555 R3 — the substitute's wall never touches the native bucket", () => {
  test("sonnet nominal walls ⇒ the SONNET cascade serves, the native opus bucket stays clear", async () => {
    await spin();
    resetFailoverForTests({
      CLAUDISH_FAILOVER_OPUS: SONNET_STEP,
      CLAUDISH_FAILOVER_SONNET: SONNET_STEP,
      CLAUDISH_FAILOVER_AUTO: "1",
      CLAUDISH_FAILOVER_ARM_AFTER: "1",
    } as Record<string, string>);
    budWalls = true;
    const res = await post("/v1/messages", "opus", clusterOnly);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(1);
    expect(calls.bud2).toBe(1);
    // The wall is the sonnet nominal's — recording it on the native bucket
    // would divert every credentialed opus request (ai-01) to the opus cascade.
    expect(isBucketWalled(nativeBucketFor(OPUS))).toBe(false);
    // No opus-role state either: the request never ran as opus.
    expect(getSessionDwellPinForTests("opus", "sess-555")).toBeNull();
  });
});

// ---- R4: ai-01 shapes --------------------------------------------------------------

describe("#555 R4 — an Anthropic-shaped credential keeps the native lane", () => {
  test("keyless sk-ant OAuth `opus` ⇒ native 200, no reroute", async () => {
    await spin();
    const res = await post("/v1/messages", "opus", { authorization: OAUTH_BEARER });
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.bud).toBe(0);
    expect(decisions).toHaveLength(0);
  });

  test("sk-ant OAuth beside the cluster key (relayed ai-01) ⇒ native 200, no reroute", async () => {
    await spin();
    const res = await post("/v1/messages", "opus", { ...clusterOnly, authorization: OAUTH_BEARER });
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.bud).toBe(0);
    expect(decisions).toHaveLength(0);
  });
});

// ---- R5: kill switch ---------------------------------------------------------------

describe("#555 R5 — kill switch restores the bare 403", () => {
  test("CLAUDISH_NATIVE_CREDENTIALLESS_REROUTE=0 ⇒ 403 permission_error, zero fetch (read per request)", async () => {
    await spin();
    process.env.CLAUDISH_NATIVE_CREDENTIALLESS_REROUTE = "0";
    const res = await post("/v1/messages", "opus", clusterOnly);
    expect(res.status).toBe(403);
    const raw: any = await res.json();
    expect(raw.error.type).toBe("permission_error");
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(0);
    expect(decisions).toHaveLength(0);
    // Same proxy, switch cleared: the reroute is back without a restart.
    delete process.env.CLAUDISH_NATIVE_CREDENTIALLESS_REROUTE;
    const again = await post("/v1/messages", "opus", clusterOnly);
    expect(again.status).toBe(200);
    expect(calls.bud).toBe(1);
  });
});

// ---- R6: no servable role ----------------------------------------------------------

describe("#555 R6 — a sonnet nominal that is itself native leaves nothing to go to", () => {
  test("modelMap.sonnet native ⇒ the 403 stays (honest), zero fetch", async () => {
    await spin({ opus: OPUS, sonnet: SONNET_NATIVE });
    const res = await post("/v1/messages", "opus", clusterOnly);
    expect(res.status).toBe(403);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(0);
    expect(decisions).toHaveLength(0);
  });
});

// ---- R7: keyless and scoped-inbound requests ---------------------------------------

describe("#555 R7 — requests that may not spend the substitute are never rerouted", () => {
  test("keyless request with no credential at all ⇒ not rerouted, zero budget fetch (#412)", async () => {
    await spin();
    const res = await post("/v1/messages", "opus", {});
    expect(res.ok).toBe(false);
    expect(calls.bud).toBe(0);
    expect(calls.anthropic).toBe(0);
    expect(decisions).toHaveLength(0);
  });

  test("scoped inbound key allowlisting the native id ⇒ not rerouted, zero budget fetch (#400)", async () => {
    await spin();
    const res = await post("/v1/messages", OPUS, { "x-api-key": SCOPED_KEY });
    expect(res.status).toBe(403);
    expect(calls.bud).toBe(0);
    expect(calls.anthropic).toBe(0);
    expect(decisions).toHaveLength(0);
  });
});

// ---- R8: count_tokens and the OpenAI-compatible ingress -----------------------------

describe("#555 R8 — the other routes resolve under the same name", () => {
  test("count_tokens ⇒ 200 estimation instead of the 403, zero native fetch", async () => {
    await spin();
    const res = await post("/v1/messages/count_tokens", "opus", clusterOnly);
    expect(res.status).toBe(200);
    const raw: any = await res.json();
    expect(typeof raw.input_tokens).toBe("number");
    expect(calls.anthropic).toBe(0);
  });

  test("count_tokens with sk-ant OAuth ⇒ still forwarded natively", async () => {
    await spin();
    const res = await post("/v1/messages/count_tokens", "opus", { authorization: OAUTH_BEARER });
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
  });

  test("OpenAI-compatible ingress ⇒ 200 on the sonnet role", async () => {
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clusterOnly },
      body: JSON.stringify({
        model: "opus",
        max_tokens: 16,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(1);
  });
});

// ---- U: the predicate is a dry run of handle()'s swap -------------------------------

describe("#555 U — NativeHandler.credentialRefusalShape", () => {
  const keys = [PROXY_KEY];

  test("cluster key as the client credential, no stored key ⇒ A", () => {
    const h = new NativeHandler(undefined, undefined, undefined, keys);
    expect(h.credentialRefusalShape({ "x-api-key": PROXY_KEY })).toBe("A");
    expect(h.credentialRefusalShape({ authorization: `Bearer ${PROXY_KEY}` })).toBe("A");
    expect(h.credentialRefusalShape({ "x-proxy-key": PROXY_KEY })).toBe("A");
  });

  test("cluster key swapped for a stored key ⇒ null (substituted credential is exempt)", () => {
    const h = new NativeHandler("stored-operator-key", undefined, undefined, keys);
    expect(h.credentialRefusalShape({ "x-api-key": PROXY_KEY })).toBeNull();
  });

  test("sk-ant OAuth ⇒ null; foreign Bearer ⇒ B", () => {
    const h = new NativeHandler(undefined, undefined, undefined, keys);
    expect(h.credentialRefusalShape({ authorization: OAUTH_BEARER })).toBeNull();
    expect(h.credentialRefusalShape({ authorization: "Bearer foreign" })).toBe("B");
  });

  test("no side effect on the client's headers", () => {
    const h = new NativeHandler("stored-operator-key", undefined, undefined, keys);
    const original = { "x-api-key": PROXY_KEY, "x-proxy-key": PROXY_KEY };
    const snapshot = JSON.stringify(original);
    h.credentialRefusalShape(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
