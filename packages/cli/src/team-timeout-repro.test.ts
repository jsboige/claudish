/**
 * Session-directory overwrite protection (originally the "Bug #3" arm of
 * main's team-timeout repro) + the written disposition for the arms that do
 * not re-port to replatform/v14.
 *
 * #1054 CR B5 / 10/11 step-6 disposition ("keep: re-add explicitly"): this
 * file returns, in the v14 shape. What that means, arm by arm:
 *
 * - Bug #3 (setupSession overwrite protection) — RE-PORTED AS-IS. The
 *   surface is live v14 code (`team-orchestrator.ts` `setupSession`), the
 *   three pins run green unmodified.
 * - Bug #1 (TIMEOUT-despite-completion race) and Bug #2 (statSync byte
 *   counter) — DO NOT RE-PORT, and the reason is architectural, not
 *   neglect: v14's orchestrator has no timeout handler for the race to
 *   happen in. The blocking deadline was deliberately removed (D9 —
 *   enforcing it killed three productive slots in session
 *   team-20260827-0015; `startModels` returns once each slot has left
 *   STARTING and the caller polls). The panes are interactive sessions
 *   whose answers land in `response-{ID}.md` at terminal transition, so
 *   there is no stdout byte-counter site to under-report either. On top of
 *   which `checkChildFlags` refuses value-carrying flags (`--bytes 65536`
 *   → invalid_args), so main's harness shapes cannot even boot here.
 *   When a v14-side deadline/byte-counter surface ever appears, these
 *   repros are the first thing to re-port against it.
 *
 * Run: bun test packages/cli/src/team-timeout-repro.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSession } from "./team-orchestrator.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "team-timeout-repro-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort; the OS tmpdir cleanup owns the rest
    }
  }
});

describe("Bug #3: Session directory overwrite protection", () => {
  it("REPRO: setupSession rejects existing session directory", () => {
    // First setup succeeds
    setupSession(tempDir, ["model-a"], "First run input");

    // Second setup on same dir should throw — manifest.json already exists
    expect(() => setupSession(tempDir, ["model-b"], "Second run input")).toThrow(
      /Session already exists/
    );
  });

  it("REPRO: session artifacts are preserved when re-run is rejected", () => {
    setupSession(tempDir, ["model-a"], "First run input");

    // Capture original file contents that setupSession actually writes
    const originalManifest = readFileSync(join(tempDir, "manifest.json"), "utf-8");
    const originalInput = readFileSync(join(tempDir, "input.md"), "utf-8");
    const originalStatus = readFileSync(join(tempDir, "status.json"), "utf-8");

    // Re-run attempt should fail
    expect(() => setupSession(tempDir, ["model-b"], "DIFFERENT input")).toThrow();

    // All session artifacts must be byte-for-byte unchanged
    expect(readFileSync(join(tempDir, "manifest.json"), "utf-8")).toBe(originalManifest);
    expect(readFileSync(join(tempDir, "input.md"), "utf-8")).toBe(originalInput);
    expect(readFileSync(join(tempDir, "status.json"), "utf-8")).toBe(originalStatus);
  });

  it("REPRO: fresh directory works fine", () => {
    // First call on a fresh dir should not throw
    expect(() => setupSession(tempDir, ["model-a", "model-b"], "Task")).not.toThrow();
  });
});
