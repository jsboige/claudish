/**
 * #886 — Codex session affinity: one stable id per Claude Code session, sent
 * as the `session-id` / `thread-id` headers and as `prompt_cache_key`.
 *
 * Hermetic: `getHeaders()` normally reads the REAL ~/.claudish/codex-oauth.json
 * (and may refresh it), so these tests never let it touch the disk — the
 * header builder is tested directly and the OAuth reader is stubbed on the
 * instance.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { codexSessionAffinityEnabled, codexSessionId } from "./codex-session-affinity.js";
import { OpenAICodexTransport, buildOAuthHeaders } from "./openai-codex.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function req(sessionId: string): any {
  return {
    metadata: {
      user_id: JSON.stringify({ device_id: "dev-1", account_uuid: "", session_id: sessionId }),
    },
  };
}

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@"],
} as RemoteProvider;

const ENV = "CLAUDISH_CODEX_SESSION_AFFINITY";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe("codexSessionId", () => {
  test("is stable for one session, UUID-shaped, and never the raw id", () => {
    const sid = "019c7f9e-1111-7000-8000-111111111111";
    const a = codexSessionId(req(sid));
    expect(codexSessionId(req(sid))).toBe(a);
    expect(a).toMatch(UUID);
    expect(a).not.toBe(sid);
    expect(a.includes("1111-7000")).toBe(false);
  });

  test("isolates two sessions", () => {
    expect(codexSessionId(req("s-aaa"))).not.toBe(codexSessionId(req("s-bbb")));
  });

  test("reads the object and the non-JSON user_id shapes", () => {
    const fromObject = codexSessionId({ metadata: { user_id: { session_id: "s-obj" } } });
    expect(fromObject).toBe(codexSessionId(req("s-obj")));
    const raw = { metadata: { user_id: "user_abc_account__session_xyz" } };
    expect(codexSessionId(raw)).toBe(codexSessionId(raw));
    expect(codexSessionId(raw)).toMatch(UUID);
  });

  test("without a session id falls back to ONE per-process id, UUID-shaped", () => {
    const a = codexSessionId(undefined);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(codexSessionId({})).toBe(a);
    expect(codexSessionId({ metadata: {} })).toBe(a);
  });
});

describe("codexSessionAffinityEnabled — kill switch", () => {
  test('unset and empty (compose injects "") mean ON', () => {
    expect(codexSessionAffinityEnabled({})).toBe(true);
    expect(codexSessionAffinityEnabled({ [ENV]: "" })).toBe(true);
    expect(codexSessionAffinityEnabled({ [ENV]: "1" })).toBe(true);
  });

  test("0 / false / off (any case, padded) mean OFF", () => {
    for (const v of ["0", "false", "off", " OFF ", "False"]) {
      expect(codexSessionAffinityEnabled({ [ENV]: v })).toBe(false);
    }
  });
});

describe("buildOAuthHeaders", () => {
  test("with an affinity id: session-id, thread-id and the x- pair all carry it", () => {
    const h = buildOAuthHeaders("tok", "acct", "11111111-2222-4333-8444-555555555555");
    expect(h["session-id"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(h["thread-id"]).toBe(h["session-id"]);
    expect(h["x-session-id"]).toBe(h["session-id"]);
    expect(h["x-conversation-id"]).toBe(h["session-id"]);
    expect(h.originator).toBe("codex_cli_rs");
    expect(h["chatgpt-account-id"]).toBe("acct");
  });

  test("without one: the pre-#886 wire — fresh x- id per call, no session-id header", () => {
    const a = buildOAuthHeaders("tok", "acct");
    const b = buildOAuthHeaders("tok", "acct");
    expect(a["session-id"]).toBeUndefined();
    expect(a["thread-id"]).toBeUndefined();
    expect(a["x-session-id"].startsWith("claudish-")).toBe(true);
    expect(a["x-session-id"]).not.toBe(b["x-session-id"]);
  });
});

describe("OpenAICodexTransport", () => {
  const transport = () => new OpenAICodexTransport(provider, "gpt-6.1-sol", "sk-test");

  test("transformPayload attaches the session's prompt_cache_key, same id as the header", () => {
    delete process.env[ENV];
    const r = req("s-key");
    const out = transport().transformPayload({ model: "gpt-6.1-sol", input: [] }, r);
    expect(out.prompt_cache_key).toBe(codexSessionId(r));
    expect(out.store).toBe(false);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("an explicit key wins; no request or switch off sends none", () => {
    delete process.env[ENV];
    const t = transport();
    expect(
      t.transformPayload({ input: [], prompt_cache_key: "caller" }, req("s")).prompt_cache_key
    ).toBe("caller");
    expect(t.transformPayload({ input: [] }).prompt_cache_key).toBeUndefined();
    process.env[ENV] = "0";
    expect(t.transformPayload({ input: [] }, req("s")).prompt_cache_key).toBeUndefined();
  });

  test("getHeaders derives the affinity id from the request it is handed", async () => {
    delete process.env[ENV];
    const t = transport() as any;
    const seen: Array<string | undefined> = [];
    t.tryOAuthHeaders = async (id?: string) => {
      seen.push(id);
      return buildOAuthHeaders("tok", "acct", id);
    };
    const r = req("s-hdr");
    const h = await t.getHeaders(r);
    expect(h["session-id"]).toBe(codexSessionId(r));
    await t.getHeaders();
    process.env[ENV] = "off";
    await t.getHeaders(r);
    expect(seen).toEqual([codexSessionId(r), undefined, undefined]);
  });
});
