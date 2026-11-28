/**
 * Countable trace of proxy-key refusals (the 401 of proxy-auth.ts).
 *
 * Until now the 401 "invalid proxy authentication" left nothing behind: no
 * capture (the route never runs), no log line. A seat failing to authenticate
 * was invisible from the hub — the only evidence lived on the client, and an
 * "auth trouble" report from a machine could not be checked against the hub
 * at the reported minute (27/11, po-2026).
 *
 * One marker line per bucket per interval, through logStderr (the hub runs
 * with debug off, where log() is file-only — #212 lesson):
 *
 *   [ProxyAuth] refused 401 bucket=<b> n=<cumulative> used=<header> present=<headers> model=<id>
 *
 * - bucket: same rule as the #439 rotation tracker (`proxyKeyAuthBucket`) —
 *   the machine header, else the User-Agent product token, else `unknown`.
 * - used: which header the middleware read the credential from, with the
 *   middleware's own precedence (x-proxy-key > x-api-key > authorization);
 *   `none` when no credential was sent at all.
 * - present: every credential-carrying header on the request, by NAME.
 * - model: the requested id when it is a short inert token, else `other`.
 *
 * Never key material: no value, no prefix, no length, no fingerprint — a
 * refusal log must not become a key oracle for whoever reads `docker logs`.
 * State is in-memory and bounded (MAX_BUCKETS); a restart resets the counts.
 * The bound has a known cost: an unauthenticated client can mint MAX_BUCKETS
 * machine names, after which every NEW bucket (a real seat included) counts
 * under `overflow` until the process restarts. The line still says
 * `bucket=overflow`, so a reader knows the attribution was lost, not wrong.
 */

import { proxyKeyAuthBucket } from "../../handlers/shared/proxy-key-rotation.js";
import { logStderr } from "../../logger.js";

/** At most one marker per bucket per minute — enough to date a report, not an echo. */
export const REFUSAL_MARKER_INTERVAL_MS = 60 * 1000;

/** A hostile client could mint machine headers; the map must stay bounded. */
const MAX_BUCKETS = 256;
const OVERFLOW_BUCKET = "overflow";

/** Model ids reach a log line: keep them inert (provider@model, [1m], paths). */
const MODEL_SAFE = /^[A-Za-z0-9._:@/\[\]-]{1,80}$/;

interface RefusalBucket {
  count: number;
  lastMarkerAt: number;
}

const buckets = new Map<string, RefusalBucket>();

export interface RefusalHeaders {
  "x-proxy-key"?: string;
  "x-api-key"?: string;
  authorization?: string;
  "x-claudish-machine"?: string;
  "user-agent"?: string;
}

function usedHeader(h: RefusalHeaders): string {
  // Mirrors `provided = proxyKeyHeader || apiKeyHeader || bearerToken`.
  if (h["x-proxy-key"]) return "x-proxy-key";
  if (h["x-api-key"]) return "x-api-key";
  if (h.authorization)
    return h.authorization.startsWith("Bearer ") ? "authorization-bearer" : "authorization";
  return "none";
}

function presentHeaders(h: RefusalHeaders): string {
  const names = (["x-proxy-key", "x-api-key", "authorization"] as const).filter((n) => !!h[n]);
  return names.length > 0 ? names.join("+") : "none";
}

function safeModel(model: unknown): string {
  if (typeof model !== "string" || model.length === 0) return "none";
  return MODEL_SAFE.test(model) ? model : "other";
}

/**
 * Count one refusal and, when one is due for this bucket, log the marker
 * through logStderr. Returns the marker line it logged, else null. Never throws.
 */
export function noteProxyAuthRefusal(
  headers: RefusalHeaders,
  model: unknown,
  now: number = Date.now()
): string | null {
  try {
    let bucket = proxyKeyAuthBucket({
      "x-claudish-machine": headers["x-claudish-machine"],
      "user-agent": headers["user-agent"],
    });
    if (!buckets.has(bucket) && buckets.size >= MAX_BUCKETS) bucket = OVERFLOW_BUCKET;
    const entry = buckets.get(bucket) ?? { count: 0, lastMarkerAt: Number.NEGATIVE_INFINITY };
    entry.count += 1;
    buckets.set(bucket, entry);
    if (now - entry.lastMarkerAt < REFUSAL_MARKER_INTERVAL_MS) return null;
    entry.lastMarkerAt = now;
    const line =
      `[ProxyAuth] refused 401 bucket=${bucket} n=${entry.count}` +
      ` used=${usedHeader(headers)} present=${presentHeaders(headers)} model=${safeModel(model)}`;
    logStderr(line);
    return line;
  } catch {
    return null;
  }
}

/** Cumulative refusals per bucket since process start (tests; a future /health field). */
export function proxyAuthRefusalCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [bucket, entry] of buckets) out[bucket] = entry.count;
  return out;
}

/** Test-only: module state is process-wide. */
export function _resetProxyAuthRefusalsForTest(): void {
  buckets.clear();
}
