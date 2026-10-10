import { describe, expect, test } from "bun:test";
import { readStepBusyWaitMs, STEP_BUSY_WAIT_DEFAULT_MS } from "./step-skip.js";

// #431 CR minor: the knob parses STRICTLY. `Number.parseInt("2s")` is 2 — two
// MILLISECONDS, not two seconds — so a unit-suffixed value silently armed a
// bound tighter than any real queue wait and every marked attempt skipped.
describe("readStepBusyWaitMs (#431 CR: strict parse + clamp)", () => {
  test("unit-suffixed garbage falls back to the default, never to 2 ms", () => {
    expect(readStepBusyWaitMs({ CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS: "2s" } as any)).toBe(
      STEP_BUSY_WAIT_DEFAULT_MS
    );
  });

  test("0 stays 0 — off, not an instant timeout", () => {
    expect(readStepBusyWaitMs({ CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS: "0" } as any)).toBe(0);
  });

  test("a plain integer passes through", () => {
    expect(readStepBusyWaitMs({ CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS: "500" } as any)).toBe(500);
  });

  test("clamped at 60 s — a minutes-as-milliseconds typo must not stall a client", () => {
    expect(readStepBusyWaitMs({ CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS: "300000" } as any)).toBe(60_000);
  });
});
