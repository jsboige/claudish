/**
 * #296 — native-lane credential guard, forms A and B, both native paths.
 *
 * Shape A: the client token matched a proxy key, the swap removed it, no
 * stored apiKey to substitute → the request used to leave for
 * api.anthropic.com with NO credential at all.
 * Shape B: a valid x-proxy-key passes the gate and a FOREIGN Bearer rides the
 * passthrough → a third party received a token it should never see.
 *
 * Both are refused locally: a stub fetch shows 0 calls to api.anthropic.com.
 * The OAuth-shaped passthrough (ai-01) still makes exactly 1 call. Assertions
 * are name-only: no credential value, prefix or length appears here.
 *
 * Mutation proof (one mutation per guard half, run before merge):
 *  - removing the B branch of nativeCredentialRefusalShape ⇒ every shape-B
 *    assertion goes red while A and OAuth stay green;
 *  - widening B to "any Bearer" (drop the sk-ant- test) ⇒ the OAuth
 *    passthrough assertions go red.
 *
 * Same harness contract as native-passthrough-strip.test.ts (#282).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests, isQuotaExhaustion } from "./fork/failover.js";
import {
  nativeAuthHeaderNames,
  nativeCredentialRefusalShape,
  stripForeignCredentialBesideAnthropic,
} from "./handlers/shared/native-credential-guard.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct range from proxy-server-routing-error.test.ts (19700+),
// proxy-server-openai-notice.test.ts (19851/19951) and #282 (19871).
const PROXY_PORT = 19921;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as #282's harness, plus the #296 kill switch: a
// machine leftover "0" would silently disarm the guard under test.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-296-test";

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** Header NAMES of every outbound call to the Anthropic API, in order. */
let anthropicCalls: { url: string; headerNames: string[] }[] = [];

function anthropicJSON(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  anthropicCalls = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      anthropicCalls.push({
        url,
        headerNames: Object.keys((init?.headers ?? {}) as Record<string, string>),
      });
      if (url.endsWith("/count_tokens")) return anthropicJSON({ input_tokens: 42 });
      return anthropicJSON({
        id: "msg_route_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    }
    return realFetch(input, init);
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

async function spin(anthropicApiKey?: string): Promise<void> {
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    anthropicApiKey,
    undefined,
    { quiet: true }
  );
}

function headers(extra: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

const NATIVE_BODY = {
  model: "claude-opus-5-5",
  max_tokens: 8,
  messages: [{ role: "user", content: "ok" }],
};

async function post(path: string, hdrs: Record<string, string>, body: unknown) {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(body),
  });
}

/** The three assertions every refused shape must satisfy, on any path. */
async function expectRefused(res: Response, model: string) {
  expect(res.status).toBe(403);
  expect(anthropicCalls.length).toBe(0);
  const raw: any = await res.json();
  expect(raw.type).toBe("error");
  expect(raw.error.type).toBe("permission_error");
  expect(raw.error.message).toContain(model);
}

/** The passthrough assertion: exactly one upstream call, auth header present. */
async function expectForwarded(res: Response, withAuthorization: boolean) {
  expect(res.status).toBe(200);
  expect(anthropicCalls.length).toBe(1);
  const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
  if (withAuthorization) expect(names).toContain("authorization");
  else expect(names).toContain("x-api-key");
}

// ---- unit: the shape function ---------------------------------------------------

describe("#296 unit — nativeCredentialRefusalShape", () => {
  test("A: no credential at all", () => {
    expect(nativeCredentialRefusalShape({}, false)).toBe("A");
    expect(nativeCredentialRefusalShape({ authorization: "" }, false)).toBe("A");
  });

  test("B: credential present, none Anthropic-shaped", () => {
    expect(
      nativeCredentialRefusalShape({ authorization: "Bearer some-foreign-token" }, false)
    ).toBe("B");
    expect(nativeCredentialRefusalShape({ "x-api-key": "other-provider-key" }, false)).toBe("B");
  });

  test("OK: sk-ant-shaped Bearer or x-api-key forwards", () => {
    expect(
      nativeCredentialRefusalShape({ authorization: "Bearer sk-ant-oat01-x" }, false)
    ).toBeNull();
    expect(nativeCredentialRefusalShape({ "x-api-key": "sk-ant-api03-x" }, false)).toBeNull();
  });

  test("substituted credential is exempt — even a non-sk-ant stored key", () => {
    expect(nativeCredentialRefusalShape({ "x-api-key": "operator-key" }, true)).toBeNull();
    expect(nativeCredentialRefusalShape({}, true)).toBeNull();
  });

  test("kill switch CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0 read per call", () => {
    expect(nativeCredentialRefusalShape({ authorization: "Bearer foreign" }, false)).toBe("B");
    process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD = "0";
    try {
      expect(nativeCredentialRefusalShape({ authorization: "Bearer foreign" }, false)).toBeNull();
      expect(nativeCredentialRefusalShape({}, false)).toBeNull();
    } finally {
      delete process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD;
    }
  });
});

// ---- the refusal wording must never arm the cascade -----------------------------

describe("#296 — refusal wording vs isQuotaExhaustion", () => {
  test("the 403 body does not match any quota-wall keyword (would arm the role cascade)", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer some-foreign-token", "x-proxy-key": PROXY_KEY }),
      NATIVE_BODY
    );
    const raw: any = await res.json();
    // The real predicate, not a copied keyword list — if a wording edit ever
    // makes this true, the refusal would arm failover and retry the cascade.
    expect(isQuotaExhaustion(res.status, JSON.stringify(raw))).toBe(false);
  }, 30_000);
});

// ---- route-level: /v1/messages ---------------------------------------------------

describe("#296 — /v1/messages native lane", () => {
  test("shape A (proxy-key token swapped away, nothing to substitute) → 403, 0 upstream calls", async () => {
    await spin(); // no stored anthropicApiKey
    const res = await post(
      "/v1/messages",
      headers({ "x-api-key": PROXY_KEY }),
      NATIVE_BODY
    );
    await expectRefused(res, "claude-opus-5-5");
  }, 30_000);

  test("shape B (valid x-proxy-key + foreign Bearer) → 403, 0 upstream calls — the token is never handed to a third party", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer some-foreign-token", "x-proxy-key": PROXY_KEY }),
      NATIVE_BODY
    );
    await expectRefused(res, "claude-opus-5-5");
  }, 30_000);

  test("shape B with stream:true → the JSON error arrives before any stream starts", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer some-foreign-token", "x-proxy-key": PROXY_KEY }),
      { ...NATIVE_BODY, stream: true }
    );
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    await expectRefused(res, "claude-opus-5-5");
  }, 30_000);

  test("OAuth-shaped Bearer (ai-01 passthrough) → exactly 1 call, authorization forwarded", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer sk-ant-oat01-test", "x-proxy-key": PROXY_KEY }),
      NATIVE_BODY
    );
    await expectForwarded(res, true);
  }, 30_000);

  test("must-not-change: swap WITH a stored apiKey still forwards (no refusal)", async () => {
    await spin("operator-stored-key-296"); // deliberately non-sk-ant: pins the exemption
    const res = await post(
      "/v1/messages",
      headers({ "x-api-key": PROXY_KEY }),
      NATIVE_BODY
    );
    await expectForwarded(res, false);
  }, 30_000);

  test("kill switch on the route: CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0 restores the passthrough", async () => {
    process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD = "0";
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer some-foreign-token", "x-proxy-key": PROXY_KEY }),
      NATIVE_BODY
    );
    expect(res.status).toBe(200); // the stub upstream answers — passthrough restored
    expect(anthropicCalls.length).toBe(1);
  }, 30_000);
});

// ---- route-level: count_tokens ---------------------------------------------------

describe("#296 — count_tokens native branch", () => {
  test("shape A → 403, 0 upstream calls", async () => {
    await spin();
    const res = await post(
      "/v1/messages/count_tokens",
      headers({ "x-api-key": PROXY_KEY }),
      { model: "claude-opus-5-5", messages: [{ role: "user", content: "ok" }] }
    );
    await expectRefused(res, "claude-opus-5-5");
  }, 30_000);

  test("shape B → 403, 0 upstream calls", async () => {
    await spin();
    const res = await post(
      "/v1/messages/count_tokens",
      headers({ authorization: "Bearer some-foreign-token", "x-proxy-key": PROXY_KEY }),
      { model: "claude-opus-5-5", messages: [{ role: "user", content: "ok" }] }
    );
    await expectRefused(res, "claude-opus-5-5");
  }, 30_000);

  test("OAuth-shaped Bearer → exactly 1 call, authorization forwarded", async () => {
    await spin();
    const res = await post(
      "/v1/messages/count_tokens",
      headers({ authorization: "Bearer sk-ant-oat01-test", "x-proxy-key": PROXY_KEY }),
      { model: "claude-opus-5-5", messages: [{ role: "user", content: "ok" }] }
    );
    await expectForwarded(res, true);
    expect(anthropicCalls[0].url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
  }, 30_000);
});

// ---- #305 — mixed credentials: strip the foreign sibling, forward the sk-ant one ----

describe("#305 unit — stripForeignCredentialBesideAnthropic", () => {
  test("sk-ant Bearer + foreign x-api-key → x-api-key stripped, authorization kept", () => {
    const h: Record<string, string> = {
      authorization: "Bearer sk-ant-oat01-x",
      "x-api-key": "other-provider-key",
    };
    expect(stripForeignCredentialBesideAnthropic(h)).toEqual(["x-api-key"]);
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["authorization"]).toBe("Bearer sk-ant-oat01-x");
  });

  test("foreign Bearer + sk-ant x-api-key → authorization stripped, x-api-key kept", () => {
    const h: Record<string, string> = {
      authorization: "Bearer some-foreign-token",
      "x-api-key": "sk-ant-api03-x",
    };
    expect(stripForeignCredentialBesideAnthropic(h)).toEqual(["authorization"]);
    expect(h["authorization"]).toBeUndefined();
    expect(h["x-api-key"]).toBe("sk-ant-api03-x");
  });

  test("both sk-ant → nothing stripped (both are Anthropic's)", () => {
    const h: Record<string, string> = {
      authorization: "Bearer sk-ant-oat01-x",
      "x-api-key": "sk-ant-api03-x",
    };
    expect(stripForeignCredentialBesideAnthropic(h)).toEqual([]);
    expect(h["authorization"]).toBeDefined();
    expect(h["x-api-key"]).toBeDefined();
  });

  test("single credential (any shape) → no-op (shape-B refusal owns the foreign one)", () => {
    expect(stripForeignCredentialBesideAnthropic({ authorization: "Bearer sk-ant-oat01-x" })).toEqual([]);
    expect(stripForeignCredentialBesideAnthropic({ authorization: "Bearer foreign" })).toEqual([]);
    expect(stripForeignCredentialBesideAnthropic({})).toEqual([]);
  });

  test("kill switch disables the strip with the refusal (one switch, one policy)", () => {
    process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD = "0";
    try {
      const h: Record<string, string> = {
        authorization: "Bearer sk-ant-oat01-x",
        "x-api-key": "other-provider-key",
      };
      expect(stripForeignCredentialBesideAnthropic(h)).toEqual([]);
      expect(h["x-api-key"]).toBe("other-provider-key");
    } finally {
      delete process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD;
    }
  });
});

describe("#305 unit — nativeAuthHeaderNames (the AC-1 instrument, names only)", () => {
  test("combinations render as names, never values", () => {
    expect(nativeAuthHeaderNames({})).toBe("(none)");
    expect(nativeAuthHeaderNames({ authorization: "Bearer x" })).toBe("authorization");
    expect(nativeAuthHeaderNames({ "x-api-key": "y" })).toBe("x-api-key");
    expect(nativeAuthHeaderNames({ authorization: "Bearer x", "x-api-key": "y" })).toBe(
      "authorization+x-api-key"
    );
  });
});

describe("#305 — /v1/messages mixed shapes", () => {
  test("sk-ant Bearer + foreign x-api-key → 1 call, authorization forwarded, x-api-key NOT", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer sk-ant-oat01-test", "x-api-key": "other-provider-key" }),
      NATIVE_BODY
    );
    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    expect(names).toContain("authorization");
    expect(names).not.toContain("x-api-key"); // the foreign sibling never leaves
  }, 30_000);

  test("foreign Bearer + sk-ant x-api-key → 1 call, x-api-key forwarded, authorization NOT", async () => {
    await spin();
    const res = await post(
      "/v1/messages",
      headers({ authorization: "Bearer some-foreign-token", "x-api-key": "sk-ant-api03-test" }),
      NATIVE_BODY
    );
    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    expect(names).toContain("x-api-key");
    expect(names).not.toContain("authorization"); // the foreign sibling never leaves
  }, 30_000);
});

describe("#305 — count_tokens mixed shapes", () => {
  test("sk-ant Bearer + foreign x-api-key → 1 call, authorization only", async () => {
    await spin();
    const res = await post(
      "/v1/messages/count_tokens",
      headers({ authorization: "Bearer sk-ant-oat01-test", "x-api-key": "other-provider-key" }),
      { model: "claude-opus-5-5", messages: [{ role: "user", content: "ok" }] }
    );
    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    expect(names).toContain("authorization");
    expect(names).not.toContain("x-api-key");
  }, 30_000);

  test("foreign Bearer + sk-ant x-api-key → 1 call, x-api-key only", async () => {
    await spin();
    const res = await post(
      "/v1/messages/count_tokens",
      headers({ authorization: "Bearer some-foreign-token", "x-api-key": "sk-ant-api03-test" }),
      { model: "claude-opus-5-5", messages: [{ role: "user", content: "ok" }] }
    );
    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    expect(names).toContain("x-api-key");
    expect(names).not.toContain("authorization");
  }, 30_000);
});
