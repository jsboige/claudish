/**
 * Controls for the strict runner itself (#175 deliverable 4): the comparison
 * core must classify fresh/resolved/flaky correctly in BOTH directions, the
 * fail-line parser must normalize durations away, and the ENV-GATE manifest
 * parser must consolidate per-file blocks into one summary.
 */
import { describe, expect, test } from "bun:test";
import {
  compareAgainstBaseline,
  normalizeFailLine,
  parseEnvGateManifests,
  type StrictBaseline,
} from "./strict-runner";

const base: StrictBaseline = {
  sha: "abc1234",
  capturedAt: "2026-09-29T00:00:00Z",
  fails: ["A > a1", "B > b1", "C > c1"],
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
  test("treats error lines as fails (module-load deaths count)", () => {
    expect(normalizeFailLine("(error) some file-level death [1.00ms]")).toBe("some file-level death");
  });
  test("rejects non-fail lines (pass/skip/log noise)", () => {
    expect(normalizeFailLine("(pass) A > a1 [1ms]")).toBeNull();
    expect(normalizeFailLine("(skip) A > a2")).toBeNull();
    expect(normalizeFailLine("random log line")).toBeNull();
  });
});

describe("compareAgainstBaseline", () => {
  test("identical population → no regression, exit 0", () => {
    const v = compareAgainstBaseline([...base.fails], base, 2);
    expect(v.regressions).toEqual([]);
    expect(v.resolved).toEqual([]);
    expect(v.exitCode).toBe(0);
  });

  test("flaky tail within tolerance is NOT a regression (dispatch: 1-2/run is noise)", () => {
    const v = compareAgainstBaseline([...base.fails, "FLAKY > x"], base, 2);
    expect(v.flakyTail).toEqual(["FLAKY > x"]);
    expect(v.regressions).toEqual([]);
    expect(v.exitCode).toBe(0);
  });

  test("fresh fails beyond the tolerance ARE regressions — the review signal", () => {
    const v = compareAgainstBaseline([...base.fails, "NEW > n1", "NEW > n2", "NEW > n3"], base, 2);
    expect(v.flakyTail).toEqual(["NEW > n1", "NEW > n2"]);
    expect(v.regressions).toEqual(["NEW > n3"]);
    expect(v.exitCode).toBe(1);
  });

  test("resolved baseline fails are informational, never an error", () => {
    const v = compareAgainstBaseline(["A > a1"], base, 2);
    expect(v.resolved.sort()).toEqual(["B > b1", "C > c1"]);
    expect(v.exitCode).toBe(0);
  });

  test("baseline classes 2/2b stay red and stay compared — hiding them is not an option", () => {
    // TEST-15 is a real win32 defect: it lives IN the baseline, and a run that
    // still fails it must exit 0 (it is expected), while a run that makes it
    // VANISH merely reports it resolved.
    const withDefect: StrictBaseline = { ...base, fails: [...base.fails, "team-orchestrator > validateSessionPath > TEST-15: accepts"] };
    const v = compareAgainstBaseline(withDefect.fails, withDefect, 2);
    expect(v.exitCode).toBe(0);
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
