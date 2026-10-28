import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Upstream-sync S1 pins (Epic #731) — the no-direct-importer census, frozen.
 *
 * The triage table (docs/reference/upstream-sync-triage.md) measured, under its
 * own rule — a `*.test.ts(x)` quoting an import specifier that resolves to the
 * module's basename — that 20 code/config source rows have NO direct test importer. A test
 * that never imports a module stays green when the module moves, so an `R` cut
 * (or an `M` deletion during sync) on any of these files would otherwise be
 * silent. Each row is pinned here BEFORE any cut, per the Epic's gate.
 *
 * What the pin is: a PRESENCE pin, deliberately not an import. Importing these
 * modules would execute their top-level code — telemetry.ts's consent prompt is
 * the reason telemetry.test.ts itself never imports it — and would flip the
 * census (the pin file would become their importer). Presence is the signal the
 * cut actually needs: move or delete a pinned path without repointing this list
 * and this file goes red.
 *
 * What the pin is not: coverage. A pinned module is not proven to work, only to
 * still sit where the triage put it. Rows whose class is `R` name the seam they
 * are allowed to move to; the move must take this list with it.
 *
 * The three top-level prose rows of the census (README.md, CLAUDE.md,
 * ROADMAP.md) are not pinned: no import can ever cover a prose file, and their
 * cut-time check is review, not a test.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const PINS: ReadonlyArray<{ row: number; path: string; cls: string }> = [
  { row: 2, path: "packages/cli/bin/claudish.cjs", cls: "R" },
  { row: 11, path: "packages/cli/src/auth/oauth-manager.ts", cls: "R" },
  { row: 17, path: "packages/cli/src/handlers/native-handler.ts", cls: "R" },
  { row: 23, path: "packages/cli/src/profile-commands.ts", cls: "R" },
  { row: 34, path: ".github/workflows/test.yml", cls: "A" },
  { row: 35, path: "bunfig.toml", cls: "A" },
  { row: 36, path: "packages/cli/bunfig.toml", cls: "A" },
  {
    row: 48,
    path: "packages/cli/src/handlers/shared/stream-parsers/message-start-usage.ts",
    cls: "A",
  },
  { row: 60, path: "packages/cli/src/config-command.ts", cls: "M" },
  {
    row: 62,
    path: "packages/cli/src/middleware/gemini-thought-signature.ts",
    cls: "M",
  },
  { row: 70, path: ".gitignore", cls: "S" },
  { row: 73, path: "docs/settings-reference.md", cls: "S" },
  { row: 74, path: "package.json", cls: "S" },
  { row: 82, path: "packages/cli/src/auth/kimi-oauth.ts", cls: "S" },
  { row: 83, path: "packages/cli/src/auth/oauth-registry.ts", cls: "S" },
  {
    row: 110,
    path: "packages/cli/src/providers/transport/openai-codex.ts",
    cls: "S",
  },
  { row: 118, path: "packages/cli/src/telemetry.ts", cls: "S" },
  { row: 119, path: "packages/cli/src/transform.ts", cls: "S" },
  { row: 120, path: "packages/cli/src/tui/App.tsx", cls: "S" },
  { row: 122, path: "scripts/generate-manifest.ts", cls: "S" },
];

describe("upstream-sync S1 pins (#731)", () => {
  it("the frozen list is well-formed (20 rows, unique, repo-relative)", () => {
    expect(PINS.length).toBe(20);
    const paths = PINS.map((p) => p.path);
    expect(new Set(paths).size).toBe(20);
    for (const p of PINS) {
      // win32 relative() yields backslashes; the frozen list is POSIX-spelled.
      const rel = relative(REPO_ROOT, join(REPO_ROOT, p.path)).split("\\").join("/");
      expect(rel).toBe(p.path);
    }
  });

  it.each(PINS)("row #%row% (%cls%) sits at its triaged path: %path%", (pin) => {
    // The presence pin. A cut that moves or deletes this path without
    // repointing the list above fails here — that is the entire point.
    expect(existsSync(join(REPO_ROOT, pin.path))).toBe(true);
  });
});
