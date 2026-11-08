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
 */
import { afterAll } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CAPTURE_SANDBOX_PREFIX = "claudish-test-capture-";

/** The pid-stamped prefix of capture files written by a given process. */
export function captureFilesOfProcess(pid: number): string {
  return `resp-${pid}-`;
}

/**
 * Pure filter, pinned by unit tests: from a directory listing, keep only the
 * capture files this process wrote. Other-pid resp files (a live sidecar
 * sharing the host dir) and unrelated names are noise, not leaks.
 */
export function foreignCaptureFiles(names: string[], pid: number): string[] {
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
  return foreignCaptureFiles(names, pid);
}

/**
 * Arm the guard. Call exactly once, at preload top level. Returns the sandbox
 * path (or null when no ambient env was set — nothing to guard, CI regime).
 */
export function armCaptureHermeticity(): string | null {
  const ambient = process.env.CLAUDISH_CAPTURE_DIR;
  if (ambient === undefined || ambient === "") return null;

  const sandbox = join(tmpdir(), `${CAPTURE_SANDBOX_PREFIX}${process.pid}-${Date.now()}`);
  process.env.CLAUDISH_CAPTURE_DIR = sandbox;
  // For tests that must assert the swap happened (sandbox value ≠ ambient).
  process.env.CLAUDISH_TEST_CAPTURE_REAL = ambient;
  process.env.CLAUDISH_TEST_CAPTURE_SANDBOX = sandbox;

  afterAll(() => {
    // Give a racing finalize a moment, then read once. Bounded, best effort —
    // layer 1 already made the real dir unreachable; this scan only catches a
    // test that re-points the env at the real dir explicitly.
    const leaks = detectOwnPidCaptures(ambient, process.pid);
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
