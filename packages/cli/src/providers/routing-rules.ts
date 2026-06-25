import { credentials } from "../auth/credentials/authority.js";
import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingEntry, RoutingRules } from "../profile-config.js";
import { DISPLAY_NAMES, PROVIDER_TO_PREFIX } from "./auto-route.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { resolveModelNameSync } from "./model-catalog-resolver.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { parseModelSpec } from "./model-parser.js";
import { buildCredentialHint } from "./routing-hints.js";

/**
 * Pure merge — defaults < global < local. Exposed for testability so callers
 * can verify merge semantics without touching the disk.
 */
export function mergeRoutingRules(
  defaults: RoutingRules,
  global_: RoutingRules,
  local: RoutingRules
): RoutingRules {
  return { ...defaults, ...global_, ...local };
}

/**
 * Load effective routing rules. Layers:
 *   1. DEFAULT_ROUTING_RULES (built-in, see default-routing-rules.ts)
 *   2. Global config (~/.claudish/config.json)
 *   3. Local config (./.claudish.json)
 *
 * Local rules overwrite global rules overwrite defaults — same key wins.
 * User patterns OVERWRITE default patterns by exact key match (no glob-vs-glob
 * interleaving).
 *
 * Always returns a non-null `RoutingRules` because defaults are baked in.
 * To get strict no-fallback mode, set `routing["*"] = []` in user config.
 */
export function loadRoutingRules(): RoutingRules {
  const local = loadLocalConfig()?.routing ?? {};
  const global_ = loadConfig().routing ?? {};

  validateRoutingRules(local);
  validateRoutingRules(global_);

  return mergeRoutingRules(DEFAULT_ROUTING_RULES, global_, local);
}

/** Warn about config issues that would silently misbehave. */
function validateRoutingRules(rules: RoutingRules): void {
  // Track lower-cased keys to catch case-insensitive collisions. Matching is
  // case-insensitive, so two keys that differ only in case will silently
  // collapse to whichever the iteration order favors. Warn the user.
  const seenLower = new Map<string, string>();
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      console.error(
        `[claudish] Warning: routing pattern "${key}" has multiple wildcards — only single * is supported. This pattern may not match as expected.`
      );
    }
    const lower = key.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined && prior !== key) {
      console.error(
        `[claudish] Warning: routing patterns "${prior}" and "${key}" collide case-insensitively. Matching is case-insensitive, so one will silently shadow the other. Pick one casing and remove the duplicate.`
      );
    } else {
      seenLower.set(lower, key);
    }
    // Empty chain is valid — explicit no-fallback mode (route() returns
    // no-route). No warning needed; user opted in.
  }
}

/**
 * Match a model name against routing rules. Case-INSENSITIVE — provider
 * docs and catalogs use mixed casing (`MiniMax-M2.5`, `GPT-4o`) but the
 * underlying APIs accept any case, so users get bitten when copy-paste
 * casing doesn't exactly match a lowercase rule key.
 *
 * Priority: exact → longest glob → "*" catch-all → null (use default chain).
 *
 * NOTE: only the rule LOOKUP is lowered. The original `modelName` casing is
 * preserved when the route is built and sent to provider APIs (some are
 * case-sensitive on their own model IDs).
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  const lowered = modelName.toLowerCase();

  // 1. Exact match (case-insensitive over rule keys)
  for (const [key, entries] of Object.entries(rules)) {
    if (!key.includes("*") && key.toLowerCase() === lowered) return entries;
  }

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return rules[pattern];
  }

  // 3. Catch-all (may be an empty array — caller treats that as "no route")
  if (rules["*"] !== undefined) return rules["*"];

  return null;
}

/**
 * Convert routing entries to Route objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 */
export function buildRoutingChain(entries: RoutingEntry[], originalModelName: string): Route[] {
  const routes: Route[] = [];

  for (const entry of entries) {
    const atIdx = entry.indexOf("@");
    let providerRaw: string;
    let modelName: string;

    if (atIdx !== -1) {
      providerRaw = entry.slice(0, atIdx);
      modelName = entry.slice(atIdx + 1);
    } else {
      providerRaw = entry;
      modelName = originalModelName;
    }

    // Resolve shortcut
    const provider = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();

    // Build modelSpec
    let modelSpec: string;
    if (provider === "openrouter") {
      const resolution = resolveModelNameSync(modelName, "openrouter");
      modelSpec = resolution.resolvedId;
    } else {
      const prefix = PROVIDER_TO_PREFIX[provider] ?? provider;
      modelSpec = `${prefix}@${modelName}`;
    }

    const displayName = DISPLAY_NAMES[provider] ?? provider;
    routes.push({ provider, modelSpec, displayName });
  }

  return routes;
}

/**
 * Single-wildcard glob: "kimi-*" matches "kimi-k2.5". Case-INSENSITIVE so
 * `MiniMax-M2.5` matches `minimax-*` and `GPT-4o` matches `gpt-*`. Provider
 * docs use mixed casing, model IDs in catalogs are usually lowercase, but
 * users routinely paste from docs and would otherwise hit the catch-all.
 */
function globMatch(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (star === -1) return p === v;
  const prefix = p.slice(0, star);
  const suffix = p.slice(star + 1);
  return v.startsWith(prefix) && v.endsWith(suffix) && v.length >= prefix.length + suffix.length;
}

// ---------------------------------------------------------------------------
// route() — single routing entry point (plan §B.3)
// ---------------------------------------------------------------------------

/** A single resolved route candidate. */
export interface Route {
  /** Canonical provider name (e.g. "openai", "openrouter"). */
  provider: string;
  /** Ready-to-handle "provider@model" string for downstream handler creation. */
  modelSpec: string;
  /** Human-readable provider label. */
  displayName: string;
}

/**
 * Result of resolving a model spec.
 *
 *   - `kind: "ok"`        — at least one credentialed provider was found.
 *                           `primary` is the first; `fallbacks` follow in order.
 *   - `kind: "no-route"`  — either the explicit prefix had no credentials
 *                           configured, or the chain was empty after credential
 *                           filtering. `hint` is a multi-line message with
 *                           actionable suggestions.
 */
export type RoutePlan =
  | { kind: "ok"; primary: Route; fallbacks: Route[] }
  | { kind: "no-route"; reason: string; hint?: string };

/**
 * Check whether the user has credentials for a given canonical provider.
 *
 * Delegates to the credential authority's sync readiness oracle. The authority's
 * per-provider impls replicate every special case this function used to inline:
 *   - `native-anthropic` requires an explicit ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *     (NativeAnthropicCredentialProvider).
 *   - `openai-codex` requires its codex-specific key or OAuth — the OPENAI_API_KEY
 *     alias is excluded (the Codex composite's API-key half has no aliases).
 *   - Local transports (ollama, lmstudio, vllm, mlx) require explicit enablement
 *     (LocalCredentialProvider → isLocalProviderEnabled).
 *   - OAuth-backed providers (kimi, gemini-codeassist) accept an OAuth file or env
 *     key; publicKeyFallback / oauthFallback affordances are honored by the
 *     ApiKeyCredentialProvider.
 *
 * Equivalence with the previous inline logic is pinned by
 * auth/credentials/equivalence.test.ts.
 */
export async function hasCredentialsForProvider(provider: string): Promise<boolean> {
  return credentials.isAvailable(provider);
}

/**
 * Path 1: an explicit "provider@model" spec. Probe ONLY that provider's
 * credentials; never fall back silently.
 */
async function routeExplicit(
  modelSpec: string,
  model: string,
  provider: string
): Promise<RoutePlan> {
  if (!(await hasCredentialsForProvider(provider))) {
    return {
      kind: "no-route",
      reason: `No credentials configured for "${provider}".`,
      hint: buildCredentialHint(model, [provider]) ?? undefined,
    };
  }

  const built = buildRoutingChain([modelSpec], model)[0];
  if (!built) {
    return {
      kind: "no-route",
      reason: `Could not build a route for "${modelSpec}".`,
    };
  }
  return { kind: "ok", primary: built, fallbacks: [] };
}

/**
 * Path 2: a bare model name. Consult rules, build candidates, filter to those
 * with credentials, and return ok/no-route accordingly.
 *
 * If `defaultProvider` is set and not already present in the matched chain, it
 * is appended as a final entry — a safety net that catches models whose chain
 * has no credentialed providers. Deduped: if the chain already lists the
 * default provider, no second copy is added.
 */
async function routeBare(
  model: string,
  nativeProvider: string,
  rules: RoutingRules,
  defaultProvider?: string
): Promise<RoutePlan> {
  const matched = matchRoutingRule(model, rules) ?? [];
  const entries = [...matched];

  if (defaultProvider && defaultProvider.length > 0) {
    const canonicalDefault =
      PROVIDER_SHORTCUTS[defaultProvider.toLowerCase()] ?? defaultProvider.toLowerCase();
    const alreadyPresent = entries.some((e) => {
      const atIdx = e.indexOf("@");
      const providerRaw = atIdx === -1 ? e : e.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      return canonical === canonicalDefault;
    });
    if (!alreadyPresent) entries.push(defaultProvider);
  }

  if (entries.length === 0) {
    return {
      kind: "no-route",
      reason: `No routing rule matched "${model}".`,
      hint: buildCredentialHint(model, [nativeProvider]) ?? undefined,
    };
  }

  const candidates = buildRoutingChain(entries, model);
  const credentialed: Route[] = [];
  const skipped: string[] = [];

  // Resolve each candidate's credentials concurrently (each call funnels through
  // the SDK serialization queue internally), but keep the original chain ORDER
  // when partitioning into credentialed / skipped.
  const checks = await Promise.all(
    candidates.map((candidate) => hasCredentialsForProvider(candidate.provider))
  );
  candidates.forEach((candidate, i) => {
    if (checks[i]) {
      credentialed.push(candidate);
    } else {
      skipped.push(candidate.provider);
    }
  });

  if (credentialed.length === 0) {
    return {
      kind: "no-route",
      reason:
        skipped.length > 0
          ? `No credentialed providers in chain for "${model}" (tried: ${skipped.join(", ")}).`
          : `No providers available for "${model}".`,
      hint: buildCredentialHint(model, skipped) ?? undefined,
    };
  }

  const [primary, ...fallbacks] = credentialed;
  return { kind: "ok", primary, fallbacks };
}

/**
 * Normalize a slugified GLM version name back to its canonical dotted form.
 *
 * Some clients derive the wire model id from a URL/registry slug and replace
 * the version dot with a dash: `glm-5.2` → `glm-5-2`, `glm-4.6` → `glm-4-6`,
 * `glm-4.5-air` → `glm-4-5-air`. Routing rules key on the canonical dotted
 * name (`glm-5.2` → `gc@glm-5.2`), so without this the slug matches no GLM rule
 * and fails with a confusing "Unknown Model" 400 from the provider.
 *
 * Narrow and anchored by design: only `glm-<digits>-<digits>` (optionally
 * followed by `-suffix`) is rewritten. Already-dotted names (`glm-5.2`),
 * dash-native open-model names (`glm-4-9b`), and every non-GLM model are left
 * exactly as-is — the regex simply doesn't match them.
 *
 * Cluster context (2026-06-25): added to unblock the Hermes bot (po-2026),
 * whose model registry slugified `glm-5.2` into `glm-5-2` before POSTing to the
 * proxy's `/v1/messages`.
 */
export function normalizeGlmSlug(model: string): string {
  return model.replace(
    /^glm-(\d+)-(\d+)(-.*)?$/i,
    (_m, major, minor, suffix) => `glm-${major}.${minor}${suffix ?? ""}`
  );
}

/**
 * Resolve a model name to a provider chain.
 *
 * Two paths:
 *   1. Explicit prefix (`provider@model`): the caller named the vendor. We
 *      probe ONLY that vendor's credentials; missing credentials → no-route
 *      with a credential hint. **No silent fallback** — `defaultProvider` is
 *      not consulted because the user named a specific vendor.
 *   2. Bare name: consult routing rules (defaults + user overrides), append
 *      `defaultProvider` as a final fallback if set and not already present,
 *      build the candidate chain, filter to credentialed entries, return the
 *      filtered chain. Empty filtered chain → no-route with hints.
 *
 * Rules and the default provider are loaded fresh each call (via `loadRoutingRules()`
 * and `loadConfig()`) unless overrides are supplied. Tests should pass overrides
 * to avoid disk lookups.
 */
export async function route(
  modelSpec: string,
  rulesOverride?: RoutingRules,
  defaultProviderOverride?: string
): Promise<RoutePlan> {
  const parsed = parseModelSpec(modelSpec);
  // Tolerate slugified GLM version names (e.g. a client that turns "glm-5.2"
  // into "glm-5-2") so they match the canonical routing rule instead of failing.
  const model = normalizeGlmSlug(parsed.model);

  if (parsed.isExplicitProvider) {
    return routeExplicit(modelSpec, model, parsed.provider);
  }

  const rules = rulesOverride ?? loadRoutingRules();
  // When tests pass an explicit `rulesOverride`, treat the rule set as the
  // authoritative source of truth and do not read `loadConfig().defaultProvider`
  // off disk — that would leak the host machine's config into unit tests.
  // Production callers (via `loadRoutingRules()`) get the disk-loaded default.
  const defaultProvider =
    defaultProviderOverride !== undefined
      ? defaultProviderOverride
      : rulesOverride !== undefined
        ? undefined
        : loadConfig().defaultProvider;
  return routeBare(model, parsed.provider, rules, defaultProvider);
}

// route() is now async; routeBare returns a Promise which is awaited by the caller.
