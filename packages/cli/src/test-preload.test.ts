/**
 * Pins the test-run home sandbox (#242). If the bunfig `[test] preload` is
 * removed, renamed, or stops taking effect, these go red — and the rest of the
 * suite is once again writing the operator's real ~/.claudish.
 *
 * The third test reads the preload's proof marker instead of assuming one
 * regime: on POSIX the launcher's sandbox must differ from the passwd home; on
 * Windows `os.userInfo()` follows USERPROFILE, so preset mode proves itself by
 * a throwaway location instead. The marker makes that explicit, so weakening a
 * branch of the guard cannot pass this file silently.
 */
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const PROOFS = ["env-home", "passwd-distinct", "throwaway-windows"];

describe("#242 — tests never see the operator's real home", () => {
  test("the preload ran: a sandbox, the real home and the proof are recorded", () => {
    expect(process.env.CLAUDISH_TEST_HOME_SANDBOX).toBeTruthy();
    expect(process.env.CLAUDISH_TEST_REAL_HOME).toBeTruthy();
    expect(PROOFS).toContain(process.env.CLAUDISH_TEST_SANDBOX_PROOF ?? "");
  });

  test("homedir() resolves to the sandbox", () => {
    const sandbox = resolve(process.env.CLAUDISH_TEST_HOME_SANDBOX!);
    expect(resolve(homedir())).toBe(sandbox);
  });

  test("the sandbox is provably NOT the operator's real home", () => {
    const sandbox = resolve(process.env.CLAUDISH_TEST_HOME_SANDBOX!);
    const realHome = resolve(process.env.CLAUDISH_TEST_REAL_HOME!);
    const proof = process.env.CLAUDISH_TEST_SANDBOX_PROOF;
    if (proof === "throwaway-windows") {
      // Equality is expected here (userInfo follows USERPROFILE); the preload
      // refused unless the sandbox sat in a throwaway location. Re-check it.
      const under = (base: string) =>
        sandbox === resolve(base) || sandbox.startsWith(resolve(base) + sep);
      const runnerTemp = process.env.RUNNER_TEMP;
      const throwaway =
        process.env.GITHUB_ACTIONS === "true" ||
        under(tmpdir()) ||
        (runnerTemp ? under(runnerTemp) : false);
      expect(throwaway).toBe(true);
      return;
    }
    expect(sandbox).not.toBe(realHome);
  });
});