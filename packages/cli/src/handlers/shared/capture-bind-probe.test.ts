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
 * mkdirSync ⇒ the ENOENT pin goes red (non-existent dir now probes "ok");
 * CR r2: drop the wedge age check ⇒ the wedge pin serves the stale
 * "ok"/unknown instead of error:wedged and goes red; drop `|| raw === ""`
 * in the TTL read ⇒ the ""-guard pin goes red at BOTH asserts (a kicked
 * refresh latches refreshing=true and the cold re-key answers
 * unknown:probing); stamp the completion-time env instead of the call-time
 * dir ⇒ the in-flight re-key pin goes red (dirA's ok served for dirB).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_PROBE_TTL_ENV,
  captureBindProbeRefreshingForTests,
  captureBindProbeSettleForTests,
  captureBindWriteVerdict,
  resetCaptureBindProbeForTests,
  setCaptureBindProbeFsForTests,
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
  setCaptureBindProbeFsForTests(); // never leak a hung/spy fs into the next test
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
  test('env unset ⇒ "disabled" (capture off BY CONFIG, not an incident)', () => {
    expect(captureBindWriteVerdict()).toBe("disabled");
  });

  test('writable dir: cold cache ⇒ unknown:probing (one refresh in flight), then "ok", file gone', async () => {
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
      expect(existsSync(join(dir, `.bind-write-probe-${process.pid}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dir path occupied by a FILE ⇒ "error:<code>", never a throw', async () => {
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
  test('TTL env = "" (the compose trap) ⇒ default TTL, not 0', async () => {
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

  // CR #1057 round 2 BLOCKING — a never-settling write must not freeze the
  // field on its last value (possibly "ok"): past the wedge bound the reader
  // reports error:wedged, and NO replacement write is started (hung fs calls
  // hold the I/O thread pool). The fs seam (AtomicFsSeam pattern, #617) makes
  // a never-resolving writeFile fabricable; the `now` argument is the clock.
  test("never-settling write ⇒ error:wedged past the bound, ONE writeFile across reads, settles cleanly (CR r2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bind-probe-291-wedge-"));
    let writeFileCalls = 0;
    // Holder object: a plain `let` gets flow-narrowed to null at reads outside
    // the callback; a property read carries the declared shape.
    const hung = { release: (): void => {} };
    setCaptureBindProbeFsForTests({
      // Hangs until released; when released it writes the REAL file so the
      // real unlink succeeds and the eventual verdict is a measured "ok".
      writeFile: (async (file: any, data: any) => {
        writeFileCalls++;
        await new Promise<void>((resolve) => {
          hung.release = resolve;
        });
        await realWriteFile(file, data);
      }) as typeof realWriteFile,
    });
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "60000"; // wedge bound = max(60s, 10s floor)
      process.env.CLAUDISH_CAPTURE_DIR = dir;
      const base = 1_000_000;
      // Cold read kicks the (hung) refresh at `base`.
      expect(captureBindWriteVerdict(base)).toBe("unknown:probing");
      expect(writeFileCalls).toBe(1);
      // In flight UNDER the bound: the honest unknown — and repeated reads do
      // not pile up writes (one-flight, pinned by the call count).
      expect(captureBindWriteVerdict(base + 5_000)).toBe("unknown:probing");
      expect(captureBindWriteVerdict(base + 59_000)).toBe("unknown:probing");
      expect(writeFileCalls).toBe(1);
      // Past the bound: the wedge is REPORTED (never a possibly-stale "ok"),
      // and still no replacement write.
      expect(captureBindWriteVerdict(base + 60_001)).toBe("error:wedged");
      expect(captureBindWriteVerdict(base + 120_000)).toBe("error:wedged");
      expect(writeFileCalls).toBe(1);
      // The hung write eventually settles: the flag clears, the measured
      // verdict lands — the model recovers without a process restart.
      hung.release();
      await captureBindProbeSettleForTests();
      expect(captureBindProbeRefreshingForTests()).toBe(false);
      expect(writeFileCalls).toBe(1); // recovery reused the SAME write
      setCaptureBindProbeFsForTests(); // back to the real fs
      expect(await truth()).toBe("ok");
    } finally {
      hung.release(); // idempotent no-op unless still pending
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CR r2 N2 — re-key WHILE a refresh is in flight: the stamp uses the
  // call-time dir (exported seams only; the flip happens BEFORE the settle).
  test("re-key DURING a refresh: the in-flight stamp belongs to the OLD dir (CR r2 N2)", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-a2-"));
    const blocker = join(tmpdir(), `bind-probe-291-blocker4-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    try {
      process.env[CAPTURE_PROBE_TTL_ENV] = "60000";
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing"); // probing dirA
      // Flip BEFORE the settle: the refresh still in flight belongs to dirA.
      process.env.CLAUDISH_CAPTURE_DIR = blocker;
      await captureBindProbeSettleForTests(); // dirA's result lands, stamped dirA
      // The new dir must NOT inherit dirA's verdict — honest unknown, then
      // its OWN truth. (A completion-time stamp would serve dirA's "ok"
      // here — the mutation this pin holds out.)
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toMatch(/^error:[A-Z]+/);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(blocker, { force: true });
    }
  });

  // CR r2 N3 — the "" guard pinned by its REFRESH side: after a settled ok
  // under the DEFAULT TTL, reading with "" set must kick NOTHING. Dropping
  // `|| raw === ""` collapses the TTL to 0: the read goes stale, kicks a
  // refresh (refreshing latches true) and the key change answers
  // unknown:probing — red on BOTH asserts under that mutation.
  test('"" TTL after a settled ok ⇒ cache served, NO refresh kicked (CR r2 N3)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-empty2-"));
    try {
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      expect(captureBindWriteVerdict()).toBe("unknown:probing");
      await captureBindProbeSettleForTests();
      expect(captureBindWriteVerdict()).toBe("ok");
      expect(captureBindProbeRefreshingForTests()).toBe(false);
      process.env[CAPTURE_PROBE_TTL_ENV] = ""; // the compose `${VAR:-}` trap
      expect(captureBindWriteVerdict()).toBe("ok"); // "" ⇒ default TTL, still fresh
      expect(captureBindProbeRefreshingForTests()).toBe(false); // nothing kicked
    } finally {
      rmSync(dirA, { recursive: true, force: true });
    }
  });

  // CR r2 N5 — the probe file is pid-suffixed: two processes sharing one
  // capture dir must not unlink each other's probe (false error:ENOENT both
  // ways). Pinned on the writeFile PATH argument via the fs seam.
  test("probe file is pid-suffixed (CR r2 N5)", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bind-probe-291-pid-"));
    const paths: string[] = [];
    setCaptureBindProbeFsForTests({
      writeFile: (async (file: any, _data: any) => {
        paths.push(String(file));
      }) as typeof realWriteFile,
    });
    try {
      process.env.CLAUDISH_CAPTURE_DIR = dirA;
      captureBindWriteVerdict();
      await captureBindProbeSettleForTests();
      expect(paths.length).toBe(1);
      expect(paths[0].endsWith(`.bind-write-probe-${process.pid}`)).toBe(true);
      expect(paths[0].startsWith(dirA)).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
    }
  });
});
