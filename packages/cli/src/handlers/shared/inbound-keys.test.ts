/**
 * Scoped inbound keys (#400) — unit pins for resolution + allowlist semantics.
 *
 * The load-bearing properties (each one is an incident class if it breaks):
 *   - a scoped key whose VALUE equals a full-access proxy key is refused —
 *     otherwise the allowlist is cosmetic and an external holds the fleet key;
 *   - an unresolvable ${VAR} reference skips the entry — a key resolving to ""
 *     would match an empty header;
 *   - invalid entries never throw (customEndpoints doctrine: config must not
 *     crash the proxy);
 *   - bare names gate on the PARSED model id, explicit provider@model forms
 *     gate on an EXACT raw match — "or@swift-1.5-27b" must NOT ride an
 *     allowlisted id onto a different transport.
 */
import { describe, expect, it } from "bun:test";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import {
  inboundModelAllowed,
  matchesInboundKey,
  resolveInboundKeys,
  type InboundKeyEntry,
} from "./inbound-keys.js";

function cfg(inboundKeys: unknown, apiKeys?: Record<string, string>): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: { default: { name: "default", description: "", models: {}, createdAt: "", updatedAt: "" } },
    ...(apiKeys ? { apiKeys } : {}),
    ...(inboundKeys ? { inboundKeys: inboundKeys as ClaudishProfileConfig["inboundKeys"] } : {}),
  } as ClaudishProfileConfig;
}

const VLLM_ALLOW = ["swift-1.5-27b", "qwen3.6-35b-a3b", "frognano-4b"];

function entry(overrides: Partial<InboundKeyEntry> = {}): InboundKeyEntry {
  return { name: "external", key: "scoped-secret", allowModels: [...VLLM_ALLOW], ...overrides };
}

describe("resolveInboundKeys (#400)", () => {
  it("returns [] with no config — byte-identical default behavior", () => {
    expect(resolveInboundKeys(cfg(undefined), ["fleet"])).toEqual([]);
    expect(resolveInboundKeys(cfg({}), ["fleet"])).toEqual([]);
  });

  it("resolves a literal key entry", () => {
    const entries = resolveInboundKeys(
      cfg({ external: { key: "scoped-secret", allowModels: VLLM_ALLOW } }),
      ["fleet"]
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ name: "external", key: "scoped-secret", allowModels: VLLM_ALLOW });
  });

  it("expands ${VAR} from config.apiKeys FIRST (the config's own secret store), then env", () => {
    process.env["INBOUND_TEST_KEY_ENV"] = "from-env";
    try {
      const entries = resolveInboundKeys(
        cfg({ external: { key: "${INBOUND_TEST_KEY}", allowModels: VLLM_ALLOW } }, {
          INBOUND_TEST_KEY: "from-config",
          INBOUND_TEST_KEY_ENV: "shadowed-env",
        }),
        ["fleet"]
      );
      expect(entries[0]?.key).toBe("from-config");

      const envOnly = resolveInboundKeys(
        cfg({ external: { key: "${INBOUND_TEST_KEY_ENV}", allowModels: VLLM_ALLOW } }),
        ["fleet"]
      );
      expect(envOnly[0]?.key).toBe("from-env");
    } finally {
      delete process.env["INBOUND_TEST_KEY_ENV"];
    }
  });

  it("REFUSES an entry whose key value equals a full-access proxy key — the allowlist must never be cosmetic", () => {
    const entries = resolveInboundKeys(
      cfg({ external: { key: "fleet-primary", allowModels: VLLM_ALLOW } }),
      ["fleet-primary", "fleet-previous"]
    );
    expect(entries).toHaveLength(0);
  });

  it("skips an unresolvable ${VAR} (resolves to '' — would match an empty header), a missing allowlist, and malformed shapes — never throws", () => {
    const bad = cfg({
      unresolvable: { key: "${DOES_NOT_EXIST_ANYWHERE}", allowModels: VLLM_ALLOW },
      noAllow: { key: "k1", allowModels: [] },
      allEmptyAllow: { key: "k2", allowModels: [""] },
      notString: { key: 42, allowModels: VLLM_ALLOW },
      valid: { key: "k3", allowModels: VLLM_ALLOW },
    });
    const entries = resolveInboundKeys(bad, ["fleet"]);
    expect(entries.map((e) => e.name)).toEqual(["valid"]);
    // Tolerance is per-element, not all-or-nothing: a stray empty string in an
    // otherwise-valid list is dropped, the real ids survive.
    const tolerant = resolveInboundKeys(
      cfg({ t: { key: "k4", allowModels: ["", "frognano-4b"] } }),
      ["fleet"]
    );
    expect(tolerant[0]?.allowModels).toEqual(["frognano-4b"]);
  });

  it("refuses duplicate key values across entries (first wins — one secret, one scope)", () => {
    const entries = resolveInboundKeys(
      cfg({
        a: { key: "same-secret", allowModels: ["frognano-4b"] },
        b: { key: "same-secret", allowModels: VLLM_ALLOW },
      }),
      ["fleet"]
    );
    expect(entries.map((e) => e.name)).toEqual(["a"]);
  });
});

describe("matchesInboundKey", () => {
  it("returns the entry for the presented secret, null otherwise", () => {
    const entries = [entry()];
    expect(matchesInboundKey("scoped-secret", entries)?.name).toBe("external");
    expect(matchesInboundKey("fleet", entries)).toBeNull();
    expect(matchesInboundKey(undefined, entries)).toBeNull();
    expect(matchesInboundKey("scoped-secret", [])).toBeNull();
  });
});

describe("inboundModelAllowed — allowlist semantics", () => {
  const e = entry();

  it("bare names: raw hit OR parsed-model hit (the id that will actually serve)", () => {
    expect(inboundModelAllowed(e, "swift-1.5-27b")).toBe(true);
    expect(inboundModelAllowed(e, "qwen3.6-35b-a3b")).toBe(true); // alias to swift
    expect(inboundModelAllowed(e, "glm-5.3")).toBe(false);        // subscription lane
    expect(inboundModelAllowed(e, "claude-opus-5-5")).toBe(false); // native
    expect(inboundModelAllowed(e, "MiniMax-M3")).toBe(false);      // subscription lane
  });

  it("explicit provider forms: ONLY an exact raw allowlist hit passes — no parsed-id riding across transports", () => {
    expect(inboundModelAllowed(e, "frognano@frognano-4b")).toBe(false); // raw not listed
    expect(inboundModelAllowed({ ...e, allowModels: ["frognano@frognano-4b"] }, "frognano@frognano-4b")).toBe(true);
    expect(inboundModelAllowed(e, "or@swift-1.5-27b")).toBe(false);     // the probing shape the rule exists for
    expect(inboundModelAllowed(e, "anthropic/claude-opus-5")).toBe(false);
  });

  it("an unparsable model name is refused, never thrown", () => {
    expect(() => inboundModelAllowed(e, "///@@@")).not.toThrow();
    expect(inboundModelAllowed(e, "///@@@")).toBe(false);
  });
});
