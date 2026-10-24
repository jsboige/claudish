/**
 * #641 G1 — toolchain and version contract for the replatform branch.
 *
 * Two policies, both enforced here so a re-platform cannot drift silently:
 *
 * 1. THREE-FILE VERSION POLICY — a version bump touches, and must keep in
 *    sync: the root `package.json`, `packages/cli/package.json` (what CI
 *    publishes), and `packages/cli/src/version.ts` (the fallback VERSION a
 *    compiled binary reports when no package.json ships beside it). A stale
 *    cli package makes `npm publish` fail; a stale version.ts makes compiled
 *    binaries lie about what they are.
 *
 * 2. SINGLE-SOURCE BUN PIN — the test side's bun version lives in
 *    `.bun-version` at the repo root and every test workflow reads it via
 *    `bun-version-file:`. No workflow may hardcode the pinned version
 *    (a second copy drifts); the deliberate divergences (blind-hooks on a
 *    newer bun, hooks-loading/release building with `latest`) keep explicit
 *    `bun-version:` values that differ from the pin and are documented in
 *    place.
 *
 * Mutation proof (observed before committing): bumping
 * packages/cli/package.json alone made assertion 1 red; hardcoding
 * `bun-version: "1.3.10"` back into a workflow made assertion 2 red.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const cliPkg = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf-8"));
const versionTs = readFileSync(join(ROOT, "packages/cli/src/version.ts"), "utf-8");
const versionMatch = versionTs.match(/export const VERSION = "([^"]+)"/);

const WORKFLOW_DIR = join(ROOT, ".github/workflows");

function readWorkflows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(WORKFLOW_DIR)) {
    if (f.endsWith(".yml") || f.endsWith(".yaml")) {
      out[f] = readFileSync(join(WORKFLOW_DIR, f), "utf-8");
    }
  }
  return out;
}

describe("#641 G1 — version and bun-pin contract", () => {
  test("the three version files agree", () => {
    const cells = [
      ["root package.json", rootPkg.version],
      ["packages/cli/package.json", cliPkg.version],
      [
        "packages/cli/src/version.ts",
        versionMatch ? versionMatch[1] : "(VERSION export not found)",
      ],
    ];
    const ok =
      cells[0][1] === cells[1][1] &&
      cells[1][1] === cells[2][1] &&
      versionMatch !== null;
    expect(
      ok
        ? `all three files at ${cells[0][1]}`
        : `version drift:\n  ${cells.map(([f, v]) => `${f}: ${v}`).join("\n  ")}`
    ).toBe(`all three files at ${cells[0][1]}`);
  });

  test(".bun-version is a concrete version and the workflows' single pin source", () => {
    const pin = readFileSync(join(ROOT, ".bun-version"), "utf-8").trim();
    // A concrete x.y.z — not "latest", not a range, not empty.
    expect(/^\d+\.\d+\.\d+$/.test(pin), `.bun-version is "${pin}"`).toBe(true);

    const workflows = readWorkflows();
    const hardcoded: string[] = [];
    let fileReaders = 0;
    for (const [name, body] of Object.entries(workflows)) {
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*bun-version:\s*(.+?)\s*$/);
        if (m && m[1].replace(/["']/g, "") === pin) {
          hardcoded.push(`${name}: ${line.trim()}`);
        }
      }
      if (body.includes("bun-version-file: .bun-version")) fileReaders++;
    }

    expect(
      hardcoded.length === 0
        ? "no workflow hardcodes the pinned version"
        : `workflows hardcoding "${pin}" (use bun-version-file instead):\n  ${hardcoded.join("\n  ")}`
    ).toBe("no workflow hardcodes the pinned version");

    // The pin is actually wired: at least the test, boot-canary and smoke
    // workflows read it. If every reader were dropped the corpus above would
    // still pass vacuously.
    expect(
      fileReaders >= 3
        ? `${fileReaders} workflow(s) read .bun-version`
        : `only ${fileReaders} workflow(s) read .bun-version — expected the test-side jobs`
    ).toBe(`${fileReaders} workflow(s) read .bun-version`);
  });
});
