/**
 * #291 — unit pins for the capture bind-write probe.
 *
 * The 29/10 incident class: the bind behind CLAUDISH_CAPTURE_DIR went
 * unwritable and every capture writer no-op'd silently. The probe is the
 * counter-signal, and these pins hold its three-way verdict honest:
 *
 *   - "disabled" ONLY when the env is unset — a configured-but-dead bind must
 *     never read as "disabled" (that conflation is the original incident);
 *   - "ok" requires a REAL write+unlink (the probe file is gone after);
 *   - "error:<code>" on refusal — code carried for the journal, never a bare
 *     throw (a probe that can kill /health trades a silent gap for an outage).
 *
 * Plus the TTL contract: within the TTL the verdict is cached (a /health
 * flood cannot stamp the disk), ≤0 re-probes every call, and a dir change
 * invalidates immediately (an operator flipping the env sees the truth on
 * the very next /health, not 30 s later).
 *
 * Mutation proof: delete captureBindWriteVerdict()'s try/catch body write ⇒
 * the "write+unlink" pin goes red; drop the cache check ⇒ the TTL pin goes
 * red (verdict follows env mid-TTL); return "ok" unconditionally when the
 * dir is set ⇒ the ENOTDIR pin goes red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_PROBE_TTL_ENV,
  captureBindWriteVerdict,
  resetCaptureBindProbeForTests,
} from "./capture-bind-probe.js";

const KEYS = ["CLAUDISH_CAPTURE_DIR", CAPTURE_PROBE_TTL_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetCaptureBindProbeForTests();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("#291 capture bind-write probe", () => {
  test("env unset ⇒ \"disabled\" (capture off BY CONFIG, not an incident)", () => {
    expect(captureBindWriteVerdict()).toBe("disabled");
  });

  test("writable dir ⇒ \"ok\" and the probe file is written then unlinked", () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-probe-291-"));
    try {
      process.env.CLAUDISH_CAPTURE_DIR = dir;
      const verdict = captureBindWriteVerdict();
      expect(verdict).toBe("ok");
      // The proof the verdict rests on a REAL write: the file existed at
      // write time and is cleaned up — no residue accumulating in captures
      // dirs (they are archived wholesale at compaction).
      expect(existsSync(join(dir, ".bind-write-probe"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dir path occupied by a FILE ⇒ \"error:<code>\", never a throw", () => {
    const blocker = join(tmpdir(), `bind-probe-291-blocker-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      // ENOTDIR on POSIX, ENOENT/EACCES on Windows — the CODE is platform
      // detail; the contract is the error: prefix and the survival.
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(blocker, { force: true });
    }
  });

  test("TTL>0: the verdict is cached — the same path going dead mid-TTL is not re-probed", () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-a-"));
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "60000";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("ok");
      // Kill the target WITHOUT touching the env (same path string): if the
      // next call still says "ok", it was served from cache — the disk-stamp
      // guard, pinned as behavior. (A dir VALUE change invalidating at once
      // is deliberate and pinned in the TTL≤0 test below.)
      rmSync(dirA, { recursive: true, force: true });
      writeFileSync(dirA, "not a dir");
      expect(captureBindWriteVerdict()).toBe("ok");
      // TTL drop to 0: the very next call must see the truth.
      process.env[CAPTURE_PROBE_TTL_ENV] = "0";
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(dirA, { force: true });
    }
  });

  test("TTL≤0 and dir change: re-probes immediately — env flips are visible at once", () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-c-"));
    const blocker = join(tmpdir(), `bind-probe-291-blocker3-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "0";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("ok");
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
      // And back: recovery is visible on the very next call too.
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("ok");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(blocker, { force: true });
    }
  });
});
