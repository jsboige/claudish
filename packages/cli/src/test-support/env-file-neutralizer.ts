/**
 * Repo-`.env` neutralizer (#1101) — the INHERITANCE half of the fix.
 *
 * `--no-env-file` on the entry points stops a bun-test process from LOADING
 * the repo `.env` (measured, bun 1.4.2). It cannot stop INHERITANCE: the
 * wrapper `bun run <script>` loads the repo-root `.env` into its own
 * environment before executing the script, and every child it spawns —
 * `test:strict`'s runner included — receives those variables through
 * `process.env`, flag or no flag (measured 16/11: a full strict run with the
 * flag on every spawn still reported the #1101 trio; the keys had come from
 * the parent). CI and fresh worktrees have no `.env`, so a seat run with the
 * keys present measures a population CI never sees.
 *
 * The neutralizer runs in the preload, before any test file: it reads the
 * repo `.env` (and `.env.local`) and DELETES every variable whose current
 * value equals the file's entry. Value-equality, not name-only: an operator
 * value the shell exported on purpose (which bun lets win over the file)
 * that happens to share a name but not a value stays — that is a deliberate
 * environment, not seat-state leakage through a file.
 *
 * FIREWALL, same doctrine as the capture guard: the file can contain
 * credentials. It is read here for comparison only; key NAMES may leave this
 * module (the drop list, the count), values never.
 *
 * CI regime: no `.env` file → nothing dropped → byte-identical behaviour.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** From this file: test-support -> src -> cli -> packages -> repo root. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The env files bun auto-loads beside the project root, in load order. */
export function defaultEnvFilePaths(): string[] {
  return [join(REPO_ROOT, ".env"), join(REPO_ROOT, ".env.local")];
}

/**
 * Minimal `KEY=VALUE` parse — enough for bun's format: comments, blank lines,
 * an optional `export ` prefix, and a matched surrounding quote pair. A line
 * without a usable `=` is skipped, never thrown: a malformed seat file must
 * not take the suite down, and the keys it fails to parse simply stay.
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (key === "") continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return entries;
}

/**
 * Which keys the file would drop from `env`: present, string-valued, and
 * exactly equal to the file's entry. Pure — pinned without touching
 * `process.env`.
 */
export function keysDroppedByFile(
  entries: ReadonlyArray<readonly [string, string]>,
  env: Record<string, string | undefined>
): string[] {
  const dropped: string[] = [];
  for (const [key, value] of entries) {
    if (typeof env[key] === "string" && env[key] === value) dropped.push(key);
  }
  return dropped;
}

/**
 * Wiring evidence for the pin: the preload sets this to the number of keys it
 * dropped, so a test can assert the arming happened without needing a `.env`
 * to exist (CI reads "0", a seat reads its count; `undefined` means the
 * neutralizer is no longer armed — exactly the mutation the pin must catch).
 */
export const ENV_NEUTRALIZED_COUNT_VAR = "CLAUDISH_TEST_ENV_NEUTRALIZED";

/**
 * Drop the repo `.env`-sourced keys from `env` (default: the live
 * `process.env`, before any test file loads). Returns the dropped key NAMES.
 * Call once, at preload top level, via `armRepoEnvFileNeutralizer`.
 */
export function neutralizeRepoEnvFile(
  env: Record<string, string | undefined> = process.env,
  envFilePaths: string[] = defaultEnvFilePaths()
): string[] {
  const dropped: string[] = [];
  for (const path of envFilePaths) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue; // absent (CI) or unreadable: nothing this file can drop
    }
    for (const key of keysDroppedByFile(parseEnvFile(text), env)) {
      delete env[key];
      if (!dropped.includes(key)) dropped.push(key);
    }
  }
  return dropped;
}

/** Preload arming: neutralize, then record the count for the wiring pin. */
export function armRepoEnvFileNeutralizer(): string[] {
  const dropped = neutralizeRepoEnvFile();
  process.env[ENV_NEUTRALIZED_COUNT_VAR] = String(dropped.length);
  return dropped;
}
