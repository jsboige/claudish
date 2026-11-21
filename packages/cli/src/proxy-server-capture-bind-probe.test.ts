/**
 * #291 — route-level pin: /health carries the capture bind-write verdict.
 *
 * The unit pins (capture-bind-probe.test.ts) hold the probe's own contract;
 * THIS file holds the wiring — the 29/10 incident was invisible precisely
 * because the signal existed nowhere an operator looks, and /health is where
 * the watchdog and the relay heartbeat already read. A probe that works but
 * is not on /health is the incident again.
 *
 * Drives the REAL proxy in-process (createProxyServer on a loopback port,
 * same harness contract as proxy-server-routing-error.test.ts). /health is
 * not gated and makes no upstream call, so no auth fixture and no stubbed
 * fetch — the file asserts only the JSON it gets.
 *
 * Mutation proof: delete the `captureBindWrite:` line in the /health handler
 * ⇒ both tests go red while every unit pin stays green (the probe itself is
 * fine; the wiring is what this file defends).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { REVISION, VERSION } from "./version.js";
import {
  CAPTURE_PROBE_TTL_ENV,
  captureBindProbeSettleForTests,
  resetCaptureBindProbeForTests,
} from "./handlers/shared/capture-bind-probe.js";
import type { ProxyServer } from "./types.js";

// One allocation per file; the scan in test-support/port-allocation.test.ts
// is the authority on what is already claimed.
const PROXY_PORT = 20151;

const KEYS = ["CLAUDISH_CAPTURE_DIR", CAPTURE_PROBE_TTL_ENV] as const;
const saved: Record<string, string | undefined> = {};
let activeProxy: ProxyServer | null = null;
const scratch: string[] = [];

beforeEach(() => {
  resetCaptureBindProbeForTests();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Immediacy for the route: each /health GET must probe the dir it sees NOW.
  process.env[CAPTURE_PROBE_TTL_ENV] = "0";
});

afterEach(async () => {
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

async function health(): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("#291 /health carries captureBindWrite", () => {
  // CR #1057 — async model: a COLD cache answers "unknown:probing" on the
  // first /health (never a guessed verdict, never a sync write on the path),
  // and the REAL verdict lands one probe later.
  test("capture on, writable bind: cold ⇒ unknown:probing, real \"ok\" one probe later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "route-291-"));
    scratch.push(dir);
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    activeProxy = await createProxyServer(PROXY_PORT, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    const first = await health();
    expect(first.captureBindWrite).toBe("unknown:probing");
    await captureBindProbeSettleForTests();
    const second = await health();
    expect(second.captureBindWrite).toBe("ok");
  });

  test("capture on, dead bind ⇒ \"error:<code>\" — and /health still 200", async () => {
    // A FILE where the dir should be: deterministic ENOTDIR/ENOENT on every
    // platform, no ACL games. The point is not the code — it is that the
    // endpoint SURFACES the refusal instead of no-op'ing silently. Same
    // one-probe cadence as above.
    const blocker = join(tmpdir(), `route-291-blocker-${process.pid}`);
    writeFileSync(blocker, "not a dir");
    scratch.push(blocker);
    process.env.CLAUDISH_CAPTURE_DIR = blocker;
    activeProxy = await createProxyServer(PROXY_PORT, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    const first = await health();
    expect(first.captureBindWrite).toBe("unknown:probing");
    await captureBindProbeSettleForTests();
    const second = await health();
    expect(second.captureBindWrite).toMatch(/^error:[A-Z]+/);
  });
});

// #1140 — /health names the running build. The fleet-rollout verification
// rule demands an artifact read from the LIVE path; before this field, a
// verification could say WHAT it probed (status, gauges) but not WHICH code
// answered — an artifact about intent, not about the fleet. The pin compares
// the field against the very constant the release bumps (version.ts is
// generated in lockstep with packages/cli/package.json), so a stale deploy
// (container still on the previous image) reads as a version mismatch, not
// as a passing probe.
//
// Mutation proof: delete the `version: VERSION,` line in the /health handler
// ⇒ this test goes red (the wiring, not the constant, is what breaks —
// version.ts has its own generate-script contract).
describe("#1140 /health carries the running build version", () => {
  test("version field === VERSION from version.ts (additive, nothing gates on it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "route-1140-"));
    scratch.push(dir);
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    activeProxy = await createProxyServer(PROXY_PORT, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    const h = await health();
    expect(h.version).toBe(VERSION);
    // #1140 r2 — VERSION cannot name a build on this fork (no release bumps),
    // so /health also carries the image's git revision, baked at BUILD time by
    // generate-version.ts from the Dockerfile's CLAUDISH_REVISION arg. In this
    // unit run the arg is absent ⇒ the generator's documented fallback.
    expect(h.revision).toBe(REVISION);
    expect(typeof h.revision).toBe("string");
    expect(h.revision.length).toBeGreaterThan(0);
  });
});
