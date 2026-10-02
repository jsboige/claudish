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

  test("policy unset (tests, library use): a matching-shaped key still never substitutes — passthrough of a NON-matching key is unaffected", () => {
    // Unset policy cannot know the fixture is a proxy key: the genuine key
    // still flows through, and nothing is invented on its behalf.
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
