/**
 * Preset-mode sandbox guard — the pure half of `test-preload.ts`.
 *
 * In preset mode the launcher hands us the sandbox via `HOME` before bun boots
 * (bun >= 1.4 / POSIX freezes `os.homedir()`), so `homedir()` alone can no
 * longer distinguish "isolated sandbox" from "the operator's real home": with
 * `CLAUDISH_TEST_PRESET_HOME=1` inherited on a seat, the old guard compared
 * `homedir()` with itself and could never fire, and `afterAll` would then
 * `rmSync` the real `~/.claudish` (#242 re-opened by the fix that made CI run).
 *
 * The reference "real home" is therefore the passwd entry (`os.userInfo()`),
 * which does not follow `HOME`, and the preset sandbox must additionally sit in
 * a throwaway location (tmpdir, RUNNER_TEMP) or run under GitHub Actions.
 *
 * Kept in its own module so the branches can be pinned by unit tests: importing
 * the preload itself runs its side effects.
 */
import { resolve, sep } from "node:path";

export interface PresetCheck {
  /** The launcher-provided home — what `homedir()` resolves to in preset mode. */
  sandbox: string;
  /** The passwd-database home, independent of HOME/USERPROFILE. */
  passwdHome: string;
  /**
   * Whether `passwdHome` is genuinely independent of the environment: true on
   * POSIX (passwd entry), FALSE on Windows — libuv derives `os.userInfo()` from
   * USERPROFILE there, so it follows the launcher's preset (measured 21/10:
   * preset HOME + preset USERPROFILE make the two equal). On Windows the
   * throwaway-location branch is the guard that catches an inherited preset.
   */
  passwdIsIndependent: boolean;
  /** `os.tmpdir()` — a sandbox below it is throwaway by construction. */
  tmpDir: string;
  /** GitHub Actions' per-job temp dir, when running on a runner. */
  runnerTemp?: string;
  /** `process.env.GITHUB_ACTIONS === "true"`. */
  githubActions: boolean;
}

/**
 * Which home the run must treat as "the operator's real home": the passwd entry
 * in preset mode (homedir() is the sandbox there), the runtime home otherwise.
 */
export function resolveRealHome(c: {
  preset: boolean;
  envHome: string;
  passwdHome: string;
}): string {
  return c.preset ? c.passwdHome : c.envHome;
}

/**
 * Returns a refusal message when preset mode cannot prove its isolation, or
 * null when it may proceed.
 */
export function presetRefusal(c: PresetCheck): string | null {
  const sandbox = resolve(c.sandbox);
  const passwd = resolve(c.passwdHome);
  if (c.passwdIsIndependent && sandbox === passwd) {
    return (
      `preset mode refused — the launcher HOME (${sandbox}) IS the passwd home; ` +
      "CLAUDISH_TEST_PRESET_HOME=1 requires an isolated HOME (the real ~/.claudish is what we protect)"
    );
  }
  const under = (base: string) => sandbox === resolve(base) || sandbox.startsWith(resolve(base) + sep);
  const throwaway = under(c.tmpDir) || (c.runnerTemp ? under(c.runnerTemp) : false);
  if (!c.githubActions && !throwaway) {
    return (
      `preset mode refused — ${sandbox} is neither under ${resolve(c.tmpDir)} nor under RUNNER_TEMP, ` +
      "and GITHUB_ACTIONS is unset; a preset HOME must be a throwaway directory"
    );
  }
  return null;
}