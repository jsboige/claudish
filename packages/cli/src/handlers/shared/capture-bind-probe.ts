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
 *                      ENOTDIR, ENOENT…), else the clamped error text;
 *   - "error:wedged" — a refresh has been in flight longer than the wedge
 *                      bound (see WEDGE_FLOOR_MS): the bind may be hung — a
 *                      wedged write does not fail fast, and the field refuses
 *                      to keep serving the last (possibly "ok") verdict as if
 *                      it were current. NO new write is started while one is
 *                      pending: hung fs calls can hold the I/O thread pool
 *                      the capture writers also need.
 *
 * CR #1057 — the probe is ASYNC-REFRESHED, never run inline on /health: the
 * writers paid twice for a sync write on this loop (request-logger.ts
 * 2026-08-20: "one slow write froze every handler, including the 4s /health
 * heartbeat"; response-capture.ts 24/08). A wedged bind does not fail fast —
 * the diagnosis instrument must not become the outage. So:
 *   - captureBindWriteVerdict() is a PURE CACHE READ (sync, ~free): the last
 *     known verdict, or "unknown:probing" on a cold/re-keyed cache — never a
 *     guessed "ok" (a cold cache that reported ok would hide exactly the
 *     dead-bind class being probed); a stale-but-matching verdict is served
 *     while its refresh runs (last MEASURED truth, aging, never a guess) —
 *     until the refresh has been in flight past the wedge bound, where the
 *     field reports "error:wedged" instead of a possibly-stale "ok";
 *   - a stale/missing verdict kicks ONE fire-and-forget async refresh
 *     (fs/promises writeFile + unlink); errors fold into the next verdict;
 *   - at most one refresh in flight — a /health flood cannot stamp the disk
 *     or pile up probes (the TTL additionally spaces them:
 *     CLAUDISH_CAPTURE_PROBE_TTL_MS, default 30 s; ≤0 = refresh allowed on
 *     every call — the "≤0" spelling INCLUDES the empty-string compose case,
 *     `${VAR:-}` injecting "" yields Number("") = 0 — deliberately treated
 *     as "probe often", the safe direction, never as a parse error);
 *   - the cache invalidates on dir or TTL change so an operator flipping the
 *     env sees the new verdict on the next refresh, not the stale one;
 *   - the probe file is pid-suffixed: two processes sharing one capture dir
 *     must not unlink each other's probe and report a false error:ENOENT
 *     (every capture writer names its files the same way).
 */

import { writeFile, unlink } from "node:fs/promises";

const PROBE_FILE = ".bind-write-probe";
const DEFAULT_TTL_MS = 30_000;
/**
 * The wedge bound's floor. A healthy bind settles in milliseconds, so the
 * horizon is the operator's own freshness choice (the TTL) — but TTL ≤ 0
 * ("re-probe every call") must not smear every merely-in-flight refresh as
 * wedged, hence the 10 s floor. Past the bound a hung write is reported as
 * `error:wedged` and NO replacement write is started (hung fs calls hold the
 * I/O thread pool; piling one per TTL would starve the capture writers).
 */
const WEDGE_FLOOR_MS = 10_000;

function wedgeBoundMs(ttlMs: number): number {
  return Math.max(ttlMs, WEDGE_FLOOR_MS);
}

/**
 * Read via a STRING LITERAL (CR #1057 blocking 2): `process.env[CONST]` is
 * invisible to the compose-env-coverage scanner, so the name could sit
 * missing from docker-compose.yml's environment: with the test green (#310:
 * the env is fixed at create time — an absent name never reaches the
 * process). The literal keeps the scanner honest.
 */
export const CAPTURE_PROBE_TTL_ENV = "CLAUDISH_CAPTURE_PROBE_TTL_MS";

let cache: { dir: string; ttlMs: number; verdict: string; at: number } | null = null;
let refreshing = false;
/** When the in-flight refresh started — the wedge clock (0 when idle). */
let refreshStartedAt = 0;

/**
 * Test seam over the fs surface (the AtomicFsSeam pattern of #617): the
 * wedge pin needs a writeFile that NEVER RESOLVES, which no real directory
 * can fabricate portably. Production always uses node:fs/promises.
 */
type ProbeFs = {
  writeFile: typeof writeFile;
  unlink: typeof unlink;
};
const realFs: ProbeFs = { writeFile, unlink };
let fsForProbe: ProbeFs = realFs;

/** Test seam — override the fs surface (undefined restores the real one). */
export function setCaptureBindProbeFsForTests(fs?: Partial<ProbeFs>): void {
  fsForProbe = fs ? { ...realFs, ...fs } : realFs;
}

function probeTtlMs(): number {
  const raw = process.env.CLAUDISH_CAPTURE_PROBE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  return n > 0 ? n : 0;
}

function errorTag(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code.slice(0, 64);
  return String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 64);
}

/** Test seam — drops the TTL cache so each test probes from a clean slate. */
export function resetCaptureBindProbeForTests(): void {
  cache = null;
  refreshing = false;
  refreshStartedAt = 0;
}

/** Test seam — true while an async refresh is in flight (the one-flight pin). */
export function captureBindProbeRefreshingForTests(): boolean {
  return refreshing;
}

/** Test seam — await the in-flight refresh (asserts the real verdict later). */
export async function captureBindProbeSettleForTests(): Promise<void> {
  while (refreshing) await new Promise((r) => setTimeout(r, 5));
}

/**
 * The ONE async refresh. Fire-and-forget from the reader below; never
 * awaited on the /health path. Errors fold into the cached verdict — the
 * probe still never throws.
 */
async function refreshVerdict(dir: string, ttlMs: number, now: number): Promise<void> {
  // N5 — pid suffix: a second process sharing the capture dir must not
  // unlink THIS process's probe (false error:ENOENT both ways).
  const file = `${dir}/${PROBE_FILE}-${process.pid}`;
  let verdict = "ok";
  try {
    await fsForProbe.writeFile(file, String(now));
    await fsForProbe.unlink(file);
  } catch (err) {
    verdict = `error:${errorTag(err)}`;
  }
  // No re-key guard here: under one-flight NOTHING else can write the cache
  // while this refresh runs (the `refreshing` gate is the whole mutex), so a
  // cache whose key differs from this refresh's key is simply the STALE
  // entry this result supersedes — always overwrite, always clear the flag
  // (a latched `refreshing` would freeze every later call on
  // unknown:probing).
  cache = { dir, ttlMs, verdict, at: now };
  refreshing = false;
  refreshStartedAt = 0;
}

/**
 * The verdict for /health's `captureBindWrite` field — a PURE SYNC CACHE
 * READ. Reads the env per call (the capture writers do the same — see
 * response-capture.ts), so a mid-life env change is honored on the next
 * refresh. The verdict served is the LAST MEASURED TRUTH for THIS
 * (dir, TTL) key — never a guess: a cold or re-keyed cache reports
 * "unknown:probing" until the first refresh lands (CR: never a guessed
 * "ok"). A stale-but-matching verdict is served WHILE one async refresh
 * runs — /health never blocks on disk, and the truth lands one probe later.
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
  const matching = cache !== null && cache.dir === dir && cache.ttlMs === ttlMs;
  // Stale when no matching verdict, or the matching one aged past the TTL
  // (age >= ttl: at TTL<=0 every call is stale — "re-probe every call").
  const stale = !matching || now - cache!.at >= ttlMs;
  if (stale && !refreshing) {
    refreshing = true;
    refreshStartedAt = now;
    void refreshVerdict(dir, ttlMs, now).catch(() => {
      // refreshVerdict never throws (its body folds errors), this guards a
      // truly unexpected rejection from leaving `refreshing` latched.
      refreshing = false;
      refreshStartedAt = 0;
    });
  }
  // CR #1057 round 2 — the WEDGE guard: a refresh that never settles must not
  // freeze the field on its last value (possibly "ok") — that is exactly the
  // dead-bind class this probe exists to detect, served as if current. Past
  // the bound the reader reports `error:wedged`; the in-flight refresh is
  // LEFT ALONE (no new write — hung fs calls hold the I/O thread pool), and
  // if it eventually settles it clears the flag as always, restoring the
  // measured verdict.
  if (refreshing && now - refreshStartedAt > wedgeBoundMs(ttlMs)) {
    return "error:wedged";
  }
  if (!matching) return "unknown:probing";
  return cache!.verdict;
}
