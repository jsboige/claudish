/**
 * Pins the test-run home sandbox (#242). If the bunfig `[test] preload` is
 * removed, renamed, or stops taking effect, these go red — and the rest of the
 * suite is once again writing the operator's real ~/.claudish.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";

describe("#242 — tests never see the operator's real home", () => {
  test("the preload ran: a sandbox and the real home are both recorded", () => {
    expect(process.env.CLAUDISH_TEST_HOME_SANDBOX).toBeTruthy();
    expect(process.env.CLAUDISH_TEST_REAL_HOME).toBeTruthy();
  });

  test("homedir() resolves to the sandbox, not the real home", () => {
    const sandbox = resolve(process.env.CLAUDISH_TEST_HOME_SANDBOX!);
    const realHome = resolve(process.env.CLAUDISH_TEST_REAL_HOME!);
    expect(sandbox).not.toBe(realHome);
    expect(resolve(homedir())).toBe(sandbox);
  });
});
