/**
 * #416 / #412 route pin — a request admitted WITHOUT a credential of its own
 * may only be served by the native passthrough, which spends the CLIENT's own
 * Anthropic-shaped credential.
 *
 * The middleware exemption admits; the RESOLUTION site decides. Every other
 * resolution spends a credential the caller does not hold: a modelMap reroute,
 * a routing entry, a custom endpoint, a cascade step, the one-shot overload
 * walk, the vision fallback.
 *
 * This file drives the REAL /v1/messages and /count_tokens routes in-process
 * (same harness contract as proxy-server-nonquota-unpin-route.test.ts): the
 * Request identity the guard reads is the one the real @hono/node-server
 * built, never a hand-made `app.request` object — `app.request` constructs a
 * fresh Request, and the WeakMap mark lives on the ORIGINAL, so a test built
 * on it would be green whatever the guard did.
 *
 * Matrix (review ai-01 08/10, point 5):
 *   T1  native positive control — keyless `sk-ant-oat` opus ⇒ 200 on native,
 *       zero fleet spend (the ai-01 lane that must not regress)
 *   T2  hub shape — keyless + a modelMap entry drawing on a server-held
 *       credential ⇒ labeled 401, zero upstream fetch, concrete lane named
 *   T3  native wall IN-REQUEST (point 1a) — the client's own 429 surfaces and
 *       NOTHING is armed: no substitution, no fleet state written
 *   T4  bucket ALREADY armed on the NEXT request (point 1b) — still native,
 *       never a 401 about a key the client never needed
 *   T5  keyed / relay-injected / scoped-inbound shapes — the guard must not
 *       fire on any of them
 *   T6  count_tokens — same invariant on the counting path
 *   T7  an image-bearing body (vision) is refused at RESOLUTION, before any
 *       fetch — the vision description call is unreachable keylessly
 *
 * Mutation proof — EXECUTED, each mutation run against this file and its red
 * set recorded (the header states what was measured, not what was intended):
 *   - disarm both `isKeylessExempt(...) && !(handler instanceof NativeHandler)`
 *     guards ⇒ T2, T6, T7 red (the request is served by the fake budget
 *     endpoint); T1, T3, T4, T5 stay green.
 *   - drop `suppressFailover` in the CASCADE loop only ⇒ T4 red (both cases);
 *     T3 stays green — its own no-arm branch returns before any retry.
 *   - drop the `keylessNative` branch in the quota-arm site ⇒ T3 red alone.
 *   - drop the suppression at the ROUTE's own resolution (log /
 *     billing-strip), keeping it in the loop ⇒ T4 red on the DWELL-PIN
 *     assertion while its status assertions stay green: the two resolutions of
 *     one request must agree, and the pin is what proves it.
 *   - remove `!keylessNative` from the overload-walk predicate ⇒ NO test goes
 *     red today (the bucket-prefix predicate still excludes the native lane).
 *     That is exactly why the explicit clause is there — it is the pin that
 *     survives a future bucketing change — and it is the one mutation this
 *     matrix cannot execute; it is named rather than implied.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  NATIVE_BUCKET,
  armFailover,
  getSessionDwellPinForTests,
  isBucketWalled,
  isQuotaExhaustion,
  nativeBucketFor,
  resetFailoverForTests,
} from "./fork/failover.js";
import { keylessRefusalMessage } from "./handlers/shared/keyless-exempt.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19921).
const PROXY_PORT = 19961;
const UPSTREAM_PORT = 19962;
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
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-416-test";
const OAUTH_BEARER = "Bearer sk-ant-oat01-416-test";
const SCOPED_KEY = "scoped-key-416";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
/** The fake custom endpoint the modelMap entries point at — a SERVER-held
 * credential, the thing a keyless request must never reach. */
const BUDGET_TARGET = "bud-ep@fake-bud";

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
/** Upstream call counters. `anthropic` = the native lane; `bud` = the budget
 * endpoint behind a server-held key. */
let calls: { anthropic: number; bud: number } = { anthropic: 0, bud: 0 };
/** Whether the fake native lane answers a quota wall instead of a message. */
let nativeWalls = false;
/** Every [ProxyAuth] / [Failover] stderr line — the countable markers. */
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
        message: "Your weekly usage limit will reset on 2026-10-12.",
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
      customEndpoints: {
        "bud-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/bud/v1`,
          format: "openai",
          apiKey: "server-held-key",
        },
      },
      // #400 — a scoped inbound key: authenticates like a proxy key but only
      // reaches its allowlist. It must never be read as "keyless".
      inboundKeys: {
        "ext-416": { key: SCOPED_KEY, allowModels: [SONNET] },
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
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.anthropic++;
      if (url.endsWith("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return nativeWalls ? anthropicWall() : anthropicMessage();
    }
    if (url.startsWith(UPSTREAM_BASE)) {
      calls.bud++;
      if (url.includes("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return budgetMessage();
    }
    return realFetch(input, init);
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

async function spin(): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined, // no stored Anthropic key: the native lane rides the client's own OAuth token
    MODEL_MAP,
    { quiet: true }
  );
}

async function post(
  path: string,
  model: string,
  auth: Record<string, string>,
  extraBody: Record<string, unknown> = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...auth },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      metadata: { user_id: JSON.stringify({ session_id: "sess-416" }) },
      messages: [{ role: "user", content: "say hi" }],
      ...extraBody,
    }),
  });
}

/** A keyless native request as ai-01 sends it: the client's own OAuth token,
 * no cluster key. */
const oauth = { authorization: OAUTH_BEARER };

// ---- T1: the lane that must not regress -----------------------------------------

describe("#416 T1 — native positive control", () => {
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

describe("#416 T2 — keyless + a server-held credential is refused before any fetch", () => {
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

// ---- T3: the native wall in-request (point 1a) -------------------------------------

describe("#416 T3 — a keyless native wall surfaces as the CLIENT's own 429", () => {
  test("in-request: no substitution into the cascade, and nothing is armed", async () => {
    await spin();
    resetFailoverForTests(CASCADE_ENV);
    nativeWalls = true;
    const res = await post("/v1/messages", OPUS, oauth);
    // The client's own meter is the exhausted one — its own wall surfaces.
    expect(res.status).toBe(429);
    // The substitution the pre-#412 flow would have performed: zero.
    expect(calls.bud).toBe(0);
    expect(calls.anthropic).toBe(1);
    // And no fleet state was written off a credential the fleet does not hold.
    expect(isBucketWalled(nativeBucketFor(OPUS))).toBe(false);
    expect(markers.filter((m) => m.includes("ARMED bucket"))).toHaveLength(0);
    expect(markers.some((m) => m.includes("[ProxyAuth] keyless native"))).toBe(true);
  });
});

// ---- T4: the bucket already armed on the next request (point 1b) --------------------

describe("#416 T4 — an already-armed native bucket still keeps the native trajectory", () => {
  test("armed bucket + healthy native ⇒ 200 native, never the substitution's lane", async () => {
    await spin();
    resetFailoverForTests(CASCADE_ENV);
    armFailover("opus", "test: native bucket already walled", nativeBucketFor(OPUS));
    expect(isBucketWalled(nativeBucketFor(OPUS))).toBe(true);
    const res = await post("/v1/messages", OPUS, oauth);
    expect(res.status).toBe(200);
    expect(calls.anthropic).toBe(1);
    expect(calls.bud).toBe(0);
    // The route resolves the handler too (for the log + the billing-header
    // strip), and that resolution writes the #91 per-session dwell pin unless
    // it carries the SAME suppression. A keyless request must leave no pin:
    // the pin is fleet failover state, and this request may not spend fleet
    // budget, so it may not steer the next one.
    expect(getSessionDwellPinForTests("opus", "sess-416")).toBeNull();
    expect(markers.filter((m) => m.includes("DWELL opus"))).toHaveLength(0);
  });

  test("armed bucket + still-walled native ⇒ 429, NOT a 401 about a key never needed", async () => {
    await spin();
    resetFailoverForTests(CASCADE_ENV);
    armFailover("opus", "test: native bucket already walled", nativeBucketFor(OPUS));
    nativeWalls = true;
    const res = await post("/v1/messages", OPUS, oauth);
    expect(res.status).toBe(429);
    expect(res.status).not.toBe(401);
    expect(calls.bud).toBe(0);
    expect(getSessionDwellPinForTests("opus", "sess-416")).toBeNull();
  });
});

// ---- T5: keyed, relay-injected and scoped shapes -----------------------------------

describe("#416 T5 — authorized shapes are untouched", () => {
  test("keyed request to a modelMap-budget target is served (it may spend fleet budget)", async () => {
    await spin();
    const res = await post("/v1/messages", SONNET, { "x-proxy-key": PROXY_KEY });
    expect(res.status).toBe(200);
    expect(calls.bud).toBe(1);
  });

  test("relay-injected cluster key ⇒ treated as authenticated, never as keyless", async () => {
    await spin();
    // A sidecar forwards with the cluster key injected as `x-proxy-key`: that
    // authenticates the RELAY, and the hub cannot see the client's own
    // credential behind it. Scope of this pin, stated rather than assumed: it
    // verifies the HUB's reading of a relay-shaped request, observed on a
    // direct connection. The sidecar's own ingress ACLs are NOT exercised
    // here and live with their owner.
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

// ---- T6: count_tokens --------------------------------------------------------------

describe("#416 T6 — the counting path carries the same invariant", () => {
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
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
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

// ---- T7: vision scope --------------------------------------------------------------

describe("#416 T7 — an image-bearing body is refused at resolution, before any fetch", () => {
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
  // call (services/vision-proxy.ts, reached from ComposedHandler on a
  // non-vision model) is not exercised by this file. The guard sits at handler
  // RESOLUTION, so a keyless request is refused before that path — which the
  // assertion above measures — but a future refactor that moved the vision
  // call ahead of resolution would not be caught here.
  test("the guard is at resolution, not per-feature (documented scope)", () => {
    expect(NATIVE_BUCKET).toBe("anthropic-native");
  });
});
