/**
 * Scoped inbound keys (#400).
 *
 * The proxy-key set (primary + previous) is the fleet's own full-access
 * credential. An inbound key authenticates exactly like a proxy key but only
 * reaches the models its allowlist names — everything behind a subscription
 * (glm-5.3, MiniMax, ...) is unreachable by construction. Motivated by the
 * external-consumer key (user GO 07/10: « qu'il ne serve que nos 2 modèles
 * vllm, on garde les abonnements pour nous »): revoking an external is
 * deleting one config entry, never rotating the fleet key again.
 *
 * Allowlist semantics (deliberate, pinned by test):
 *   - bare name ("swift-1.5-27b", alias "qwen3.6-35b-a3b"): the parsed model
 *     id must be allowlisted — the id that will actually serve;
 *   - explicit provider@model / provider/model form: ONLY an exact raw match
 *     with an allowlist entry passes ("frognano@frognano-4b" passes iff that
 *     exact string is listed). A parsed-model match is NOT enough here, or
 *     "or@swift-1.5-27b" would ride an allowlisted id onto a different
 *     transport's wire.
 *
 * Deliberately a leaf module beside proxy-keys.ts: needed by the fork
 * middleware, proxy-server and request-logger, and the fork layer imports
 * core — never the reverse.
 */

import { logStderr } from "../../logger.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import { parseModelSpec } from "../../providers/model-parser.js";

export interface InboundKeyEntry {
  /** Config-declared name — what refusals, markers and the capture envelope carry. NEVER the key value. */
  name: string;
  /** Resolved secret (after ${VAR} expansion). Never logged. */
  key: string;
  /** Model ids this key may serve (raw allowlist, compared per the semantics above). */
  allowModels: string[];
}

/**
 * Expand a `${VAR_NAME}` secret reference: config.apiKeys first (the config's
 * own secret store — where e.g. MINIMAX_CODING_API_KEY already lives), then
 * process.env. A literal value passes through unchanged. Unresolvable
 * reference → empty string → the entry is skipped by the caller (a scoped key
 * that can never authenticate beats one that authenticates as "" — which
 * would match an empty header).
 */
function expandSecretValue(
  literal: string,
  config: ClaudishProfileConfig
): string {
  const match = literal.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return literal;
  return config.apiKeys?.[match[1]] ?? process.env[match[1]] ?? "";
}

/**
 * Resolve the `inboundKeys` config map into validated entries.
 *
 * Doctrine identical to customEndpoints: an entry failing validation is
 * skipped with one stderr warning — it must never crash the proxy. Two extra
 * guards:
 *   - a key value equal to a FULL-ACCESS proxy key is refused (a scoped
 *     definition must never shadow full access — the allowlist would be
 *     cosmetic);
 *   - duplicate key values across entries are refused (first wins) so one
 *     external key can never carry two different scopes.
 */
export function resolveInboundKeys(
  config: ClaudishProfileConfig,
  proxyKeys: string[]
): InboundKeyEntry[] {
  const raw = config.inboundKeys;
  if (!raw || typeof raw !== "object") return [];

  const entries: InboundKeyEntry[] = [];
  const seenKeyValues = new Set<string>(proxyKeys); // full-access values are pre-taken

  for (const [name, value] of Object.entries(raw)) {
    const v = value as { key?: unknown; allowModels?: unknown } | undefined;
    const skip = (why: string): void => {
      // logStderr, not console.error: must reach the durable log file (218c3586).
      logStderr(`[claudish] inboundKeys['${name}'] skipped: ${why}`);
    };

    const key = typeof v?.key === "string" ? expandSecretValue(v.key, config) : "";
    if (!name || key.length === 0) {
      skip("key missing, empty, or unresolvable ${VAR} reference");
      continue;
    }
    const allowModels = Array.isArray(v?.allowModels)
      ? (v!.allowModels as unknown[]).filter(
          (m): m is string => typeof m === "string" && m.length > 0
        )
      : [];
    if (allowModels.length === 0) {
      skip("allowModels missing/empty — a scoped key with no reachable model is a config error");
      continue;
    }
    if (seenKeyValues.has(key)) {
      skip("key value already used by a full-access proxy key or another inbound key");
      continue;
    }
    seenKeyValues.add(key);
    entries.push({ name, key, allowModels });
  }
  return entries;
}

/** The entry whose secret the client presented, or null (falls back to the full-access check). */
export function matchesInboundKey(
  provided: string | undefined,
  entries: InboundKeyEntry[]
): InboundKeyEntry | null {
  if (!provided || entries.length === 0) return null;
  return entries.find((e) => e.key === provided) ?? null;
}

/** Allowlist verdict per the semantics documented on the module. */
export function inboundModelAllowed(entry: InboundKeyEntry, model: string): boolean {
  if (entry.allowModels.includes(model)) return true; // exact raw hit (any form)
  if (model.includes("@") || model.includes("/")) return false; // explicit provider: exact raw hit only
  try {
    const spec = parseModelSpec(model);
    return entry.allowModels.includes(spec.model);
  } catch {
    return false;
  }
}

// ─── Per-request attribution (#400 goal 2: the capture names the KEY, not the IP) ───
// The middleware authenticates; logRequest captures seconds later off the same
// raw Request object — same WeakMap pattern as requestNumberFor.

const inboundKeyNames = new WeakMap<Request, string>();

/** Middleware marks the request as authenticated by a named scoped key. */
export function markInboundKey(req: Request, name: string): void {
  try {
    inboundKeyNames.set(req, name);
  } catch {
    /* attribution is best-effort */
  }
}

/** Capture side: the scoped key NAME that authenticated this request, if any. */
export function inboundKeyFor(req: Request): string | undefined {
  try {
    return inboundKeyNames.get(req);
  } catch {
    return undefined;
  }
}
