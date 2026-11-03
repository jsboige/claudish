/**
 * #412 / #416 route pin (replatform/v14 port) — a request admitted WITHOUT a
 * credential of its own may only be served by the native passthrough, which
 * spends the CLIENT's own Anthropic-shaped credential.
 *
 * The middleware half (proxy-auth's mark) and the relay half (cluster key not
 * injected on a keyless forward) rode in with the #641 G3 port; this file pins
 * the RESOLUTION half this grain wires: the loop guard, the cascade
 * suppression, the arm-site early return, and the count_tokens refusal.
 *
 * Harness: same contract as proxy-server-overload-walk-route.test.ts — the
 * REAL proxy runs on an ephemeral port (`activeProxy.url`, never a hand-made
 * `app.request` object: that would build a fresh Request and read an unmarked
 * WeakSet, so every case would pass whatever the guard did), the fake budget
 * endpoint registers through the config the proxy itself loads, and the
 * outbound legs are answered by a stubbed fetch. The config FILE is written
 * (backed up / restored) because the scoped-inbound-key shapes (#400) have no
 * other entry point on this base.
 *
 * Matrix (review ai-01 08/10, point 5 — same numbering as main's suite):
 *   T1  native positive control — keyless `sk-ant-oat` opus ⇒ 200 on native,
 *       zero fleet spend (the ai-01 lane that must not regress)
 *   T2  hub shape — keyless + a modelMap entry drawing on a server-held
 *       credential ⇒ labeled 401, zero upstream fetch, concrete lane named
 *   T3  native wall IN-REQUEST — the client's own 429 surfaces and NOTHING is
 *       armed: no substitution, no fleet state written
 *   T4  bucket ALREADY armed on the NEXT request — still native, never a 401
 *       about a key the client never needed
 *   T5  keyed / relay-injected / scoped-inbound shapes — the guard must not
 *       fire on any of them (the RELAY's own side lives in
 *       fork/server/relay-keyless-forward.test.ts, already on this base)
 *   T6  count_tokens + the OpenAI-compatible ingress — same invariant
 *   T7  an image-bearing body (vision) is refused at RESOLUTION, before any
 *       fetch — the vision path is unreachable keylessly
 *
 * Mutation proof — EXECUTED against this file, red set measured (not
 * predicted) and recorded in the PR body:
 *   - disarm the loop guard ⇒ T2/T6(ingress) red; T1/T3/T4/T5 stay green
 *   - disarm the count_tokens guard ⇒ T6(count) red alone
 *   - drop `!keylessNative` in the resolved clause ⇒ T4 red (both cases)
 *   - drop the `keylessNative` branch at the arm site ⇒ T3 red on the STATE
 *     assertion (isBucketWalled), its status staying green — the 429 shape is
 *     identical, only the written state differs
 *   - remove the middleware mark ⇒ T2/T3/T4 red
 *   - a quota word in keylessRefusalMessage ⇒ the wording pin red against the
 *     REAL isQuotaExhaustion
 *   - name the handler class instead of the concrete lane ⇒ T2's lane
 *     assertions red
 *   - the `if (response) return response` prior-answer branch in the loop
 *     guard is expected NON-KILLER (the arm-site return exits a keyless
 *     native request first; the branch is defense-in-depth for a future path
 *     that lets one walk past a native refusal) — measured and reported as
 *     such, never assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_BUCKET,
  armFailover,
  getSessionDwellPinForTests,
  isBucketWalled,
  isQuotaExhaustion,
  nativeBucketFor,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import { keylessRefusalMessage } from "./handlers/shared/keyless-exempt.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

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
  "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
  "CLAUDISH_NATIVE_MODEL_PIN",
  "CLAUDISH_RELAY_UPSTREAM",
];
const savedEnv: Record<string, string | undefined> = {};
/** The full CLAUDISH_FAILOVER_* wipe (same as the overload-walk suite): an
 * armed cascade leaking from another test file would divert T2's request. */
let sandboxedFailoverKeys: string[] = [];
let savedFailoverEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-412-test";
const OAUTH_BEARER = "Bearer sk-ant-oat01-412-test";
const SCOPED_KEY = "scoped-key-412";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
/** The fake custom endpoint the modelMap entries point at — a SERVER-held
 * credential, the thing a keyless request must never reach. */
const BUDGET_TARGET = "bud-ep@fake-bud";

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch.bind(globalThis);
/** Upstream call counters. `anthropic` = the native lane; `bud` = the budget
 * endpoint behind a server-held key. */
let calls: { anthropic: number; bud: number } = { anthropic: 0, bud: 0 };
/** Whether the fake native lane answers a quota wall instead of a message. */
let nativeWalls = false;
/** Every [ProxyAuth] stderr line — the countable markers. */
let markers: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

function anthropicMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_route_test",
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

/** The wall the native lane answers with: a quota-class body, so
 * `isQuotaExhaustion` fires and the PRE-#412 flow would arm the role and
 * retry into the cascade. */
function anthropicWall(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Your weekly usage limit will reset on 2026-11-12.",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } }
  );
}

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

beforeEach(() => {
  calls = { anthropic: 0, bud: 0 };
  nativeWalls = false;
  markers = [];
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "bud-ep": {
          kind: "simple",
          url: "http://fake.invalid/bud/v1",
          format: "openai",
          apiKey: "server-held-key",
        },
      },
      // #400 — a scoped inbound key: authenticates like a proxy key but only
      // reaches its allowlist. It must never be read as "keyless".
      inboundKeys: {
        "ext-412": { key: SCOPED_KEY, allowModels: [SONNET] },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sandboxedFailoverKeys = Object.keys(process.env).filter((k) =>
    k.startsWith("CLAUDISH_FAILOVER_")
  );
  savedFailoverEnv = {};
  for (const k of sandboxedFailoverKeys) {
    savedFailoverEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any) => {
    // Request / URL instances reach here too (the native lane builds a
    // Request); reading only `input.url` would silently fall through and make
    // a native answer look like the budget endpoint's (measured trap, #820).
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? "");
    if (url.includes("api.anthropic.com")) {
      calls.anthropic++;
      if (url.endsWith("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return nativeWalls ? anthropicWall() : anthropicMessage();
    }
    if (url.startsWith("http://fake.invalid/bud")) {
      calls.bud++;
      return budgetMessage();
    }
    // Background warmers (pricing / catalog) and anything else.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[ProxyAuth]") || line.includes("[Failover]")) markers.push(line);
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
  for (const k of sandboxedFailoverKeys) {
    const v = savedFailoverEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFailoverForTests();
});

/** opus stays native (modelMap pins it to itself); sonnet resolves to the
 * budget endpoint. This is the pair that separates "a native request that got
 * substituted" from "a request whose nominal was never native". */
const MODEL_MAP = { opus: OPUS, sonnet: BUDGET_TARGET } as Record<string, string>;

const CASCADE_ENV = {
  CLAUDISH_FAILOVER_OPUS: BUDGET_TARGET,
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** Re-init the module with the cascade env and re-inject the nominal resolver
 * (resetFailoverForTests clears it; the proxy injected its own at startup). */
function armOpusCascade(): void {
  resetFailoverForTests({ ...CASCADE_ENV });
  setRoleNominalResolver((r) => (r === "opus" ? OPUS : undefined));
}

async function spin(): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
  activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, MODEL_MAP, {
    quiet: true,
  });
}

async function post(
  path: string,
  model: string,
  auth: Record<string, string>,
  extraBody: Record<string, unknown> = {}
): Promise<Response> {
  return realFetch(`${activeProxy!.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...auth },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      metadata: { user_id: JSON.stringify({ session_id: "sess-412" }) },
      messages: [{ role: "user", content: "say hi" }],
      ...extraBody,
    }),
  });
}

/** A keyless native request as ai-01 sends it: the client's own OAuth token,
 * no cluster key. */
const oauth = { authorization: OAUTH_BEARER };

// ---- T1: the lane that must not regress -----------------------------------------

describe("#412 T1 — native positive control", () => {
  test("keyless sk-ant-oat opus ⇒ 200 on the native passthrough, zero fleet spend", async () => {
    await spin();
    const res = await post("/v1/messages", OPUS, oauth);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.bud).toBe(0);
    expect(markers.filter((m) => m.includes("[ProxyAuth] keyless request"))).toHaveLength(0);
  });
});

// ---- T2: the hub shape ------------------------------------------------------------

describe("#412 T2 — keyless + a server-held credential is refused before any fetch", () => {
  test("modelMap entry drawing on the fleet's key ⇒ 401, zero upstream fetch, concrete lane named", async () => {
    await spin();
    const res = await post("/v1/messages", SONNET, {});
    expect(res.status).toBe(401);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(0);
    const raw: any = await res.json();
    expect(raw.type).toBe("error");
    expect(raw.error.type).toBe("authentication_error");
    // Point 4: the lane must be the CONCRETE target, never the handler class.
    expect(raw.error.message).toContain("bud-ep@fake-bud");
    expect(raw.error.message).not.toContain("ComposedHandler");
    expect(raw.error.message).toContain(SONNET);
  });

  test("the refusal wording never arms the fleet's own failover (#296 doctrine)", () => {
    const msg = keylessRefusalMessage(SONNET, "bud-ep@fake-bud");
    // The real predicate, not a paraphrase of it.
    expect(isQuotaExhaustion(401, msg)).toBe(false);
    expect(isQuotaExhaustion(403, msg)).toBe(false);
    for (const word of ["quota", "credit", "balance", "weekly", "plan limit", "usage limit"]) {
      expect(msg.toLowerCase()).not.toContain(word);
    }
  });
});

// ---- T3: the native wall in-request ------------------------------------------------

describe("#412 T3 — a keyless native wall surfaces as the CLIENT's own 429", () => {
  test("in-request: no substitution into the cascade, and nothing is armed", async () => {
    await spin();
    armOpusCascade();
    nativeWalls = true;
    const res = await post("/v1/messages", OPUS, oauth);
    // The client's own meter is the exhausted one — its own wall surfaces.
    expect(res.status).toBe(429);
    // The substitution the pre-#412 flow would have performed: zero.
    expect(calls.bud).toBe(0);
    expect(calls.anthropic).toBe(1);
    // And no fleet state was written off a credential the fleet does not hold.
    expect(isBucketWalled(nativeBucketFor(OPUS))).toBe(false);
    expect(markers.some((m) => m.includes("[ProxyAuth] keyless native"))).toBe(true);
  });
});

// ---- T4: the bucket already armed on the next request -------------------------------

describe("#412 T4 — an already-armed native bucket still keeps the native trajectory", () => {
  test("armed bucket + healthy native ⇒ 200 native, never the substitution's lane", async () => {
    await spin();
    armOpusCascade();
    armFailover("opus", "test: native bucket already walled", nativeBucketFor(OPUS));
    expect(isBucketWalled(nativeBucketFor(OPUS))).toBe(true);
    const res = await post("/v1/messages", OPUS, oauth);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.bud).toBe(0);
    // The suppressed resolution is never called, so it can write no #91
    // per-session dwell pin: the pin is fleet failover state, and this request
    // may not spend fleet budget, so it may not steer the next one. (On main
    // the ROUTE's own resolution was the second pin writer and needed the same
    // suppression; this base has no route-level resolution — the loop is the
    // only writer, and the pin assertion still proves it stayed silent.)
    expect(getSessionDwellPinForTests("opus", "sess-412")).toBeNull();
  });

  test("armed bucket + still-walled native ⇒ 429, NOT a 401 about a key never needed", async () => {
    await spin();
    armOpusCascade();
    armFailover("opus", "test: native bucket already walled", nativeBucketFor(OPUS));
    nativeWalls = true;
    const res = await post("/v1/messages", OPUS, oauth);
    expect(res.status).toBe(429);
    expect(res.status).not.toBe(401);
    expect(calls.bud).toBe(0);
    expect(getSessionDwellPinForTests("opus", "sess-412")).toBeNull();
  });
});

// ---- T5: keyed, relay-injected and scoped shapes ------------------------------------

describe("#412 T5 — authorized shapes are untouched", () => {
  test("keyed request to a modelMap-budget target is served (it may spend fleet budget)", async () => {
    await spin();
    const res = await post("/v1/messages", SONNET, { "x-proxy-key": PROXY_KEY });
    expect(res.status).toBe(200);
    expect(calls.bud).toBe(1);
  });

  test("HUB reading of a relay-shaped forward (cluster key in x-proxy-key) ⇒ authenticated, never keyless", async () => {
    await spin();
    // A sidecar forwards with the cluster key injected as `x-proxy-key`: that
    // authenticates the RELAY, and the hub cannot see the client's own
    // credential behind it. Scope (review ai-01 09/10, point 3): this verifies
    // the HUB's READING of an already-relayed request on a direct connection;
    // the relay's own side (it must not manufacture that shape for a client
    // holding no key) is pinned in fork/server/relay-keyless-forward.test.ts,
    // already carried on this base.
    const res = await post("/v1/messages", SONNET, { "x-proxy-key": PROXY_KEY });
    expect(res.status).toBe(200);
    expect(calls.bud).toBe(1);
    expect(markers.filter((m) => m.includes("[ProxyAuth] keyless request"))).toHaveLength(0);
  });

  test("scoped inbound key on an allowlisted model ⇒ its own gate, not the keyless 401", async () => {
    await spin();
    const res = await post("/v1/messages", SONNET, { "x-api-key": SCOPED_KEY });
    expect(res.status).toBe(200);
    expect(calls.bud).toBe(1);
  });

  test("scoped inbound key off its allowlist ⇒ its OWN 403, still not the keyless 401", async () => {
    await spin();
    const res = await post("/v1/messages", OPUS, { "x-api-key": SCOPED_KEY });
    expect(res.status).toBe(403);
    const raw: any = await res.json();
    expect(raw.error.message).toContain("[InboundKey]");
    expect(raw.error.message).not.toContain("keyless request");
    expect(calls.anthropic).toBe(0);
  });
});

// ---- T6: count_tokens + the OpenAI-compatible ingress -------------------------------

describe("#412 T6 — the counting path and the OpenAI ingress carry the same invariant", () => {
  test("keyless + a server-held credential ⇒ 401, zero upstream fetch", async () => {
    await spin();
    const res = await post("/v1/messages/count_tokens", SONNET, {});
    expect(res.status).toBe(401);
    expect(calls.anthropic).toBe(0);
    expect(calls.bud).toBe(0);
  });

  test("keyless + native ⇒ forwarded to the counting endpoint", async () => {
    await spin();
    const res = await post("/v1/messages/count_tokens", OPUS, oauth);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
  });

  test("the OpenAI-compatible ingress carries the same invariant", async () => {
    await spin();
    const res = await realFetch(`${activeProxy!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONNET,
        max_tokens: 16,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    expect(res.status).toBe(401);
    expect(calls.bud).toBe(0);
  });
});

// ---- T7: vision scope -----------------------------------------------------------------

describe("#412 T7 — an image-bearing body is refused at resolution, before any fetch", () => {
  test("keyless + budget target + images ⇒ 401 with zero upstream calls (no vision description call either)", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      SONNET,
      {},
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      }
    );
    expect(res.status).toBe(401);
    expect(calls.bud).toBe(0);
    expect(calls.anthropic).toBe(0);
  });

  // Named gap, not a claim of coverage: the vision fallback's OWN description
  // call is not exercised by this file. The guard sits at handler RESOLUTION,
  // so a keyless request is refused before that path — which the assertion
  // above measures — but a future refactor that moved the vision call ahead of
  // resolution would not be caught here.
  test("the guard is at resolution, not per-feature (documented scope)", () => {
    expect(NATIVE_BUCKET).toBe("anthropic-native");
  });
});
