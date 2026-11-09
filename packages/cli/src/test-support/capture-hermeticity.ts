/**
 * Capture hermeticity guard — armed by test-preload.ts for every test run
 * (both bunfig.tomls point at the same preload).
 *
 * WHY. The response/error capture writers are gated on CLAUDISH_CAPTURE_DIR
 * (request-logger.ts: "captureDir && ensureCaptureDir(captureDir)"): with the
 * env UNSET nothing writes anywhere, but with it SET every request through the
 * pipeline writes resp-*.sse / upstream-errors.log / connection-errors.log
 * into it. On a seat, the developer shell often carries the env from ops work
 * (D:\captures is the live sidecar's host bind) — measured 2026-11-08, three
 * test files ran under that ambient env and wrote into the REAL capture dir:
 * upstream-compression.test.ts (native describe, pre-isolation; openai
 * describe still leaking upstream-errors.log 401s) and composed-handler-error
 * .test.ts (2 resp-*.sse + connection-errors.log). composed-handler.test.ts
 * would land 281 resp-*.sse files per run under the same conditions.
 *
 * Two layers, one arm() call:
 *
 * 1. PREVENT (the swap). At preload time — before any test file — an ambient
 *    CLAUDISH_CAPTURE_DIR is swapped for a per-run tmp dir. A test that
 *    forgets to isolate then pollutes the tmp sandbox, not the real dir, and
 *    tests that save/restore the env save the sandbox value (they nest
 *    correctly: outer-beforeEach sets tmp, inner describes overwrite and
 *    restore to tmp). The real dir becomes unreachable by env inheritance,
 *    which is the only mechanism every writer shares.
 *
 * 2. DETECT (the pin). afterAll in a preload runs once, after the last test
 *    file (measured, Bun 1.3.13 — process exit hooks do NOT fire under
 *    `bun test`, precedent: the home sandbox in this same preload). The
 *    original dir is scanned read-only for files named resp-<this pid>-*: the
 *    capture filename embeds the writing process's pid, so a test-process
 *    write is attributable while the live sidecar's concurrent writes into
 *    the SAME host dir (different pid namespace) are not mistaken for leaks.
 *    The shared append-only logs (upstream-errors.log, connection-errors.log)
 *    carry no pid and cannot be attributed — they are covered by layer 1, and
 *    the scan deliberately does not guess on them (a mtime window would
 *    false-positive against sidecar traffic on every live seat).
 *
 * 3. CLEAN UP (review B1 on #936). The run that fills the sandbox is exactly
 *    the leaky run the guard exists for — leaving it in %TEMP% would grow
 *    unbounded on a seat that runs the suite a few times a day (measured: 289
 *    files in one run of a non-isolated composed-handler.test.ts). The
 *    sandbox is therefore disposed in the same afterAll, after the detection
 *    scan, and a preload-start sweep removes leftovers of runs that never
 *    reached their afterAll (killed/crashed) — the same shape as the
 *    claudish-test-home-* sweep. The sweep is age-gated so it can never touch
 *    a run still in flight.
 */
import { afterAll } from "bun:test";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CAPTURE_SANDBOX_PREFIX = "claudish-test-capture-";

/**
 * Age beyond which a leftover sandbox cannot belong to a live run. Six hours:
 * far longer than any suite run (minutes), short enough that a day of dev runs
 * leaves nothing behind. Not a day — that is the home-sandbox threshold, whose
 * leftovers are bounded by one directory per killed run; a leaky capture
 * sandbox is bounded by hundreds of files.
 */
const STALE_SANDBOX_MS = 6 * 60 * 60 * 1000;

/** The pid-stamped prefix of capture files written by a given process. */
export function captureFilesOfProcess(pid: number): string {
  return `resp-${pid}-`;
}

/**
 * Pure filter, pinned by unit tests: from a directory listing, keep only the
 * capture files THIS process wrote. Other-pid resp files (a live sidecar
 * sharing the host dir) and unrelated names are noise, not leaks. Named for
 * what it returns — the earlier `foreignCaptureFiles` read like the opposite.
 */
export function ownPidCaptureFiles(names: string[], pid: number): string[] {
  const own = captureFilesOfProcess(pid);
  return names.filter((n) => n.startsWith(own) && n.endsWith(".sse"));
}

/** Scan a capture dir (read-only) for files this process should not have written. */
export function detectOwnPidCaptures(dir: string, pid: number): string[] | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Unreadable or missing: cannot verify — never a verdict, and never a fail.
    return null;
  }
  return ownPidCaptureFiles(names, pid);
}

/**
 * Remove a per-run capture sandbox (and everything a leaky test wrote in it).
 * Best effort and idempotent: a missing dir is a no-op, an interposed file
 * cannot fail the run — the verdict was already taken by the scan. Pinned.
 */
export function disposeCaptureSandbox(sandbox: string): void {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

/**
 * Sweep sandboxes left behind by runs that never reached their afterAll
 * (killed, crashed, OOM). Age-gated by mtime so a run in flight is never a
 * target. Returns the names removed (empty when the tree is clean) — the shape
 * a pin asserts on. Pinned.
 */
export function sweepStaleCaptureSandboxes(
  dir: string,
  now: number = Date.now(),
  staleMs: number = STALE_SANDBOX_MS
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(CAPTURE_SANDBOX_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const { mtimeMs } = statSync(path);
      if (now - mtimeMs <= staleMs) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(name);
    } catch {}
  }
  return removed;
}

/** What the preload saw, for the regime pin. Module state, not env: a name
 *  read by the code would owe a docker-compose entry under #310's rule, and
 *  this is harness bookkeeping no container will ever need. */
let armed: { real: string; sandbox: string } | null = null;

export function captureRegime(): { real: string; sandbox: string } | null {
  return armed;
}

/**
 * Arm the guard. Call exactly once, at preload top level. Returns the sandbox
 * path (or null when no ambient env was set — nothing to guard, CI regime).
 */
export function armCaptureHermeticity(): string | null {
  const ambient = process.env.CLAUDISH_CAPTURE_DIR;
  if (ambient === undefined || ambient === "") return null;

  // Leftovers of killed runs first — before this run creates its own sandbox.
  sweepStaleCaptureSandboxes(tmpdir());

  const sandbox = join(tmpdir(), `${CAPTURE_SANDBOX_PREFIX}${process.pid}-${Date.now()}`);
  process.env.CLAUDISH_CAPTURE_DIR = sandbox;
  armed = { real: ambient, sandbox };

  afterAll(() => {
    // Give a racing finalize a moment, then read once. Bounded, best effort —
    // layer 1 already made the real dir unreachable; this scan only catches a
    // test that re-points the env at the real dir explicitly.
    const leaks = detectOwnPidCaptures(ambient, process.pid);
    // Dispose BEFORE the verdict: a failing run must not leave its sandbox
    // behind either (the check is already in hand, so nothing is lost).
    disposeCaptureSandbox(sandbox);
    if (leaks !== null && leaks.length > 0) {
      // Loud first (a swallowed afterAll throw still leaves this in the log),
      // then the throw, then the exit code as belt and suspenders.
      console.error(
        `[capture-hermeticity] TEST RUN WROTE INTO THE REAL CAPTURE DIR ${ambient}:`,
        leaks,
        "— a test bypassed the sandbox (explicit env re-point or hardcoded path)."
      );
      process.exitCode = 1;
      throw new Error(`capture hermeticity violated: ${leaks.join(", ")} landed in ${ambient}`);
    }
  });

  return sandbox;
}
