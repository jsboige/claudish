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
 *     allowlisted id onto a different transport;
 *   - a malformed maxConcurrency skips the entry (fail closed) — an unreadable
 *     cap must never read as "unlimited".
 */
import { describe, expect, it } from "bun:test";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import {
  acquireInboundSlot,
  inboundInFlight,
  inboundModelAllowed,
  matchesInboundKey,
  releaseInboundSlot,
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

// ── Per-key in-flight cap (ASK FROGNANO-ACCESS 08/10) ────────────────────────
// The cap exists so an external consumer cannot saturate the local GPU models
// and starve the fleet's own lanes. Two properties are load-bearing:
//   - an ABSENT cap is uncapped (`undefined`, byte-identical to pre-cap code);
//   - a MALFORMED cap is refused (the entry is skipped), never degraded to
//     "unlimited" — fail closed, same doctrine as the unresolvable ${VAR}.

describe("maxConcurrency parsing (#400)", () => {
  const withCap = (maxConcurrency: unknown) =>
    resolveInboundKeys(
      cfg({ external: { key: "scoped-secret", allowModels: VLLM_ALLOW, maxConcurrency } }),
      ["fleet"]
    );

  it("an absent cap yields an entry with NO maxConcurrency key at all (uncapped default)", () => {
    const entries = resolveInboundKeys(
      cfg({ external: { key: "scoped-secret", allowModels: VLLM_ALLOW } }),
      ["fleet"]
    );
    expect(entries[0]?.maxConcurrency).toBeUndefined();
    // The field is omitted, not set to undefined — callers spread the object.
    expect("maxConcurrency" in entries[0]!).toBe(false);
  });

  it("accepts a positive integer, and a numeric string (config files are JSON-read generously)", () => {
    expect(withCap(2)[0]?.maxConcurrency).toBe(2);
    expect(withCap("3")[0]?.maxConcurrency).toBe(3);
    expect(withCap(1)[0]?.maxConcurrency).toBe(1);
  });

  it("REFUSES a malformed cap by skipping the entry — never silently unlimited", () => {
    for (const bad of [0, -1, 1.5, "abc", "", null, {}, []]) {
      const entries = withCap(bad);
      expect(entries).toHaveLength(0);
    }
  });
});

describe("acquire/release in-flight slots (#400)", () => {
  // Names are unique per test: the counters are module-level process state, so
  // a shared name would let one test's leak read as another test's defect.
  it("an uncapped entry always acquires and is never counted", () => {
    const e = entry({ name: "uncapped", maxConcurrency: undefined });
    for (let i = 0; i < 10; i++) expect(acquireInboundSlot(e)).toBe(true);
    expect(inboundInFlight("uncapped")).toBe(0);
  });

  it("a capped entry admits exactly `cap` slots, then refuses", () => {
    const e = entry({ name: "cap-2", maxConcurrency: 2 });
    expect(acquireInboundSlot(e)).toBe(true);
    expect(acquireInboundSlot(e)).toBe(true);
    expect(inboundInFlight("cap-2")).toBe(2);
    expect(acquireInboundSlot(e)).toBe(false); // at cap — the 429 path
    expect(inboundInFlight("cap-2")).toBe(2);  // a refused acquire never counts
  });

  it("a release frees the slot for the next request", () => {
    const e = entry({ name: "cap-1", maxConcurrency: 1 });
    expect(acquireInboundSlot(e)).toBe(true);
    expect(acquireInboundSlot(e)).toBe(false);
    releaseInboundSlot("cap-1");
    expect(inboundInFlight("cap-1")).toBe(0);
    expect(acquireInboundSlot(e)).toBe(true);
    releaseInboundSlot("cap-1");
  });

  it("release is a no-op on an unknown name or an empty count — a double release never mints a free slot", () => {
    releaseInboundSlot("never-acquired"); // must not throw
    expect(inboundInFlight("never-acquired")).toBe(0);

    const e = entry({ name: "cap-1-dup", maxConcurrency: 1 });
    expect(acquireInboundSlot(e)).toBe(true);
    releaseInboundSlot("cap-1-dup");
    releaseInboundSlot("cap-1-dup"); // extra release: no negative count
    expect(inboundInFlight("cap-1-dup")).toBe(0);

    // The proof it did not go negative: cap 1 still admits exactly ONE.
    expect(acquireInboundSlot(e)).toBe(true);
    expect(acquireInboundSlot(e)).toBe(false);
    releaseInboundSlot("cap-1-dup");
  });

  it("two keys never share a cap", () => {
    const a = entry({ name: "iso-a", maxConcurrency: 1 });
    const b = entry({ name: "iso-b", maxConcurrency: 1 });
    expect(acquireInboundSlot(a)).toBe(true);
    expect(acquireInboundSlot(b)).toBe(true); // b is unaffected by a being at cap
    expect(acquireInboundSlot(a)).toBe(false);
    releaseInboundSlot("iso-a");
    releaseInboundSlot("iso-b");
  });
});
