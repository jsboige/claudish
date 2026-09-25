/**
 * #219 — auto-resolve the newest Anthropic model for the native pin.
 *
 * Fixtures replicate the live contract-v3 catalog shapes measured
 * 2026-09-25: `modelId` in dashes, OpenRouter dotted spellings and the
 * `~anthropic/claude-…-latest` / `:batch` decoys living in aliases and
 * aggregator rows, Fable as a separate family, release dates present.
 */

import { describe, expect, test, afterEach } from "bun:test";
import type { SlimModelEntry } from "./all-models-cache.js";
import {
  normalizeAnthropicModelId,
  compareClaudeFamilyVersions,
  findNewestAnthropicFamilyMember,
  pickNativePinUpdates,
  applyNativePinOverride,
  setNativePinOverridesForTests,
  startNativePinAutoWatch,
} from "./native-pin-auto.js";
import { setMemCatalogForTests } from "./catalog-resolvers/openrouter.js";
import { resolveNativeModelPin } from "../proxy-server.js";

/** Live shape of the 2026-09-25 v3 catalog, Anthropic family. */
const LIVE_LIKE: SlimModelEntry[] = [
  {
    modelId: "claude-opus-5-5",
    aliases: ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5:batch", "~anthropic/claude-opus-latest"],
    sources: {},
    releaseDate: "2026-09-22",
    aggregators: [
      { provider: "anthropic", externalId: "claude-opus-5-5", confidence: "scrape_verified" },
      { provider: "openrouter", externalId: "~anthropic/claude-opus-latest", confidence: "aggregator_reported" },
      { provider: "openrouter", externalId: "anthropic/claude-opus-5.5", confidence: "aggregator_reported" },
    ],
  },
  {
    modelId: "claude-opus-5",
    aliases: ["anthropic/claude-opus-5", "anthropic/claude-opus-5:batch"],
    sources: {},
    releaseDate: "2026-07-24",
    aggregators: [
      { provider: "anthropic", externalId: "claude-opus-5", confidence: "api_official" },
      { provider: "openrouter", externalId: "anthropic/claude-opus-5", confidence: "aggregator_reported" },
    ],
  },
  {
    modelId: "claude-fable-5-1",
    aliases: ["anthropic/claude-fable-5.1", "~anthropic/claude-fable-latest"],
    sources: {},
    releaseDate: "2026-09-01",
    aggregators: [
      { provider: "anthropic", externalId: "claude-fable-5-1", confidence: "scrape_verified" },
    ],
  },
  {
    modelId: "claude-sonnet-5",
    aliases: ["anthropic/claude-sonnet-5", "~anthropic/claude-sonnet-latest"],
    sources: {},
    aggregators: [
      { provider: "anthropic", externalId: "claude-sonnet-5", confidence: "api_official" },
    ],
  },
];

afterEach(() => {
  setNativePinOverridesForTests(null);
  setMemCatalogForTests(null);
});

describe("normalizeAnthropicModelId (#219 dots/dashes mirror)", () => {
  test("OpenRouter dotted spelling becomes the Anthropic dashed id", () => {
    expect(normalizeAnthropicModelId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(normalizeAnthropicModelId("anthropic/claude-fable-5.1")).toBe("claude-fable-5-1");
  });

  test("dashed spellings pass through unchanged, bare or prefixed", () => {
    expect(normalizeAnthropicModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeAnthropicModelId("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  test("tilde alias prefix is stripped (exclusion is the selector's job)", () => {
    expect(normalizeAnthropicModelId("~anthropic/claude-opus-latest")).toBe("claude-opus-latest");
  });

  test("non-Claude and non-family ids are null — never touched", () => {
    expect(normalizeAnthropicModelId("gpt-4o")).toBeNull();
    expect(normalizeAnthropicModelId("glm-5.2")).toBeNull();
    // Generation-first legacy ids are outside the modern family nomenclature.
    expect(normalizeAnthropicModelId("anthropic/claude-3-opus-20240229")).toBeNull();
  });
});

describe("compareClaudeFamilyVersions (numeric, not lexicographic)", () => {
  test("4.10 > 4.8 — the lexicographic lie", () => {
    expect(compareClaudeFamilyVersions("claude-opus-4-10", "claude-opus-4-8")).toBeGreaterThan(0);
    expect(compareClaudeFamilyVersions("claude-opus-4-8", "claude-opus-4-10")).toBeLessThan(0);
  });

  test("more segments win on a shared prefix: 5-5 > 5", () => {
    expect(compareClaudeFamilyVersions("claude-opus-5-5", "claude-opus-5")).toBeGreaterThan(0);
  });

  test("major version dominates", () => {
    expect(compareClaudeFamilyVersions("claude-opus-5", "claude-opus-4-8")).toBeGreaterThan(0);
  });

  test("equal ids compare 0", () => {
    expect(compareClaudeFamilyVersions("claude-opus-5-5", "claude-opus-5-5")).toBe(0);
  });

  test("non-numeric versions compare 0 — the comparator never guesses", () => {
    expect(compareClaudeFamilyVersions("claude-opus-latest", "claude-opus-5")).toBe(0);
  });
});

describe("findNewestAnthropicFamilyMember (live decoys)", () => {
  test("opus resolves to the newest corroborated member", () => {
    expect(findNewestAnthropicFamilyMember(LIVE_LIKE, "opus")).toBe("claude-opus-5-5");
  });

  test("fable and sonnet are separate families — no cross-contamination", () => {
    expect(findNewestAnthropicFamilyMember(LIVE_LIKE, "fable")).toBe("claude-fable-5-1");
    expect(findNewestAnthropicFamilyMember(LIVE_LIKE, "sonnet")).toBe("claude-sonnet-5");
    expect(findNewestAnthropicFamilyMember(LIVE_LIKE, "haiku")).toBeNull();
  });

  test("an uncorroborated newer id is ignored — never guessed", () => {
    const withUncorroborated: SlimModelEntry[] = [
      ...LIVE_LIKE,
      {
        modelId: "claude-opus-6-0",
        aliases: [],
        sources: { "openrouter-api": { externalId: "anthropic/claude-opus-6.0" } },
        aggregators: [{ provider: "openrouter", externalId: "anthropic/claude-opus-6.0", confidence: "aggregator_reported" }],
      },
    ];
    expect(findNewestAnthropicFamilyMember(withUncorroborated, "opus")).toBe("claude-opus-5-5");
  });

  test("~…-latest and :batch decoys never resolve", () => {
    const decoys: SlimModelEntry[] = [
      {
        modelId: "claude-opus-latest",
        aliases: [],
        sources: {},
        aggregators: [{ provider: "anthropic", externalId: "claude-opus-latest", confidence: "scrape_verified" }],
      },
      {
        modelId: "anthropic/claude-opus-5.5:batch",
        aliases: [],
        sources: {},
        aggregators: [{ provider: "anthropic", externalId: "anthropic/claude-opus-5.5:batch", confidence: "scrape_verified" }],
      },
      ...LIVE_LIKE,
    ];
    expect(findNewestAnthropicFamilyMember(decoys, "opus")).toBe("claude-opus-5-5");
  });

  test("pre-aggregators disk cache: anthropic-api source row still corroborates", () => {
    const legacyCache: SlimModelEntry[] = [
      {
        modelId: "claude-opus-5-5",
        aliases: [],
        sources: { "anthropic-api": { externalId: "claude-opus-5-5" } },
      },
    ];
    expect(findNewestAnthropicFamilyMember(legacyCache, "opus")).toBe("claude-opus-5-5");
  });
});

describe("pickNativePinUpdates (pure decision)", () => {
  test("a configured older opus yields one update", () => {
    const updates = pickNativePinUpdates({ opus: "claude-opus-5" }, LIVE_LIKE);
    expect(updates).toEqual([{ family: "opus", configured: "claude-opus-5", newest: "claude-opus-5-5" }]);
  });

  test("the dotted configured spelling still compares correctly", () => {
    const updates = pickNativePinUpdates({ opus: "anthropic/claude-opus-5.5" }, LIVE_LIKE);
    expect(updates).toEqual([]);
  });

  test("up-to-date config yields nothing", () => {
    expect(pickNativePinUpdates({ opus: "claude-opus-5-5" }, LIVE_LIKE)).toEqual([]);
  });

  test("non-Claude role targets are not this mechanism's business", () => {
    expect(pickNativePinUpdates({ sonnet: "glm-5.2" }, LIVE_LIKE)).toEqual([]);
  });

  test("null catalog keeps the configured value — never un-pins", () => {
    expect(pickNativePinUpdates({ opus: "claude-opus-5" }, null)).toEqual([]);
  });
});

describe("resolveNativeModelPin + override (byte-identical when unset)", () => {
  test("without an override the pin is exactly #218's behaviour", () => {
    expect(resolveNativeModelPin("claude-opus-5", { opus: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  test("an adopted opus override re-points the opus pin", () => {
    setNativePinOverridesForTests({ opus: "claude-opus-6-0" });
    expect(resolveNativeModelPin("claude-opus-5", { opus: "claude-opus-5-5" })).toBe("claude-opus-6-0");
  });

  test("an opus override never re-points another family's pin", () => {
    setNativePinOverridesForTests({ opus: "claude-opus-6-0" });
    expect(resolveNativeModelPin("claude-fable-5", { fable: "claude-fable-5-1" })).toBe("claude-fable-5-1");
    expect(resolveNativeModelPin("claude-sonnet-5", { sonnet: "claude-sonnet-5" })).toBeUndefined();
  });

  test("the #218 kill switch disarms the whole pin, override included", () => {
    setNativePinOverridesForTests({ opus: "claude-opus-6-0" });
    expect(resolveNativeModelPin("claude-opus-5", { opus: "claude-opus-5-5" }, { CLAUDISH_NATIVE_MODEL_PIN: "0" })).toBeUndefined();
  });
});

describe("startNativePinAutoWatch (gate + dedup)", () => {
  const stubResolver = {
    ensureReady: async () => {},
    refreshCatalog: async () => ({ kind: "refreshed", modelCount: 4 }),
  };

  test("default mode notifies once, adopts nothing", async () => {
    setMemCatalogForTests(LIVE_LIKE);
    delete process.env.CLAUDISH_NATIVE_PIN_AUTO;
    const lines: string[] = [];
    const stop = startNativePinAutoWatch(
      { opus: "claude-opus-5" },
      { notify: (l) => lines.push(l), intervalMs: 20, firstDelayMs: 5, resolver: stubResolver }
    );
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(lines.length).toBe(1); // deduped across ticks
    expect(lines[0]).toContain("newer anthropic opus available");
    expect(lines[0]).toContain("claude-opus-5-5");
    expect(lines[0]).toContain("notify-only");
    // Not adopted: no override was registered for any family.
    expect(applyNativePinOverride("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  test("CLAUDISH_NATIVE_PIN_AUTO=on adopts and the pin serves it", async () => {
    setMemCatalogForTests(LIVE_LIKE);
    process.env.CLAUDISH_NATIVE_PIN_AUTO = "on";
    const lines: string[] = [];
    const stop = startNativePinAutoWatch(
      { opus: "claude-opus-5" },
      { notify: (l) => lines.push(l), intervalMs: 20, firstDelayMs: 5, resolver: stubResolver }
    );
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(lines.length).toBe(1); // adoption announced once, not per tick
    expect(lines[0]).toContain("adopted newer anthropic opus");
    // The pin now serves the adopted id, not the configured one.
    expect(resolveNativeModelPin("claude-opus-4-8", { opus: "claude-opus-5" })).toBe("claude-opus-5-5");
    delete process.env.CLAUDISH_NATIVE_PIN_AUTO;
  });

  test("a failing catalog refresh keeps the configured pin, silently", async () => {
    setMemCatalogForTests(null); // cold cache: nothing to evaluate against
    const lines: string[] = [];
    const failing = {
      ensureReady: async () => {},
      refreshCatalog: async () => ({ kind: "fetch_failed", reason: "network" }),
    };
    const stop = startNativePinAutoWatch(
      { opus: "claude-opus-5" },
      { notify: (l) => lines.push(l), intervalMs: 20, firstDelayMs: 5, resolver: failing }
    );
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(lines).toEqual([]);
    expect(resolveNativeModelPin("claude-opus-5", { opus: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });
});
