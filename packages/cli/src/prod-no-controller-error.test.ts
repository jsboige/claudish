/**
 * #641 (G4a bullet 2a, structural pin) — no `controller.error(` anywhere in
 * production sources under packages/cli/src.
 *
 * The proxy sits inside an agentic loop: `controller.error()` on a
 * ReadableStream the client is reading KILLS the client-visible response
 * mid-flight — a hang by another name. The rule has lived in CLAUDE.md
 * ("Never-Hang Constraints") with no assertion holding it; a re-platform that
 * reintroduces one call would pass every functional test and wedge the fleet.
 *
 * What counts as production: every .ts under packages/cli/src EXCEPT test
 * files (`*.test.ts`), the test-support harness (which legitimately calls
 * `controller.error` — see stub-fetch.ts) and checked-in fixtures. Comments
 * and string literals are stripped by a small state machine BEFORE detection,
 * so a mention in prose or a log message is not a hit — only a call site in
 * code is.
 *
 * Positive control: the same detector runs over a synthetic file that carries
 * a real call — if the detector can go blind, this test fails loudly instead
 * of certifying a broken scan. Mutation proof (observed 2026-10-24, queue
 * 1230Z grain 3): injecting `controller.error(` into a production source made
 * exactly this suite red; byte-exact restore made it green again.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_ROOT = join(import.meta.dir);

/**
 * #641 landing, étape 7 (coordinator GO 12/11): the ONLY surviving
 * `controller.error(` call sites — the two stream-head sniffers, whose
 * replayed stream feeds a PARSER, never the client directly; a rejection
 * there is the parser's own error handling running (the conversion), not a
 * killed client stream. Every other former site (seam-tap, seam-transform,
 * raw's replay and fallback, the advisor tee, the two lease wrappers) now
 * terminates with a synthetic labeled terminal + close, or release + close
 * (#663 r1) — pinned in seam-neverhang-pins.test.ts.
 *
 * Each entry names its conversion pin BY TEST NAME: the pin seeds a rejection
 * in the upstream body after the sniffer's clean verdict and asserts a
 * labeled error terminal on the client side, through the real consumer
 * chain — responses: responses-leg.ts `{kind:"stream-error"}` →
 * responses-turn.ts `sink.endWithError/endWithText`; devin:
 * devin-connect.ts `finalize("error")` (an SSE `error` frame). The liveness
 * test below refuses an entry whose pin is gone from that file. Line-pinned
 * on purpose: a NEW site (or a line shift from a legitimate edit)
 * re-reddens this pin instead of passing silently.
 */
const V14_SEAM_SITES = new Map<string, string>([
  [
    "handlers/shared/stream-head-sniffer.ts:132",
    "responses sniffer: a replayed rejection ends as a labeled error terminal through the Responses chain",
  ],
  [
    "handlers/shared/devin-stream-head-sniffer.ts:163",
    "devin sniffer: a replayed rejection ends as a labeled error frame through the Devin chain",
  ],
]);

/** Call sites are what kill streams — a mention inside a string or comment
 * is not. Returns the file content with comments and string-literal contents
 * blanked (same length, so line numbers stay meaningful in error output). */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  type State = "code" | "line" | "block" | "squote" | "dquote" | "tpl";
  let state: State = "code";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? "";
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out.push("  ");
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out.push("  ");
        i++;
        continue;
      }
      if (ch === "'") {
        state = "squote";
        out.push(" ");
        continue;
      }
      if (ch === '"') {
        state = "dquote";
        out.push(" ");
        continue;
      }
      if (ch === "`") {
        state = "tpl";
        out.push(" ");
        continue;
      }
      out.push(ch);
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out.push("\n");
      } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out.push("  ");
        i++;
      } else out.push(ch === "\n" ? "\n" : " ");
      continue;
    }
    // string states: contents blanked, escapes honored
    if (ch === "\\") {
      out.push("  ");
      i++;
      continue;
    }
    if (
      (state === "squote" && ch === "'") ||
      (state === "dquote" && ch === '"') ||
      (state === "tpl" && ch === "`")
    ) {
      state = "code";
      out.push(" ");
      continue;
    }
    out.push(ch === "\n" ? "\n" : " ");
  }
  return out.join("");
}

const CALL_SITE = /controller\.error\s*\(/;

function findCallSites(content: string): number[] {
  const stripped = stripCommentsAndStrings(content);
  const hits: number[] = [];
  stripped.split("\n").forEach((line, idx) => {
    if (CALL_SITE.test(line)) hits.push(idx + 1);
  });
  return hits;
}

/** Production .ts files: everything under src except tests, the test-support
 * harness and checked-in fixtures. */
function collectProdFiles(): string[] {
  const skipDirs = new Set(["test-support", "test-fixtures", "node_modules", "dist"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(entry)) walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      files.push(full);
    }
  };
  walk(SRC_ROOT);
  return files;
}

describe("#641 G4a-2a — no controller.error( in production sources", () => {
  test("positive control: the detector flags a file that really carries a call", () => {
    const fixture = [
      "// a comment mentioning controller.error( is not a hit",
      'const msg = "controller.error( in a string is not a hit either";',
      "function boom(controller: ReadableStreamDefaultController) {",
      "  controller.error(new Error('kill the stream'));",
      "}",
    ].join("\n");
    const hits = findCallSites(fixture);
    // Line 4 is the only real call site; if the detector ever goes blind on
    // it, this pin is lying about the corpus below.
    expect(hits).toEqual([4]);
  });

  test("the scan covers the production corpus and finds zero call sites", () => {
    const files = collectProdFiles();
    // Guard against a silently-empty corpus (a path change making the walk
    // find nothing would otherwise certify a vacuous green).
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC_ROOT, f).split(sep).join("/");
      const hits = findCallSites(readFileSync(f, "utf-8"));
      for (const line of hits) {
        if (V14_SEAM_SITES.has(`${rel}:${line}`)) continue;
        offenders.push(`${f}:${line}`);
      }
    }
    expect(
      offenders.length === 0
        ? "no controller.error( call sites in production sources"
        : `controller.error( found at:\n  ${offenders.join("\n  ")}`
    ).toBe("no controller.error( call sites in production sources");
  });

  test("every surviving site names a conversion pin that exists", () => {
    // An allowlist entry without its pin is an unpinned rejection: the entry
    // would keep certifying a site nobody proves converted. The pin file is
    // read from disk, so deleting the test (not just failing it) reddens
    // here too.
    const pinFile = readFileSync(join(SRC_ROOT, "seam-neverhang-pins.test.ts"), "utf-8");
    for (const [site, pin] of V14_SEAM_SITES) {
      expect(
        pinFile.includes(pin),
        `${site} names pin "${pin}" — present in seam-neverhang-pins.test.ts?`
      ).toBe(true);
    }
  });
});
