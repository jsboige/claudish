/**
 * #641 step 4 — the shape the native authority puts a credential under.
 *
 * The provider resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN as the native
 * lane's FALLBACK credential. Before step 4, getRequestAuth emitted x-api-key
 * unconditionally, so an OAuth token (sk-ant-oat*, the ANTHROPIC_AUTH_TOKEN
 * case) left for api.anthropic.com under the wrong header name at every
 * consumer of the authority. Main's swap sites have been shape-aware since
 * #282/#439; these pins hold the same predicate at the authority.
 *
 * Fresh provider instance per test: resolution is memoized per instance, and
 * the route-level behavior (including the count_tokens and serving fallbacks)
 * is pinned separately in proxy-server-native-oat-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride, setConfigFileOverride } from "../../config-override.js";
import { NativeAnthropicCredentialProvider } from "./native-anthropic-credential.js";

const HERMETIC_CONFIG = join(
  tmpdir(),
  `claudish-native-anthropic-credential-${process.pid}-does-not-exist.json`
);

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
let savedConfigOverride: string | null;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  savedConfigOverride = getConfigFileOverride();
  // A missing override file resolves as an empty config — the real machine's
  // config must never leak a key into these pins.
  setConfigFileOverride(HERMETIC_CONFIG);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setConfigFileOverride(savedConfigOverride);
});

describe("#641 step 4 — NativeAnthropicCredentialProvider shapes the credential", () => {
  test("an sk-ant-oat token resolves as authorization: Bearer, never x-api-key", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-test-oauth-token";
    const auth = await new NativeAnthropicCredentialProvider().getRequestAuth({
      model: "claude-opus-4-8",
    });
    expect(auth.headers.authorization).toBe("Bearer sk-ant-oat01-test-oauth-token");
    expect(auth.headers["x-api-key"]).toBeUndefined();
  });

  test("an sk-ant-api key keeps x-api-key — the classic form is unchanged", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
    const auth = await new NativeAnthropicCredentialProvider().getRequestAuth({
      model: "claude-opus-4-8",
    });
    expect(auth.headers["x-api-key"]).toBe("sk-ant-api03-test-key");
    expect(auth.headers.authorization).toBeUndefined();
  });

  test("no credential resolves to empty headers, not an empty header value", async () => {
    const auth = await new NativeAnthropicCredentialProvider().getRequestAuth({
      model: "claude-opus-4-8",
    });
    expect(auth.headers).toEqual({});
  });

  test("ANTHROPIC_API_KEY wins over ANTHROPIC_AUTH_TOKEN, and its shape decides the header", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-test-oauth-token";
    const auth = await new NativeAnthropicCredentialProvider().getRequestAuth({
      model: "claude-opus-4-8",
    });
    expect(auth.headers["x-api-key"]).toBe("sk-ant-api03-test-key");
  });
});
