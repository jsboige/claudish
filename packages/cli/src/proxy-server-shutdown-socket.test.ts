/**
 * #630 — `shutdown()` must not wait for a client that cannot receive anything.
 *
 * `server.close()` drops the listening socket immediately, then waits for every
 * connection to END. A half-written request — the shape an agent killed
 * mid-turn leaves behind — never becomes a `request` event, so it is invisible
 * to the stream tracker AND to a request counter, yet it holds `close()` open
 * until the kernel or the client gives up. Measured 2026-10-24 on hub po-2025:
 * `shutdown()` resolved at 3046 ms, exactly when the client destroyed its own
 * socket, and a throwaway container carrying one such request took 21 401 ms to
 * stop against 482 ms with no client. With `stop_grace_period: 120s` that is up
 * to two minutes of hub downtime per recreate.
 *
 * WHAT THIS FILE PINS, AND WHAT IT DOES NOT. It pins the bound (shutdown
 * returns promptly while the offending socket is still open) and that the
 * listening socket really is closed — a "fast" shutdown that forgot to stop
 * listening would pass the first half alone. It does NOT pin that a genuine
 * long in-flight turn keeps its full grace: the harness has no slow upstream to
 * synthesize one, and inventing a fake would measure the fake.
 */

import { describe, test, expect } from "bun:test";
import net from "node:net";
import { createProxyServer } from "./proxy-server.js";

const PORT_BASE = 19860;

function nextPort(): number {
  return PORT_BASE + Math.floor(Math.random() * 120);
}

/** A request whose body never arrives: headers promise 500 bytes, 11 are sent. */
function openHalfWrittenRequest(port: number): { socket: net.Socket; closed: () => boolean } {
  let closed = false;
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write('POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 500\r\n\r\n{"model":');
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {});
  return { socket, closed: () => closed };
}

describe("#630 shutdown does not wait for a dead socket", () => {
  // The pin is the BOUND, not an instant. Node emits `request` as soon as the
  // headers parse, so a half-written body counts as in-flight and honestly
  // earns the grace — what must not happen is earning the runtime's 120 s.
  // A small grace makes the bound observable in a test.
  const GRACE_MS = 300;

  function withGrace<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
    process.env.CLAUDISH_SHUTDOWN_GRACE_MS = String(GRACE_MS);
    return fn().finally(() => {
      if (previous === undefined) delete process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
      else process.env.CLAUDISH_SHUTDOWN_GRACE_MS = previous;
    });
  }

  test("shutdown() honours the grace instead of waiting for the client to give up", async () => {
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

    const half = openHalfWrittenRequest(port);
    // Let the connection land and the parser sit on the missing body.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(half.closed()).toBe(false);

    const startedAt = Date.now();
    await withGrace(() => proxy.shutdown());
    const elapsed = Date.now() - startedAt;

    // The client is STILL holding its socket — so a fast return can only come
    // from us cutting, never from waiting for it. Without the bound this
    // assertion is what goes red: the pre-fix path returns when the socket dies.
    expect(half.closed()).toBe(false);
    expect(elapsed).toBeLessThan(2000);

    half.socket.destroy();
  }, 15_000);

  test("the listening socket is really closed — fast must not mean 'forgot to stop'", async () => {
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

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
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

    await proxy.shutdown();
    // The drain's wrapper and the signal path can both land here; a throw would
    // surface as OUTCOME exception on a deploy that actually succeeded.
    await proxy.shutdown();
    expect(true).toBe(true);
  }, 15_000);
});
