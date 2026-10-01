/**
 * Controls for the strict runner itself (#175 deliverable 4): the comparison
 * core must classify fresh/resolved correctly, the reproduction rule must
 * treat a reproduced fresh entry as a regression whatever the count, the
 * output parser must key fails on their file and must NOT print a verdict it
 * cannot account for — including the module-load death shape, driven here
 * through REAL bun output, not hand-written lines (review 2026-10-01).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  diffAgainstBaseline,
  main,
  normalizeFailLine,
  parseEnvGateManifests,
  parseRunOutput,
  realSuiteRunner,
  runIsAccountable,
  splitFreshByReproduction,
  type StrictBaseline,
  type SuiteRun,
} from "./strict-runner";

const base: StrictBaseline = {
  sha: "abc1234",
  capturedAt: "2026-09-29T00:00:00Z",
  fails: ["a.test.ts > a1", "b.test.ts > b1", "c.test.ts > c1"],
};

describe("normalizeFailLine", () => {
  test("strips the trailing duration from a fail line", () => {
    expect(normalizeFailLine("(fail) team-orchestrator > validateSessionPath > TEST-15: accepts [3.40ms]")).toBe(
      "team-orchestrator > validateSessionPath > TEST-15: accepts",
    );
  });
  test("accepts lines without a duration", () => {
    expect(normalizeFailLine("(fail) ProviderProfile table completeness > all expected")).toBe(
      "ProviderProfile table completeness > all expected",
    );
  });
  test("rejects non-fail lines (pass/skip/log noise)", () => {
    expect(normalizeFailLine("(pass) A > a1 [1ms]")).toBeNull();
    expect(normalizeFailLine("(skip) A > a2")).toBeNull();
    expect(normalizeFailLine("random log line")).toBeNull();
  });
});

describe("parseRunOutput (real bun output)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  function makeTree(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), "strict-bun-out-"));
    tmpDirs.push(d);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body, "utf-8");
    return d;
  }

  function realBunOutput(treeDir: string): string {
    const r = spawnSync(process.execPath, ["test", treeDir, "--timeout", "5000"], { encoding: "utf-8" });
    return (r.stdout ?? "") + (r.stderr ?? "");
  }

  test("a file that dies at module load becomes a NAMED entry and is accounted for (review defect 1)", () => {
    const d = makeTree({
      "good.test.ts": "import { test, expect } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
      "throws.test.ts": "throw new Error('module-level death');\n",
    });
    const parsed = parseRunOutput(realBunOutput(d));
    // bun prints the header relative to its cwd, so match on the suffix — the
    // property under test is the NAMED load-error entry, not the path prefix.
    expect(parsed.entries.some((e) => e.endsWith("throws.test.ts: load error #1"))).toBe(true);
    // bun reports 0 named fails + 1 error; the synthesized entry accounts for it
    expect(runIsAccountable(parsed)).toBe(true);
  });

  test("same describe path in two files stays TWO entries (file keying)", () => {
    const d = makeTree({
      "fa.test.ts":
        "import { test, expect, describe } from 'bun:test';\ndescribe('same path', () => { test('fails here', () => { expect(1).toBe(2); }); });\n",
      "fb.test.ts":
        "import { test, expect, describe } from 'bun:test';\ndescribe('same path', () => { test('fails here', () => { expect(1).toBe(2); }); });\n",
    });
    const parsed = parseRunOutput(realBunOutput(d));
    expect(parsed.entries.filter((e) => e.endsWith("fa.test.ts > same path > fails here")).length).toBe(1);
    expect(parsed.entries.filter((e) => e.endsWith("fb.test.ts > same path > fails here")).length).toBe(1);
    expect(parsed.entries.length).toBe(2);
    expect(runIsAccountable(parsed)).toBe(true);
  });

  test("a broken import is never silence — whatever shape bun prints, the parse must account for it", () => {
    const d = makeTree({
      "broken.test.ts": "import { nope } from './does-not-exist';\ntest('never runs', () => {});\n",
    });
    const parsed = parseRunOutput(realBunOutput(d));
    // bun 1.3.14 renders a missing import differently from a top-level throw
    // (sometimes a named fail, sometimes an unhandled block) — the invariant
    // that matters is that the parser accounts for every counter bun reports.
    expect(runIsAccountable(parsed)).toBe(true);
    expect(parsed.entries.length).toBe(Math.max(parsed.fail, parsed.error));
  });
});

describe("realSuiteRunner (kill path — re-review 2 defect)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  function captureStdout(fn: () => number): { code: number; out: string } {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(String(s));
      return true;
    };
    try {
      return { code: fn(), out: chunks.join("") };
    } finally {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = orig as unknown as (s: string) => boolean;
    }
  }

  test("a wall-clock kill keeps the partial output and names the last file WITH output", () => {
    const d = mkdtempSync(join(tmpdir(), "strict-kill-"));
    tmpDirs.push(d);
    // aaa-first produces output (header + a named fail), zzz-hang blocks in
    // beforeAll forever: bun never prints its header (non-TTY headers come
    // only with output), so the diagnosis can only name the PRECEDING file.
    writeFileSync(
      join(d, "aaa-first.test.ts"),
      "import { test, expect } from 'bun:test';\ntest('red', () => { expect(1).toBe(2); });\n",
      "utf-8",
    );
    writeFileSync(
      join(d, "zzz-hang.test.ts"),
      "import { beforeAll, test } from 'bun:test';\nbeforeAll(() => new Promise(() => {}));\ntest('never runs', () => {});\n",
      "utf-8",
    );

    const { code, out } = captureStdout(() =>
      main([], realSuiteRunner(d, { testPath: ".", wallClockMs: 8000 })),
    );
    expect(code).toBe(3);
    // The kill fired on the REAL spawn path and the diagnosis feature is alive
    // (the 28472efb regression returned raw:"" here, killing it silently).
    expect(out).toContain("RUN KILLED (ETIMEDOUT)");
    expect(out).toContain("the hung file is the NEXT one");
    expect(out).toContain("aaa-first.test.ts");
  }, 20000);
});

describe("runIsAccountable (no verdict without accounting)", () => {
  test("missing Ran-line (truncated output) → not accountable", () => {
    const run: SuiteRun = { entries: [], fail: 0, error: 0, ranLinePresent: false, envGates: [], raw: "" };
    expect(runIsAccountable(run)).toBe(false);
  });
  test("parsed count below bun's counters (parser blind to a shape) → not accountable", () => {
    const run: SuiteRun = { entries: [], fail: 2, error: 1, ranLinePresent: true, envGates: [], raw: "" };
    expect(runIsAccountable(run)).toBe(false);
  });
  test("exact accounting → accountable", () => {
    // 3 entries = 2 named fails + 1 load error; bun double-counts the load
    // error into BOTH counters → fail 3, error 1 (measured bun 1.3.14).
    const run: SuiteRun = { entries: ["a", "b", "throws.test.ts: load error #1"], fail: 3, error: 1, ranLinePresent: true, envGates: [], raw: "" };
    expect(runIsAccountable(run)).toBe(true);
  });
});

describe("splitFreshByReproduction (review defect 2)", () => {
  test("a fresh entry that REPRODUCES is a regression even as a single one — a count-based tolerance excused exactly this", () => {
    const { regressions, flakyTail } = splitFreshByReproduction(["NEW > red"], ["NEW > red"]);
    expect(regressions).toEqual(["NEW > red"]);
    expect(flakyTail).toEqual([]);
  });
  test("a fresh entry that does NOT reproduce is noise", () => {
    const { regressions, flakyTail } = splitFreshByReproduction(["FLAKY > x"], ["other > y"]);
    expect(regressions).toEqual([]);
    expect(flakyTail).toEqual(["FLAKY > x"]);
  });
});

describe("diffAgainstBaseline", () => {
  test("identical population → no fresh, no resolved", () => {
    const { fresh, resolved } = diffAgainstBaseline([...base.fails], base);
    expect(fresh).toEqual([]);
    expect(resolved).toEqual([]);
  });
  test("fresh and resolved sides are independent", () => {
    const { fresh, resolved } = diffAgainstBaseline(["a.test.ts > a1", "NEW > n1"], base);
    expect(fresh).toEqual(["NEW > n1"]);
    expect(resolved.sort()).toEqual(["b.test.ts > b1", "c.test.ts > c1"]);
  });
});

/** Build a bun-shaped output for exactly these entries (self-checked below). */
function outputFor(entries: string[]): string {
  const lines: string[] = ["bun test v1.3.14"];
  let file = "";
  let loadErrors = 0;
  let namedFails = 0;
  for (const e of entries) {
    const f = e.includes(": load error") ? e.slice(0, e.indexOf(":")) : e.split(" > ")[0];
    if (f !== file) {
      file = f;
      lines.push(`${f}:`);
    }
    if (e.includes(": load error")) {
      loadErrors += 1;
      lines.push("# Unhandled error between tests", "-------------------------------", "error: module-level death");
    } else {
      namedFails += 1;
      lines.push(`(fail) ${e.split(" > ").slice(1).join(" > ")} [1.00ms]`);
    }
  }
  // bun double-counts a module-load death into BOTH summary counters
  // (measured 1.3.14: good+throws → "1 pass / 1 fail / 1 error" for one
  // synthesized entry), so a load error increments fail AND error here.
  lines.push(
    ` ${namedFails + loadErrors} fail`,
    `${loadErrors} error`,
    `Ran ${entries.length} tests across ${new Set(entries.map((e) => (e.includes(": load error") ? e.slice(0, e.indexOf(":")) : e.split(" > ")[0]))).size} files. [10.00ms]`,
  );
  return lines.join("\n");
}

describe("main (verdict wiring, injected runs + tmp cwd)", () => {
  const prevCwd = process.cwd();
  const tmpDirs: string[] = [];
  afterEach(() => {
    process.chdir(prevCwd);
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  function chdirTmpWithBaseline(b?: StrictBaseline): void {
    const d = mkdtempSync(join(tmpdir(), "strict-main-"));
    tmpDirs.push(d);
    if (b) writeFileSync(join(d, ".test-strict-baseline.json"), JSON.stringify(b), "utf-8");
    process.chdir(d);
  }

  // Self-check: the synthetic harness must parse back to its own entries, else
  // the scenario tests below would exercise a fixture the parser disagrees
  // with — the exact failure mode the review flagged on the old synthetic line.
  test("harness self-check: outputFor parses back to its entries and is accountable", () => {
    const entries = ["fa.test.ts > same > x", "fb.test.ts > same > x", "throws.test.ts: load error #1"];
    const parsed = parseRunOutput(outputFor(entries));
    expect(parsed.entries).toEqual(entries);
    expect(runIsAccountable(parsed)).toBe(true);
  });

  test("killed run → exit 3, no verdict", () => {
    const code = main([], () => ({ raw: "", killed: true, errorCode: "ETIMEDOUT" }));
    expect(code).toBe(3);
  });

  test("unaccountable output → exit 3, no verdict (truncated summary)", () => {
    const code = main([], () => ({ raw: "bun test\n(no summary line)" }));
    expect(code).toBe(3);
  });

  test("no baseline on disk → exit 2", () => {
    chdirTmpWithBaseline();
    const code = main([], () => ({ raw: outputFor(["A > a1"]) }));
    expect(code).toBe(2);
  });

  test("observed ⊆ baseline → exit 0 with exactly ONE suite run (no confirmation pass when nothing is fresh)", () => {
    chdirTmpWithBaseline(base);
    let runs = 0;
    const code = main(
      [],
      () => {
        runs += 1;
        return { raw: outputFor([...base.fails]) };
      },
    );
    expect(runs).toBe(1);
    expect(code).toBe(0);
  });

  test("a SINGLE fresh entry that reproduces → exit 1 — the deterministic-red case a count tolerance excused", () => {
    chdirTmpWithBaseline(base);
    const code = main([], () => ({ raw: outputFor([...base.fails, "NEW > deterministic red"]) }));
    expect(code).toBe(1);
  });

  test("a fresh entry that does NOT reproduce → exit 0 (noise, by property not count)", () => {
    chdirTmpWithBaseline(base);
    let call = 0;
    const code = main([], () => {
      call += 1;
      // run 1 has the flaky entry, the confirmation run does not
      return { raw: outputFor(call === 1 ? [...base.fails, "FLAKY > x"] : [...base.fails]) };
    });
    expect(code).toBe(0);
  });
});

describe("parseEnvGateManifests", () => {
  test("consolidates per-file manifest blocks into one per-class count", () => {
    const raw = [
      "[ENV-GATE] 6 test(s) NOT executed — class 'posix-path-shim':",
      "[ENV-GATE]   · first test",
      "[ENV-GATE] 2 test(s) NOT executed — class 'live-endpoint-catalog':",
      "[ENV-GATE] 6 test(s) NOT executed — class 'posix-path-shim':",
    ].join("\n");
    const summary = parseEnvGateManifests(raw);
    expect(summary).toEqual([
      { classId: "posix-path-shim", notExecuted: 12 },
      { classId: "live-endpoint-catalog", notExecuted: 2 },
    ]);
  });

  test("no manifests → empty summary (complete machine)", () => {
    expect(parseEnvGateManifests("no gates here")).toEqual([]);
  });
});
