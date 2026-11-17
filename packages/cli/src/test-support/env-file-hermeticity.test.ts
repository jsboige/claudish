/**
 * Entry-point hermeticity pin (#1101).
 *
 * WHY. Bun autoloads the nearest `.env` into `process.env` for `bun test`
 * (measured, bun 1.4.2: a `.env` beside the cwd fails a probe test; the same
 * probe passes under `--no-env-file`). On a seat, the repo-root `.env` is
 * gitignored production state — container-absolute values such as
 * `CLAUDISH_CAPTURE_DIR=/captures` and
 * `CLAUDISH_OVERFLOW_CAPS_PATH=/var/cache/claudish/overflow-caps.json` — so a
 * seat run measured a DIFFERENT population than CI, and `test:strict` reported
 * three "fresh" entries that fail standalone too (#1101 carries the bisection
 * and the two decisive keys).
 *
 * The fix is one flag on every declared bun-test entry point:
 * `--no-env-file`. This pin drives those entry points against a fixture whose
 * `.env` carries the two keys, and asserts the runtime never sees them.
 *
 * MUTATION-SENSITIVE BY CONSTRUCTION, not by restating the flags:
 * - the strict runner is exercised through its EXPORTED `suiteSpawnArgs()`,
 *   so removing the flag there makes the child autoload the fixture `.env` and
 *   the pin fails;
 * - the package scripts are read from `package.json` and EXECUTED as written
 *   (tokenized, `bun` replaced by `process.execPath`), so removing the flag
 *   from a script makes the pin fail;
 * - a NEGATIVE CONTROL runs the same fixture without the flag and asserts it
 *   FAILS — a pin that cannot go red is not a pin.
 *
 * Inherited environment: when this pin runs inside a non-hermetic invocation
 * (a bare `bun test` on a seat whose `.env` was autoloaded), the parent itself
 * carries the two keys and every child would inherit them regardless of any
 * flag. The pin therefore deletes the two keys from the child environment —
 * it measures the CHILD's own `.env` loading, which is the contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_NEUTRALIZED_COUNT_VAR,
  keysDroppedByFile,
  neutralizeRepoEnvFile,
  parseEnvFile,
} from "./env-file-neutralizer";
import { suiteSpawnArgs } from "./strict-runner";

const PROBE_NAME = "probe.test.ts";
const PROBE_BODY = `import { expect, test } from "bun:test";
test("a parasite .env must not reach the test runtime", () => {
  expect(process.env.CLAUDISH_CAPTURE_DIR).toBeUndefined();
  expect(process.env.CLAUDISH_OVERFLOW_CAPS_PATH).toBeUndefined();
});
`;
/** The two decisive keys of the seat `.env` (#1101 bisection). */
const PARASITE_ENV =
  "CLAUDISH_CAPTURE_DIR=/captures\n" +
  "CLAUDISH_OVERFLOW_CAPS_PATH=/var/cache/claudish/overflow-caps.json\n";

/** Repo root from this file: test-support -> src -> cli -> packages -> root. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** Temp dir carrying a `.env` the pin wants the runtime NOT to see. */
function parasiteFixture(): string {
  const d = mkdtempSync(join(tmpdir(), "claudish-envfile-pin-"));
  dirs.push(d);
  writeFileSync(join(d, ".env"), PARASITE_ENV, "utf-8");
  writeFileSync(join(d, PROBE_NAME), PROBE_BODY, "utf-8");
  return d;
}

/** Child env with the two keys removed: see the header's inheritance note. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDISH_CAPTURE_DIR;
  delete env.CLAUDISH_OVERFLOW_CAPS_PATH;
  return env;
}

function runBun(args: string[], cwd: string): string {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    env: childEnv(),
    timeout: 30_000,
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/** Parse a package's declared `test` script into a spawnable argv. */
function scriptArgv(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, pkgPath), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.test;
  expect(script).toBeString();
  expect(script).not.toContain("&&"); // compound shape: this pin must be revisited, never silently skipped
  const tokens = (script as string).trim().split(/\s+/);
  expect(tokens[0]).toBe("bun");
  return tokens.slice(1);
}

describe("bun-test entry points keep a parasite .env out (#1101)", () => {
  test("negative control: without the flag the fixture .env DOES reach the runtime", () => {
    const d = parasiteFixture();
    const raw = runBun(["test", PROBE_NAME], d);
    // If this ever passes, the fixture stopped being potent (bun changed the
    // autoload rules) and every assertion below would be vacuous.
    expect(raw).toContain("(fail)");
    expect(raw).toContain("1 fail");
  });

  test("the strict runner's real argv keeps it out", () => {
    const d = parasiteFixture();
    const raw = runBun(suiteSpawnArgs(PROBE_NAME, 5000), d);
    expect(raw).toContain("1 pass");
    expect(raw).not.toContain("(fail)");
  });

  test("packages/cli's declared test script keeps it out", () => {
    const d = parasiteFixture();
    const raw = runBun([...scriptArgv("packages/cli/package.json"), PROBE_NAME], d);
    expect(raw).toContain("1 pass");
    expect(raw).not.toContain("(fail)");
  });

  test("packages/macos-bridge's declared test script keeps it out", () => {
    const d = parasiteFixture();
    const raw = runBun([...scriptArgv("packages/macos-bridge/package.json"), PROBE_NAME], d);
    expect(raw).toContain("1 pass");
    expect(raw).not.toContain("(fail)");
  });
});

describe("repo .env neutralizer (#1101 — the inheritance half)", () => {
  // `--no-env-file` stops the test process from LOADING the repo .env; it
  // cannot stop INHERITANCE: `bun run <script>` loads it into the parent and
  // the spawned child receives the keys through process.env (measured 16/11:
  // a strict run with the flag on every spawn still reported the trio). The
  // preload therefore drops every key whose value equals the file's entry.

  test("parseEnvFile: comments, blank lines, export prefix, quotes, BOM", () => {
    const entries = parseEnvFile(
      "﻿# comment\n\nexport A=1\nB=\"two words\"\nC='single'\nMALFORMED\n=D\n"
    );
    expect(entries).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "single"],
    ]);
  });

  test("keysDroppedByFile: equal value drops, different value and absent stay", () => {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["CLAUDISH_CAPTURE_DIR", "/captures"],
      ["CLAUDISH_SAME_NAME", "file-value"],
    ];
    const env: Record<string, string | undefined> = {
      CLAUDISH_CAPTURE_DIR: "/captures",
      CLAUDISH_SAME_NAME: "shell-value", // an operator override bun let win — deliberate, kept
      CLAUDISH_UNRELATED: "x",
    };
    expect(keysDroppedByFile(entries, env)).toEqual(["CLAUDISH_CAPTURE_DIR"]);
  });

  test("neutralizeRepoEnvFile on a fixture: drops the file's keys, keeps the rest, names the drops", () => {
    const d = mkdtempSync(join(tmpdir(), "claudish-envfile-neut-"));
    dirs.push(d);
    const envFile = join(d, ".env");
    writeFileSync(
      envFile,
      "CLAUDISH_CAPTURE_DIR=/captures\nCLAUDISH_OVERFLOW_CAPS_PATH=/var/cache/claudish/overflow-caps.json\n",
      "utf-8"
    );
    const env: Record<string, string | undefined> = {
      CLAUDISH_CAPTURE_DIR: "/captures",
      CLAUDISH_OVERFLOW_CAPS_PATH: "/var/cache/claudish/overflow-caps.json",
      CLAUDISH_KEPT: "not-in-file",
    };
    const dropped = neutralizeRepoEnvFile(env, [envFile]);
    expect(dropped.sort()).toEqual(["CLAUDISH_CAPTURE_DIR", "CLAUDISH_OVERFLOW_CAPS_PATH"]);
    expect(env.CLAUDISH_CAPTURE_DIR).toBeUndefined();
    expect(env.CLAUDISH_OVERFLOW_CAPS_PATH).toBeUndefined();
    expect(env.CLAUDISH_KEPT).toBe("not-in-file");
  });

  test("neutralizeRepoEnvFile: a missing file is a no-op, never a throw (CI regime)", () => {
    const env: Record<string, string | undefined> = { CLAUDISH_CAPTURE_DIR: "/captures" };
    expect(neutralizeRepoEnvFile(env, [join(tmpdir(), "claudish-envfile-absent-404")])).toEqual([]);
    expect(env.CLAUDISH_CAPTURE_DIR).toBe("/captures");
  });

  test("WIRING: the preload arms the neutralizer in a real bun-test run", () => {
    // Spawns a bun test from the REPO ROOT so the real bunfig.toml preload
    // runs, against a probe asserting the evidence variable. On CI the count
    // is "0" (no .env); on a seat it is the seat's count; undefined means the
    // arming call was removed from test-preload.ts — the mutation this pin
    // exists to catch.
    const d = mkdtempSync(join(tmpdir(), "claudish-envfile-wiring-"));
    dirs.push(d);
    const probe = join(d, "wiring.test.ts");
    writeFileSync(
      probe,
      `import { expect, test } from "bun:test";
test("neutralizer armed", () => {
  expect(process.env.${ENV_NEUTRALIZED_COUNT_VAR}).toMatch(/^\\d+$/);
});
`,
      "utf-8"
    );
    const r = spawnSync(process.execPath, ["--no-env-file", "test", probe], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: childEnv(),
      timeout: 30_000,
    });
    const raw = (r.stdout ?? "") + (r.stderr ?? "");
    expect(raw).toContain("1 pass");
    expect(raw).not.toContain("(fail)");
  });
});
