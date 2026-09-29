/**
 * #255 — the die-side `activeStreams` line, and the wiring that makes it real.
 *
 * The unit half pins the contract the issue exists for: the count reaches
 * STDERR at the die, because Node writes stderr synchronously and the line
 * must survive the `process.exit()` that immediately follows (stdout on a
 * pipe can still hold an unflushed buffer — the docker logs of a dying
 * container are exactly that).
 *
 * The structural half pins the wiring, not the intention. `gracefulExit`
 * lives in standalone-proxy.ts as a top-level script body: importing it in a
 * test starts a real proxy, so the emit sites are pinned from the source,
 * the same way tool-choice-mapping.test.ts pins that there is ONE mapping.
 * Removing the emit at either exit site, or the `getActiveStreams` exposure
 * in proxy-server.ts, turns a test red.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitShutdownDieLine } from "./shutdown-die-log.js";

const LINE = /^\[Shutdown\] die=(graceful|forced) activeStreams=\d+\n$/;

describe("emitShutdownDieLine unit", () => {
  test("writes the exact greppable shape to stderr", () => {
    const errWrites: string[] = [];
    const outWrites: string[] = [];
    const origErr = process.stderr.write;
    const origOut = process.stdout.write;
    (process.stderr.write as unknown) = ((s: unknown) => {
      errWrites.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    (process.stdout.write as unknown) = ((s: unknown) => {
      outWrites.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      emitShutdownDieLine("graceful", 0);
      emitShutdownDieLine("forced", 5);
    } finally {
      (process.stderr.write as unknown) = origErr;
      (process.stdout.write as unknown) = origOut;
    }
    expect(errWrites).toHaveLength(2);
    expect(errWrites[0]).toMatch(LINE);
    expect(errWrites[0]).toBe("[Shutdown] die=graceful activeStreams=0\n");
    expect(errWrites[1]).toBe("[Shutdown] die=forced activeStreams=5\n");
    // The channel IS the property: stdout is the buffer that dies with the pipe.
    expect(outWrites).toHaveLength(0);
  });
});

describe("emitShutdownDieLine wiring (structural)", () => {
  const src = readFileSync(join(import.meta.dir, "standalone-proxy.ts"), "utf8");
  const start = src.indexOf("const gracefulExit");
  const end = src.indexOf("// Keep process alive");
  const body = start !== -1 && end > start ? src.slice(start, end) : "";

  test("gracefulExit was found in the source (instrument liveness)", () => {
    // If this fails the extraction above silently matched nothing, and the
    // exit-site test below would be vacuously green.
    expect(body).toContain("await server.shutdown()");
  });

  test("every exit site in gracefulExit emits the die line first", () => {
    const lines = body.split("\n");
    const sites: number[] = [];
    lines.forEach((l, i) => {
      if (l.includes("process.exit(0)")) sites.push(i);
    });
    expect(sites.length).toBe(2); // the forced branch and the graceful path
    for (const i of sites) {
      const window = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
      expect(window).toContain("emitShutdownDieLine(");
    }
  });

  test("the server object exposes getActiveStreams to the SIGTERM path", () => {
    const proxySrc = readFileSync(join(import.meta.dir, "..", "..", "proxy-server.ts"), "utf8");
    // Non-vacuous read: the return block we pin is the real one.
    expect(proxySrc).toContain("shutdown: async () => {");
    expect(proxySrc).toMatch(/getActiveStreams:\s*\(\)\s*=>\s*streamTracker\.getActiveStreams\(\)/);
  });
});
