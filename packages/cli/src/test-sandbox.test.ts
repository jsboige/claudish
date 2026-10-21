/**
 * Pins the preset-mode sandbox guard (`test-sandbox.ts`). Each branch that can
 * let a real home through has a test here; the preload calls the same function,
 * so a mutation of a guard turns exactly its pin red.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { presetRefusal, resolveRealHome } from "./test-sandbox";

const base = {
  sandbox: "/tmp/claudish-test-home-abc",
  passwdHome: "/home/runner",
  passwdIsIndependent: true,
  tmpDir: "/tmp",
  githubActions: false,
};

describe("preset-mode sandbox guard", () => {
  test("accepts a sandbox under tmpdir", () => {
    expect(presetRefusal(base)).toBeNull();
  });

  test("accepts a sandbox under RUNNER_TEMP", () => {
    expect(
      presetRefusal({
        ...base,
        sandbox: "/home/runner/work/_temp/claudish-test-home",
        runnerTemp: "/home/runner/work/_temp",
      }),
    ).toBeNull();
  });

  test("accepts any sandbox under GitHub Actions", () => {
    expect(
      presetRefusal({ ...base, sandbox: "/mnt/ci/home", githubActions: true }),
    ).toBeNull();
  });

  test("refuses a sandbox that IS the passwd home", () => {
    const msg = presetRefusal({ ...base, sandbox: "/home/runner" });
    expect(msg).toContain("IS the passwd home");
  });

  test("Windows: an equal passwd home is expected (userInfo follows USERPROFILE)", () => {
    // libuv derives os.userInfo().homedir from USERPROFILE, so a launcher preset
    // makes the two equal by construction; the throwaway branch is the guard.
    expect(
      presetRefusal({
        ...base,
        sandbox: "/tmp/claudish-preset-abc",
        passwdHome: "/tmp/claudish-preset-abc",
        passwdIsIndependent: false,
      }),
    ).toBeNull();
  });

  test("Windows: an inherited preset pointing at the real home still refuses", () => {
    const msg = presetRefusal({
      ...base,
      sandbox: "C:/Users/operator",
      passwdHome: "C:/Users/operator",
      passwdIsIndependent: false,
    });
    expect(msg).toContain("neither under");
  });

  test("refuses a non-throwaway sandbox outside CI", () => {
    const msg = presetRefusal({ ...base, sandbox: "/home/runner/claudish" });
    expect(msg).toContain("neither under");
  });

  test("does not treat a sibling directory as under tmpdir", () => {
    // "/tmpfoo" must not pass the prefix check against "/tmp".
    expect(presetRefusal({ ...base, sandbox: "/tmpfoo/home" })).toContain("neither under");
  });

  test("resolves dot segments before comparing", () => {
    expect(presetRefusal({ ...base, sandbox: "/home/runner/../runner" })).toContain(
      "IS the passwd home",
    );
  });

  test("refusal names the offending path", () => {
    const msg = presetRefusal({ ...base, sandbox: "/home/runner" });
    expect(msg).toContain(resolve("/home/runner"));
    const other = presetRefusal({ ...base, sandbox: "/mnt/elsewhere" });
    expect(other).toContain(resolve("/mnt/elsewhere"));
  });
});

describe("real-home selection (#242 pin)", () => {
  test("preset mode records the passwd home, not the sandbox", () => {
    expect(
      resolveRealHome({ preset: true, envHome: "/tmp/claudish-test-home-a", passwdHome: "/home/runner" }),
    ).toBe("/home/runner");
  });

  test("seat mode records the runtime home", () => {
    expect(
      resolveRealHome({ preset: false, envHome: "/home/operator", passwdHome: "/home/runner" }),
    ).toBe("/home/operator");
  });

  test("the two differ in preset mode — the pin that B1 had made tautological", () => {
    const envHome = "/tmp/claudish-test-home-a";
    const passwdHome = "/home/runner";
    expect(resolveRealHome({ preset: true, envHome, passwdHome })).not.toBe(envHome);
  });
});