/**
 * #538 — FAILED models must carry the error details the MCP report renders.
 *
 * The report block in mcp-server.ts (`formatTeamResult`) reads
 * `m.error.{model, command, stderrSnippet, errorLogPath, workDir}` — but no
 * producer ever attached that field, so failed models were listed with state
 * and exit code only, and the stderr snippet the surrounding text promised
 * never appeared.
 *
 * These tests pin the producer (failureDetails + the runModels finish path)
 * and the renderer (formatTeamResult):
 *  - unit tests run everywhere (they are the red/green pair for this fix);
 *  - the PATH-shim e2e (fake claudish exiting non-zero) runs on POSIX hosts
 *    per the envDescribe convention from team-timeout-repro.test.ts — it is
 *    the mutant killer for "revert the attach in finish()".
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureDetails,
  setupSession,
  runModels,
  type TeamStatus,
  type ModelStatus,
} from "./team-orchestrator.js";
import { formatTeamResult } from "./mcp-server.js";
import { envDescribe } from "./test-support/env-gate";

// ─── Unit: failureDetails (the producer) ─────────────────────────────────────

describe("#538 failureDetails", () => {
  const args = ["--model", "or@deepseek/deepseek-r1", "-y", "--stdin", "--quiet"];

  it("carries the five fields the MCP report renders", () => {
    const d = failureDetails({ model: "or@deepseek/deepseek-r1" }, args, "boom", "/s/errors/01.log", "/s");
    expect(d.model).toBe("or@deepseek/deepseek-r1");
    expect(d.command).toBe("claudish --model or@deepseek/deepseek-r1 -y --stdin --quiet");
    expect(d.stderrSnippet).toBe("boom");
    expect(d.errorLogPath).toBe("/s/errors/01.log");
    expect(d.workDir).toBe("/s");
  });

  it("bounds the stderr snippet (full stderr lives in the log, not in status.json)", () => {
    const long = "x".repeat(5_000);
    const d = failureDetails({ model: "m" }, args, long, "/log", "/s");
    expect(d.stderrSnippet.length).toBeLessThanOrEqual(500);
    expect(d.stderrSnippet).toBe(long.slice(0, 500));
  });

  it("keeps an empty snippet well-formed (failed run with no stderr)", () => {
    const d = failureDetails({ model: "m" }, args, "", "/log", "/s");
    expect(d.stderrSnippet).toBe("");
  });
});

// ─── Unit: formatTeamResult (the renderer) ───────────────────────────────────

describe("#538 formatTeamResult renders failure details", () => {
  const failed: ModelStatus = {
    state: "FAILED",
    exitCode: 3,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:00:05Z",
    outputSize: 0,
    error: {
      model: "or@deepseek/deepseek-r1",
      command: "claudish --model or@deepseek/deepseek-r1 -y --stdin --quiet",
      stderrSnippet: "provider quota exhausted",
      errorLogPath: "/sess/errors/01.log",
      workDir: "/sess",
    },
  };
  const timedOut: ModelStatus = {
    state: "TIMEOUT",
    exitCode: null,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:05:00Z",
    outputSize: 12,
  };
  const ok: ModelStatus = {
    state: "COMPLETED",
    exitCode: 0,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:00:05Z",
    outputSize: 800,
  };

  it("renders model, command, snippet, log path and workDir for a FAILED model", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": failed, "02": ok } };
    const out = formatTeamResult(status, "/sess");
    expect(out).toContain("## Failures Detected");
    expect(out).toContain("or@deepseek/deepseek-r1");
    expect(out).toContain("claudish --model or@deepseek/deepseek-r1");
    expect(out).toContain("provider quota exhausted");
    expect(out).toContain("/sess/errors/01.log");
    expect(out).toContain("- **Working directory:** /sess");
  });

  it("does not crash or invent details for a TIMEOUT without error details", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": timedOut, "02": ok } };
    const out = formatTeamResult(status, "/sess");
    expect(out).toContain("Model 01: TIMEOUT");
    expect(out).not.toContain("**Error output:**");
    expect(out).not.toContain("**Full error log:**");
  });

  it("no failure section when everything completed", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": ok } };
    expect(formatTeamResult(status, "/sess")).not.toContain("## Failures Detected");
  });
});

// ─── E2E (POSIX): the finish() path attaches details on a real spawn ────────

envDescribe(
  {
    id: "posix-path-shim-538",
    active: process.platform !== "win32",
    reason:
      "the fake claudish is a #!/bin/sh script joined into PATH with `:` — it cannot execute on win32 (spawn without shell only resolves .exe)",
    activation: "run on a POSIX host, or port the fake to a claudish.cmd wrapper",
  },
  "#538 runModels attaches error details to FAILED statuses"
)((it) => {
  let tempDir = "";
  let fakeDir = "";

  const makeFailingClaudish = () => {
    fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-fail-"));
    const script = join(fakeDir, "claudish");
    writeFileSync(
      script,
      `#!/bin/sh
# consume stdin (the input prompt)
cat > /dev/null
echo "538-stderr-marker: provider blew up" 1>&2
exit 3
`,
      "utf-8"
    );
    chmodSync(script, 0o755);
  };

  it("REPRO: a non-zero exit attaches error details and writes the error log", async () => {
    makeFailingClaudish();
    tempDir = mkdtempSync(join(tmpdir(), "team-538-"));
    try {
      setupSession(tempDir, ["failing-model"], "Say hello");
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeDir}:${originalPath}`;
      try {
        const status = await runModels(tempDir, { timeout: 10 });
        const m = Object.values(status.models)[0];
        expect(m.state).toBe("FAILED");
        expect(m.exitCode).toBe(3);
        expect(m.error).toBeDefined();
        expect(m.error!.model).toBe("failing-model");
        expect(m.error!.command).toContain("--model failing-model");
        expect(m.error!.stderrSnippet).toContain("538-stderr-marker");
        expect(m.error!.workDir).toBe(process.cwd());
        // The full stderr log exists on disk at the advertised path
        expect(existsSync(m.error!.errorLogPath)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
