/**
 * #291 — bind-write probe for the capture directory.
 *
 * Incident class (29/10, po-2028): the host bind behind CLAUDISH_CAPTURE_DIR
 * became unwritable (rootfs full) and every capture writer no-ops silently —
 * a capture gap with no signal anywhere on the box. The probe answers one
 * question on /health: can the process ACTUALLY write into the capture dir
 * right now? A real write+unlink of a dot-file, mkdir-less on purpose (the
 * writers' ensureCaptureDir failure mode is the one being probed — creating
 * the dir here would mask ENOSPC-backed ENOENT and report "ok" on a dead
 * bind).
 *
 * Verdict vocabulary, read by the watchdog and the journal:
 *   - "ok"           — write and unlink both succeeded;
 *   - "disabled"     — CLAUDISH_CAPTURE_DIR unset (capture off BY CONFIG, not
 *                      an incident; the two must never be conflated);
 *   - "error:<code>" — capture on but the bind refused the write; <code> is
 *                      the errno code when present (ENOSPC, EROFS, EACCES,
 *                      ENOTDIR, ENOENT…), else the clamped error text.
 *
 * Never throws — a probe that can kill /health would trade a silent capture
 * gap for a dead health endpoint. Result is TTL-cached
 * (CLAUDISH_CAPTURE_PROBE_TTL_MS, default 30 s, ≤0 = re-probe every call) so
 * a /health flood cannot stamp the disk; the cache invalidates on dir or TTL
 * change so an operator flipping the env sees the new verdict immediately.
 */

import { rmSync, writeFileSync } from "node:fs";

const PROBE_FILE = ".bind-write-probe";
const DEFAULT_TTL_MS = 30_000;

export const CAPTURE_PROBE_TTL_ENV = "CLAUDISH_CAPTURE_PROBE_TTL_MS";

let cache: { dir: string; ttlMs: number; verdict: string; at: number } | null = null;

function probeTtlMs(): number {
  const raw = Number(process.env[CAPTURE_PROBE_TTL_ENV]);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_MS;
  return raw > 0 ? raw : 0;
}

function errorTag(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code.slice(0, 64);
  return String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 64);
}

/** Test seam — drops the TTL cache so each test probes from a clean slate. */
export function resetCaptureBindProbeForTests(): void {
  cache = null;
}

/**
 * The verdict for /health's `captureBindWrite` field. Reads the env per call
 * (the capture writers do the same — see response-capture.ts), so a mid-life
 * env change is honored on the next probe once the TTL allows it.
 */
export function captureBindWriteVerdict(now = Date.now()): string {
  const dir = process.env.CLAUDISH_CAPTURE_DIR;
  if (!dir) {
    // No dir, nothing to probe — and nothing worth caching (the unset case
    // costs nothing, and skipping the cache keeps "disabled" honest the
    // instant capture is turned on).
    cache = null;
    return "disabled";
  }
  const ttlMs = probeTtlMs();
  if (cache && cache.dir === dir && cache.ttlMs === ttlMs && now - cache.at < ttlMs) {
    return cache.verdict;
  }
  let verdict = "ok";
  try {
    writeFileSync(`${dir}/${PROBE_FILE}`, String(now));
    rmSync(`${dir}/${PROBE_FILE}`, { force: true });
  } catch (err) {
    verdict = `error:${errorTag(err)}`;
  }
  cache = { dir, ttlMs, verdict, at: now };
  return verdict;
}
