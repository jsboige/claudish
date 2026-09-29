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
 *   - new fails beyond the flaky tolerance  → exit 1, names printed
 *   - baseline fails that vanished          → noted (run --learn to refresh)
 *   - ENV-GATE manifests                    → consolidated into one end-of-run
 *                                              block, counted, with classes
 *
 * The baseline is per-machine by design (`.test-strict-baseline.json`, git
 * ignored): po-204 and ai-01 have different systematic populations and neither
 * is wrong. `--learn` captures it. The exit criterion is subset-vs-baseline,
 * never zero — classes 2/2b (stale contract, win32 defect) STAY red and stay
 * in the baseline; hiding them is what this gate must never do.
 *
 * Usage:
 *   bun run packages/cli/src/test-support/strict-runner.ts            # compare
 *   bun run packages/cli/src/test-support/strict-runner.ts --learn    # capture
 *   bun run packages/cli/src/test-support/strict-runner.ts --flaky-tail 3
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASELINE_PATH = ".test-strict-baseline.json";
const DEFAULT_TEST_TIMEOUT_MS = 15_000;
const DEFAULT_FLAKY_TAIL = 2;

export interface StrictBaseline {
  /** commit the baseline was captured on, for staleness checks */
  sha: string;
  capturedAt: string;
  /** normalized failing test names, sorted */
  fails: string[];
}

export interface EnvGateSummaryEntry {
  classId: string;
  notExecuted: number;
}

export interface StrictVerdict {
  /** fails observed this run */
  observed: string[];
  /** fails present in baseline but not observed (informational) */
  resolved: string[];
  /** NEW fails beyond the flaky tolerance — the regression signal */
  regressions: string[];
  /** observed fails not in baseline, within tolerance (the flaky tail) */
  flakyTail: string[];
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

/**
 * The comparison core, pure so its verdict logic is unit-testable: subset
 * against baseline with a flaky tolerance, never against zero.
 */
export function compareAgainstBaseline(
  observed: string[],
  baseline: StrictBaseline,
  flakyTail: number,
): Pick<StrictVerdict, "resolved" | "regressions" | "flakyTail" | "exitCode"> {
  const base = new Set(baseline.fails);
  const obs = new Set(observed);
  const fresh = observed.filter((n) => !base.has(n));
  const resolved = baseline.fails.filter((n) => !obs.has(n));
  const regressions = fresh.slice(flakyTail);
  return {
    resolved,
    regressions,
    flakyTail: fresh.slice(0, flakyTail),
    exitCode: regressions.length > 0 ? 1 : 0,
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
  } else {
    if (v.flakyTail.length > 0) {
      line(`[STRICT] flaky tail (within tolerance, not regression): ${v.flakyTail.length}`);
      for (const n of v.flakyTail) line(`[STRICT]   · ${n}`);
    }
    if (v.regressions.length > 0) {
      line(`[STRICT] 🔴 NEW FAILING TESTS beyond the flaky tail: ${v.regressions.length}`);
      for (const n of v.regressions) line(`[STRICT]   · ${n}`);
    } else {
      line(`[STRICT] ✅ no regression: observed ⊆ baseline (+ flaky tail)`);
    }
    if (v.resolved.length > 0) {
      line(`[STRICT] baseline fails NOT observed this run (improvement? refresh with --learn): ${v.resolved.length}`);
      for (const n of v.resolved) line(`[STRICT]   · ${n}`);
    }
  }
}

export function main(argv: string[]): number {
  const learn = argv.includes("--learn");
  const flakyIdx = argv.indexOf("--flaky-tail");
  const flakyTail = flakyIdx >= 0 ? Number(argv[flakyIdx + 1]) : DEFAULT_FLAKY_TAIL;
  const cwd = process.cwd();

  // Bounded by default: an unbounded suite cannot back a review verdict (a
  // single network-hanging test stalls it past any usable wall clock —
  // measured 2026-09-29: unbounded run looped >35 min, bounded finished in 145 s).
  // The wall-clock bound exists because bun's --timeout covers TESTS, not
  // hooks: a beforeAll stuck on a network call hangs the run with no per-test
  // timeout to save it (measured same day: two identical bounded runs, one
  // finished in 145 s, the other still silent at 420 s). Killed ≠ verdict.
  const WALL_CLOCK_MS = 420_000;
  const r = spawnSync(
    process.execPath,
    ["test", "--timeout", String(DEFAULT_TEST_TIMEOUT_MS)],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, cwd, timeout: WALL_CLOCK_MS },
  );
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    process.stdout.write(
      `[STRICT] 🔴 RUN KILLED at wall-clock ${WALL_CLOCK_MS / 1000}s — a hook hung beyond the per-test timeout. ` +
        `No verdict can be drawn from a killed run; re-run (the flaky tail is exactly this class of event).\n`,
    );
    // Diagnosis: the last file that produced output is the usual suspect —
    // spawnSync's buffers hold whatever was read before the kill, so surface
    // it instead of leaving the hung hook nameless.
    const tail = ((r.stdout ?? "") + (r.stderr ?? ""))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.startsWith("[ENV-GATE]"))
      .slice(-15);
    if (tail.length > 0) {
      process.stdout.write(`[STRICT] last output before the kill (diagnosis):\n`);
      for (const l of tail) process.stdout.write(`[STRICT] | ${l.slice(0, 160)}\n`);
    }
    return 3;
  }
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  const observed = [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map(normalizeFailLine)
        .filter((n): n is string => n !== null),
    ),
  ].sort();

  if (learn) {
    const baseline: StrictBaseline = { sha: currentSha(), capturedAt: new Date().toISOString(), fails: observed };
    writeFileSync(join(cwd, BASELINE_PATH), JSON.stringify(baseline, null, 2) + "\n", "utf-8");
    process.stdout.write(`[STRICT] baseline captured: ${observed.length} fail(s) on ${baseline.sha} → ${BASELINE_PATH}\n`);
    return 0;
  }

  const bp = join(cwd, BASELINE_PATH);
  const hadBaseline = existsSync(bp);
  const baseline: StrictBaseline | null = hadBaseline
    ? (JSON.parse(readFileSync(bp, "utf-8")) as StrictBaseline)
    : null;

  const verdict: StrictVerdict = {
    observed,
    resolved: [],
    regressions: [],
    flakyTail: [],
    envGates: parseEnvGateManifests(raw),
    exitCode: 0,
  };
  if (baseline) Object.assign(verdict, compareAgainstBaseline(observed, baseline, flakyTail));
  printVerdict(verdict, hadBaseline);
  return baseline ? verdict.exitCode : 2;
}

if (process.argv[1] && process.argv[1].endsWith("strict-runner.ts")) {
  process.exit(main(process.argv.slice(2)));
}
