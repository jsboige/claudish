/**
 * #219 — auto-resolve the newest Anthropic model for the native pin.
 *
 * `modelMap.opus` pins the version served on the native lane (#218), but the
 * version is a hand-edited config value: Opus 5.5 shipped 2026-09-22 and the
 * table was updated the same day, by hand. The hub holds no Anthropic
 * credential (0 non-empty keys measured 2026-09-22), so it cannot ask
 * Anthropic's own `/v1/models` — but it already consumes the hosted slim
 * catalog (contract v3, #254), whose entries carry a corroborated
 * `aggregators[]` index with `provider:"anthropic"` rows and release dates.
 *
 * Two modes, one gate (`CLAUDISH_NATIVE_PIN_AUTO`, re-read every check so the
 * fleet can flip it without restarting the proxy that is keeping everyone
 * working):
 *
 *   unset/"off" (default) — detect + notify. A periodic catalog check logs a
 *   greppable line when the catalog knows a newer family member than the one
 *   `modelMap` names. Catches the release the day it lands, changes nothing.
 *   "on" — adopt: the resolved id becomes the pin for that family.
 *
 * A resolution failure (catalog unreachable, no match) keeps the configured
 * value — never un-pins, never guesses. Once adopted, an override survives a
 * later catalog failure on purpose: reverting to the older configured id would
 * be an un-pin.
 */

import { getResolver } from "./model-catalog-resolver.js";
import { getMemCatalogEntries } from "./catalog-resolvers/openrouter.js";
import type { SlimModelEntry } from "./all-models-cache.js";

export type NativeFamily = "opus" | "sonnet" | "haiku" | "fable";

const FAMILIES: readonly NativeFamily[] = ["opus", "sonnet", "haiku", "fable"];

const FAMILY_RE = /^claude-(opus|sonnet|haiku|fable)-/;

/**
 * Turn any catalog-facing spelling of a Claude id into the Anthropic-API one.
 *
 * The OpenRouter catalog writes the version with DOTS
 * (`anthropic/claude-opus-5.5`); the Anthropic API wants DASHES
 * (`claude-opus-5-5`). A naive strip-the-vendor-prefix copy produces an id
 * Anthropic rejects — and since #218 that id would be pinned onto every
 * native request, i.e. a fleet-wide outage caused by the updater itself.
 * The dash spelling and a bare (unprefixed) id pass through unchanged.
 *
 * Returns null for anything that is not a `claude-<family>-…` id — callers
 * treat that as "do not touch".
 */
export function normalizeAnthropicModelId(raw: string): string | null {
  let id = raw.trim();
  if (id.startsWith("~")) id = id.slice(1);
  if (id.startsWith("anthropic/")) id = id.slice("anthropic/".length);
  const m = FAMILY_RE.exec(id);
  if (!m) return null;
  const version = id.slice(m[0].length).replace(/\./g, "-");
  return `${m[0]}${version}`;
}

/**
 * Numeric version comparator for `claude-<family>-X-Y` ids.
 *
 * Lexicographic comparison lies here: `4.10 > 4.8` as numbers but "4-10" <
 * "4-8" as strings. Segments compare numerically; when one version is a
 * strict prefix of the other, the longer one wins (5-5 > 5, the same way
 * 5.5 > 5). Returns 0 for ids whose version is not all-numeric — the
 * selector never feeds it those, but the comparator must not guess.
 */
export function compareClaudeFamilyVersions(a: string, b: string): number {
  const va = versionSegments(a);
  const vb = versionSegments(b);
  if (!va || !vb) return 0;
  const n = Math.max(va.length, vb.length);
  for (let i = 0; i < n; i++) {
    const sa = va[i] ?? 0;
    const sb = vb[i] ?? 0;
    if (sa !== sb) return sa - sb;
  }
  return va.length - vb.length;
}

function versionSegments(id: string): number[] | null {
  const m = FAMILY_RE.exec(id);
  if (!m) return null;
  const parts = id.slice(m[0].length).split("-");
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

function familyOfClaudeId(id: string): NativeFamily | null {
  const m = FAMILY_RE.exec(id);
  return m ? (m[1] as NativeFamily) : null;
}

/**
 * Newest member of one Claude family in the catalog, corroborated by a
 * direct-Anthropic aggregator row.
 *
 * Excludes by construction the decoys measured in the live v3 catalog:
 * `~anthropic/claude-opus-latest` (an OpenRouter alias — Anthropic has no
 * floating `-latest`, dateless ids are pinned snapshots, and pinning that
 * alias would 404), `:batch` variants, and the other families (Fable is a
 * separate family in the same catalog). A numeric-only version pattern does
 * all of it: `-latest` and preview suffixes never parse, `:` never matches.
 */
export function findNewestAnthropicFamilyMember(
  entries: SlimModelEntry[],
  family: NativeFamily
): string | null {
  let newest: string | null = null;
  for (const entry of entries) {
    const id = normalizeAnthropicModelId(entry.modelId);
    if (!id || familyOfClaudeId(id) !== family) continue;
    if (!versionSegments(id)) continue; // -latest / preview / suffixed decoys
    if (!hasAnthropicCorroboration(entry, id)) continue;
    if (newest === null || compareClaudeFamilyVersions(id, newest) > 0) newest = id;
  }
  return newest;
}

function hasAnthropicCorroboration(entry: SlimModelEntry, normalizedId: string): boolean {
  if (entry.aggregators?.some((a) => a.provider === "anthropic" && normalizeAnthropicModelId(a.externalId) === normalizedId)) {
    return true;
  }
  // Older disk caches predate `aggregators[]`; their v3 ingest still wrote
  // the direct-api source row.
  return normalizeAnthropicModelId(entry.sources["anthropic-api"]?.externalId ?? "") === normalizedId;
}

// ---------------------------------------------------------------------------
// Pin-override seam — read by resolveNativeModelPin on every request.
// ---------------------------------------------------------------------------

const _pinOverrides: Partial<Record<NativeFamily, string>> = {};

/** @internal test seam */
export function setNativePinOverridesForTests(o: Partial<Record<NativeFamily, string>> | null): void {
  for (const f of FAMILIES) delete _pinOverrides[f];
  if (o) Object.assign(_pinOverrides, o);
}

/**
 * Apply the adopted override to a resolved role target. Without an override
 * for that family (the default — gate unset, or catalog never resolved) the
 * target passes through byte-identical. An opus override never re-points a
 * fable or sonnet pin.
 */
export function applyNativePinOverride(roleTarget: string): string {
  const family = familyOfClaudeId(roleTarget);
  return family && _pinOverrides[family] ? _pinOverrides[family]! : roleTarget;
}

// ---------------------------------------------------------------------------
// Watch — periodic catalog check, notify by default, adopt on explicit opt-in.
// ---------------------------------------------------------------------------

export interface NativePinUpdate {
  family: NativeFamily;
  configured: string;
  newest: string;
}

/**
 * Pure decision: which configured native pins does the catalog know a newer
 * member for. Only families whose configured value is itself a `claude-<family>-`
 * id participate — a `modelMap.sonnet` pointing at a budget model is not this
 * mechanism's business, and is left untouched.
 */
export function pickNativePinUpdates(
  configured: Partial<Record<NativeFamily, string | undefined>>,
  entries: SlimModelEntry[] | null
): NativePinUpdate[] {
  if (!entries) return [];
  const updates: NativePinUpdate[] = [];
  for (const family of FAMILIES) {
    const raw = configured[family];
    if (!raw) continue;
    const normalized = normalizeAnthropicModelId(raw);
    if (!normalized || familyOfClaudeId(normalized) !== family) continue;
    const newest = findNewestAnthropicFamilyMember(entries, family);
    if (!newest) continue; // no match keeps the configured value
    if (compareClaudeFamilyVersions(newest, normalized) > 0) {
      updates.push({ family, configured: normalized, newest });
    }
  }
  return updates;
}

export interface NativePinAutoWatchOptions {
  /** Sink for the countable marker lines. Default: process.stderr. */
  notify?: (line: string) => void;
  /** Check interval. Default 6h; `CLAUDISH_NATIVE_PIN_AUTO_INTERVAL_MS` overrides. */
  intervalMs?: number;
  /** Delay before the first check (waits for the startup warm). Default 30s. */
  firstDelayMs?: number;
  /** Test seam: catalog resolver to poll. Default: the registered openrouter one. */
  resolver?: { ensureReady(timeoutMs: number): Promise<void>; refreshCatalog(timeoutMs: number): Promise<unknown> };
}

/**
 * Start the periodic native-pin check. First tick waits for the startup
 * catalog warm (no double fetch — `ensureReady` rides the in-flight promise),
 * later ticks refresh the shared catalog cache and evaluate against it.
 * Returns a stop function.
 */
export function startNativePinAutoWatch(
  configured: Partial<Record<NativeFamily, string | undefined>>,
  opts: NativePinAutoWatchOptions = {}
): () => void {
  const notify = opts.notify ?? ((line: string) => process.stderr.write(line + "\n"));
  const intervalMs =
    opts.intervalMs ??
    (Number(process.env.CLAUDISH_NATIVE_PIN_AUTO_INTERVAL_MS) > 0
      ? Number(process.env.CLAUDISH_NATIVE_PIN_AUTO_INTERVAL_MS)
      : 6 * 60 * 60 * 1000);

  // Dedup: notify once per (family, newest) — not once per tick.
  const lastNotified: Partial<Record<NativeFamily, string>> = {};

  const check = async (first: boolean): Promise<void> => {
    const resolver = opts.resolver ?? getResolver("openrouter");
    if (!resolver) return;
    try {
      if (first) await resolver.ensureReady(10_000);
      else await resolver.refreshCatalog(8_000);
    } catch {
      return; // catalog unreachable — keep configured, stay quiet
    }
    const auto = process.env.CLAUDISH_NATIVE_PIN_AUTO === "on"; // re-read per check
    for (const u of pickNativePinUpdates(configured, getMemCatalogEntries())) {
      if (auto) {
        // The configured value never changes, so the update re-detects every
        // tick — announce the adoption only when the override actually moves.
        if (_pinOverrides[u.family] !== u.newest) {
          _pinOverrides[u.family] = u.newest;
          notify(
            `[NativePin] adopted newer anthropic ${u.family}: '${u.configured}' → '${u.newest}' (CLAUDISH_NATIVE_PIN_AUTO=on)`
          );
          lastNotified[u.family] = u.newest;
        }
      } else if (lastNotified[u.family] !== u.newest) {
        notify(
          `[NativePin] newer anthropic ${u.family} available: configured='${u.configured}' catalog='${u.newest}' (notify-only — set CLAUDISH_NATIVE_PIN_AUTO=on to adopt)`
        );
        lastNotified[u.family] = u.newest;
      }
    }
  };

  const firstTimer = setTimeout(() => void check(true), opts.firstDelayMs ?? 30_000);
  firstTimer.unref?.();
  const interval = setInterval(() => void check(false), intervalMs);
  interval.unref?.();
  return () => {
    clearTimeout(firstTimer);
    clearInterval(interval);
  };
}
