/**
 * #567 — pin the CLAUDISH_CHANNEL_TRACE gate: OFF writes nothing.
 *
 * `docs/reference/channel-mode.md` promises "Off by default, zero production
 * overhead". Nothing pinned it: no test covered the trace mechanism at all,
 * so a regression that always-on'd the trace (or wrote the file mirror while
 * the flag was unset) would pass every CI run while adding prod I/O and
 * persisting session content on every fleet seat.
 *
 * The dangerous shape is not "no env at all" (nothing tells the code where to
 * write) — it is `CLAUDISH_CHANNEL_TRACE_FILE` set while `CLAUDISH_CHANNEL_TRACE`
 * is absent: a leftover path in an operator's shell must stay a dead letter.
 *
 * Two cases, same spawn harness as channel-wire-format.test.ts:
 *   1. OFF pin  — TRACE absent, TRACE_FILE pointed at a fresh tmpdir path;
 *                 after a full fake session the file must NOT exist.
 *   2. ON control — same spawn with TRACE=1: the file must exist and hold
 *                 `[channel-trace]` records. Proves case 1 is a real gate,
 *                 not a harness blind spot (mutation discipline: remove the
 *                 `traceEnabled()` guards in diagnostics.ts -> case 1 fails).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";

// #175 — spawn the CURRENT runtime, never a bare "bun" (npm shim has no .exe
// for CreateProcess). Same trick as channel-wire-format.test.ts.
const BUN = process.execPath;
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");
const FAKE_CLAUDISH_TS = join(__dirname, "test-helpers", "fake-claudish.ts");

let shimDir: string;
const ORIGINAL_PATH = process.env.PATH ?? "";

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "claudish-shim-trace-"));
  if (process.platform === "win32") {
    // win32: spawn(shell:false) resolves .cmd only; re-exec the same bun.
    writeFileSync(
      join(shimDir, "claudish.cmd"),
      `@echo off\r\n"${BUN}" run "${FAKE_CLAUDISH_TS}" %*\r\n`
    );
  } else {
    const shimPath = join(shimDir, "claudish");
    writeFileSync(
      shimPath,
      `#!/bin/sh\nexec bun run "${FAKE_CLAUDISH_TS}" "$@"\n`,
      { mode: 0o755 }
    );
  }
  process.env.PATH = `${shimDir}${delimiter}${ORIGINAL_PATH}`;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (shimDir) {
    try {
      rmSync(shimDir, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * Spawn the MCP server, run one create_session -> terminal, and return the
 * child env used. `trace` absent means the variable is DELETED, not "0" —
 * absence is the production shape.
 */
async function runFakeSession(opts: {
  traceFile: string;
  trace: boolean;
}): Promise<{ stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDISH_MCP_TOOLS: "all",
    CLAUDISH_CHANNEL_TRACE_FILE: opts.traceFile,
  };
  if (opts.trace) {
    env.CLAUDISH_CHANNEL_TRACE = "1";
  } else {
    delete env.CLAUDISH_CHANNEL_TRACE;
  }

  const proc: ChildProcess = spawn(BUN, ["run", SERVER_ENTRY, "--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  let terminalSeen = false;
  proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const evt = msg?.params?.meta?.event;
        if (evt === "completed" || evt === "failed" || evt === "cancelled") {
          terminalSeen = true;
        }
      } catch {
        // not JSON, ignore
      }
    }
  });

  const send = (rpc: object) => proc.stdin!.write(JSON.stringify(rpc) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "trace-gate-test", version: "1.0.0" },
      capabilities: { experimental: { "claude/channel": {} } },
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 100));
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_session",
      arguments: {
        model: "fake-model",
        prompt: "ignored",
        timeout_seconds: 10,
        claudish_flags: ["--lines", "2"],
      },
    },
  });

  // Wait for the terminal event or a bounded timeout, same as wire-format.
  const deadline = Date.now() + 15_000;
  while (!terminalSeen && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 200));

  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.on("exit", () => r()));
  return { stderr };
}

describe("#567 trace gate", () => {
  test(
    "OFF: a pointed TRACE_FILE stays a dead letter when CLAUDISH_CHANNEL_TRACE is absent",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "claudish-trace-off-"));
      const traceFile = join(dir, "trace.log");
      try {
        const { stderr } = await runFakeSession({ traceFile, trace: false });
        // The session ran (a shim-served fake reaches a terminal event); the
        // trace file is the only thing that must not have happened.
        expect(existsSync(traceFile)).toBe(false);
        // And no trace records leaked to stderr either.
        expect(stderr).not.toContain("[channel-trace]");
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    },
    30_000
  );

  test(
    "ON control: with CLAUDISH_CHANNEL_TRACE=1 the same spawn writes [channel-trace] records",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "claudish-trace-on-"));
      const traceFile = join(dir, "trace.log");
      try {
        await runFakeSession({ traceFile, trace: true });
        expect(existsSync(traceFile)).toBe(true);
        const content = readFileSync(traceFile, "utf-8");
        expect(content).toContain("[channel-trace]");
        // The wire tap announces itself at startup; at least one state-change
        // or wire record must follow a full session.
        expect(content.length).toBeGreaterThan(20);
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    },
    30_000
  );
});