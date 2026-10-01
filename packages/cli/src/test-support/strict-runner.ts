/**
 * Strict-mode test runner (#175 deliverable 4): runs the suite bounded, parses
 * the failing population BY NAME, and compares it against this machine's
 * systematic-fail baseline instead of against zero.
 *
 * Doctrine (dispatch 2026-09-29): a review needs to answer ONE question —
 * "did my change add a failing test that was not already failing?" A bare
 * `bun test` cannot answer it: the systematic population is machine-dependent
 * (PATH corruption from earlier files, mock.module leakage, live endpoints),
 * and the flaky tail (1-2 tests/run, a different one each time) is noise, not
 * regression. This runner makes the dependency loud:
 *
 *   - new fails that REPRODUCE on a confirmation re-run  → exit 1, names printed
 *   - baseline fails that vanished                      → noted (run --learn to refresh)
 *   - module-load deaths                                → named per file, counted like fails
 *   - ENV-GATE manifests                                → consolidated into one end-of-run
 *                                                          block, counted, with classes
 *
 * The baseline is per-machine by design (`.test-strict-baseline.json`, git
 * ignored): po-204 and ai-01 have different systematic populations and neither
 * is wrong. `--learn` captures it. The exit criterion is subset-vs-baseline,
 * never zero — classes 2/2b (stale contract, win32 defect) STAY red and stay
 * in the baseline; hiding them is what this gate must never do.
 *
 * What a verdict requires (review 2026-10-01, both defects measured): the
 * parsed entries must account for bun's own `fail` + `error` counters, and the
 * `Ran N tests across M files` line must be present (its absence means the
 * output was truncated — crash, or ENOBUFS past maxBuffer). Anything
 * unaccounted is NO VERDICT (exit 3), the same discipline as a wall-clock
 * kill: a green that cannot see a file dying at import is worse than no gate.
 *
 * The flaky tolerance is by REPRODUCTION, never by count: when fresh fails
 * exist, the suite is re-run once and only the names present in BOTH runs are
 * regressions. A deterministic new red cannot hide behind two slots — a fail
 * that reproduces is a regression whatever the count, one that does not is
 * noise.
 *
 * Usage:
 *   bun run packages/cli/src/test-support/strict-runner.ts            # compare
 *   bun run packages/cli/src/test-support/strict-runner.ts --learn    # capture
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASELINE_PATH = ".test-strict-baseline.json";
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

export interface StrictBaseline {
  /** commit the baseline was captured on, for staleness checks */
  sha: string;
  capturedAt: string;
  /** failing entries, sorted: "file > describe > test" or "file: load error #N" */
  fails: string[];
}

export interface EnvGateSummaryEntry {
  classId: string;
  notExecuted: number;
}

export interface SuiteRun {
  /** failing entries keyed "file > name" (+ load-error entries) */
  entries: string[];
  /** bun's own summary counters, when present in the output */
  fail: number;
  error: number;
  /** null when the "Ran N tests across M files" line is absent (truncated output) */
  ranLinePresent: boolean;
  envGates: EnvGateSummaryEntry[];
  raw: string;
}

export interface StrictVerdict {
  /** entries observed on the first run */
  observed: string[];
  /** baseline entries not observed (informational) */
  resolved: string[];
  /** fresh entries that REPRODUCED on the confirmation run — the regression signal */
  regressions: string[];
  /** fresh entries that did NOT reproduce (the flaky tail, by property not count) */
  flakyTail: string[];
  /** true when a confirmation re-run happened */
  confirmed: boolean;
  envGates: EnvGateSummaryEntry[];
  exitCode: number;
}

/** Strip the trailing duration bun appends: "(fail) name > case [12.34ms]" */
export function normalizeFailLine(line: string): string | null {
  const m = line.match(/^\((?:fail|error)\)\s*(.+?)\s*(?:\[[\d.]+m?s\])?\s*$/);
  return m ? m[1] : null;
}

/** Aggregate the per-file ENV-GATE manifests into one summary list. */
export function parseEnvGateManifests(raw: string): EnvGateSummaryEntry[] {
  const byClass = new Map<string, number>();
  const re = /\[ENV-GATE\] (\d+) test\(s\) NOT executed — class '([^']+)':/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const n = Number(m[1]);
    byClass.set(m[2], (byClass.get(m[2]) ?? 0) + n);
  }
  return [...byClass.entries()]
    .map(([classId, notExecuted]) => ({ classId, notExecuted }))
    .sort((a, b) => b.notExecuted - a.notExecuted);
}

const FILE_HEADER_RE = /^(.+\.test\.[cm]?[jt]sx?):\s*$/;
const UNHANDLED_RE = /^# Unhandled error between tests/;

/**
 * Parse a real `bun test` output into named failing entries.
 *
 * Two entry shapes exist and both must be counted:
 *  - named fails:   "(fail) describe > test [1.23ms]" — keyed on the file
 *    header that precedes the block, because two files can host the same
 *    describe path (review 2026-10-01: keying on the name alone collapses
 *    them and lets a new red hide behind a same-named baseline entry);
 *  - module-load deaths: a `# Unhandled error between tests` block under a
 *    file header emits NO (fail) line at all — the entry is synthesized as
 *    "<file>: load error #N" so it enters the baseline and the comparison
 *    by name instead of silently vanishing the whole file (the green-verdict
 *    defect the review measured: a broken import turns every test of the
 *    file into "resolved").
 */
export function parseRunOutput(raw: string): SuiteRun {
  const entries: string[] = [];
  let currentFile = "";
  let loadErrorsInFile = 0;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(FILE_HEADER_RE);
    if (header) {
      currentFile = header[1].replace(/\\/g, "/");
      loadErrorsInFile = 0;
      continue;
    }
    if (UNHANDLED_RE.test(line)) {
      if (currentFile === "") continue; // stray block with no owning file — unkeyable
      loadErrorsInFile += 1;
      entries.push(`${currentFile}: load error #${loadErrorsInFile}`);
      continue;
    }
    const name = normalizeFailLine(line);
    if (name !== null) {
      entries.push(currentFile ? `${currentFile} > ${name}` : name);
    }
  }
  const fail = Number(raw.match(/^\s*(\d+) fail\b/m)?.[1] ?? -1);
  const error = Number(raw.match(/^\s*(\d+) errors?\b/m)?.[1] ?? 0);
  const ranLinePresent = /^Ran \d+ tests? across \d+ files?\./m.test(raw);
  return { entries, fail, error, ranLinePresent, envGates: parseEnvGateManifests(raw), raw };
}

/**
 * The completeness gate: parsed entries must account for bun's own counters.
 * bun 1.3.14 double-counts a module-load death (one `# Unhandled error`
 * block increments BOTH the `fail` and the `error` summary counters —
 * measured on a good+throws tree: "1 pass / 1 fail / 1 error" for exactly
 * one synthesized entry), so the invariant is `entries === max(fail, error)`:
 * N named fails + M load errors must cover the larger of the two counters.
 * A `fail` missing (-1), an absent `Ran` line (truncated output), or a
 * mismatch means the parser and bun disagree about what failed — no verdict
 * can be drawn (exit 3), exactly like a wall-clock kill. Trusting a parser
 * over the producer's own summary is how a truncated output turns into a
 * false green.
 */
export function runIsAccountable(run: SuiteRun): boolean {
  if (!run.ranLinePresent) return false;
  if (run.fail < 0) return false;
  return run.entries.length === Math.max(run.fail, run.error);
}

/**
 * The reproduction rule: a fresh entry that reproduces on the confirmation
 * run is a regression whatever the count; one that does not is noise. This is
 * the property the body names ("a different test each time") — a count-based
 * tolerance cannot tell a deterministic new red from noise and excused exactly
 * that in review.
 */
export function splitFreshByReproduction(fresh1: string[], fresh2: string[]): {
  regressions: string[];
  flakyTail: string[];
} {
  const set2 = new Set(fresh2);
  const regressions = fresh1.filter((n) => set2.has(n));
  const flakyTail = fresh1.filter((n) => !set2.has(n));
  return { regressions, flakyTail };
}

/**
 * Baseline diff, pure so its verdict logic is unit-testable.
 * (The confirmation re-run that qualifies `fresh` happens in main.)
 */
export function diffAgainstBaseline(
  observed: string[],
  baseline: StrictBaseline,
): { fresh: string[]; resolved: string[] } {
  const base = new Set(baseline.fails);
  const obs = new Set(observed);
  return {
    fresh: observed.filter((n) => !base.has(n)),
    resolved: baseline.fails.filter((n) => !obs.has(n)),
  };
}

type SuiteRunner = () => { raw: string; killed?: boolean; errorCode?: string };

function realSuiteRunner(cwd: string): SuiteRunner {
  return () => {
    // Bounded by default: an unbounded suite cannot back a review verdict (a
    // single network-hanging test stalls it past any usable wall clock —
    // measured 2026-09-29: unbounded run looped >35 min, bounded finished in 145 s).
    // The wall-clock bound exists because bun's --timeout covers TESTS, not
    // hooks: a beforeAll stuck on a network call hangs the run with no per-test
    // timeout to save it. Killed ≠ verdict.
    //
    // Scope to src/: a compiled dist/ in the tree gets picked up by a bare
    // `bun test` and its compiled tests fail en masse on fixture/import
    // resolution they were never meant to survive (the documented
    // tool-choice-mapping/dist class — measured 2026-10-01: a fresh tsc emit
    // inflated the failing population from 9 to 52 without a single source
    // change). The dist is a build artifact, not a test population.
    const WALL_CLOCK_MS = 420_000;
    const r = spawnSync(
      process.execPath,
      ["test", "packages/cli/src", "--timeout", String(DEFAULT_TEST_TIMEOUT_MS)],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, cwd, timeout: WALL_CLOCK_MS },
    );
    if (r.error) return { raw: "", killed: true, errorCode: (r.error as NodeJS.ErrnoException).code ?? "?" };
    return { raw: (r.stdout ?? "") + (r.stderr ?? "") };
  };
}

function currentSha(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
  return (r.stdout ?? "").trim() || "unknown";
}

function printVerdict(v: StrictVerdict, hadBaseline: boolean): void {
  const line = (s: string) => process.stdout.write(s + "\n");
  line("");
  line("── [STRICT] end-of-run manifest " + "─".repeat(20));
  if (v.envGates.length > 0) {
    const total = v.envGates.reduce((s, e) => s + e.notExecuted, 0);
    line(`[STRICT] ${total} test(s) NOT executed, per environment class:`);
    for (const e of v.envGates) line(`[STRICT]   · ${e.classId}: ${e.notExecuted}`);
    line(`[STRICT]   (a complete machine runs them all; CLAUDISH_TEST_ENV_STRICT=1 fails them instead)`);
  } else {
    line("[STRICT] 0 environment-gated tests — every class active on this machine");
  }
  line(`[STRICT] failing population observed: ${v.observed.length}`);
  for (const n of v.observed) line(`[STRICT]   · ${n}`);
  if (!hadBaseline) {
    line(`[STRICT] NO BASELINE (${BASELINE_PATH}) — capture one with --learn, then re-run to compare.`);
    return;
  }
  if (v.confirmed) {
    line(`[STRICT] fresh entries triggered a confirmation re-run:`);
    if (v.flakyTail.length > 0) {
      line(`[STRICT] flaky tail (did NOT reproduce — noise): ${v.flakyTail.length}`);
      for (const n of v.flakyTail) line(`[STRICT]   · ${n}`);
    } else {
      line(`[STRICT] flaky tail: 0 (every fresh entry reproduced)`);
    }
    if (v.regressions.length > 0) {
      line(`[STRICT] 🔴 NEW FAILING TESTS (reproduced on the confirmation run): ${v.regressions.length}`);
      for (const n of v.regressions) line(`[STRICT]   · ${n}`);
    } else {
      line(`[STRICT] ✅ no regression: every fresh entry failed to reproduce`);
    }
  } else if (v.flakyTail.length > 0) {
    line(`[STRICT] flaky tail (within tolerance, not regression): ${v.flakyTail.length}`);
    for (const n of v.flakyTail) line(`[STRICT]   · ${n}`);
  } else {
    line(`[STRICT] ✅ no regression: observed ⊆ baseline`);
  }
  if (v.resolved.length > 0) {
    line(`[STRICT] baseline fails NOT observed this run (improvement? refresh with --learn): ${v.resolved.length}`);
    for (const n of v.resolved) line(`[STRICT]   · ${n}`);
  }
}

function printKill(errorCode: string, raw: string): void {
  process.stdout.write(
    `[STRICT] 🔴 RUN KILLED (${errorCode}) — no verdict can be drawn from a killed run; ` +
      `re-run (the flaky tail is exactly this class of event).\n`,
  );
  // Diagnosis: the last file that produced output is the usual suspect —
  // spawnSync's buffers hold whatever was read before the kill, so surface
  // it instead of leaving the hung hook nameless.
  const tail = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("[ENV-GATE]"))
    .slice(-15);
  if (tail.length > 0) {
    process.stdout.write(`[STRICT] last output before the kill (diagnosis):\n`);
    for (const l of tail) process.stdout.write(`[STRICT] | ${l.slice(0, 160)}\n`);
  }
}

export function main(argv: string[], runSuite: SuiteRunner = realSuiteRunner(process.cwd())): number {
  const learn = argv.includes("--learn");
  const cwd = process.cwd();

  const run1 = runSuite();
  if (run1.killed) {
    printKill(run1.errorCode ?? "killed", run1.raw);
    return 3;
  }
  const parsed1 = parseRunOutput(run1.raw);
  if (!runIsAccountable(parsed1)) {
    process.stdout.write(
      `[STRICT] 🔴 NO VERDICT — parsed entries (${parsed1.entries.length}) do not account for bun's own ` +
        `counters (fail=${parsed1.fail}, error=${parsed1.error}, ran-line ${parsed1.ranLinePresent ? "present" : "ABSENT"}).\n` +
        `[STRICT]   A gap means the parser is blind to a failure shape (module-load death, truncated ` +
        `output past maxBuffer) — trusting it would print a false green. Fix the parser, re-run.\n`,
    );
    return 3;
  }
  const observed = [...new Set(parsed1.entries)].sort();

  if (learn) {
    const baseline: StrictBaseline = { sha: currentSha(), capturedAt: new Date().toISOString(), fails: observed };
    writeFileSync(join(cwd, BASELINE_PATH), JSON.stringify(baseline, null, 2) + "\n", "utf-8");
    process.stdout.write(`[STRICT] baseline captured: ${observed.length} fail(s) on ${baseline.sha} → ${BASELINE_PATH}\n`);
    return 0;
  }

  const bp = join(cwd, BASELINE_PATH);
  const hadBaseline = existsSync(bp);
  const baseline: StrictBaseline | null = hadBaseline
    ? (JSON.parse(readFileSync(bp, "utf-8") as string) as StrictBaseline)
    : null;

  const verdict: StrictVerdict = {
    observed,
    resolved: [],
    regressions: [],
    flakyTail: [],
    confirmed: false,
    envGates: parsed1.envGates,
    exitCode: 0,
  };

  if (baseline) {
    const { fresh, resolved } = diffAgainstBaseline(observed, baseline);
    verdict.resolved = resolved;
    if (fresh.length > 0) {
      // Reproduction, not count: one extra bounded run, and only the names
      // present in both runs are regressions.
      process.stdout.write(`[STRICT] ${fresh.length} fresh entr(ies) — running confirmation pass (reproduction rule)…\n`);
      const run2 = runSuite();
      if (run2.killed) {
        printKill(run2.errorCode ?? "killed", run2.raw);
        return 3;
      }
      const parsed2 = parseRunOutput(run2.raw);
      if (!runIsAccountable(parsed2)) {
        process.stdout.write(`[STRICT] 🔴 NO VERDICT — the confirmation pass is unaccountable (fail=${parsed2.fail}, error=${parsed2.error}, ran-line ${parsed2.ranLinePresent ? "present" : "ABSENT"}).\n`);
        return 3;
      }
      const fresh2 = [...new Set(parsed2.entries)].filter(
        (n) => !baseline.fails.includes(n),
      );
      const split = splitFreshByReproduction(fresh, fresh2);
      verdict.regressions = split.regressions;
      verdict.flakyTail = split.flakyTail;
      verdict.confirmed = true;
      verdict.exitCode = split.regressions.length > 0 ? 1 : 0;
    }
  }

  printVerdict(verdict, hadBaseline);
  return baseline ? verdict.exitCode : 2;
}

if (process.argv[1] && process.argv[1].endsWith("strict-runner.ts")) {
  process.exit(main(process.argv.slice(2)));
}
