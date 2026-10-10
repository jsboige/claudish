import { describe, test, expect } from "bun:test";
import { ConcurrencyLimiter, StepBusyError } from "./concurrency-limiter.js";

/**
 * ConcurrencyLimiter — per-instance async semaphore for remote transports.
 *
 * Why these tests exist: the limiter replaced LocalModelQueue for the transport
 * maxConcurrency path (LocalModelQueue is a global singleton whose shared
 * maxParallel is mutated per-override — capping a second provider through it
 * would tangle caps). These tests pin the contract that matters for the proxy:
 * cap is respected, release is FIFO, extras queue without rejecting (never-hang).
 */
describe("ConcurrencyLimiter", () => {
  test("rejects construction with non-positive max", () => {
    expect(() => new ConcurrencyLimiter(0, "x")).toThrow();
    expect(() => new ConcurrencyLimiter(-1, "x")).toThrow();
  });

  test("runs tasks concurrently up to the cap", async () => {
    const limiter = new ConcurrencyLimiter(2, "test");
    let active = 0;
    let peak = 0;
    const track = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(track)));
    expect(peak).toBe(2); // never exceeded the cap
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  test("never exceeds cap=1 (strict serialization)", async () => {
    const limiter = new ConcurrencyLimiter(1, "serial");
    let active = 0;
    let peak = 0;
    const track = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 5 }, () => limiter.run(track)));
    expect(peak).toBe(1);
  });

  test("queues extras in FIFO order and releases them as slots free", async () => {
    const limiter = new ConcurrencyLimiter(1, "fifo");
    const order: string[] = [];
    const task = (label: string) =>
      limiter.run(async () => {
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${label}`);
      });

    const p = Promise.all([task("a"), task("b"), task("c")]);
    // Under cap=1, a must fully finish before b starts, b before c.
    await p;
    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  test("never rejects — even many tasks beyond cap all complete", async () => {
    const limiter = new ConcurrencyLimiter(2, "never-reject");
    let completed = 0;
    const task = async () => {
      await new Promise((r) => setTimeout(r, 2));
      completed++;
    };
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => limiter.run(task))
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(completed).toBe(50);
  });

  test("propagates task rejection and still releases the slot", async () => {
    const limiter = new ConcurrencyLimiter(1, "reject-prop");
    let secondRan = false;

    const first = limiter.run(async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    // Slot must have been released despite the throw.
    await limiter.run(async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
    expect(limiter.activeCount).toBe(0);
  });

  // ── #431: bounded queue wait (busy skip) ──────────────────────────────────

  test("#431: a bounded wait that expires rejects with StepBusyError", async () => {
    const limiter = new ConcurrencyLimiter(1, "busy");
    let releaseHolder!: () => void;
    const holder = limiter.run(
      () => new Promise<void>((r) => { releaseHolder = r; })
    );
    await new Promise((r) => setTimeout(r, 5)); // holder has the slot

    const t0 = Date.now();
    await expect(limiter.run(async () => "never", 50)).rejects.toBeInstanceOf(StepBusyError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45); // it really waited
    releaseHolder();
    await holder;
  });

  test("#431: a busy timeout does NOT leak the slot — the next task still runs", async () => {
    const limiter = new ConcurrencyLimiter(1, "busy-leak");
    let releaseHolder!: () => void;
    const holder = limiter.run(
      () => new Promise<void>((r) => { releaseHolder = r; })
    );
    await new Promise((r) => setTimeout(r, 5));

    // The abandoned waiter's resolver must be GONE from the queue: a freed
    // slot that wakes it would decrement `active` for a waiter that never
    // increments — the slot disappears for every later task.
    await expect(limiter.run(async () => "x", 20)).rejects.toBeInstanceOf(StepBusyError);
    releaseHolder();
    await holder;

    let ran = false;
    await limiter.run(async () => { ran = true; }, 20);
    expect(ran).toBe(true);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  test("#431: without a budget the FIFO wait stays unbounded (pre-#431 behavior)", async () => {
    const limiter = new ConcurrencyLimiter(1, "unbounded");
    let releaseHolder!: () => void;
    const holder = limiter.run(
      () => new Promise<void>((r) => { releaseHolder = r; })
    );
    await new Promise((r) => setTimeout(r, 5));

    let ran = false;
    const waiter = limiter.run(async () => { ran = true; }); // no budget arg
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toBe(false); // still waiting — no silent timeout
    releaseHolder();
    await holder;
    await waiter;
    expect(ran).toBe(true);
  });

  test("#431: budget 0 means no bound, not an instant timeout", async () => {
    const limiter = new ConcurrencyLimiter(1, "zero-off");
    let releaseHolder!: () => void;
    const holder = limiter.run(
      () => new Promise<void>((r) => { releaseHolder = r; })
    );
    await new Promise((r) => setTimeout(r, 5));

    let ran = false;
    const waiter = limiter.run(async () => { ran = true; }, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toBe(false);
    releaseHolder();
    await holder;
    await waiter;
    expect(ran).toBe(true);
  });
});
