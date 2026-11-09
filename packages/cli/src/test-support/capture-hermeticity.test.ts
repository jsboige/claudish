/**
 * Pins for the capture hermeticity guard (armed by test-preload.ts).
 *
 * The wiring itself is pinned by regime: when this run was launched with an
 * ambient CLAUDISH_CAPTURE_DIR (a seat's developer shell — the exact leak
 * scenario of 2026-11-08), the preload must have swapped it for the sandbox
 * BEFORE any test could inherit it; on CI the ambient env is unset and the
 * guard is inert by design, so the pin asserts the inert regime instead.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_SANDBOX_PREFIX,
  captureFilesOfProcess,
  captureRegime,
  detectOwnPidCaptures,
  disposeCaptureSandbox,
  ownPidCaptureFiles,
  sweepStaleCaptureSandboxes,
} from "./capture-hermeticity";

describe("capture hermeticity — pid attribution (filter)", () => {
  const pid = 424242;

  test("captureFilesOfProcess embeds the pid in the resp- prefix", () => {
    expect(captureFilesOfProcess(pid)).toBe("resp-424242-");
  });

  test("this process's capture files are leaks", () => {
    const names = [
      `resp-${pid}-r0000-2026-11-08T06-31-04-212Z-native-claude-stub-opus.sse`,
      `resp-${pid}-r0001-2026-11-08T06-31-04-216Z-native-claude-stub-opus.sse`,
    ];
    expect(ownPidCaptureFiles(names, pid)).toHaveLength(2);
  });

  test("a live sidecar sharing the host dir (other pid) is NOT a leak", () => {
    // Container pids are small; the host test pid is large — but the filter
    // must not care about magnitude, only identity.
    const names = [
      "resp-12-r0000-2026-11-08T06-30-00-000Z-openai-glm-5.3.sse",
      `resp-${pid + 1}-r0000-2026-11-08T06-30-00-000Z-openai-glm-5.3.sse`,
    ];
    expect(ownPidCaptureFiles(names, pid)).toHaveLength(0);
  });

  test("non-capture names and non-sse pid files are not leaks", () => {
    // The shared append-only logs carry no pid and are deliberately not
    // guessed at (sidecar appends concurrently into the same host dir).
    const names = [
      "upstream-errors.log",
      "connection-errors.log",
      `resp-${pid}-r0000-2026-11-08T06-31-04-212Z.sse.tmp`,
      "notes.txt",
    ];
    expect(ownPidCaptureFiles(names, pid)).toHaveLength(0);
  });
});

describe("capture hermeticity — detection scan", () => {
  test("a missing/unreadable dir is NOT a verdict (null, never a fail)", () => {
    expect(detectOwnPidCaptures(join(tmpdir(), "claudish-no-such-dir-xyz"), 1)).toBeNull();
  });

  test("a planted resp-<pid> file in a real tmp dir is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-herm-pin-"));
    try {
      writeFileSync(
        join(dir, `resp-${process.pid}-r0000-2026-11-08T06-31-04-212Z-openai-fugu-ultra.sse`),
        "x"
      );
      writeFileSync(join(dir, "resp-999-r0000-2026-11-08T06-31-04-212Z-openai-glm-5.3.sse"), "x");
      const found = detectOwnPidCaptures(dir, process.pid);
      expect(found).toHaveLength(1);
      expect(found![0]).toContain(`resp-${process.pid}-`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty dir scans clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-herm-pin-"));
    try {
      expect(detectOwnPidCaptures(dir, process.pid)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capture hermeticity — preload wiring (regime pin)", () => {
  test("ambient set ⇒ swapped to the sandbox before any test ran; unset ⇒ inert", () => {
    const regime = captureRegime();
    if (regime !== null) {
      // Seat regime: the swap happened at preload time, and no test since
      // then left the env pointing anywhere but the sandbox.
      expect(regime.sandbox).toContain(CAPTURE_SANDBOX_PREFIX);
      expect(process.env.CLAUDISH_CAPTURE_DIR).toBe(regime.sandbox);
      expect(regime.sandbox).not.toBe(regime.real);
    } else {
      // CI regime: nothing to guard, and nothing swapped.
      const current = process.env.CLAUDISH_CAPTURE_DIR;
      expect(current === undefined || !current.includes(CAPTURE_SANDBOX_PREFIX)).toBe(true);
    }
  });
});

/**
 * Review B1 on #936: the run that fills the sandbox is precisely the leaky run
 * the guard exists for — leaving it in %TEMP% grows unbounded on a seat that
 * runs the suite a few times a day (measured: 289 files in one run of a
 * non-isolated composed-handler.test.ts).
 */
describe("capture hermeticity — sandbox disposal", () => {
  test("a run that filled its sandbox leaves nothing behind after cleanup", () => {
    const sandbox = join(tmpdir(), `${CAPTURE_SANDBOX_PREFIX}${process.pid}-${Date.now()}-pin`);
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(
      join(sandbox, `resp-${process.pid}-r0000-2026-11-08T06-31-04-212Z-openai-fugu-ultra.sse`),
      "x"
    );
    // The pid-less append-only log lands there too — the dir goes, all of it.
    writeFileSync(join(sandbox, "upstream-errors.log"), "x");
    expect(readdirSync(sandbox)).toHaveLength(2);

    disposeCaptureSandbox(sandbox);

    expect(existsSync(sandbox)).toBe(false);
  });

  test("dispose is idempotent — a missing dir is a no-op, never a throw", () => {
    const absent = join(tmpdir(), `${CAPTURE_SANDBOX_PREFIX}no-such-dir-pin`);
    expect(() => disposeCaptureSandbox(absent)).not.toThrow();
  });
});

/** A killed run never reaches its afterAll: the preload-start sweep is its net. */
describe("capture hermeticity — stale-sandbox sweep", () => {
  test("an old sandbox is swept; a fresh one and unrelated names are spared", () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-herm-pin-"));
    try {
      const oldName = `${CAPTURE_SANDBOX_PREFIX}111-1700000000000`;
      const freshName = `${CAPTURE_SANDBOX_PREFIX}222-${Date.now()}`;
      const otherName = "claudish-test-home-pin";
      for (const n of [oldName, freshName, otherName])
        mkdirSync(join(root, n), { recursive: true });
      const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
      utimesSync(join(root, oldName), old, old);

      const removed = sweepStaleCaptureSandboxes(root);

      expect(removed).toEqual([oldName]);
      expect(existsSync(join(root, oldName))).toBe(false);
      // A run still in flight must never be a target, and the home sandbox
      // has its own (24 h) sweep — this one does not touch it.
      expect(existsSync(join(root, freshName))).toBe(true);
      expect(existsSync(join(root, otherName))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable/missing root is not a failure", () => {
    expect(sweepStaleCaptureSandboxes(join(tmpdir(), "claudish-no-such-root-xyz"))).toEqual([]);
  });
});
