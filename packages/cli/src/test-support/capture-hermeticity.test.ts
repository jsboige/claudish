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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_SANDBOX_PREFIX,
  captureFilesOfProcess,
  detectOwnPidCaptures,
  foreignCaptureFiles,
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
    expect(foreignCaptureFiles(names, pid)).toHaveLength(2);
  });

  test("a live sidecar sharing the host dir (other pid) is NOT a leak", () => {
    // Container pids are small; the host test pid is large — but the filter
    // must not care about magnitude, only identity.
    const names = [
      "resp-12-r0000-2026-11-08T06-30-00-000Z-openai-glm-5.3.sse",
      `resp-${pid + 1}-r0000-2026-11-08T06-30-00-000Z-openai-glm-5.3.sse`,
    ];
    expect(foreignCaptureFiles(names, pid)).toHaveLength(0);
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
    expect(foreignCaptureFiles(names, pid)).toHaveLength(0);
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
    const real = process.env.CLAUDISH_TEST_CAPTURE_REAL;
    const sandbox = process.env.CLAUDISH_TEST_CAPTURE_SANDBOX;
    if (real !== undefined) {
      // Seat regime: the swap happened at preload time, and no test since
      // then left the env pointing anywhere but the sandbox.
      expect(sandbox).toBeDefined();
      expect(sandbox).toContain(CAPTURE_SANDBOX_PREFIX);
      expect(process.env.CLAUDISH_CAPTURE_DIR).toBe(sandbox);
      expect(sandbox).not.toBe(real);
    } else {
      // CI regime: nothing to guard.
      expect(sandbox).toBeUndefined();
    }
  });
});
