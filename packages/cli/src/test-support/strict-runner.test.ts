import { afterEach, describe, expect, test } from "bun:test";
/**
 * Controls for the strict runner itself (#175 deliverable 4): the comparison
 * core must classify fresh/resolved correctly, the reproduction rule must
 * treat a reproduced fresh entry as a regression whatever the count, the
 * output parser must key fails on their file and must NOT print a verdict it
 * cannot account for — including the module-load death shape, driven here
 * through REAL bun output, not hand-written lines (review 2026-10-01).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET_FOOTER_MARKER, manifestFooter } from "./env-gate";
import {
  BASELINE_PATH,
  DEFAULT_PARTITION_SIZE,
  DEFAULT_WALL_CLOCK_MS,
  MAX_WALL_CLOCK_MS,
  type PartitionDeps,
  type StrictBaseline,
  type SuiteRun,
  diffAgainstBaseline,
  entryFile,
  enumerateTestFiles,
  foreignEntryFiles,
  main,
  mergeEnvGates,
  normalizeFailLine,
  parseEnvGateManifests,
  parsePartitionArg,
  parseRunOutput,
  planPartitions,
  populationEchoOverCounts,
  populationGapUnexplained,
  ranLineFileCount,
  realSuiteRunner,
  resolveWallClock,
  resolveWallClockMs,
  runIsAccountable,
  splitFreshByReproduction,
  wallClockSentence,
} from "./strict-runner";

const base: StrictBaseline = {
  sha: "abc1234",
  capturedAt: "2026-09-29T00:00:00Z",
  fails: ["a.test.ts > a1", "b.test.ts > b1", "c.test.ts > c1"],
};

describe("normalizeFailLine", () => {
  test("strips the trailing duration from a fail line", () => {
    expect(
      normalizeFailLine(
        "(fail) team-orchestrator > validateSessionPath > TEST-15: accepts [3.40ms]"
      )
    ).toBe("team-orchestrator > validateSessionPath > TEST-15: accepts");
  });
  test("accepts lines without a duration", () => {
    expect(normalizeFailLine("(fail) ProviderProfile table completeness > all expected")).toBe(
      "ProviderProfile table completeness > all expected"
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
    const r = spawnSync(process.execPath, ["test", treeDir, "--timeout", "5000"], {
      encoding: "utf-8",
    });
    return (r.stdout ?? "") + (r.stderr ?? "");
  }

  test("a file that dies at module load becomes a NAMED entry and is accounted for (review defect 1)", () => {
    const d = makeTree({
      "good.test.ts":
        "import { test, expect } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
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
    expect(
      parsed.entries.filter((e) => e.endsWith("fa.test.ts > same path > fails here")).length
    ).toBe(1);
    expect(
      parsed.entries.filter((e) => e.endsWith("fb.test.ts > same path > fails here")).length
    ).toBe(1);
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

describe("resolveWallClockMs (per-seat wall override, #641 C3)", () => {
  test("unset and empty env → the 420 s default, silently", () => {
    expect(resolveWallClockMs({})).toBe(DEFAULT_WALL_CLOCK_MS);
    expect(DEFAULT_WALL_CLOCK_MS).toBe(420_000); // the default is part of the arbitration
    expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: "" })).toBe(DEFAULT_WALL_CLOCK_MS);
  });

  test("a positive integer of ms overrides", () => {
    expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: "900000" })).toBe(900_000);
    expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: "1" })).toBe(1);
    // the spawnSync ceiling itself is the largest legal value (review MINOR 1:
    // 2^31 kills at once and reads as a flaky tail)
    expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: "2147483647" })).toBe(
      MAX_WALL_CLOCK_MS
    );
    expect(MAX_WALL_CLOCK_MS).toBe(2_147_483_647);
  });

  test("values above the spawnSync ceiling fall back to the default (review MINOR 1)", () => {
    for (const bad of ["2147483648", "3000000000", "4294967296"]) {
      expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: bad })).toBe(
        DEFAULT_WALL_CLOCK_MS
      );
    }
  });

  test("invalid values fall back to the default (never a silent bound change, never a crash)", () => {
    for (const bad of ["abc", "0", "-5", "420.5", "420 000", "undefined", "20min"]) {
      expect(resolveWallClockMs({ CLAUDISH_STRICT_WALL_CLOCK_MS: bad })).toBe(
        DEFAULT_WALL_CLOCK_MS
      );
    }
  });

  test("the source travels with the value, and the kill sentence names it exactly (review MINOR 2)", () => {
    expect(resolveWallClock({})).toEqual({ ms: 420_000, source: "default" });
    expect(resolveWallClock({ CLAUDISH_STRICT_WALL_CLOCK_MS: "420000" })).toEqual({
      ms: 420_000,
      source: "env",
    });
    // an env 420000 is NOT "(default)", an injected 420000 is NOT an env override
    expect(wallClockSentence({ ms: 420_000, source: "default" })).toBe(
      " The wall clock in force was 420000 ms (default)."
    );
    expect(wallClockSentence({ ms: 420_000, source: "env" })).toBe(
      " The wall clock in force was 420000 ms — CLAUDISH_STRICT_WALL_CLOCK_MS overrides the 420000 default."
    );
    expect(wallClockSentence({ ms: 8000, source: "injected" })).toBe(
      " The wall clock in force was 8000 ms (injected for this run)."
    );
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
      (process.stdout as unknown as { write: (s: string) => boolean }).write = orig as unknown as (
        s: string
      ) => boolean;
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
      "utf-8"
    );
    writeFileSync(
      join(d, "zzz-hang.test.ts"),
      "import { beforeAll, test } from 'bun:test';\nbeforeAll(() => new Promise(() => {}));\ntest('never runs', () => {});\n",
      "utf-8"
    );

    const { code, out } = captureStdout(() =>
      main([], realSuiteRunner(d, { testPath: ".", wallClockMs: 8000 }))
    );
    expect(code).toBe(3);
    // The kill fired on the REAL spawn path and the diagnosis feature is alive
    // (the 28472efb regression returned raw:"" here, killing it silently).
    expect(out).toContain("RUN KILLED (ETIMEDOUT)");
    expect(out).toContain("the hung file is the NEXT one");
    expect(out).toContain("aaa-first.test.ts");
    // The kill line names the wall that actually killed the run (#641 C3).
    expect(out).toContain("The wall clock in force was 8000 ms (injected for this run).");
  }, 20000);
});

describe("runIsAccountable (no verdict without accounting)", () => {
  test("missing Ran-line (truncated output) → not accountable", () => {
    const run: SuiteRun = {
      entries: [],
      fail: 0,
      error: 0,
      ranLinePresent: false,
      envGates: [],
      raw: "",
    };
    expect(runIsAccountable(run)).toBe(false);
  });
  test("parsed count below bun's counters (parser blind to a shape) → not accountable", () => {
    const run: SuiteRun = {
      entries: [],
      fail: 2,
      error: 1,
      ranLinePresent: true,
      envGates: [],
      raw: "",
    };
    expect(runIsAccountable(run)).toBe(false);
  });
  test("exact accounting → accountable", () => {
    // 3 entries = 2 named fails + 1 load error; bun double-counts the load
    // error into BOTH counters → fail 3, error 1 (measured bun 1.3.14).
    const run: SuiteRun = {
      entries: ["a", "b", "throws.test.ts: load error #1"],
      fail: 3,
      error: 1,
      ranLinePresent: true,
      envGates: [],
      raw: "",
    };
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
function outputFor(entries: string[], ranFilesOverride?: number): string {
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
      lines.push(
        "# Unhandled error between tests",
        "-------------------------------",
        "error: module-level death"
      );
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
    `Ran ${entries.length} tests across ${ranFilesOverride ?? new Set(entries.map((e) => (e.includes(": load error") ? e.slice(0, e.indexOf(":")) : e.split(" > ")[0]))).size} files. [10.00ms]`
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
    const entries = [
      "fa.test.ts > same > x",
      "fb.test.ts > same > x",
      "throws.test.ts: load error #1",
    ];
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
    const code = main([], () => {
      runs += 1;
      return { raw: outputFor([...base.fails]) };
    });
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
      { classId: "posix-path-shim", notExecuted: 12, budget: false },
      { classId: "live-endpoint-catalog", notExecuted: 2, budget: false },
    ]);
  });

  test("no manifests → empty summary (complete machine)", () => {
    expect(parseEnvGateManifests("no gates here")).toEqual([]);
  });
});

describe("strict-runner consolidated footer vs budget classes (#385 follow-up)", () => {
  // The runner only sees the PRINTED manifest, so the budget kind has to be
  // read off the text. These fixtures are built with the REAL producer
  // (`manifestFooter`) rather than a hand-copied string: if either side's
  // wording drifts, the pin goes red instead of the detector silently
  // matching nothing — the failure mode a copied literal cannot catch.
  function manifestBlock(id: string, n: number, footer: string): string {
    return [
      `[ENV-GATE] ${n} test(s) NOT executed — class '${id}':`,
      "[ENV-GATE]   · some test",
      "[ENV-GATE]   reason: r",
      "[ENV-GATE]   activation: a",
      `[ENV-GATE]   ${footer}`,
    ].join("\n");
  }
  // `kind: BUDGET` (not the literal) keeps the static scan pin in
  // env-gate.test.ts — "only a real budget declaration may carry the
  // exemption" — matching exactly one production file; this is a fixture.
  const BUDGET = "budget" as const;
  const budgetFooter = manifestFooter({
    id: "b",
    active: false,
    reason: "r",
    activation: "a",
    kind: BUDGET,
  });
  const regularFooter = manifestFooter({ id: "r", active: true, reason: "r", activation: "a" });

  const prevCwd = process.cwd();
  const tmpDirs: string[] = [];
  afterEach(() => {
    process.chdir(prevCwd);
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  /** Run main() against a stubbed suite output, returning its stdout. */
  function verdictOutput(envGateBlocks: string[], entries: string[] = ["A > a1"]): string {
    const d = mkdtempSync(join(tmpdir(), "strict-budget-"));
    tmpDirs.push(d);
    writeFileSync(
      join(d, ".test-strict-baseline.json"),
      JSON.stringify({ ...base, fails: entries }),
      "utf-8"
    );
    process.chdir(d);
    const raw = [outputFor(entries), ...envGateBlocks].join("\n");
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(String(s));
      return true;
    };
    try {
      main([], () => ({ raw }));
    } finally {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = orig as unknown as (
        s: string
      ) => boolean;
    }
    return chunks.join("");
  }

  test("the producer's budget footer is what the detector keys on (no copied literal)", () => {
    expect(budgetFooter).toContain(BUDGET_FOOTER_MARKER);
    expect(regularFooter).not.toContain(BUDGET_FOOTER_MARKER);
    const summary = parseEnvGateManifests(manifestBlock("real-cc-e2e", 3, budgetFooter));
    expect(summary).toEqual([{ classId: "real-cc-e2e", notExecuted: 3, budget: true }]);
  });

  test("a budget class in the manifest → the footer no longer claims STRICT=1 fails it", () => {
    const out = verdictOutput([manifestBlock("real-cc-e2e", 3, budgetFooter)]);
    expect(out).toContain("opt-in budget — STRICT=1 never fails it");
    expect(out).toContain("never fails them");
    // The blanket claim is the lie this pin exists to refuse: it must not
    // appear when EVERY listed class is budget-exempt.
    expect(out).not.toContain("fails them instead");
  });

  test("mixed manifest → only the non-budget class carries the strict-fail claim", () => {
    const out = verdictOutput([
      manifestBlock("real-cc-e2e", 3, budgetFooter),
      manifestBlock("posix-path-shim", 6, regularFooter),
    ]);
    expect(out).toContain("fails those instead");
    expect(out).toContain("the 1 opt-in budget class(es) are exempt by design");
  });

  test("control: a manifest with NO budget class keeps the original wording", () => {
    const out = verdictOutput([manifestBlock("posix-path-shim", 6, regularFooter)]);
    expect(out).toContain(
      "(a complete machine runs them all; CLAUDISH_TEST_ENV_STRICT=1 fails them instead)"
    );
    expect(out).not.toContain("budget");
  });
});

// ─── Partitioned mode (#641 C3) ───────────────────────────────────────────────
//
// The cut must be bounded by COUNT (a per-directory cut leaves three
// directories at 119-151 files, inside the crash zone measured at 176); a
// crashed partition must refuse the verdict and name its population; learn and
// verify must provably run the same cut.

describe("planPartitions (count-bounded, never directory-bounded)", () => {
  test("151 files at N=50 → 50/50/50/1, order preserved, nothing lost", () => {
    const files = Array.from({ length: 151 }, (_, i) => `f${String(i).padStart(3, "0")}.test.ts`);
    const parts = planPartitions(files, 50);
    expect(parts.map((p) => p.length)).toEqual([50, 50, 50, 1]);
    expect(parts.flat()).toEqual(files);
  });

  test("120 files from ONE directory at N=50 → 50/50/20 — a directory cut could never shrink this slice", () => {
    // The measured counter-example: src root alone holds 151 files, so any
    // directory-shaped "partition" is not a bound at all.
    const files = Array.from({ length: 120 }, (_, i) => `src/root${i}.test.ts`);
    expect(planPartitions(files, 50).map((p) => p.length)).toEqual([50, 50, 20]);
  });

  test("fewer files than N → a single partition", () => {
    expect(planPartitions(["a.test.ts", "b.test.ts"], 50)).toEqual([["a.test.ts", "b.test.ts"]]);
  });

  test("empty population → no partitions (main refuses separately)", () => {
    expect(planPartitions([], 50)).toEqual([]);
  });

  test("n ≤ 0 or fractional throws (never a silent full-population slice)", () => {
    expect(() => planPartitions(["a.test.ts"], 0)).toThrow();
    expect(() => planPartitions(["a.test.ts"], -1)).toThrow();
    expect(() => planPartitions(["a.test.ts"], 2.5)).toThrow();
  });
});

describe("enumerateTestFiles (the partitioned population)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  test("recursive, test files only, sorted, forward slashes", () => {
    const d = mkdtempSync(join(tmpdir(), "strict-enum-"));
    tmpDirs.push(d);
    mkdirSync(join(d, "sub"));
    mkdirSync(join(d, "sub", "deep"));
    writeFileSync(join(d, "b.test.ts"), "", "utf-8");
    writeFileSync(join(d, "sub", "c.test.tsx"), "", "utf-8");
    writeFileSync(join(d, "sub", "deep", "a.test.mjs"), "", "utf-8");
    writeFileSync(join(d, "helper.ts"), "", "utf-8");
    writeFileSync(join(d, "z.spec.ts"), "", "utf-8"); // .spec is not the population
    const fwd = (p: string) => p.replace(/\\/g, "/");
    expect(enumerateTestFiles(d)).toEqual(
      [
        fwd(join(d, "sub", "deep", "a.test.mjs")),
        fwd(join(d, "b.test.ts")),
        fwd(join(d, "sub", "c.test.tsx")),
      ].sort()
    );
  });

  test("an empty tree → empty population", () => {
    const d = mkdtempSync(join(tmpdir(), "strict-enum-"));
    tmpDirs.push(d);
    expect(enumerateTestFiles(d)).toEqual([]);
  });
});

describe("parsePartitionArg / entryFile / ranLineFileCount / mergeEnvGates", () => {
  test("bare --partition → the default size; =N → N; malformed → invalid; absent → null", () => {
    expect(DEFAULT_PARTITION_SIZE).toBe(50); // the measured starting point, part of the arbitration
    expect(parsePartitionArg([])).toBeNull();
    expect(parsePartitionArg(["--learn"])).toBeNull();
    expect(parsePartitionArg(["--partition"])).toEqual({ n: 50 });
    expect(parsePartitionArg(["--learn", "--partition=30"])).toEqual({ n: 30 });
    for (const bad of [
      "--partition=abc",
      "--partition=0",
      "--partition=-3",
      "--partition=2.5",
      "--partition=",
    ]) {
      expect(parsePartitionArg([bad])).toBe("invalid");
    }
  });

  test("entryFile: named fail AND load-error shapes both reduce to the owning file", () => {
    expect(entryFile("a/b.test.ts > describe > case")).toBe("a/b.test.ts");
    expect(entryFile("a/b.test.ts: load error #2")).toBe("a/b.test.ts");
  });

  test("ranLineFileCount reads M off the Ran line, singular and plural", () => {
    expect(ranLineFileCount("Ran 12 tests across 3 files. [10.00ms]")).toBe(3);
    expect(ranLineFileCount("Ran 1 test across 1 file.")).toBe(1);
    expect(ranLineFileCount("bun test v1.3.14\n(no summary)")).toBeNull();
  });

  test("ranLineFileCount takes the LAST Ran line — a nested child summary must not shadow the parent's", () => {
    // Measured 18/11: a file spawning `bun test <one file>` with inherited
    // stdio (call-abort, client-cancel) prints its own summary BEFORE the
    // parent's final line; the first match echoed "1 file ran" for 50
    // delivered files. The parent's summary is always printed last.
    const raw = [
      "(fail) something",
      " 9 pass",
      " 2 fail",
      "Ran 11 tests across 1 file. [4.25s]",
      " 624 pass",
      " 24 fail",
      "Ran 666 tests across 50 files. [22.64s]",
    ].join("\n");
    expect(ranLineFileCount(raw)).toBe(50);
  });

  test("mergeEnvGates sums counts per class and ORs the budget flag", () => {
    expect(
      mergeEnvGates([
        [{ classId: "x", notExecuted: 3, budget: false }],
        [
          { classId: "x", notExecuted: 4, budget: true },
          { classId: "y", notExecuted: 1, budget: false },
        ],
        [],
      ])
    ).toEqual([
      { classId: "x", notExecuted: 7, budget: true },
      { classId: "y", notExecuted: 1, budget: false },
    ]);
  });
});

describe("main --partition (wiring, injected partitions + tmp cwd)", () => {
  const prevCwd = process.cwd();
  const tmpDirs: string[] = [];
  afterEach(() => {
    process.chdir(prevCwd);
    for (const d of tmpDirs.splice(0)) spawnSync("cmd", ["/c", "rmdir", "/s", "/q", d]);
  });

  function chdirTmp(b?: StrictBaseline): void {
    const d = mkdtempSync(join(tmpdir(), "strict-part-"));
    tmpDirs.push(d);
    if (b) writeFileSync(join(d, BASELINE_PATH), JSON.stringify(b), "utf-8");
    process.chdir(d);
  }

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
      (process.stdout as unknown as { write: (s: string) => boolean }).write = orig as unknown as (
        s: string
      ) => boolean;
    }
  }

  // A PartitionDeps whose every partition comes back accountable, built from a
  // per-file entry map; records every invocation so the tests can count runs.
  function depsFor(
    files: string[],
    entriesByFile: Record<string, string[]>
  ): PartitionDeps & { invocations: string[][] } {
    const invocations: string[][] = [];
    return {
      invocations,
      listFiles: () => files,
      runPartition: (fs) => {
        invocations.push(fs);
        const entries = fs.flatMap((f) => (entriesByFile[f] ?? []).map((n) => `${f} > ${n}`));
        return { raw: outputFor(entries, fs.length) };
      },
    };
  }

  /** Same, but every call for the given file adds a fresh entry (reproduction). */
  function depsWithFresh(
    files: string[],
    baselineFails: Record<string, string[]>,
    freshByFile: Record<string, string[]>
  ): PartitionDeps & { invocations: string[][] } {
    const invocations: string[][] = [];
    return {
      invocations,
      listFiles: () => files,
      runPartition: (fs) => {
        invocations.push(fs);
        const entries = fs.flatMap((f) => [
          ...(baselineFails[f] ?? []).map((n) => `${f} > ${n}`),
          ...(freshByFile[f] ?? []).map((n) => `${f} > ${n}`),
        ]);
        return { raw: outputFor(entries, fs.length) };
      },
    };
  }

  const neverRunner = (): { raw: string } => ({ raw: "" }); // partitioned mode must never call it

  const partBaseline = (fails: string[], n: number, boundaries: string[]): StrictBaseline => ({
    sha: "abc1234",
    capturedAt: "2026-11-18T00:00:00Z",
    fails,
    partition: { n, boundaries },
  });

  test("a malformed --partition value refuses BEFORE enumerating anything (no run started)", () => {
    chdirTmp();
    const deps = depsFor(["a.test.ts"], {});
    const { code, out } = captureStdout(() => main(["--partition=abc"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("--partition expects a positive integer");
    expect(deps.invocations.length).toBe(0);
  });

  test("an empty population refuses (exit 3, no spawn)", () => {
    chdirTmp();
    const deps = depsFor([], {});
    const { code, out } = captureStdout(() => main(["--partition=50"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("NO TEST FILES");
    expect(deps.invocations.length).toBe(0);
  });

  test("a CRASHED partition refuses the verdict, names the partition and its FULL file list, and stops (mutation pin)", () => {
    chdirTmp();
    const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
    const invocations: string[][] = [];
    const deps: PartitionDeps = {
      listFiles: () => files,
      runPartition: (fs, i) => {
        invocations.push(fs);
        // partition 1 (c+d) dies mid-run — partial output only
        if (i === 1)
          return { raw: "c.test.ts:\n(fail) partial [1ms]", killed: true, errorCode: "ETIMEDOUT" };
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("PARTITION 2/2 RUN KILLED");
    // The unknown population is named in full — "partition 2/2" alone tells no one anything
    expect(out).toContain("c.test.ts");
    expect(out).toContain("d.test.ts");
    expect(out).toContain('never "zero fails"');
    // No partition after the crash runs
    expect(invocations.length).toBe(2);
  });

  test("an UNACCOUNTABLE partition refuses the verdict too (accounting gate holds per partition)", () => {
    chdirTmp();
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (_fs, i) =>
        i === 0
          ? { raw: "a.test.ts:\n(fail) ghost > x [1ms]\n 1 fail\nRan 1 tests across 1 files." } // entries 1, fail 1 — fine
          : { raw: "b.test.ts:\n(fail) seen > y [1ms]\n 2 fail\nRan 2 tests across 1 files." }, // parser sees 1, bun says 2
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("PARTITION 2/2 UNACCOUNTABLE");
    expect(out).toContain("b.test.ts");
  });

  test("learn writes the partition manifest (N + boundaries) into the baseline", () => {
    chdirTmp();
    const deps = depsFor(["a.test.ts", "b.test.ts", "c.test.ts"], {
      "a.test.ts": ["a1"],
      "b.test.ts": ["b1"],
    });
    const { code } = captureStdout(() => main(["--learn", "--partition=2"], neverRunner, deps));
    expect(code).toBe(0);
    expect(deps.invocations).toEqual([["a.test.ts", "b.test.ts"], ["c.test.ts"]]);
    const saved = JSON.parse(
      readFileSync(join(process.cwd(), BASELINE_PATH), "utf-8")
    ) as StrictBaseline;
    expect(saved.partition).toEqual({ n: 2, boundaries: ["a.test.ts", "c.test.ts"] });
    expect(saved.fails).toEqual(["a.test.ts > a1", "b.test.ts > b1"]);
  });

  test("observed = UNION of the partitions' entries; disjoint fails across partitions exit 0 when ⊆ baseline", () => {
    chdirTmp(partBaseline(["a.test.ts > a1", "b.test.ts > b1"], 1, ["a.test.ts", "b.test.ts"]));
    const deps = depsFor(["a.test.ts", "b.test.ts"], { "a.test.ts": ["a1"], "b.test.ts": ["b1"] });
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(0);
    expect(out).toContain("failing population observed: 2");
    // exactly one pass — nothing fresh, no confirmation re-run
    expect(deps.invocations.length).toBe(2);
  });

  test("a baseline captured WITHOUT partitions refuses a partitioned verify", () => {
    chdirTmp({ sha: "abc1234", capturedAt: "t", fails: ["a.test.ts > a1"] });
    const deps = depsFor(["a.test.ts"], { "a.test.ts": ["a1"] });
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("captured WITHOUT partitions");
    // fail-fast: the refusal precedes any partition run
    expect(deps.invocations.length).toBe(0);
  });

  test("a verify at a DIFFERENT N than the baseline refuses", () => {
    chdirTmp(partBaseline(["a.test.ts > a1", "b.test.ts > b1"], 2, ["a.test.ts"]));
    const deps = depsFor(["a.test.ts", "b.test.ts"], { "a.test.ts": ["a1"], "b.test.ts": ["b1"] });
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("baseline was partitioned at N=2, this verify runs N=1");
    expect(deps.invocations.length).toBe(0);
  });

  test("boundary drift alone is a WARNING, not a refusal (entries compare by name)", () => {
    // baseline cut at n=1 on [a, b]; the tree today is [a0, a, b] — same N,
    // different cut points (files added since the capture)
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    const deps = depsFor(["a0.test.ts", "a.test.ts", "b.test.ts"], { "a.test.ts": ["a1"] });
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(0);
    expect(out).toContain("boundary drift");
  });

  test("a fresh entry re-runs ONLY the partition hosting it — the clean partition is not re-spawned", () => {
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    // run 1: partition a carries a1 (baseline) + NEW1 (fresh); re-run of a: a1 + NEW1 again (reproduces)
    // the alone-run (3rd call, NEW1 gone) reclassifies it as context-sensitive
    let seenA = 0;
    let aloneA = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        if (fs[0] === "a.test.ts") {
          seenA += 1;
          if (seenA === 3) aloneA += 1; // alone-run carries a1 only (NEW1 gone)
          const fresh = seenA <= 2 ? ["a.test.ts > NEW1"] : [];
          return { raw: outputFor(["a.test.ts > a1", ...fresh], fs.length) };
        }
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("re-running 1/2 partition(s)");
    // a ran twice before the alone-run (first pass + confirmation), b once (never re-run)
    expect(seenA).toBe(3);
    expect(aloneA).toBe(1);
  });

  test("a fresh entry that does NOT reproduce exits 0 (noise, by property not count — holds per partition)", () => {
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    let seenA = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        if (fs[0] === "a.test.ts") {
          seenA += 1;
          // FLAKY appears on the first pass only
          const fresh = seenA === 1 ? ["a.test.ts > FLAKY"] : [];
          return { raw: outputFor(["a.test.ts > a1", ...fresh], fs.length) };
        }
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(0);
    expect(out).toContain("did NOT reproduce");
  });

  test("a FOREIGN entry refuses the first pass (verify path too): exit 3, the foreign file named — no verdict from a population that was never delivered", () => {
    // Review #1114, third review: the old no-blind-spot fallback (re-run
    // everything) lived only on the verify path, and learn never reached it —
    // it is retired. A foreign entry is refused wherever it is parsed; the
    // retry-all escape hatch no longer exists to reach.
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    const deps = depsWithFresh(
      ["a.test.ts", "b.test.ts"],
      { "a.test.ts": ["a1"] },
      { "unmapped/ghost.test.ts": ["g1"] } // entry observed but owning file not in the population
    );
    // depsWithFresh only maps files in the list; simulate the ghost by injecting it into a's output
    const inner = deps.runPartition;
    deps.runPartition = (fs, i, t) => {
      const r = inner(fs, i, t);
      if (fs[0] === "a.test.ts") {
        return { raw: outputFor(["a.test.ts > a1", "unmapped/ghost.test.ts > g1"]) };
      }
      return r;
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("FOREIGN POPULATION");
    // the refusal names the foreign file — "a population" alone tells no one what leaked in
    expect(out).toContain("unmapped/ghost.test.ts");
    // no retry-all was ever armed: the first pass refuses before any re-run
    expect(out).not.toContain("re-running");
    expect(deps.invocations.length).toBe(1); // partition a only (the ghost carrier), partition b never ran
  });

  // ─── Population-gap guard (file 19b items 1+2+3, review #1114) ────────────

  test("an UNEXPLAINED population gap refuses --learn: exit 3 and NO baseline file is written (review defect)", () => {
    chdirTmp();
    // The review's exact shape: 10 files delivered, the engine ran 1 — the echo
    // is a hard mismatch and the missing 9 left no trace (a silent union loss).
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.test.ts`);
    const deps: PartitionDeps = {
      listFiles: () => files,
      runPartition: () => ({ raw: outputFor([], 1) }), // 1 ran, 10 delivered
    };
    const { code, out } = captureStdout(() =>
      main(["--learn", "--partition=50"], neverRunner, deps)
    );
    expect(code).toBe(3);
    expect(out).toContain("POPULATION GAP");
    expect(out).toContain("UNEXPLAINED");
    // the refusal names the lost files — "a gap" alone tells no one what vanished
    expect(out).toContain("f0.test.ts");
    // NO baseline file was written — the empty union must never become the reference
    expect(existsSync(join(process.cwd(), BASELINE_PATH))).toBe(false);
  });

  test("a gap fully EXPLAINED by module-load-dead files is NOT a refusal (learn proceeds, the gap is named)", () => {
    chdirTmp();
    // a carries a real fail; b died at module load (a load-error entry names it,
    // and bun does NOT count it in the echo) → delivered 2, ran 1, explained.
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: () => ({
        raw: outputFor(["a.test.ts > a1", "b.test.ts: load error #1"], 1),
      }),
    };
    const { code, out } = captureStdout(() =>
      main(["--learn", "--partition=50"], neverRunner, deps)
    );
    expect(code).toBe(0);
    expect(out).toContain("EXPLAINED");
    expect(out).toContain("b.test.ts");
    expect(existsSync(join(process.cwd(), BASELINE_PATH))).toBe(true);
  });

  test("the CONFIRMATION pass holds the same gap guard — an entry whose file never ran is never classified flaky", () => {
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (fs[0] === "a.test.ts") {
          // first pass: a runs, carries a1 + a FRESH entry
          if (pass === 1)
            return { raw: outputFor(["a.test.ts > a1", "a.test.ts > NEW1"], fs.length) };
          // confirmation pass: a's output loses its echo (delivered 1, ran 0) —
          // NEW1 absent would otherwise read as "flaky, did not reproduce"
          return { raw: outputFor([], 0) };
        }
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("POPULATION GAP in confirmation");
    expect(out).toContain("never ran");
    expect(out).not.toContain("flaky tail");
  });

  // ─── Population over-count guard (file 19d item 1, review #1114 second review) ──

  test("an over-counting echo (3 attested / 2 delivered) refuses --learn: exit 3 and NO baseline (review witness)", () => {
    chdirTmp();
    // The second review's exact shape: 2 files delivered, an otherwise
    // accountable summary whose echo says "Ran N tests across 3 files". The
    // old `>=` read "3 >= 2" as coverage, --learn printed "EXPLAINED by 0
    // files", wrote an EMPTY baseline and returned 0 — three files cannot
    // attest the execution of exactly the two delivered.
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: () => ({ raw: outputFor([], 3) }), // 0 entries, echo says 3 files
    };
    const { code, out } = captureStdout(() =>
      main(["--learn", "--partition=50"], neverRunner, deps)
    );
    expect(code).toBe(3);
    expect(out).toContain("POPULATION OVER-COUNT");
    // the refusal states WHY an over-count is not coverage, not just "3 != 2"
    expect(out).toContain("cannot attest this run's population");
    expect(existsSync(join(process.cwd(), BASELINE_PATH))).toBe(false);
  });

  test("the CONFIRMATION pass holds the same over-count gate — no flaky verdict from an echo that outruns its delivery", () => {
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (fs[0] === "a.test.ts") {
          // first pass: healthy echo + a fresh entry; confirmation: 2 attested /
          // 1 delivered with entries naming only that file — NEW1's absence
          // would otherwise read as "flaky, did not reproduce"
          if (pass === 1)
            return { raw: outputFor(["a.test.ts > a1", "a.test.ts > NEW1"], fs.length) };
          return { raw: outputFor(["a.test.ts > a1"], fs.length + 1) };
        }
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("POPULATION OVER-COUNT in confirmation");
    expect(out).not.toContain("flaky tail");
  });

  test("carve-out division of labor: an entry-explained echo is NOT an over-count — the ghost is a FOREIGN entry, refused by its own guard", () => {
    // 1 delivered, entries name a.test.ts + a file outside the delivery, echo
    // == 2 == entry-file count: numerically consistent, so populationEchoOverCounts
    // rightly declines it (only an echo beyond BOTH delivery and entries is an
    // over-count). The ghost is not tolerated anywhere though — since review
    // #1114's third return, foreignEntryFiles owns that shape (the retired
    // retry-all fallback used to).
    const ghostRaw = outputFor(["a.test.ts > a1", "unmapped/ghost.test.ts > g1"]);
    const parsed = parseRunOutput(ghostRaw);
    expect(ranLineFileCount(ghostRaw)).toBe(2); // echo == entry-file count
    expect(populationEchoOverCounts(["a.test.ts"], ranLineFileCount(ghostRaw), parsed)).toBe(false);
    // the SAME parsed run is caught by the foreign guard: the two predicates
    // partition the defect space without overlap or hole
    expect(foreignEntryFiles(["a.test.ts"], parsed)).toEqual(["unmapped/ghost.test.ts"]);
    // the review-2 witness shape, by contrast, IS an over-count on both axes
    // (and names nothing foreign — zero entries to name)
    const witnessRaw = outputFor([], 3);
    expect(
      populationEchoOverCounts(
        ["a.test.ts", "b.test.ts"],
        ranLineFileCount(witnessRaw),
        parseRunOutput(witnessRaw)
      )
    ).toBe(true);
  });

  test("GitHub Actions group framing: a `::group::<file>:` header keys entries to the file, never to a foreign name (macOS CI, measured 24/11)", () => {
    // The producer's framing, not a fixture quirk: on a GHA runner (macOS
    // shard, bun 1.4.0) the child bun prints `::group::b.test.ts:`, and a raw
    // parser keyed on `^(.+\.test\.):$` captures the prefix — the entry then
    // names `::group::b.test.ts`, outside the delivery, and the run is refused
    // FOREIGN (exit 3) although the population is exactly the one delivered.
    // Windows emits no group line under either bun version, with
    // GITHUB_ACTIONS=true and without, so this shape had to be pinned from
    // the job log rather than from a local probe.
    const ghaRaw = [
      "::group::a.test.ts:",
      "(pass) a poisons [0.10ms]",
      "",
      "::group::b.test.ts:",
      "(fail) b reads the marker [0.50ms]",
      "",
      " 1 pass",
      " 1 fail",
      "Ran 2 tests across 2 files.",
      "::endgroup::",
      "",
    ].join("\n");
    const parsed = parseRunOutput(ghaRaw);
    expect(parsed.entries).toEqual(["b.test.ts > b reads the marker"]);
    expect(runIsAccountable(parsed)).toBe(true);
    expect(foreignEntryFiles(["a.test.ts", "b.test.ts"], parsed)).toEqual([]);
    // control: the prefix is what made it foreign — stripping it by hand
    // gives the same parse, so the assertion cannot pass on a parser that
    // simply ignores the line
    expect(parseRunOutput(ghaRaw.replaceAll("::group::", "")).entries).toEqual(parsed.entries);
  });

  // ─── Foreign population guard (file 20a items 1+2+3, review #1114 third return) ──

  test("a foreign entry refuses --learn: exit 3 and NO baseline — the review-3 witness (1 delivered, ghost written into the baseline, was exit 0)", () => {
    chdirTmp();
    // The third review's exact shape on 33955107: 1 delivered a.test.ts,
    // accountable output with failed entries for a.test.ts AND ghost.test.ts,
    // echo 2. Every count guard passed (echo == entry-file count), the old
    // retry-all fallback lives only on the verify path, so --learn wrote BOTH
    // entries into the baseline and returned 0.
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts"],
      runPartition: () => ({
        raw: outputFor(["a.test.ts > a1", "ghost.test.ts > g1"]), // echo 2, accountable
      }),
    };
    const { code, out } = captureStdout(() =>
      main(["--learn", "--partition=2"], neverRunner, deps)
    );
    expect(code).toBe(3);
    expect(out).toContain("FOREIGN POPULATION");
    expect(out).toContain("ghost.test.ts");
    expect(existsSync(join(process.cwd(), BASELINE_PATH))).toBe(false);
  });

  test("the CONFIRMATION pass holds the same foreign gate — a ghost in the re-run is never evidence of non-reproduction", () => {
    chdirTmp(partBaseline(["a.test.ts > a1"], 1, ["a.test.ts", "b.test.ts"]));
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (fs[0] === "a.test.ts") {
          // first pass: clean echo + a fresh entry; confirmation: the re-run of
          // partition a carries a ghost entry — NEW1's absence would otherwise
          // read as "flaky, did not reproduce" from a population that was
          // never delivered
          if (pass === 1)
            return { raw: outputFor(["a.test.ts > a1", "a.test.ts > NEW1"], fs.length) };
          return { raw: outputFor(["a.test.ts > a1", "ghost.test.ts > g1"]) }; // echo 2 == entry-file count: count guards all pass
        }
        return { raw: outputFor([], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=1"], neverRunner, deps));
    expect(code).toBe(3);
    expect(out).toContain("FOREIGN POPULATION in confirmation");
    expect(out).toContain("ghost.test.ts");
    expect(out).not.toContain("flaky tail");
  });

  // ─── Context sensitivity (#641 C4, file 24a item 2) ───────────────────────
  // A reproduced entry is not necessarily a defect in its own right: REQ-9 of
  // script-runtime failed inside its partition AND on that partition's
  // confirmation re-run, then passed alone (41/41, 6.45 s — measured by ai-01).
  // The third run is the file ALONE, one per distinct file hosting a
  // reproduced entry. Exit stays 1: context sensitivity is not a green.

  /** Deps for the three-pass shape: the first two runs carry a fresh entry,
   * the third (the file alone) carries what `aloneByFile` says. */
  function depsWithAlone(
    files: string[],
    freshByFile: Record<string, string[]>,
    aloneByFile: Record<string, string[]>
  ): PartitionDeps & { invocations: string[][] } {
    const invocations: string[][] = [];
    return {
      invocations,
      listFiles: () => files,
      runPartition: (fs) => {
        invocations.push(fs);
        if (fs.length === 1) {
          const f = fs[0];
          return { raw: outputFor(aloneByFile[f] ?? [], 1) };
        }
        const entries = fs.flatMap((f) => (freshByFile[f] ?? []).map((n) => `${f} > ${n}`));
        return { raw: outputFor(entries, fs.length) };
      },
    };
  }

  test("a reproduced entry that PASSES when its file runs ALONE is labeled context-sensitive, NOT NEW FAILING — exit stays 1 (the REQ-9 case)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    const deps = depsWithAlone(
      ["a.test.ts", "b.test.ts"],
      { "a.test.ts": ["NEW1"] }, // fresh on the first pass AND on the confirmation
      { "a.test.ts": [] } // alone: the file is green
    );
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1); // a label change is never a green
    expect(out).toContain("context-sensitive");
    expect(out).toContain("a.test.ts > NEW1"); // named with its label
    expect(out).not.toContain("NEW FAILING");
    // three runs: the partition, its confirmation, then a.test.ts ALONE
    expect(deps.invocations).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["a.test.ts", "b.test.ts"],
      ["a.test.ts"],
    ]);
  });

  test("a reproduced entry that still FAILS alone stays NEW FAILING, exit 1 (a true new red is not excused)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    const deps = depsWithAlone(
      ["a.test.ts", "b.test.ts"],
      { "a.test.ts": ["NEW1"] },
      { "a.test.ts": ["a.test.ts > NEW1"] }
    );
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("NEW FAILING");
    expect(out).not.toContain("context-sensitive");
    expect(deps.invocations).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["a.test.ts", "b.test.ts"],
      ["a.test.ts"],
    ]);
  });

  test("two files hosting context-sensitive entries are each re-run ALONE once — one third run per distinct file, never one per entry", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts", "c.test.ts"]));
    const deps = depsWithAlone(
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
      { "a.test.ts": ["A1", "A2"], "c.test.ts": ["C1"] },
      {}
    );
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("context-sensitive");
    expect(out).toContain("2 file(s)");
    // a alone, c alone (a carries TWO entries but is re-run once) — after the
    // 2 partitions and their 2 confirmations
    expect(deps.invocations.slice(4)).toEqual([["a.test.ts"], ["c.test.ts"]]);
    expect(deps.invocations.length).toBe(6);
  });

  test("context-sensitive entries leave the NEW FAILING header — a label is a reclassification, exit stays 1", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    const deps = depsWithAlone(
      ["a.test.ts", "b.test.ts"],
      { "a.test.ts": ["NEW1"] },
      { "a.test.ts": [] }
    );
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("CONTEXT-SENSITIVE");
    expect(out).not.toContain("NEW FAILING");
  });

  test("a reproduced entry whose file dies when run ALONE stays NEW FAILING, and the line names the reason (an unreadable third run excuses nothing)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        // passes 1-2: the partition and its confirmation carry both entries;
        // pass 3 = a alone (an injected errorCode), pass 4 = b alone (killed,
        // no code — the `?? "killed"` fallback)
        if (pass === 3) return { raw: "", killed: true, errorCode: "ETIMEDOUT" };
        if (pass === 4) return { raw: "", killed: true };
        return { raw: outputFor(["a.test.ts > NEW1", "b.test.ts > NEW2"], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("NEW FAILING");
    expect(out).not.toContain("context-sensitive");
    // The reason, not just the outcome: the generic "unaccountable output"
    // line is reached by the same empty raw, so asserting only "could not be
    // read" would let `if (run.killed)` be deleted with every pin still green
    // (review ai-01 on #1184, second surviving mutant).
    expect(out).toContain("could not be read (ETIMEDOUT)");
    expect(out).toContain("could not be read (killed)");
  });

  test("an alone-run keyed to ANOTHER file excuses nothing: the entries stay NEW FAILING and the line names the mismatch (the ::group:: framing CI hit)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    // Accountable counters, correct echo — the ONE thing wrong is that the
    // entry belongs to ghost.test.ts, not to the file the run was given. This
    // is the real CI shape (the parser strips `::group::`, so a framing
    // variant can key entries to a foreign name and every count still adds up).
    const foreignRaw = [
      "::group::ghost.test.ts:",
      "(fail) g1 [1.00ms]",
      "",
      " 1 fail",
      " 0 error",
      "Ran 1 test across 1 file. [10.00ms]",
      "::endgroup::",
    ].join("\n");
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (pass === 3) return { raw: foreignRaw }; // pass 3 = a.test.ts ALONE
        return { raw: outputFor(["a.test.ts > NEW1"], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    // Without the foreign-entry guard, NEW1 is simply absent from `alone` and
    // gets labeled CONTEXT-SENSITIVE — exit still 1, but the label sends the
    // reader to the wrong suspect (review ai-01 on #1184, first surviving mutant).
    expect(out).toContain("NEW FAILING");
    expect(out).toContain("a.test.ts > NEW1");
    expect(out).not.toContain("context-sensitive");
    expect(out).toContain("alone-run of a.test.ts could not be read");
    expect(out).toContain("population mismatch");
  });

  // ─── The alone-run's three readability guards, one witness each ───────────
  // ai-01's mutation run on #1184 killed three of six mutants and left exactly
  // these three alive: M3 `!runIsAccountable`, M4 `populationEchoOverCounts`,
  // M5 `populationGapUnexplained` could each be DELETED with the whole file
  // still 73/0. The foreign-entry guard was the only one with a witness, and
  // its test is the shape copied here: an alone-run that is GREEN for the entry
  // under test (so no other condition stops it) but that cannot be READ. Each
  // fixture below is wrong in exactly one way, so the pin that reddens names one
  // guard and not its neighbours.

  /** Hand-built alone-run output: named failures, the summary counters bun
   * prints, and its population echo. Every knob exists so a fixture can be made
   * unreadable along ONE axis only. */
  function aloneRun(named: string[], fails: number, echoFiles: number): string {
    const lines = ["bun test v1.3.14", ""];
    let file = "";
    for (const e of named) {
      const [f, n] = e.split(" > ");
      if (f !== file) {
        file = f;
        lines.push(`${f}:`);
      }
      lines.push(`(fail) ${n} [1.00ms]`);
    }
    lines.push(
      "",
      ` ${fails} fail`,
      " 0 error",
      `Ran 3 tests across ${echoFiles} file${echoFiles === 1 ? "" : "s"}. [10.00ms]`
    );
    return lines.join("\n");
  }

  test("an alone-run whose summary and named entries disagree excuses nothing: the entry stays NEW FAILING (the C4 guard that survived removal)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    // One named entry, two reported failures: the torn / truncated stream
    // `runIsAccountable` exists for. The echo is right and no name is foreign,
    // so the other two guards stay silent — without the accountability check,
    // NEW1 simply is not in `alone` and gets labeled CONTEXT-SENSITIVE on output
    // the parser and bun disagreed about.
    const torn = aloneRun(["a.test.ts > other"], 2, 1);
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (pass === 3) return { raw: torn }; // pass 3 = a.test.ts ALONE
        return { raw: outputFor(["a.test.ts > NEW1"], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("NEW FAILING");
    expect(out).toContain("a.test.ts > NEW1");
    expect(out).not.toContain("context-sensitive");
    expect(out).toContain("alone-run of a.test.ts could not be read");
  });

  test("an alone-run echoing MORE files than it was given excuses nothing: the entry stays NEW FAILING (over-count guard)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    // Accountable counters (zero named failures, zero reported), but the echo
    // claims two files for a one-file run: three files cannot attest exactly
    // one. Deleting `populationEchoOverCounts` reads the surplus as coverage.
    const overCounted = aloneRun([], 0, 2);
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (pass === 3) return { raw: overCounted };
        return { raw: outputFor(["a.test.ts > NEW1"], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("NEW FAILING");
    expect(out).not.toContain("context-sensitive");
    expect(out).toContain("alone-run of a.test.ts could not be read");
  });

  test("an alone-run that never attests having run the file excuses nothing: the entry stays NEW FAILING (population-gap guard)", () => {
    chdirTmp(partBaseline([], 2, ["a.test.ts"]));
    // The echo says ZERO files ran while the run was handed one, and nothing
    // explains the missing file (no load-error entry names it). Deleting
    // `populationGapUnexplained` turns "the file may not have run at all" into
    // "the entry passed there" — the silent population loss of review #1114.
    const ranNothing = aloneRun([], 0, 0);
    let pass = 0;
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        pass += 1;
        if (pass === 3) return { raw: ranNothing };
        return { raw: outputFor(["a.test.ts > NEW1"], fs.length) };
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=2"], neverRunner, deps));
    expect(code).toBe(1);
    expect(out).toContain("NEW FAILING");
    expect(out).not.toContain("context-sensitive");
    expect(out).toContain("alone-run of a.test.ts could not be read");
  });

  test("REAL defaultPartitionDeps wiring: an entry that reproduces in its partition and passes alone is CONTEXT-SENSITIVE, exit 1 — no injected runPartition", () => {
    // The alone-run reaches `realSuiteRunner` through `defaultPartitionDeps`
    // (testFiles), which every injected-deps pin above skips. Two REAL bun
    // files: `a` leaves a disk marker, `b` reads it — the only poison is
    // intra-process (a runs before b in the same partition process). In the
    // partition and on its confirmation b is red; alone (marker cleaned by the
    // runPartition wrapper, which is exactly the caller's own precondition)
    // b is green. Same shape as the REQ-9 case, without depending on its
    // timing-dependent red (measured on po-2024: 3 reds in the first 6 runs
    // after install, 0 in the following 20 — see the PR).
    const d = mkdtempSync(join(tmpdir(), "strict-ctx-real-"));
    tmpDirs.push(d);
    writeFileSync(
      join(d, "a.test.ts"),
      'import { test } from "bun:test"; import { writeFileSync } from "node:fs"; import { join } from "node:path";\n' +
        'test("a poisons", () => { writeFileSync(join(process.cwd(), "poison.marker"), "x", "utf-8"); });\n',
      "utf-8"
    );
    writeFileSync(
      join(d, "b.test.ts"),
      'import { test, expect } from "bun:test"; import { existsSync } from "node:fs"; import { join } from "node:path";\n' +
        'test("b reads the marker", () => { expect(existsSync(join(process.cwd(), "poison.marker"))).toBe(false); });\n',
      "utf-8"
    );
    chdirTmp(partBaseline([], 50, ["a.test.ts"]));
    const deps: PartitionDeps = {
      listFiles: () => ["a.test.ts", "b.test.ts"],
      runPartition: (fs) => {
        // clean slate per process: the poison is intra-process only
        rmSync(join(d, "poison.marker"), { force: true });
        return realSuiteRunner(d, { testFiles: fs })();
      },
    };
    const { code, out } = captureStdout(() => main(["--partition=50"], neverRunner, deps));
    // The runner's own lines were captured, so a refusal here would otherwise
    // reach the CI log as a bare "Received: 3". Re-emit on refusal: which
    // guard fired (foreign entry, counters, population gap) must be readable
    // from the job itself, not re-derived from the platform.
    if (code !== 1) process.stdout.write(out);
    expect(code).toBe(1); // context sensitivity is never a green
    expect(out).toContain("CONTEXT-SENSITIVE");
    expect(out).toContain("b.test.ts > b reads the marker");
    expect(out).not.toContain("NEW FAILING");
  }, 60_000);

  test("portable concrete control: realSuiteRunner's per-file selection runs TWO real Bun test files and the echo covers both", () => {
    // File 19b item 4: a real `bun test ./a ./b` invocation, no learn. Two
    // minimal real files in a tmp tree, run through the PRODUCTION runner's
    // file-list path, and the Ran echo must count BOTH. This is the concrete
    // witness that the multi-file union holds on this seat's bun.
    const d = mkdtempSync(join(tmpdir(), "strict-sel-"));
    tmpDirs.push(d);
    writeFileSync(
      join(d, "one.test.ts"),
      'import { test, expect } from "bun:test"; test("one", () => { expect(1).toBe(1); });\n'
    );
    writeFileSync(
      join(d, "two.test.ts"),
      'import { test, expect } from "bun:test"; test("two", () => { expect(2).toBe(2); });\n'
    );
    const run = realSuiteRunner(d, { testFiles: ["one.test.ts", "two.test.ts"] })();
    expect(run.killed ?? false).toBe(false);
    const parsed = parseRunOutput(run.raw);
    expect(ranLineFileCount(run.raw)).toBe(2);
    expect(
      populationGapUnexplained(["one.test.ts", "two.test.ts"], ranLineFileCount(run.raw), parsed)
    ).toEqual([]);
  }, 30_000);
});
