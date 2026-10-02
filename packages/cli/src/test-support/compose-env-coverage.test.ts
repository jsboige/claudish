/**
 * #304 — static cross-check: every CLAUDISH_* env name the proxy READS must be
 * injected by docker-compose.yml's `environment:` list, or it is unreachable in
 * a container.
 *
 * The compose `environment:` list is an explicit allowlist: the env file is
 * used for interpolation only, so a knob written there for a name the list
 * does not carry never reaches the process — the proxy runs on its defaults
 * whatever the operator wrote. That is how five #91/#293 failover knobs and
 * the #218 kill switch (`CLAUDISH_NATIVE_MODEL_PIN`) shipped documented
 * (.env.sidecar.example) but unreachable in every compose deployment.
 *
 * What this test pins, in both directions:
 *   1. code → compose: every name read in production sources (tests excluded)
 *      appears in the compose list. This is the AC that failed for #304.
 *   2. compose → code: every CLAUDISH_FAILOVER_* name in the compose list is
 *      read by the code (statically or through the dynamic role family) — a
 *      renamed knob would otherwise leave a dead compose line that looks
 *      configurable and is not.
 *
 * Dynamic reads are template literals (`env[`CLAUDISH_FAILOVER_${role}`]`,
 * `env[`${key}_LABEL`]`) — they cannot be extracted as literals, so the closed
 * role set {OPUS,SONNET,HAIKU,FABLE} is resolved here, and the resolution is
 * itself pinned: if FAILOVER_ROLES ever grows a fifth role, the bare-role
 * anchor assertion below fails and forces the family (and compose) to follow.
 *
 * Positive controls (a detector that silently matches nothing proves nothing):
 *   - the compose parser must find the known 23-name family (parser alive);
 *   - the code scan must collect ≥ 10 names incl. CLAUDISH_FAILOVER_ACTIVE
 *     (scanner alive);
 *   - the gap checker must report a name on a synthetic compose that lacks it
 *     (verdict alive — this is the mutation, run as a fixture so the real
 *     repository is never touched).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const COMPOSE_FILE = join(REPO_ROOT, "docker-compose.yml");

/** The closed role set — mirrors FAILOVER_ROLES in fork/failover.ts. */
const ROLES = ["OPUS", "SONNET", "HAIKU", "FABLE"] as const;

/**
 * Env names covered by this cross-check. CLAUDISH_FAILOVER_* wholesale, plus
 * the two kill switches the #304 addendum named (NATIVE_MODEL_PIN was in the
 * same absent-from-compose state; FOREIGN_TOKEN_GUARD is the control member —
 * it was ADDED to the list as a review fixup on #303, so it must stay).
 */
const WATCHED = [
  "CLAUDISH_FAILOVER_",
  "CLAUDISH_NATIVE_MODEL_PIN",
  "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
  // #305 AC-1 instrument — added with the name itself, so it cannot ship
  // unreachable the way the #304 knobs did. #310 widens this to all CLAUDISH_*.
  "CLAUDISH_NATIVE_HEADER_NAMES_LOG",
];

function isWatched(name: string): boolean {
  return WATCHED.some((w) => (w.endsWith("_") ? name.startsWith(w) : name === w));
}

/** Recursively collect non-test .ts files under packages/cli/src. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

export interface ScanResult {
  /** Literal name → where it is read (file:line). */
  staticReads: Map<string, string[]>;
  /** Template-literal reads that resolve onto the role family. */
  dynamicBareRole: boolean;
  dynamicSuffixes: Set<string>;
}

/** Scan sources for the shapes the failover code uses to read the environment. */
export function scanSources(files: { path: string; text: string }[]): ScanResult {
  const staticReads = new Map<string, string[]>();
  let dynamicBareRole = false;
  const dynamicSuffixes = new Set<string>();
  // \benv\b: standalone `env.` (initFailover's parameter) — must NOT match
  // `xenv.`/`myenv.`; `process.env` matched by its own alternative.
  const staticRe = /(?:process\.env|\benv\b)\.(CLAUDISH_FAILOVER_[A-Z0-9_]+|CLAUDISH_NATIVE_MODEL_PIN|CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD|CLAUDISH_NATIVE_HEADER_NAMES_LOG)/g;
  const dynamicBareRe = /env\[`CLAUDISH_FAILOVER_\$\{[^}]+\}`\]/;
  // `env[`${key}_LABEL`]` — capture the suffix WITHOUT its joining underscore
  // (the required name is built as `${role}_${suffix}`).
  const dynamicSuffixRe = /env\[`\$\{key\}_([A-Z]+)`\]/g;
  for (const f of files) {
    const lines = f.text.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(staticRe)) {
        const name = m[1];
        const where = `${f.path.replace(SRC_ROOT + "\\", "").replace(/\\/g, "/")}:${i + 1}`;
        const list = staticReads.get(name) ?? [];
        list.push(where);
        staticReads.set(name, list);
      }
      if (dynamicBareRe.test(line)) dynamicBareRole = true;
      for (const m of line.matchAll(dynamicSuffixRe)) dynamicSuffixes.add(m[1]);
    });
  }
  return { staticReads, dynamicBareRole, dynamicSuffixes };
}

/** Extract the CLAUDISH_* names the compose environment: list injects. */
export function composeEnvNames(composeText: string): Set<string> {
  const names = new Set<string>();
  for (const m of composeText.matchAll(/^\s*- (CLAUDISH_[A-Z0-9_]+)=\$\{/gm)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * The full set of names the code can read, dynamic templates resolved onto
 * the role family. Everything in this set must be in the compose list.
 */
export function requiredNames(scan: ScanResult): Set<string> {
  const required = new Set<string>();
  for (const name of scan.staticReads.keys()) required.add(name);
  if (scan.dynamicBareRole) {
    for (const role of ROLES) required.add(`CLAUDISH_FAILOVER_${role}`);
  }
  for (const suffix of scan.dynamicSuffixes) {
    for (const role of ROLES) required.add(`CLAUDISH_FAILOVER_${role}_${suffix}`);
  }
  return required;
}

/** Direction 1 verdict: names the code reads that compose does not inject. */
export function coverageGaps(scan: ScanResult, composeNames: Set<string>): string[] {
  const gaps: string[] = [];
  for (const name of requiredNames(scan)) {
    if (!composeNames.has(name)) gaps.push(name);
  }
  return gaps.sort();
}

/** Direction 2 verdict: failover compose entries the code no longer reads. */
export function deadComposeEntries(scan: ScanResult, composeNames: Set<string>): string[] {
  const required = requiredNames(scan);
  return [...composeNames]
    .filter((n) => isWatched(n) && !required.has(n))
    .sort();
}

describe("#304 compose env coverage", () => {
  const composeText = readFileSync(COMPOSE_FILE, "utf-8");
  const files = collectSourceFiles(SRC_ROOT).map((path) => ({ path, text: readFileSync(path, "utf-8") }));
  const scan = scanSources(files);
  const composeNames = composeEnvNames(composeText);

  test("positive control: the compose parser sees the known 23-name family", () => {
    // If this fires, the parser is matching nothing and every assertion below
    // is vacuously green — the exact blindness this control exists to catch.
    for (const role of ROLES) {
      expect(composeNames.has(`CLAUDISH_FAILOVER_${role}`)).toBe(true);
      for (const suffix of ["LABEL", "DIRECTION", "NOTE", "RESET"]) {
        expect(composeNames.has(`CLAUDISH_FAILOVER_${role}_${suffix}`)).toBe(true);
      }
    }
    expect(composeNames.has("CLAUDISH_FAILOVER_ROLE_MODELS")).toBe(true);
    expect(composeNames.has("CLAUDISH_FAILOVER_ACTIVE")).toBe(true);
    expect(composeNames.has("CLAUDISH_FAILOVER_AUTO")).toBe(true);
  });

  test("positive control: the source scanner collected the known reads", () => {
    // initFailover (fork/failover.ts) reads these as literals.
    for (const name of [
      "CLAUDISH_FAILOVER_ACTIVE",
      "CLAUDISH_FAILOVER_AUTO",
      "CLAUDISH_FAILOVER_ROLE_MODELS",
      "CLAUDISH_FAILOVER_ARM_AFTER",
      "CLAUDISH_FAILOVER_SESSION_DWELL_MS",
      "CLAUDISH_FAILOVER_RECOVERY_GRACE_MS",
      "CLAUDISH_NATIVE_MODEL_PIN",
      "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
      "CLAUDISH_NATIVE_HEADER_NAMES_LOG",
    ]) {
      expect(scan.staticReads.has(name)).toBe(true);
    }
    // The dynamic role family is detected, not assumed.
    expect(scan.dynamicBareRole).toBe(true);
    expect(scan.dynamicSuffixes.has("LABEL")).toBe(true);
    expect(scan.staticReads.size).toBeGreaterThanOrEqual(10);
  });

  test("every env name the code reads is injected by docker-compose.yml (#304 AC1)", () => {
    const gaps = coverageGaps(scan, composeNames);
    const detail = gaps.map((g) => {
      const where = scan.staticReads.get(g) ?? ["(dynamic role-family read)"];
      return `  ${g} — read at ${where.join(", ")}`;
    });
    expect(gaps).toEqual([], `names read in code but absent from docker-compose.yml environment:\n${detail.join("\n")}\n(the env file only interpolates — these never reach a container)`);
  });

  test("every CLAUDISH_FAILOVER_* compose entry is read by the code (no dead knobs)", () => {
    const dead = deadComposeEntries(scan, composeNames);
    expect(dead).toEqual([], `compose entries the code never reads (renamed knob? stale line?):\n  ${dead.join("\n  ")}`);
  });

  test("positive control (mutation): the gap checker reports a name the compose lacks", () => {
    // Synthetic fixture: the real compose minus one knob. The checker must
    // name it — proving the verdict function can fail, not just return [].
    const gutted = composeText.replace(
      /^\s*- CLAUDISH_FAILOVER_ARM_AFTER=\$\{CLAUDISH_FAILOVER_ARM_AFTER:-\}\r?\n/m,
      ""
    );
    const gaps = coverageGaps(scan, composeEnvNames(gutted));
    expect(gaps).toContain("CLAUDISH_FAILOVER_ARM_AFTER");
    // And the direction-2 checker on a synthetic name nothing reads.
    const withGhost = composeText + "      - CLAUDISH_FAILOVER_GHOST=${CLAUDISH_FAILOVER_GHOST:-}\n";
    expect(deadComposeEntries(scan, composeEnvNames(withGhost))).toContain("CLAUDISH_FAILOVER_GHOST");
  });
});
