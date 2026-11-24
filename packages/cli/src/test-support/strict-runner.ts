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
 * Partitioned mode (#641 C3, opt-in): `--partition[=N]` runs the population in
 * N-file slices (sorted paths, cut by COUNT — a per-directory cut leaves the
 * root at 151 files, three directories at 119-131, all inside the crash zone
 * measured at 176 files / ~1.3 GB RSS). Each partition is its own `bun test`
 * process with its own wall clock; a partition that crashes or cannot be
 * accounted for refuses the verdict (exit 3) naming the partition and its
 * files — its keys are unknown, never "zero fails". The baseline records the
 * partition size and boundaries; a verify with a different size (or a
 * single-process baseline) refuses until re-learned in the same mode.
 *
 * Usage:
 *   bun run packages/cli/src/test-support/strict-runner.ts            # compare
 *   bun run packages/cli/src/test-support/strict-runner.ts --learn    # capture
 *   bun run packages/cli/src/test-support/strict-runner.ts --learn --partition=50
 *   bun run packages/cli/src/test-support/strict-runner.ts --partition=50
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUDGET_FOOTER_MARKER } from "./env-gate";

export const BASELINE_PATH = ".test-strict-baseline.json";
const DEFAULT_TEST_TIMEOUT_MS = 15_000;
/** The population the monolithic mode points `bun test` at (see realSuiteRunner). */
export const TEST_ROOT = "packages/cli/src";

export interface StrictBaseline {
  /** commit the baseline was captured on, for staleness checks */
  sha: string;
  capturedAt: string;
  /** failing entries, sorted: "file > describe > test" or "file: load error #N" */
  fails: string[];
  /**
   * Present iff the baseline was captured with --partition: the slice size and
   * the first file of each slice. Learn and verify must cut the same
   * population — a verify at a different N (or without partitions) refuses.
   */
  partition?: PartitionManifest;
}

export interface EnvGateSummaryEntry {
  classId: string;
  notExecuted: number;
  /**
   * True when the class is an opt-in BUDGET class (`kind: "budget"`, #385):
   * inactive by operator choice, so strict mode never fails it. Detected from
   * the printed manifest (the runner never sees the EnvGateClass) — the
   * consolidated footer must not claim a failure mode strict mode does not
   * have.
   */
  budget: boolean;
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
  /**
   * Reproduced entries whose FILE passes when run ALONE (#641 C4, file 24a
   * item 2): context-sensitive, not a new failing test in their own right.
   * Subset of `regressions` — exit 1 is unchanged, the label only says where
   * to look (the surrounding population, not the test).
   */
  contextSensitive?: string[];
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
  const re = /\[ENV-GATE\] (\d+) test\(s\) NOT executed — class '([^']+)':/g;
  const hits: Array<{ index: number; classId: string; notExecuted: number }> = [];
  let m = re.exec(raw);
  while (m !== null) {
    hits.push({ index: m.index, classId: m[2], notExecuted: Number(m[1]) });
    m = re.exec(raw);
  }
  const byClass = new Map<string, EnvGateSummaryEntry>();
  // The class's block runs to the NEXT header — its reason, activation and
  // footer lines. The footer is the only place the budget kind is visible in
  // the printed output, so the slice is what has to carry the detection.
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : raw.length;
    const block = raw.slice(hit.index, end);
    const prev = byClass.get(hit.classId);
    byClass.set(hit.classId, {
      classId: hit.classId,
      notExecuted: (prev?.notExecuted ?? 0) + hit.notExecuted,
      budget: (prev?.budget ?? false) || block.includes(BUDGET_FOOTER_MARKER),
    });
  });
  return [...byClass.values()].sort((a, b) => b.notExecuted - a.notExecuted);
}

const FILE_HEADER_RE = /^(.+\.test\.[cm]?[jt]sx?):\s*$/;
const UNHANDLED_RE = /^# Unhandled error between tests/;
/**
 * GitHub Actions group framing. On a GHA runner (measured: macOS shard,
 * 24/11, bun 1.4.0) the child bun prefixes each file header with
 * `::group::`, so the raw line is `::group::b.test.ts:` — FILE_HEADER_RE
 * then captures `::group::b.test.ts` as the file name and every entry of
 * that block lands OUTSIDE the delivered set (FOREIGN POPULATION, exit 3,
 * reproduced by the real-wiring pin). The same probe on Windows emits no
 * group line at all, with GITHUB_ACTIONS=true and without, under bun 1.3.14
 * and 1.4.0: the framing is the producer's, so the parser strips it before
 * matching anything.
 */
const GHA_GROUP_PREFIX = "::group::";

/** Strip the GHA group framing before any header/fail line is matched. */
function withoutGhaGroupPrefix(rawLine: string): string {
  return rawLine.startsWith(GHA_GROUP_PREFIX) ? rawLine.slice(GHA_GROUP_PREFIX.length) : rawLine;
}

/** Last match of an anchored multiline regex, or null (see parseRunOutput). */
function lastSummaryMatch(raw: string, re: RegExp): string | null {
  const g = new RegExp(re.source, "gm");
  let last: RegExpExecArray | null = null;
  let m = g.exec(raw);
  while (m !== null) {
    last = m;
    if (m[0].length === 0) g.lastIndex += 1;
    m = g.exec(raw);
  }
  return last?.[1] ?? null;
}

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
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = withoutGhaGroupPrefix(rawLine);
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
  // Anchor the summary counters on the LAST match: nothing in the suite echoes
  // a child bun summary today, but a test that ever does would sit before the
  // real one, and the first-match read would count the child's (re-review 2,
  // non-blocking — the gate stays no-verdict either way, this is robustness).
  const fail = Number(lastSummaryMatch(raw, /^\s*(\d+) fail\b/m) ?? -1);
  const error = Number(lastSummaryMatch(raw, /^\s*(\d+) errors?\b/m) ?? 0);
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
 * The `Ran N tests across M files` line's M. The partitioned mode uses it as a
 * population echo: bun was handed exactly K files, so M is the only in-output
 * witness of how many of them actually ran. A persistent M < K on every
 * partition would mean the multi-arg union does not hold (each call would be
 * running one file) — the kind of silent population loss this gate must never
 * green over, so the mismatch is PRINTED for the operator even though a
 * zero-test file can legitimately keep M off K by one.
 *
 * The LAST match wins: a nested bun-test child (a file spawning
 * `bun test <one file>` with inherited stdio) prints its own summary EARLIER
 * in the stream, and the first match would shadow the parent's final line —
 * measured 18/11: partitions hosting `call-abort.test.ts` or
 * `client-cancel.test.ts` echoed "1 file ran" for 50 delivered files.
 */
export function ranLineFileCount(raw: string): number | null {
  const matches = raw.matchAll(/^Ran \d+ tests? across (\d+) files?\./gm);
  let last: number | null = null;
  for (const m of matches) last = Number(m[1]);
  return last;
}

/**
 * The files a partition delivered but bun's population echo never counted, and
 * whether each is EXPLAINED. The only explained shape is an inspected file with
 * no runnable test: it died at module load (a `load error` entry names it) or
 * carries zero tests (its header prints, no entry exists). Anything else — a
 * missing file with a PASSING body would leave no trace either — is an
 * UNEXPLAINED population loss: the union the runner just compared is not the
 * population it delivered. Review #1114 (file 19b item 1): a delivered set of
 * 10 files echoed "Ran 1 test across 1 file" and --learn wrote an EMPTY
 * baseline with exit 0. This classification is what turns that silent loss
 * into a named refusal instead.
 */
export function missingRunnableFiles(
  delivered: string[],
  parsed: SuiteRun
): { missing: string[]; unexplained: string[] } {
  const seen = new Set(parsed.entries.map(entryFile));
  const missing = delivered.filter((f) => !seen.has(f));
  const loadDead = missing.filter((f) =>
    parsed.entries.some((e) => e.startsWith(`${f}: load error`))
  );
  return { missing, unexplained: missing.filter((f) => !loadDead.includes(f)) };
}

/**
 * One gate, both passes (file 19b items 1+2): a population echo that does not
 * match the delivered set is a refusal (exit 3) UNLESS every missing file is an
 * inspected-without-runnable-test one. Returns the unexplained list (empty =
 * the gap is fully explained). `ranFiles === null` means the echo is absent —
 * the population is UNKNOWN, which is unexplained by definition.
 */
export function populationGapUnexplained(
  delivered: string[],
  ranFiles: number | null,
  parsed: SuiteRun
): string[] {
  if (ranFiles === null) return [...delivered]; // unknown population: never a baseline
  if (ranFiles >= delivered.length) return []; // nothing missing (an over-count is refused below first)
  return missingRunnableFiles(delivered, parsed).unexplained;
}

/**
 * Review #1114, second review: an echo that attests MORE files than were
 * delivered is not coverage — it is no attestation of this run at all. The
 * review's witness: deliver a.test.ts + b.test.ts, parse an otherwise
 * accountable "Ran N tests across 3 files" — the old `>=` read that as "the
 * echo covers the delivery", --learn wrote the empty union as a baseline and
 * returned 0. Three files cannot attest the execution of exactly two.
 *
 * This predicate stays NUMERIC: it fires only when the echo outruns BOTH the
 * delivery and every file the entries name (no trace at all accounts for the
 * extra count). The shape where the echo IS consistent with the entries but
 * an entry names a file outside the delivery is a FOREIGN entry, not an
 * over-count — foreignEntryFiles owns that case (third review).
 */
export function populationEchoOverCounts(
  delivered: string[],
  ranFiles: number | null,
  parsed: SuiteRun
): boolean {
  if (ranFiles === null) return false; // unknown population: the gap guard owns it
  const entryFiles = new Set(parsed.entries.map(entryFile));
  return ranFiles > delivered.length && ranFiles > entryFiles.size;
}

/**
 * Review #1114, third review (file 20a): an entry naming a file OUTSIDE the
 * delivery is a foreign population. Its witness: 1 delivered a.test.ts,
 * accountable output with failed entries for a.test.ts AND ghost.test.ts,
 * echo 2 — learn wrote BOTH into the baseline and returned 0, because the
 * count guards all pass (echo == entry-file count >= delivery) and the
 * re-run-everything fallback lives only on the verify path, never reached in
 * learn. A foreign entry is refused everywhere it is parsed: no baseline
 * write, no verdict, and on confirmation a foreign population is never
 * evidence of non-reproduction (a ghost cannot re-appear in a partition it
 * was never delivered to, so its absence would read as flaky).
 */
export function foreignEntryFiles(delivered: string[], parsed: SuiteRun): string[] {
  const owned = new Set(delivered);
  return [...new Set(parsed.entries.map(entryFile))].filter((f) => !owned.has(f)).sort();
}

/**
 * The reproduction rule: a fresh entry that reproduces on the confirmation
 * run is a regression whatever the count; one that does not is noise. This is
 * the property the body names ("a different test each time") — a count-based
 * tolerance cannot tell a deterministic new red from noise and excused exactly
 * that in review.
 */
export function splitFreshByReproduction(
  fresh1: string[],
  fresh2: string[]
): {
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
  baseline: StrictBaseline
): { fresh: string[]; resolved: string[] } {
  const base = new Set(baseline.fails);
  const obs = new Set(observed);
  return {
    fresh: observed.filter((n) => !base.has(n)),
    resolved: baseline.fails.filter((n) => !obs.has(n)),
  };
}

type SuiteRunner = () => {
  raw: string;
  killed?: boolean;
  errorCode?: string;
  wall?: { ms: number; source: WallClockSource };
};

export const DEFAULT_WALL_CLOCK_MS = 420_000;
/**
 * `spawnSync`'s `timeout` misbehaves above 2^31-1 (measured on bun 1.3.13 by
 * the coordinator: 2^31 → immediate ETIMEDOUT reported as a kill, 2^32 → a
 * 133 ms kill, one value wrapped to ~1 s — each would masquerade as a flaky
 * tail). The resolver refuses anything above the ceiling on the same warning
 * path as the other invalid shapes.
 */
export const MAX_WALL_CLOCK_MS = 2_147_483_647;

export type WallClockSource = "default" | "env" | "injected";

/**
 * The wall clock is overridable per seat (env `CLAUDISH_STRICT_WALL_CLOCK_MS`,
 * positive integer, milliseconds, at most MAX_WALL_CLOCK_MS). Measured
 * 2026-11-15 (#641 C3): the v14 population does not fit 420 s on seats that
 * run it (po-2024 and po-2028 both killed ETIMEDOUT while main's baseline fits
 * — population and/or seat load, not a port defect), so the arbitrated fix is
 * a per-seat bound, default unchanged; sharding was considered and rejected.
 * An invalid value (empty, non-numeric, <= 0, fractional, above the spawnSync
 * ceiling) falls back to the default WITH a warning — never a silent bound
 * change, never a crash before the run starts. The source travels with the
 * value so the kill line can name where the bound came from instead of
 * inferring it (an injected 420000 is not "the default", an env 420000 is not
 * "injected").
 */
export function resolveWallClock(env: NodeJS.ProcessEnv = process.env): {
  ms: number;
  source: WallClockSource;
} {
  const raw = env.CLAUDISH_STRICT_WALL_CLOCK_MS;
  if (raw === undefined || raw === "") return { ms: DEFAULT_WALL_CLOCK_MS, source: "default" };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_WALL_CLOCK_MS) {
    process.stderr.write(
      `[STRICT] CLAUDISH_STRICT_WALL_CLOCK_MS=${raw} is not a positive integer of ms up to ${MAX_WALL_CLOCK_MS} — using the default ${DEFAULT_WALL_CLOCK_MS}.\n`
    );
    return { ms: DEFAULT_WALL_CLOCK_MS, source: "default" };
  }
  return { ms: n, source: "env" };
}

export function resolveWallClockMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveWallClock(env).ms;
}

/**
 * Partitioned mode (#641 C3). Measured on the synchronized v14 head: the full
 * population dies around 176 files / ~1.3 GB RSS, and a per-DIRECTORY cut does
 * not bound the slice (src root 151, providers 131, handlers 119 — three
 * directories at 68-86 % of the crash point). The cut is therefore by COUNT:
 * the sorted file list is sliced into blocks of at most N, so no slice can
 * exceed N however any directory is populated.
 */
export const DEFAULT_PARTITION_SIZE = 50;

export interface PartitionManifest {
  /** slice size the baseline was captured with (`--partition=N`) */
  n: number;
  /** first file of each slice, in order — the cut points of the capture */
  boundaries: string[];
}

/** Slice a SORTED file list into consecutive blocks of at most N files. */
export function planPartitions(files: string[], n: number): string[][] {
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`planPartitions: n must be a positive integer, got ${n}`);
  const out: string[][] = [];
  for (let i = 0; i < files.length; i += n) out.push(files.slice(i, i + n));
  return out;
}

const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The population the partitioned mode runs: every test file under TEST_ROOT,
 * sorted, forward slashes. Sorted so `--learn` and the verdict cut the SAME
 * population for a given N (determinism is the whole point of recording
 * boundaries in the baseline).
 */
export function enumerateTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (TEST_FILE_RE.test(e.name)) out.push(join(dir, e.name).replace(/\\/g, "/"));
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * Parse `--partition` (default size) / `--partition=N`. Returns "invalid" for
 * a malformed value so main() can refuse BEFORE enumerating anything — a
 * usage error must never fall back to a silent single-process run.
 */
export function parsePartitionArg(argv: string[]): { n: number } | "invalid" | null {
  for (const a of argv) {
    if (a === "--partition") return { n: DEFAULT_PARTITION_SIZE };
    if (a.startsWith("--partition=")) {
      const n = Number(a.slice("--partition=".length));
      if (!Number.isInteger(n) || n <= 0) return "invalid";
      return { n };
    }
  }
  return null;
}

/** The file a parsed entry belongs to ("f > name" / "f: load error #N"). */
export function entryFile(entry: string): string {
  const gt = entry.indexOf(" > ");
  if (gt !== -1) return entry.slice(0, gt);
  return entry.split(": load error")[0];
}

/** Merge per-partition ENV-GATE summaries: counts sum, budget flag ORs. */
export function mergeEnvGates(perPartition: EnvGateSummaryEntry[][]): EnvGateSummaryEntry[] {
  const byClass = new Map<string, EnvGateSummaryEntry>();
  for (const list of perPartition) {
    for (const e of list) {
      const prev = byClass.get(e.classId);
      byClass.set(e.classId, {
        classId: e.classId,
        notExecuted: (prev?.notExecuted ?? 0) + e.notExecuted,
        budget: (prev?.budget ?? false) || e.budget,
      });
    }
  }
  return [...byClass.values()].sort((a, b) => b.notExecuted - a.notExecuted);
}

/**
 * The real suite runner. Bounded by default: an unbounded suite cannot back a
 * review verdict (a single network-hanging test stalls it past any usable wall
 * clock — measured 2026-09-29: unbounded run looped >35 min, bounded finished
 * in 145 s). The wall-clock bound exists because bun's --timeout covers TESTS,
 * not hooks: a beforeAll stuck on a network call hangs the run with no per-test
 * timeout to save it. Killed ≠ verdict.
 *
 * Scope to src/: a compiled dist/ in the tree gets picked up by a bare
 * `bun test` and its compiled tests fail en masse on fixture/import
 * resolution they were never meant to survive (the documented
 * tool-choice-mapping/dist class — measured 2026-10-01: a fresh tsc emit
 * inflated the failing population from 9 to 52 without a single source
 * change). The dist is a build artifact, not a test population.
 *
 * `opts` exists for the tests: an injectable wall clock and test path are what
 * let the kill diagnosis be exercised on the REAL spawn path (re-review 2,
 * 2026-10-01: a fixture branch injecting `raw` cannot see a runner that drops
 * its own output on ETIMEDOUT).
 *
 * On a kill (ETIMEDOUT, ENOBUFS, any spawn error) the PARTIAL output is kept:
 * spawnSync's buffers hold everything read before the kill, and that tail is
 * the only diagnosis a hung hook will ever get — returning `raw: ""` there
 * (the regression this fixed) silently killed the diagnosis feature.
 */
export function realSuiteRunner(
  cwd: string,
  opts: { testPath?: string; testFiles?: string[]; wallClockMs?: number } = {}
): SuiteRunner {
  return () => {
    const wall =
      opts.wallClockMs !== undefined
        ? { ms: opts.wallClockMs, source: "injected" as const }
        : resolveWallClock();
    // Exact-file addressing, NOT filters: a bare `bun test <path>` arg is a
    // regex filter over discovered files, so a partition passed that way could
    // select the wrong population. The `./`-prefixed form addresses each file
    // exactly (measured quirk, bun 1.3.x) — one arg per file of the partition.
    const targets = opts.testFiles
      ? opts.testFiles.map((f) => `./${f}`)
      : [opts.testPath ?? TEST_ROOT];
    const r = spawnSync(
      process.execPath,
      ["test", ...targets, "--timeout", String(DEFAULT_TEST_TIMEOUT_MS), "--isolate"],
      {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        cwd,
        timeout: wall.ms,
      }
    );
    const raw = (r.stdout ?? "") + (r.stderr ?? "");
    if (r.error)
      return {
        raw,
        killed: true,
        errorCode: (r.error as NodeJS.ErrnoException).code ?? "?",
        wall,
      };
    return { raw };
  };
}

function currentSha(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
  return (r.stdout ?? "").trim() || "unknown";
}

function printVerdict(v: StrictVerdict, hadBaseline: boolean): void {
  const line = (s: string) => process.stdout.write(`${s}\n`);
  line("");
  line(`── [STRICT] end-of-run manifest ${"─".repeat(20)}`);
  if (v.envGates.length > 0) {
    const total = v.envGates.reduce((s, e) => s + e.notExecuted, 0);
    const budget = v.envGates.filter((e) => e.budget);
    const regular = v.envGates.filter((e) => !e.budget);
    line(`[STRICT] ${total} test(s) NOT executed, per environment class:`);
    for (const e of v.envGates) {
      line(
        `[STRICT]   · ${e.classId}: ${e.notExecuted}${e.budget ? " (opt-in budget — STRICT=1 never fails it)" : ""}`
      );
    }
    // The claim must match what strict mode ACTUALLY does (#385): a budget class
    // is exempt, so a blanket "fails them instead" is false the moment one is
    // listed — and it was, until this footer learned to read the kind off the
    // manifest. Three cases, so the honest sentence is never approximated.
    if (regular.length === 0) {
      line(
        "[STRICT]   (every class above is an opt-in budget class — each run costs real money, so a complete machine " +
          "deliberately does NOT run them; CLAUDISH_TEST_ENV_STRICT=1 never fails them)"
      );
    } else if (budget.length === 0) {
      line(
        "[STRICT]   (a complete machine runs them all; CLAUDISH_TEST_ENV_STRICT=1 fails them instead)"
      );
    } else {
      line(
        `[STRICT]   (a complete machine runs the ${regular.length} non-budget class(es); CLAUDISH_TEST_ENV_STRICT=1 ` +
          `fails those instead — the ${budget.length} opt-in budget class(es) are exempt by design)`
      );
    }
  } else {
    line("[STRICT] 0 environment-gated tests — every class active on this machine");
  }
  line(`[STRICT] failing population observed: ${v.observed.length}`);
  for (const n of v.observed) line(`[STRICT]   · ${n}`);
  if (!hadBaseline) {
    line(
      `[STRICT] NO BASELINE (${BASELINE_PATH}) — capture one with --learn, then re-run to compare.`
    );
    return;
  }
  if (v.confirmed) {
    line("[STRICT] fresh entries triggered a confirmation re-run:");
    if (v.flakyTail.length > 0) {
      line(`[STRICT] flaky tail (did NOT reproduce — noise): ${v.flakyTail.length}`);
      for (const n of v.flakyTail) line(`[STRICT]   · ${n}`);
    } else {
      line("[STRICT] flaky tail: 0 (every fresh entry reproduced)");
    }
    // #641 C4 (file 24a item 2): a reproduced entry whose file passes ALONE is
    // context-sensitive. It is NOT counted under NEW FAILING — the count and
    // the list hold only the entries that still fail alone.
    const cs = v.contextSensitive ?? [];
    const newFailing = v.regressions.filter((n) => !cs.includes(n));
    if (cs.length > 0) {
      const files = new Set(cs.map(entryFile)).size;
      line(
        `[STRICT] 🟡 CONTEXT-SENSITIVE (reproduced in their partition, PASS when the file runs alone — the surrounding population is the suspect, not the test): ${cs.length} in ${files} file(s)`
      );
      for (const n of cs) line(`[STRICT]   · ${n}`);
    }
    if (newFailing.length > 0) {
      line(
        `[STRICT] 🔴 NEW FAILING TESTS (reproduced on the confirmation run): ${newFailing.length}`
      );
      for (const n of newFailing) line(`[STRICT]   · ${n}`);
    } else if (cs.length === 0) {
      line("[STRICT] ✅ no regression: every fresh entry failed to reproduce");
    } else {
      line(
        "[STRICT] every reproduced entry is context-sensitive — exit stays 1 (a label is not a green)"
      );
    }
  } else {
    line("[STRICT] ✅ no regression: observed ⊆ baseline");
  }
  if (v.resolved.length > 0) {
    line(
      `[STRICT] baseline fails NOT observed this run (improvement? refresh with --learn): ${v.resolved.length}`
    );
    for (const n of v.resolved) line(`[STRICT]   · ${n}`);
  }
}

/**
 * The kill line's wall sentence, exact about where the bound came from:
 * `default` (unset), `env` (the override), or `injected` (a test harness).
 * Value-inference was wrong on both edges (an injected 420000 read as
 * "default", an env 420000 read as an override… or the reverse — the source
 * is carried, not guessed).
 */
export function wallClockSentence(wall: { ms: number; source: WallClockSource }): string {
  const tail =
    wall.source === "default"
      ? " (default)."
      : wall.source === "env"
        ? ` — CLAUDISH_STRICT_WALL_CLOCK_MS overrides the ${DEFAULT_WALL_CLOCK_MS} default.`
        : " (injected for this run).";
  return ` The wall clock in force was ${wall.ms} ms${tail}`;
}

function printKill(
  errorCode: string,
  raw: string,
  wall?: { ms: number; source: WallClockSource }
): void {
  const wallLine = wall === undefined ? "" : wallClockSentence(wall);
  process.stdout.write(
    `[STRICT] 🔴 RUN KILLED (${errorCode}) — no verdict can be drawn from a killed run; ` +
      `re-run (the flaky tail is exactly this class of event).${wallLine}\n`
  );
  // Diagnosis: bun's non-TTY reporter prints a file header only once that file
  // produces output, so a file hung in a hook stays nameless — the last file
  // WITH output names the file just before the one hanging. Say so, instead
  // of implying the named file is the suspect.
  const tail = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("[ENV-GATE]"))
    .slice(-15);
  if (tail.length > 0) {
    process.stdout.write(
      "[STRICT] last file with output (the hung file is the NEXT one — bun does not name a file until it produces output):\n"
    );
    for (const l of tail) process.stdout.write(`[STRICT] | ${l.slice(0, 160)}\n`);
  }
}

/**
 * A crashed or unaccountable partition refuses the verdict AND names itself:
 * its keys are unknown (a crash can hide any number of fails), so the runner
 * must never let the remaining partitions' green stand in for the whole. The
 * file list is printed in full — "partition 3/9" alone tells the operator
 * nothing about which population is unknown.
 */
function printCrashedPartition(
  kind: "killed" | "unaccountable",
  index: number,
  total: number,
  files: string[],
  detail: string,
  raw: string
): void {
  const line = (s: string) => process.stdout.write(`${s}\n`);
  line(
    `[STRICT] 🔴 PARTITION ${index + 1}/${total} ${kind === "killed" ? "RUN KILLED" : "UNACCOUNTABLE"} (${detail}) — its keys are UNKNOWN, never "zero fails": no verdict can be drawn while any partition is missing. Files:`
  );
  for (const f of files) line(`[STRICT]   · ${f}`);
  const tail = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("[ENV-GATE]"))
    .slice(-15);
  if (tail.length > 0) {
    line("[STRICT] last output lines of the partition:");
    for (const l of tail) line(`[STRICT] | ${l.slice(0, 160)}`);
  }
}

/**
 * Context sensitivity (#641 C4, file 24a item 2): reproduction on the partition
 * is not proof that the test is at fault. REQ-9 of script-runtime failed in its
 * partition, reproduced on the confirmation re-run, then passed alone — the
 * surrounding population (PATH corruption, mock leakage, leftover state) is the
 * suspect, not the test. So every file hosting a reproduced entry gets ONE last
 * run ALONE (one run per distinct file, not per entry). An entry that passes
 * alone is `context-sensitive`; one that still fails stays a NEW FAILING.
 *
 * A third run that cannot be read (kill, unaccountable, gap, foreign entry)
 * excuses nothing: its entries stay regressions, and the line says the file's
 * verdict could not be read. Exit is unchanged (1) either way — a label is not
 * a green.
 */
function splitReproducedByAloneRun(
  regressions: string[],
  deps: PartitionDeps,
  total: number
): { contextSensitive: string[]; lines: string[] } {
  const contextSensitive: string[] = [];
  const lines: string[] = [];
  const files = [...new Set(regressions.map(entryFile))].sort();
  for (const f of files) {
    const owned = regressions.filter((e) => entryFile(e) === f);
    const run = deps.runPartition([f], total, total);
    if (run.killed) {
      lines.push(
        `[STRICT] ⚠ alone-run of ${f} could not be read (${run.errorCode ?? "killed"}) — its ${owned.length} entry(ies) stay NEW FAILING.`
      );
      continue;
    }
    const parsed = parseRunOutput(run.raw);
    const ranFiles = ranLineFileCount(run.raw);
    if (
      !runIsAccountable(parsed) ||
      populationEchoOverCounts([f], ranFiles, parsed) ||
      populationGapUnexplained([f], ranFiles, parsed).length > 0 ||
      foreignEntryFiles([f], parsed).length > 0
    ) {
      lines.push(
        `[STRICT] ⚠ alone-run of ${f} could not be read (unaccountable output or a population mismatch) — its ${owned.length} entry(ies) stay NEW FAILING.`
      );
      continue;
    }
    const alone = new Set(parsed.entries);
    for (const e of owned) if (!alone.has(e)) contextSensitive.push(e);
  }
  return { contextSensitive, lines };
}

/** Injectable partition execution, so the partition wiring is unit-testable. */
export interface PartitionDeps {
  /** The population, sorted (defaults to enumerateTestFiles(TEST_ROOT)). */
  listFiles: () => string[];
  /** Run one partition's files as its own bounded `bun test` process. */
  runPartition: (
    files: string[],
    index: number,
    total: number
  ) => { raw: string; killed?: boolean; errorCode?: string };
}

function defaultPartitionDeps(cwd: string): PartitionDeps {
  return {
    listFiles: () => enumerateTestFiles(TEST_ROOT),
    runPartition: (files) => realSuiteRunner(cwd, { testFiles: files })(),
  };
}

/**
 * Partitioned main (#641 C3): same verdict discipline as the single-process
 * main, applied per partition. Every partition must come back accountable or
 * the whole run refuses; the observed population is the UNION of the
 * partitions' entries; the confirmation re-run visits ONLY the partitions that
 * hosted fresh entries (the others just ran clean — re-running them buys
 * nothing but wall clock). Learn records the partition manifest so a later
 * verify can prove it cut the same population.
 */
function mainPartitioned(argv: string[], n: number, deps: PartitionDeps): number {
  const learn = argv.includes("--learn");
  const cwd = process.cwd();

  const files = deps.listFiles();
  if (files.length === 0) {
    process.stdout.write("[STRICT] 🔴 NO TEST FILES found to partition.\n");
    return 3;
  }
  const partitions = planPartitions(files, n);
  const boundaries = partitions.map((p) => p[0]);
  process.stdout.write(
    `[STRICT] partitioned mode: ${files.length} test file(s) → ${partitions.length} partition(s) of ≤${n}\n`
  );

  const partitionOf = new Map<string, number>();
  partitions.forEach((p, i) => {
    for (const f of p) partitionOf.set(f, i);
  });

  // Fail fast on mode mismatch BEFORE burning the partitions: a verify whose
  // baseline cannot be compared against is knowable from the baseline alone.
  // (Not parsed in learn mode — same as the single-process main, a corrupted
  // old baseline must never block capturing a fresh one.)
  const bp = join(cwd, BASELINE_PATH);
  const hadBaseline = existsSync(bp);
  const baseline: StrictBaseline | null =
    !learn && hadBaseline
      ? (JSON.parse(readFileSync(bp, "utf-8") as string) as StrictBaseline)
      : null;
  const manifest = baseline?.partition;
  if (!learn && baseline && manifest === undefined) {
    process.stdout.write(
      `[STRICT] 🔴 NO VERDICT — the baseline was captured WITHOUT partitions; a partitioned verify cuts a different population. Re-learn with --partition=${n} (learn and verify must run the same mode and size).\n`
    );
    return 3;
  }
  if (manifest !== undefined && manifest.n !== n) {
    process.stdout.write(
      `[STRICT] 🔴 NO VERDICT — baseline was partitioned at N=${manifest.n}, this verify runs N=${n}. ` +
        `Learn and verify must cut the same population: re-learn at N=${n} or verify at N=${manifest.n}.\n`
    );
    return 3;
  }
  if (
    manifest !== undefined &&
    JSON.stringify(manifest.boundaries) !== JSON.stringify(boundaries)
  ) {
    process.stdout.write(
      "[STRICT] ⚠ boundary drift — this tree's cut points differ from the baseline's (files added/removed/renamed " +
        "since the capture). Entries still compare by name; re-learn to refresh the manifest.\n"
    );
  }

  const observedPerPartition: string[][] = [];
  const envGatesPerPartition: EnvGateSummaryEntry[][] = [];
  const wallPerPartition: number[] = [];

  for (let i = 0; i < partitions.length; i++) {
    const t0 = Date.now();
    const run = deps.runPartition(partitions[i], i, partitions.length);
    const ms = Date.now() - t0;
    wallPerPartition.push(ms);
    if (run.killed) {
      printCrashedPartition(
        "killed",
        i,
        partitions.length,
        partitions[i],
        `${run.errorCode ?? "killed"}, wall ${ms} ms`,
        run.raw
      );
      return 3;
    }
    const parsed = parseRunOutput(run.raw);
    if (!runIsAccountable(parsed)) {
      printCrashedPartition(
        "unaccountable",
        i,
        partitions.length,
        partitions[i],
        `entries (${parsed.entries.length}) do not account for bun's counters (fail=${parsed.fail}, error=${parsed.error}, ran-line ${parsed.ranLinePresent ? "present" : "ABSENT"})`,
        run.raw
      );
      return 3;
    }
    const delivered = partitions[i].length;
    const ranFiles = ranLineFileCount(run.raw);
    if (populationEchoOverCounts(partitions[i], ranFiles, parsed)) {
      // Review #1114, second review: the echo attests more files than were
      // delivered AND more than the entries themselves name — nothing accounts
      // for the extra count, so the summary describes another population. The
      // old `>=` read this as coverage and --learn consecrated the union (or
      // its emptiness) as a baseline with exit 0.
      process.stdout.write(
        `[STRICT] 🔴 POPULATION OVER-COUNT in partition ${i + 1}/${partitions.length}: bun reports ` +
          `${ranFiles} file(s) ran, ${delivered} delivered — the echo attests more files than were ` +
          `handed to it and more than the entries name; it cannot attest this run's population.\n`
      );
      process.stdout.write(
        "[STRICT]   Refusing: no baseline is written from an echo that outruns its delivery. " +
          "The echo reads the LAST Ran line; a count beyond both the delivery and the entries " +
          "describes some other run.\n"
      );
      return 3;
    }
    const unexplained = populationGapUnexplained(partitions[i], ranFiles, parsed);
    if (unexplained.length > 0) {
      // Review #1114 (file 19b item 1): an echo below the delivery used to be a
      // warning, and --learn then wrote the EMPTY union as the baseline with
      // exit 0 — a silent population loss consecrated as the reference. The gap
      // is now a refusal: no baseline is written, no verdict is drawn, and every
      // unexplained file is named. The ONLY tolerated gap is the named set of
      // files inspected without a runnable test (module-load death).
      process.stdout.write(
        `[STRICT] 🔴 POPULATION GAP in partition ${i + 1}/${partitions.length}: bun reports ` +
          `${ranFiles ?? "NO Ran line"} file(s) ran, ${delivered} delivered — ` +
          `${unexplained.length} file(s) are UNEXPLAINED (not a module-load death):\n`
      );
      for (const f of unexplained) process.stdout.write(`[STRICT]   · ${f}\n`);
      process.stdout.write(
        "[STRICT]   Refusing: no baseline is written from an unexplained population loss. " +
          "Fix the delivery (paths the engine never received) or the echo, then re-run.\n"
      );
      return 3;
    }
    const foreign = foreignEntryFiles(partitions[i], parsed);
    if (foreign.length > 0) {
      // Review #1114, third review (file 20a): an entry naming a file outside
      // the delivery is a foreign population. The witness: 1 delivered, failed
      // entries for a.test.ts AND ghost.test.ts, echo 2 — every count guard
      // passes and --learn wrote the ghost INTO the baseline with exit 0. The
      // old no-blind-spot fallback lives only on the verify path, so learn
      // never reached it. Refused here, both modes, before anything is
      // consecrated: no baseline write, no verdict.
      process.stdout.write(
        `[STRICT] 🔴 FOREIGN POPULATION in partition ${i + 1}/${partitions.length}: entries name ` +
          `${foreign.length} file(s) outside the delivery:\n`
      );
      for (const f of foreign) process.stdout.write(`[STRICT]   · ${f}\n`);
      process.stdout.write(
        "[STRICT]   Refusing: an entry from a file that was never delivered is not this run's " +
          "population — no baseline is written and no verdict is drawn from it.\n"
      );
      return 3;
    }
    if (ranFiles !== null && ranFiles !== delivered) {
      const explained = partitions[i].filter((f) =>
        parsed.entries.some((e) => e.startsWith(`${f}: load error`))
      );
      process.stdout.write(
        `[STRICT] ℹ population echo: ${ranFiles} ran / ${delivered} delivered — the gap is ` +
          `EXPLAINED by ${explained.length} file(s) inspected without a runnable test (module-load death): ` +
          `${explained.join(", ")}\n`
      );
    }
    observedPerPartition.push([...new Set(parsed.entries)].sort());
    envGatesPerPartition.push(parsed.envGates);
    process.stdout.write(
      `[STRICT] partition ${i + 1}/${partitions.length} done in ${ms} ms — ${parsed.entries.length} fail entr(ies)\n`
    );
  }

  const observed = [...new Set(observedPerPartition.flat())].sort();
  const envGates = mergeEnvGates(envGatesPerPartition);

  if (learn) {
    const baseline: StrictBaseline = {
      sha: currentSha(),
      capturedAt: new Date().toISOString(),
      fails: observed,
      partition: { n, boundaries },
    };
    writeFileSync(join(cwd, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
    process.stdout.write(
      `[STRICT] baseline captured: ${observed.length} fail(s) on ${baseline.sha} → ${BASELINE_PATH}\n` +
        `[STRICT] partition manifest recorded: n=${n}, ${partitions.length} slice(s).\n` +
        `[STRICT] wall: total ${wallPerPartition.reduce((s, w) => s + w, 0)} ms, slowest partition ${Math.max(...wallPerPartition)} ms.\n`
    );
    return 0;
  }

  const verdict: StrictVerdict = {
    observed,
    resolved: [],
    regressions: [],
    flakyTail: [],
    confirmed: false,
    envGates,
    exitCode: 0,
  };

  if (baseline) {
    const { fresh, resolved } = diffAgainstBaseline(observed, baseline);
    verdict.resolved = resolved;
    if (fresh.length > 0) {
      const rerun = new Set<number>();
      for (const entry of fresh) {
        const idx = partitionOf.get(entryFile(entry));
        if (idx === undefined) {
          // Foreign entries are refused at the FIRST pass (foreignEntryFiles),
          // so an unmapped fresh file cannot reach here — this is defence in
          // depth, not a retry-all: never confirm from a population we do not
          // own. The old re-run-everything fallback was retired with that
          // refusal (review #1114, third review).
          process.stdout.write(
            `[STRICT] 🔴 FRESH ENTRY OUTSIDE THE POPULATION: ${entry} — no partition owns ` +
              `${entryFile(entry)}. Refusing: no verdict is drawn from an unowned file.\n`
          );
          return 3;
        }
        rerun.add(idx);
      }
      process.stdout.write(
        `[STRICT] ${fresh.length} fresh entr(ies) — re-running ${rerun.size}/${partitions.length} partition(s) (reproduction rule)…\n`
      );
      const fresh2Set = new Set<string>();
      for (const i of [...rerun].sort((a, b) => a - b)) {
        const run2 = deps.runPartition(partitions[i], i, partitions.length);
        if (run2.killed) {
          printCrashedPartition(
            "killed",
            i,
            partitions.length,
            partitions[i],
            `confirmation pass, ${run2.errorCode ?? "killed"}`,
            run2.raw
          );
          return 3;
        }
        const parsed2 = parseRunOutput(run2.raw);
        if (!runIsAccountable(parsed2)) {
          printCrashedPartition(
            "unaccountable",
            i,
            partitions.length,
            partitions[i],
            "confirmation pass",
            run2.raw
          );
          return 3;
        }
        // File 19b item 2: the confirmation pass must hold the SAME population
        // gate — otherwise an entry whose file never ran would be classified
        // flaky (absent from the re-run) instead of unexplained. An unexplained
        // gap here is a refusal, not a verdict.
        const ranFiles2 = ranLineFileCount(run2.raw);
        if (populationEchoOverCounts(partitions[i], ranFiles2, parsed2)) {
          // Review #1114, second review: same gate as the first pass — no
          // entry is classified flaky from an echo that outruns its delivery.
          process.stdout.write(
            `[STRICT] 🔴 POPULATION OVER-COUNT in confirmation of partition ${i + 1}/${partitions.length}: ` +
              `${ranFiles2} file(s) ran / ${partitions[i].length} delivered — the echo attests more ` +
              "than this run delivered and more than the entries name. No entry is classified flaky " +
              "from an echo that outruns its delivery.\n"
          );
          return 3;
        }
        const unexplained2 = populationGapUnexplained(partitions[i], ranFiles2, parsed2);
        if (unexplained2.length > 0) {
          process.stdout.write(
            `[STRICT] 🔴 POPULATION GAP in confirmation of partition ${i + 1}/${partitions.length}: ${ranFiles2 ?? "NO Ran line"} file(s) ran / ${partitions[i].length} delivered — ${unexplained2.length} UNEXPLAINED (not a module-load death). No entry is classified flaky from a population that never ran:\n`
          );
          for (const f of unexplained2) process.stdout.write(`[STRICT]   · ${f}\n`);
          return 3;
        }
        const foreign2 = foreignEntryFiles(partitions[i], parsed2);
        if (foreign2.length > 0) {
          // Review #1114, third review: a foreign population is never evidence
          // of non-reproduction — a ghost cannot re-appear in a partition it
          // was never delivered to, so its absence here would read as flaky.
          process.stdout.write(
            `[STRICT] 🔴 FOREIGN POPULATION in confirmation of partition ${i + 1}/${partitions.length}: ` +
              `entries name file(s) outside the delivery (${foreign2.join(", ")}). No entry is ` +
              "classified flaky from a population that was never delivered.\n"
          );
          return 3;
        }
        for (const e of parsed2.entries) if (!baseline.fails.includes(e)) fresh2Set.add(e);
      }
      const split = splitFreshByReproduction(fresh, [...fresh2Set]);
      verdict.regressions = split.regressions;
      verdict.flakyTail = split.flakyTail;
      verdict.confirmed = true;
      verdict.exitCode = split.regressions.length > 0 ? 1 : 0;
      if (split.regressions.length > 0) {
        const alone = splitReproducedByAloneRun(split.regressions, deps, partitions.length);
        verdict.contextSensitive = alone.contextSensitive;
        for (const l of alone.lines) process.stdout.write(`${l}\n`);
      }
    }
  }

  printVerdict(verdict, hadBaseline);
  return baseline ? verdict.exitCode : 2;
}

export function main(
  argv: string[],
  runSuite: SuiteRunner = realSuiteRunner(process.cwd()),
  partitionDeps: PartitionDeps = defaultPartitionDeps(process.cwd())
): number {
  const partition = parsePartitionArg(argv);
  if (partition === "invalid") {
    process.stdout.write(
      "[STRICT] 🔴 --partition expects a positive integer (--partition or --partition=N). No run started.\n"
    );
    return 3;
  }
  if (partition !== null) return mainPartitioned(argv, partition.n, partitionDeps);

  const learn = argv.includes("--learn");
  const cwd = process.cwd();

  const run1 = runSuite();
  if (run1.killed) {
    printKill(run1.errorCode ?? "killed", run1.raw, run1.wall);
    return 3;
  }
  const parsed1 = parseRunOutput(run1.raw);
  if (!runIsAccountable(parsed1)) {
    process.stdout.write(
      `[STRICT] 🔴 NO VERDICT — parsed entries (${parsed1.entries.length}) do not account for bun's own counters (fail=${parsed1.fail}, error=${parsed1.error}, ran-line ${parsed1.ranLinePresent ? "present" : "ABSENT"}).\n[STRICT]   A gap means the parser is blind to a failure shape (module-load death, truncated output past maxBuffer) — trusting it would print a false green. Fix the parser, re-run.\n`
    );
    return 3;
  }
  const observed = [...new Set(parsed1.entries)].sort();

  if (learn) {
    const baseline: StrictBaseline = {
      sha: currentSha(),
      capturedAt: new Date().toISOString(),
      fails: observed,
    };
    writeFileSync(join(cwd, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
    process.stdout.write(
      `[STRICT] baseline captured: ${observed.length} fail(s) on ${baseline.sha} → ${BASELINE_PATH}\n`
    );
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
      process.stdout.write(
        `[STRICT] ${fresh.length} fresh entr(ies) — running confirmation pass (reproduction rule)…\n`
      );
      const run2 = runSuite();
      if (run2.killed) {
        printKill(run2.errorCode ?? "killed", run2.raw, run2.wall);
        return 3;
      }
      const parsed2 = parseRunOutput(run2.raw);
      if (!runIsAccountable(parsed2)) {
        process.stdout.write(
          `[STRICT] 🔴 NO VERDICT — the confirmation pass is unaccountable (fail=${parsed2.fail}, error=${parsed2.error}, ran-line ${parsed2.ranLinePresent ? "present" : "ABSENT"}).\n`
        );
        return 3;
      }
      const fresh2 = [...new Set(parsed2.entries)].filter((n) => !baseline.fails.includes(n));
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

if (process.argv[1]?.endsWith("strict-runner.ts")) {
  process.exit(main(process.argv.slice(2)));
}
