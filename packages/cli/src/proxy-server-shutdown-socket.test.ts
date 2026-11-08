/**
 * #630 — `shutdown()` must not wait for a client that cannot receive anything.
 *
 * `server.close()` drops the listening socket immediately, then waits for every
 * connection to END. A half-written request — the shape an agent killed
 * mid-turn leaves behind — never completes, so it is invisible to the stream
 * tracker, yet it holds `close()` open until the kernel or the client gives up.
 * Measured 2026-10-24 on hub po-2025: `shutdown()` resolved at 3046 ms, exactly
 * when the client destroyed its own socket, and a throwaway container carrying
 * one such request took 21 401 ms to stop against 482 ms with no client. With
 * `stop_grace_period: 120s` that is up to two minutes of hub downtime per
 * recreate.
 *
 * THE RULE THIS FILE PINS: shutdown waits only for CONSUMABLE work — a request
 * whose body has fully arrived (`req.complete`) and whose response is not yet
 * written (`!res.writableEnded`). Everything else (headers without a body, an
 * idle keep-alive) earns nothing. Mutant check (run by hand, 2026-10-24):
 * hardcoding the `req.complete` gate to `true` makes the first pin red again —
 * the half-written socket earns the full grace back.
 *
 * The slow upstream of the last pin is synthesized with `installStubFetch`
 * (#593) plus a delay — a real socket here would be a Bun.serve, and every
 * Bun.serve created after a node:http server in the same `bun test` process is
 * unreachable (see test-support/stub-fetch.ts for the measurement).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clearRuntimeRegistry } from "./providers/runtime-providers.js";
import { createProxyServer } from "./proxy-server.js";
import { declaredPortClaims } from "./test-support/port-claims.js";

const PORT_BASE = 19860;
const PORT_SPAN = 120;

// #791 — a random draw inside [PORT_BASE, PORT_BASE+SPAN) overlaps the FIXED
// ports sibling route suites claim (19863 cascade-revisit, 19871
// native-passthrough-strip, 19881 hop-gate, …): CI run 42224660315 caught
// `nextPort()` landing on 19863 after a sibling's listener lingered. The fix is
// not another hand-kept list (those drifted — see port-allocation.test.ts) but
// the same file-scan that pin enforces: every port another test file declares
// is skipped, and so is anything actually bound at draw time.
const SIBLING_PORT_CLAIMS = declaredPortClaims("proxy-server-shutdown-socket.test.ts");

/** True when nothing on this host currently binds the port (IPv4 wildcard). */
function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function nextPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    if (SIBLING_PORT_CLAIMS.has(port)) continue;
    if (!(await isPortBindable(port))) continue;
    return port;
  }
  throw new Error(
    `#791: no free port found in ${32} draws across [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`
  );
}

// #791 — this suite used to overwrite the REAL ~/.claudish/config.json with a
// minimal object (restore in `finally`) for the ~1.5 s the slow-upstream test
// runs, so any deferred async work reading the config inside that window saw
// an amputated object (no modelMap, no providers, one extra `slow-ep`
// endpoint). It now points the process at a scratch file via
// CLAUDISH_CONFIG_PATH and pins that the real file is byte-identical from
// beforeAll to afterAll — red the moment any path writes it again.
const REAL_CONFIG_PATH = join(homedir(), ".claudish", "config.json");
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "claudish-791-shutdown-"));
const SCRATCH_CONFIG_PATH = join(SCRATCH_DIR, "config.json");

/** A request whose body never arrives: headers promise 500 bytes, 11 are sent. */
function openHalfWrittenRequest(port: number): { socket: net.Socket; closed: () => boolean } {
  let closed = false;
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(
      'POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 500\r\n\r\n{"model":'
    );
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {});
  return { socket, closed: () => closed };
}

describe("#630 shutdown waits only for consumable work", () => {
  // Per the CR: the bound is observable with a LONG grace — 5 s — so a return
  // well under 1 s can only come from the gate refusing to count the socket,
  // never from the grace having elapsed.
  const GRACE_MS = 5000;

  let realConfigBefore: string | null = null;
  let previousConfigPath: string | undefined;
  beforeAll(() => {
    realConfigBefore = existsSync(REAL_CONFIG_PATH)
      ? readFileSync(REAL_CONFIG_PATH, "utf-8")
      : null;
    // CR 6673025851: restore the PRIOR env, not delete — a suite running under
    // an outer CLAUDISH_CONFIG_PATH (a wrapper harness, a -p invocation) must
    // find it intact after us.
    previousConfigPath = process.env.CLAUDISH_CONFIG_PATH;
    process.env.CLAUDISH_CONFIG_PATH = SCRATCH_CONFIG_PATH;
  });
  afterAll(() => {
    if (previousConfigPath === undefined) delete process.env.CLAUDISH_CONFIG_PATH;
    else process.env.CLAUDISH_CONFIG_PATH = previousConfigPath;
    // #791 pin: nothing this suite does may touch the real config.
    const after = existsSync(REAL_CONFIG_PATH) ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
    expect(after).toBe(realConfigBefore);
    // #791 registry channel: createProxyServer registered `slow-ep` from the
    // scratch config into the process-global runtime-provider map; without
    // this clear the entry outlives the suite and a later suite's proxy can
    // still resolve it (the second leak candidate of #791).
    clearRuntimeRegistry();
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  function withGrace<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
    process.env.CLAUDISH_SHUTDOWN_GRACE_MS = String(GRACE_MS);
    return fn().finally(() => {
      if (previous === undefined) delete process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
      else process.env.CLAUDISH_SHUTDOWN_GRACE_MS = previous;
    });
  }

  test("a half-written request earns nothing: shutdown() returns at the settle, not the grace", async () => {
    const port = await nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    const half = openHalfWrittenRequest(port);
    // Let the connection land and the parser sit on the missing body.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(half.closed()).toBe(false);

    const startedAt = Date.now();
    await withGrace(() => proxy.shutdown());
    const elapsed = Date.now() - startedAt;

    // The client is STILL holding its socket — a fast return can only come
    // from the gate, never from waiting for it. Under the pre-fix path (or the
    // `req.complete → true` mutant) this is red: the socket earns the grace.
    expect(half.closed()).toBe(false);
    expect(elapsed).toBeLessThan(1000);

    half.socket.destroy();
  }, 15_000);

  test("the listening socket is really closed — fast must not mean 'forgot to stop'", async () => {
    const port = await nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    const half = openHalfWrittenRequest(port);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await withGrace(() => proxy.shutdown());

    // A refused connection after shutdown proves close() ran; a listener left
    // behind would keep answering and would also keep the port busy for the
    // replacement container.
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    half.socket.destroy();
  }, 15_000);

  test("a second shutdown() call is harmless", async () => {
    const port = await nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    await proxy.shutdown();
    // The drain's wrapper and the signal path can both land here; a throw would
    // surface as OUTCOME exception on a deploy that actually succeeded.
    await proxy.shutdown();
    expect(true).toBe(true);
  }, 15_000);

  test("#791 a draw landing on a sibling suite's claimed port is redrawn (skip-set)", async () => {
    // The draw window overlaps FIXED sibling claims (19863 cascade-revisit,
    // 19871 native-passthrough-strip, …) — the collision CI run 42224660315
    // caught. Mutant: delete the `SIBLING_PORT_CLAIMS.has(port)` continue and
    // this pin is red — the first (forced) draw would be returned as-is.
    const claimedInSpan = [...SIBLING_PORT_CLAIMS]
      .filter((p) => p >= PORT_BASE && p < PORT_BASE + PORT_SPAN)
      .sort((a, b) => a - b);
    expect(claimedInSpan.length).toBeGreaterThan(0); // guards a vacuous pin

    const target = claimedInSpan[0]!;
    const targetFraction = (target - PORT_BASE) / PORT_SPAN;
    // Second draw: a deterministic fraction whose port is unclaimed (0.5 →
    // 19920 today; walk a few candidates so the pin survives new claims).
    const free = [0.5, 0.75, 0.25, 0.9]
      .map((f) => PORT_BASE + Math.floor(f * PORT_SPAN))
      .find((p) => !SIBLING_PORT_CLAIMS.has(p))!;
    const freeFraction = (free - PORT_BASE) / PORT_SPAN;

    const realRandom = Math.random;
    let draws = 0;
    Math.random = () => (draws++ === 0 ? targetFraction : freeFraction);
    try {
      const port = await nextPort();
      expect(port).not.toBe(target);
      expect(port).toBe(free);
      expect(draws).toBe(2); // exactly one rejection, then the clean draw
    } finally {
      Math.random = realRandom;
    }
  }, 10_000);

  test("#791 a draw landing on a port already bound on this host is redrawn (bind probe)", async () => {
    // The skip-set cannot know a port a LINGERING listener (a sibling suite's
    // unreleased server, the collision shape CI actually hit) still holds —
    // only the bind probe can. Mutant: delete the isPortBindable continue and
    // this pin is red.
    const candidates = Array.from({ length: PORT_SPAN }, (_, i) => PORT_BASE + i).filter(
      (p) => !SIBLING_PORT_CLAIMS.has(p)
    );
    expect(candidates.length).toBeGreaterThan(2); // room for the held port AND the escape draw

    let holder: net.Server | null = null;
    let held: number | null = null;
    for (const p of candidates) {
      const s = net.createServer();
      const ok = await new Promise<boolean>((resolve) => {
        s.once("error", () => resolve(false));
        s.listen(p, "0.0.0.0", () => resolve(true));
      });
      if (ok) {
        holder = s;
        held = p;
        break;
      }
    }
    expect(held).not.toBeNull();

    try {
      const heldFraction = (held! - PORT_BASE) / PORT_SPAN;
      const escapePort = candidates.find((p) => p !== held)!;
      const escapeFraction = (escapePort - PORT_BASE) / PORT_SPAN;
      const realRandom = Math.random;
      let draws = 0;
      Math.random = () => (draws++ === 0 ? heldFraction : escapeFraction);
      try {
        const port = await nextPort();
        expect(port).not.toBe(held);
        expect(port).toBe(escapePort);
      } finally {
        Math.random = realRandom;
      }
    } finally {
      holder?.close();
    }
  }, 10_000);
});
