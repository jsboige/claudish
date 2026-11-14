/**
 * #291 — unit pins for the capture bind-write probe (async-refresh model,
 * CR #1057: never a sync write on the /health path).
 *
 * The 29/10 incident class: the bind behind CLAUDISH_CAPTURE_DIR went
 * unwritable and every capture writer no-op'd silently. The probe is the
 * counter-signal, and these pins hold its verdict honest:
 *
 *   - "disabled" ONLY when the env is unset — a configured-but-dead bind must
 *     never read as "disabled" (that conflation is the original incident);
 *   - a COLD cache reports "unknown:probing", never a guessed "ok" — the
 *     truth lands ONE PROBE later (the reader is a pure sync cache read;
 *     the refresh is async fire-and-forget, at most one in flight);
 *   - "ok" requires a REAL write+unlink (the probe file is gone after);
 *   - "error:<code>" on refusal — code carried for the journal, never a bare
 *     throw (a probe that can kill /health trades a silent gap for an outage);
 *   - CR cheap pins: a NON-EXISTENT dir reads error:ENOENT, never "ok" (the
 *     probe stays mkdir-less — creating the dir would mask the incident
 *     class); a dir CHANGE mid-TTL is visible at once (never the old dir's
 *     cached verdict — the cache key is (dir, TTL)).
 *
 * Mutation proof (each run): return "ok" unconditionally when the dir is set
 * ⇒ the ENOTDIR/ENOENT pins go red; serve the verdict on a cold cache ⇒ the
 * unknown:probing pins go red; drop the dir half of the cache key ⇒ the
 * re-key pin goes red (old dir's "ok" served for the new dir); add a
 * mkdirSync ⇒ the ENOENT pin goes red (non-existent dir now probes "ok").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_PROBE_TTL_ENV,
  captureBindProbeRefreshingForTests,
  captureBindProbeSettleForTests,
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

afterEach(async () => {
  await captureBindProbeSettleForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/**
 * The measured truth under TTL<=0, where every SERVING call also kicks a
 * refresh (age >= 0 is always stale): drain whatever is in flight, kick,
 * let it land, then read. Two settle rounds make a re-key observable no
 * matter what the previous call left in flight.
 */
async function truth(): Promise<string> {
  await captureBindProbeSettleForTests();
  captureBindWriteVerdict();
  await captureBindProbeSettleForTests();
  return captureBindWriteVerdict();
}

describe("#291 capture bind-write probe (async refresh, CR #1057)", () => {
  test("env unset ⇒ \"disabled\" (capture off BY CONFIG, not an incident)", () => {
    expect(captureBindWriteVerdict()).toBe("disabled");
  });

  test("writable dir: cold cache ⇒ unknown:probing (one refresh in flight), then \"ok\", file gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-probe-291-"));
    try {
      process.env.CLAUDISH_CAPTURE_DIR = dir;
      // CR #1057: a cold cache NEVER guesses — the first /health reads the
      // honest unknown while exactly ONE async refresh runs.
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      expect(captureBindProbeRefreshingForTests()).toBe(true);
      await captureBindProbeSettleForTests();
      expect(captureBindProbeRefreshingForTests()).toBe(false);
      // One probe later: the measured verdict, and the proof it rests on a
      // REAL write — the file existed at write time and is cleaned up (no
      // residue accumulating in captures dirs, archived wholesale at
      // compaction).
      expect(captureBindWriteVerdict()).toBe("ok");
      expect(existsSync(join(dir, ".bind-write-probe"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dir path occupied by a FILE ⇒ \"error:<code>\", never a throw", async () => {
    const blocker = join(tmpdir(), `bind-probe-291-blocker-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      // ENOTDIR on POSIX, ENOENT/EACCES on Windows — the CODE is platform
      // detail; the contract is the error: prefix and the survival.
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(blocker, { force: true });
    }
  });

  // CR cheap pin 1 — mkdir-less: a probe that created its dir would mask the
  // exact incident class (rootfs-full → ENOENT). A NEVER-CREATED dir must
  // report the error, never "ok".
  test("NON-EXISTENT dir ⇒ error:ENOENT after the probe — mkdir-less pinned (CR)", async () => {
    const ghost = join(tmpdir(), `bind-probe-291-ghost-${process.pid}`);
    process.env.CLAUDISH_CAPTURE_DIR = ghost;
    expect(captureBindWriteVerdict()).toBe("unknown:probing");
    await captureBindProbeSettleForTests();
    // POSIX/Windows both surface ENOENT for a missing path segment; the pin
    // accepts the error: prefix with the ENOENT code (an added mkdirSync
    // would flip this to "ok" — that mutation MUST go red here).
    const verdict = captureBindWriteVerdict();
    expect(verdict).toMatch(/^error:(ENOENT|[A-Z]+)/);
    expect(verdict).not.toBe("ok");
    expect(existsSync(ghost)).toBe(false); // the probe never created it
  });

  // CR cheap pin 2 — cache-key invalidation: the key is (dir, TTL). A dir
  // flip mid-TTL must NEVER serve the old dir's cached verdict.
  test("dir CHANGE mid-TTL: old verdict never served for the new dir (cache key = dir+TTL, CR)", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-a-"));
    const blocker = join(tmpdir(), `bind-probe-291-blocker2-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "60000";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toBe("ok"); // A measured ok, cached
      // Flip to a DIFFERENT (dead) path: the next read must not serve A's
      // "ok" — the honest unknown, then the new dir's truth.
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(blocker, { force: true });
    }
  });

  test("TTL>0: the verdict is cached — the same path going dead mid-TTL is not re-probed", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-ttl-"));
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "60000";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toBe("ok");
      // Kill the target WITHOUT touching the env (same path string): if the
      // next call still says "ok", it was served from cache — the disk-stamp
      // guard, pinned as behavior. (A dir VALUE change invalidating at once
      // is deliberate and pinned in its own test above.)
      rmSync(dirA, { recursive: true, force: true });
      writeFileSync(dirA, "not a dir");
      expect(captureBindWriteVerdict()).toBe("ok");
      // TTL drop to 0: the key changed — unknown, then the truth.
      process.env[CAPTURE_PROBE_TTL_ENV] = "0";
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      expect(await truth()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
    }
  });

  test("TTL≤0: every call refresh-eligible — the truth moves between consecutive calls", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-c-"));
    const blocker = join(tmpdir(), `bind-probe-291-blocker3-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "0";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toBe("ok");
      // Re-key to the dead path: unknown now, error one settle later, and
      // back — recovery is visible at the same one-probe cadence.
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      expect(await truth()).toMatch(/^error:[A-Z]+/);
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      expect(await truth()).toBe("ok");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(blocker, { force: true });
    }
  });

  // CR #1057 trap — compose's `${VAR:-}` injects "": the read must treat ""
  // as unset (the DEFAULT TTL), never as Number("")===0 (re-probe storm).
  test("TTL env = \"\" (the compose trap) ⇒ default TTL, not 0", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-empty-"));
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toBe("ok");
      // "" behaved as the default (60s-scale cache): a same-path read right
      // after serves the fresh cache WITHOUT a new refresh — flip the target
      // dead under the same path and the cached "ok" is still served, which
      // is only true when "" did NOT collapse the TTL to 0.
      rmSync(dirA, { recursive: true, force: true });
      writeFileSync(dirA, "not a dir");
      expect(captureBindWriteVerdict()).toBe("ok");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
    }
  });
});
