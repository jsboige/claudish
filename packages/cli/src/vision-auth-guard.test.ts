/**
 * #289 — route-level pin: the vision fallback never forwards the proxy's own
 * key to api.anthropic.com.
 *
 * `ComposedHandler` asks `services/vision-proxy.ts` to describe images when a
 * non-vision model receives them. `extractAuthHeaders` (composed-handler.ts)
 * used to copy the inbound `x-api-key` verbatim, and `describeImages` sent it
 * to https://api.anthropic.com/v1/messages. A client authenticating to the
 * proxy with its key in that header (the auth gate accepts it,
 * fork/middleware/proxy-auth.ts:42) would hand the cluster key to Anthropic
 * on every described image — same class as #282/#285, third call site.
 *
 * This file pins the exact duo the handler calls — `extractAuthHeaders` +
 * `describeImages` — against a stubbed outbound fetch, asserting on header
 * names and fixture EQUALITY only: every value compared here is a literal
 * fixture defined below, no real credential is ever read or printed.
 *
 * Mutation proof: remove the `sanitizeVisionAuthHeaders(auth)` call inside
 * `extractAuthHeaders` ⇒ tests "primary", "previous-key", "substituted-api"
 * and "substituted-oat" go red (the proxy-key fixture reaches the outbound
 * call); remove the `stripProxyOwnHeaders` call inside the sanitizer ⇒ the
 * "proxy-own headers" test goes red. Each guard is pinned on its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import {
  extractAuthHeaders,
  sanitizeVisionAuthHeaders,
  setVisionAuthPolicy,
} from "./handlers/composed-handler.js";
import { describeImages } from "./services/vision-proxy.js";
import type { OpenAIImageBlock } from "./services/vision-proxy.js";

// ---- fixtures ------------------------------------------------------------------
// Fixture credentials, deliberately NOT real-shaped beyond what the swap rule
// branches on (sk-ant-oat prefix). No env var or config file is read here.
const PROXY_PRIMARY = "pk-primary-fixture-289";
const PROXY_PREVIOUS = "pk-previous-fixture-289";
const STORED_API_KEY = "sk-ant-api03-fixture-stored";
const STORED_OAT_KEY = "sk-ant-oat01-fixture-stored";
const GENUINE_CLIENT_KEY = "sk-ant-api03-fixture-genuine-client";

const realFetch = globalThis.fetch;
let outboundHeaderNames: string[] = [];
let outboundHeaders: Record<string, string> = {};

function fakeContext(inboundHeaders: Record<string, string>): Context {
  return { req: { header: () => inboundHeaders } } as unknown as Context;
}

/** Minimal 1x1 PNG payload — parseDataUrl only needs non-empty base64 data. */
const PNG_DATA_URL = `data:image/png;base64,${"A".repeat(16)}`;
const ONE_IMAGE: OpenAIImageBlock[] = [
  { type: "image_url", image_url: { url: PNG_DATA_URL } },
];

function anthropicJSON(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_vision_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "a tiny image" }],
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

beforeEach(() => {
  outboundHeaderNames = [];
  outboundHeaders = {};
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      outboundHeaders = { ...(init?.headers ?? {}) } as Record<string, string>;
      outboundHeaderNames = Object.keys(outboundHeaders).map((n) => n.toLowerCase());
      return anthropicJSON();
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // Leave the policy unset for other suites: unset means "no match possible",
  // never "forward everything".
  setVisionAuthPolicy({});
});

// ---- the pin --------------------------------------------------------------------

describe("#289 — the vision fallback never forwards the proxy's own key", () => {
  test("inbound x-api-key == PRIMARY proxy key: dropped, nothing substituted (no stored key)", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY, PROXY_PREVIOUS] });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PRIMARY }));
    expect(auth["x-api-key"]).toBeUndefined();
    expect(auth.authorization).toBeUndefined();

    const descriptions = await describeImages(ONE_IMAGE, auth);
    expect(descriptions).toEqual(["a tiny image"]);
    expect(outboundHeaderNames).not.toContain("x-api-key");
    expect(outboundHeaderNames).not.toContain("authorization");
  });

  test("inbound x-api-key == PREVIOUS proxy key (rotation window): same drop", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY, PROXY_PREVIOUS] });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PREVIOUS }));
    expect(auth["x-api-key"]).toBeUndefined();
    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaderNames).not.toContain("x-api-key");
  });

  test("substituted api key: stored non-oat key rides x-api-key out (NativeHandler swap rule)", async () => {
    setVisionAuthPolicy({
      proxyKeys: [PROXY_PRIMARY],
      anthropicApiKey: STORED_API_KEY,
    });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PRIMARY }));
    expect(auth["x-api-key"]).toBe(STORED_API_KEY);

    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaders["x-api-key"]).toBe(STORED_API_KEY);
    expect(outboundHeaderNames).not.toContain("authorization");
  });

  test("substituted oat key: stored sk-ant-oat rides authorization out, x-api-key absent", async () => {
    setVisionAuthPolicy({
      proxyKeys: [PROXY_PRIMARY],
      anthropicApiKey: STORED_OAT_KEY,
    });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PRIMARY }));
    expect(auth["x-api-key"]).toBeUndefined();
    expect(auth.authorization).toBe(`Bearer ${STORED_OAT_KEY}`);

    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaders["authorization"]).toBe(`Bearer ${STORED_OAT_KEY}`);
    expect(outboundHeaderNames).not.toContain("x-api-key");
  });

  test("AC4 negative: a genuine client Anthropic key (no match) passes through unchanged", async () => {
    setVisionAuthPolicy({
      proxyKeys: [PROXY_PRIMARY],
      anthropicApiKey: STORED_API_KEY,
    });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": GENUINE_CLIENT_KEY }));
    expect(auth["x-api-key"]).toBe(GENUINE_CLIENT_KEY);

    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaders["x-api-key"]).toBe(GENUINE_CLIENT_KEY);
  });

  test("no inbound x-api-key: nothing sent (the canon-client 401 path stays as-is)", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY] });
    const auth = extractAuthHeaders(fakeContext({}));
    expect(auth["x-api-key"]).toBeUndefined();
    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaderNames).not.toContain("x-api-key");
  });

  test("policy unset (tests, library use): a NON-matching key passes through unchanged, nothing substituted", () => {
    // Unset policy cannot know the fixture is a proxy key: the genuine key
    // still flows through, and nothing is invented on its behalf. (The flip
    // side — a proxy-shaped key IS forwarded under an unset policy — is why
    // the boot wiring test below exists.)
    setVisionAuthPolicy({});
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": GENUINE_CLIENT_KEY }));
    expect(auth["x-api-key"]).toBe(GENUINE_CLIENT_KEY);
    expect(auth.authorization).toBeUndefined();
  });

  test("AC2 — the #285 helper runs on this path: x-proxy-key and x-claudish-* are stripped from what the sanitizer touches", () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY] });
    const auth = {
      "x-api-key": GENUINE_CLIENT_KEY,
      "x-proxy-key": PROXY_PRIMARY,
      "x-claudish-machine": "myia-fixture",
      "x-claudish-hops": "hop-fixture",
    };
    sanitizeVisionAuthHeaders(auth);
    expect(auth["x-proxy-key"]).toBeUndefined();
    expect(auth["x-claudish-machine"]).toBeUndefined();
    expect(auth["x-claudish-hops"]).toBeUndefined();
    // The genuine key survives the strip: the helper only removes proxy-own names.
    expect(auth["x-api-key"]).toBe(GENUINE_CLIENT_KEY);
  });
});

// ---- boot wiring (review 03/10: "mutation W") ------------------------------------
//
// Every test above injects the policy itself — the suite proves the sanitizer
// and says nothing about whether production ever arms it. Removing the
// `setVisionAuthPolicy({ proxyKeys, anthropicApiKey })` call in
// proxy-server.ts left this file 8/8 green while the inbound proxy key
// flowed to api.anthropic.com verbatim (unset policy = no key can match).
// This describe goes through createProxyServer with fixture proxy keys in
// the env (the exact production source: `resolveProxyKeys(process.env.
// CLAUDISH_PROXY_KEY …)`) and asserts the sanitizer is armed after boot.
// Mutation W ⇒ the swap assertions go red.

describe("#289 — boot wiring: createProxyServer arms the vision policy", () => {
  const BOOT_PORT = 19922; // distinct from every other in-process server suite

  // Same hermeticism contract as proxy-server-drain-freeze.test.ts: unset
  // keys would change handler resolution during the spin.
  const SANDBOX_ENV_KEYS = [
    "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
    "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
    "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
    "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
    "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
    "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
    "CLAUDISH_CAPTURE_DIR",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  test("after boot with CLAUDISH_PROXY_KEY set, the inbound proxy key is swapped, not forwarded", async () => {
    for (const k of SANDBOX_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.CLAUDISH_PROXY_KEY = PROXY_PRIMARY;
    process.env.CLAUDISH_PROXY_KEY_PREVIOUS = PROXY_PREVIOUS;
    const { createProxyServer } = await import("./proxy-server.js");
    const proxy = await createProxyServer(
      BOOT_PORT, undefined, undefined, false, STORED_API_KEY, undefined, { quiet: true }
    );
    try {
      // THE wiring assertions — these are what mutation W turns red: with the
      // policy unset, proxyKeys is empty, nothing matches, and the proxy key
      // would pass through verbatim instead of being swapped.
      const swapped = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PRIMARY }));
      expect(swapped["x-api-key"]).toBe(STORED_API_KEY);
      const swappedPrev = extractAuthHeaders(fakeContext({ "x-api-key": PROXY_PREVIOUS }));
      expect(swappedPrev["x-api-key"]).toBe(STORED_API_KEY);
      // And the negative still holds through the real boot path.
      const genuine = extractAuthHeaders(fakeContext({ "x-api-key": GENUINE_CLIENT_KEY }));
      expect(genuine["x-api-key"]).toBe(GENUINE_CLIENT_KEY);
    } finally {
      await proxy.shutdown();
      delete process.env.CLAUDISH_PROXY_KEY;
      delete process.env.CLAUDISH_PROXY_KEY_PREVIOUS;
      for (const k of SANDBOX_ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });
});

// ---- #315: a foreign client key never leaves on the vision path ------------------
//
// The #289 sanitizer swaps a MATCHING proxy key; a NON-matching key is the
// client's own credential and used to flow verbatim to api.anthropic.com
// whatever its shape — the #296 shape-B class on a third call site (the
// native lane has refused that shape since #303). Here it strips instead:
// there is no client turn to refuse, the fallback's own contract is to
// degrade. The predicate is the native lane's (isAnthropicShapedCredential,
// shared — not a second copy), so the sites cannot drift.
//
// Mutation proof (one per half):
//  - remove the `stripForeignVisionApiKey(auth)` call in
//    sanitizeVisionAuthHeaders ⇒ the drop tests below go red while the #289
//    suite stays green;
//  - narrow isAnthropicShapedCredential to `sk-ant-api` (the drift this
//    extraction forbids) ⇒ the oat-passes test here AND the native-lane
//    OAuth assertions in native-credential-guard.test.ts go red together.

describe("#315 — a non-Anthropic client x-api-key is dropped on the vision path", () => {
  // Foreign fixtures, deliberately OTHER providers' shapes — never sk-ant-.
  const FOREIGN_OR_KEY = "sk-or-v1-fixture-foreign-315";
  const FOREIGN_GSK_KEY = "gsk-fixture-foreign-315";
  // An oat-shaped CLIENT key: still Anthropic's, must pass (pins the shared
  // predicate at `sk-ant-`, not `sk-ant-api`).
  const CLIENT_OAT_KEY = "sk-ant-oat01-fixture-client-315";

  test("foreign key (OpenRouter shape), policy armed: dropped, the outbound call carries no credential", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY], anthropicApiKey: STORED_API_KEY });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": FOREIGN_OR_KEY }));
    expect(auth["x-api-key"]).toBeUndefined();
    // The stored key must NOT be invented on the foreign key's behalf: the
    // substitution is reserved for a MATCHING proxy key (#289).
    expect(auth.authorization).toBeUndefined();

    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaderNames).not.toContain("x-api-key");
    expect(outboundHeaderNames).not.toContain("authorization");
  });

  test("foreign key (Groq shape) degrades exactly like a missing credential: 401 → describeImages null (caller strips images, turn continues)", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY] });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": FOREIGN_GSK_KEY }));
    expect(auth["x-api-key"]).toBeUndefined();

    // The beforeEach stub answers 200; re-point it at the 401 Anthropic sends
    // a credential-less call — the pre-#315 missing-credential behavior.
    const stub = globalThis.fetch;
    globalThis.fetch = (async (_input: any, _init: any) =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const descriptions = await describeImages(ONE_IMAGE, auth);
      // null = the documented fallback trigger: the caller strips the images
      // and the turn continues (never-hang holds).
      expect(descriptions).toBeNull();
    } finally {
      globalThis.fetch = stub;
    }
  });

  test("policy UNSET (tests, library use): a foreign key is STILL dropped — the shape is knowable without config", () => {
    // Contrast with #289's unset doctrine (a proxy-shaped key cannot be
    // recognized without the policy): sk-ant- is a prefix, not a config.
    setVisionAuthPolicy({});
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": FOREIGN_OR_KEY }));
    expect(auth["x-api-key"]).toBeUndefined();
  });

  test("AC negative: an sk-ant-oat CLIENT key passes unchanged — the shared predicate is sk-ant-, not sk-ant-api", async () => {
    setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY] });
    const auth = extractAuthHeaders(fakeContext({ "x-api-key": CLIENT_OAT_KEY }));
    expect(auth["x-api-key"]).toBe(CLIENT_OAT_KEY);

    await describeImages(ONE_IMAGE, auth);
    expect(outboundHeaders["x-api-key"]).toBe(CLIENT_OAT_KEY);
  });

  test("kill switch CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0 restores the passthrough (one switch, one policy — #305 precedent)", () => {
    const saved = process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD;
    process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD = "0";
    try {
      setVisionAuthPolicy({ proxyKeys: [PROXY_PRIMARY] });
      const auth = extractAuthHeaders(fakeContext({ "x-api-key": FOREIGN_OR_KEY }));
      // Pre-#315 behavior: the operator explicitly disarmed the shape guard.
      expect(auth["x-api-key"]).toBe(FOREIGN_OR_KEY);
    } finally {
      if (saved === undefined) delete process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD;
      else process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD = saved;
    }
  });
});
