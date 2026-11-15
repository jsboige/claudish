/**
 * Cross-contract pin between `replatform/v14` and `main` (#641 C4).
 *
 * The landing (B6) is a one-shot merge, and six pipeline modules exist on both
 * branches under the same names:
 *
 *   handlers/shared/thinking-signature.ts
 *   handlers/shared/collect-sse-message.ts
 *   handlers/shared/stream-parsers/sse-line.ts
 *   handlers/shared/stream-parsers/block-writer.ts
 *   handlers/shared/stream-parsers/think-tag-splitter.ts
 *   handlers/shared/stream-parsers/message-start-usage.ts
 *
 * #641's rule for them is "drop or reconcile, never re-port" — which only holds
 * if the two copies still share one CONTRACT. This pin makes that measurable:
 * capture the six modules from `main` once (`--learn --main <checkout>`), then
 * any v14 checkout verifies against the recording. The wire contract is the
 * CODE, so the comparison is three-way per module:
 *
 *   IDENTICAL     raw bytes equal
 *   COMMENT-ONLY  raw differs, comment/whitespace-stripped source equal —
 *                 cosmetic, the contract still matches (a reviewer is told,
 *                 a gate is not failed)
 *   DIVERGENT     comment-stripped source differs — the contract moved, the
 *                 divergence needs an adjudicated reconcile line
 *
 * Exit codes follow the same discipline as test:strict: 0 = every module
 * IDENTICAL or COMMENT-ONLY, 1 = at least one DIVERGENT (named), 3 = the
 * instrument itself could not measure (missing baseline, missing module, bad
 * args) — never read as a pass.
 *
 * Usage:
 *   bun scripts/contract-cross-pin.ts --learn --main D:/Dev/claudish
 *   bun scripts/contract-cross-pin.ts            # verify against the recording
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_PATH = "scripts/contract-cross-baseline.json";

export const SHARED_MODULES = [
  "packages/cli/src/handlers/shared/thinking-signature.ts",
  "packages/cli/src/handlers/shared/collect-sse-message.ts",
  "packages/cli/src/handlers/shared/stream-parsers/sse-line.ts",
  "packages/cli/src/handlers/shared/stream-parsers/block-writer.ts",
  "packages/cli/src/handlers/shared/stream-parsers/think-tag-splitter.ts",
  "packages/cli/src/handlers/shared/stream-parsers/message-start-usage.ts",
] as const;

export interface ModuleDigest {
  raw: string;
  normalized: string;
}

export interface ContractBaseline {
  schemaVersion: 1;
  /** `git rev-parse --short HEAD` of the tree the baseline was captured from */
  sourceSha: string;
  capturedAt: string;
  modules: Record<string, ModuleDigest>;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Strip comments and collapse whitespace, leaving code and string contents.
 *
 * A hand-rolled state machine, not a parser — and deliberately not a regex.
 * Neither side of the comparison is ever compiled with this output; the ONLY
 * property that must hold is that the SAME transformation runs on both trees.
 * A mis-read (a regex literal taken for a comment, a `/*` inside a string)
 * can therefore only ever produce a false DIVERGENT — visible and adjudicated
 * — never a silent false IDENTICAL, because the raw hash broke first and is
 * reported alongside.
 */
export function normalizeSource(src: string): string {
  let out = "";
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  // Brace depth inside each active `${ … }` of each nested template literal.
  const templateExpressions: number[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "single" || state === "double") {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if ((state === "single" && c === "'") || (state === "double" && c === '"')) state = "code";
      i++;
      continue;
    }
    if (state === "template") {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        out += c;
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        out += c + next;
        templateExpressions.push(0);
        state = "code";
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    // state === "code"
    if (c === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state = c === "'" ? "single" : c === '"' ? "double" : "template";
      out += c;
      i++;
      continue;
    }
    if (templateExpressions.length > 0) {
      if (c === "{") templateExpressions[templateExpressions.length - 1]++;
      if (c === "}") {
        if (templateExpressions[templateExpressions.length - 1] === 0) {
          // closing the `${`: back inside the template literal
          templateExpressions.pop();
          state = "template";
          out += c;
          i++;
          continue;
        }
        templateExpressions[templateExpressions.length - 1]--;
      }
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function digestModule(src: string): ModuleDigest {
  return { raw: sha256(src), normalized: sha256(normalizeSource(src)) };
}

export type ModuleVerdict = "IDENTICAL" | "COMMENT-ONLY" | "DIVERGENT" | "MISSING";

export interface PinRow {
  module: string;
  verdict: ModuleVerdict;
}

export function compareTree(
  root: string,
  baseline: ContractBaseline
): { rows: PinRow[]; divergent: string[]; missing: string[] } {
  const rows: PinRow[] = [];
  const divergent: string[] = [];
  const missing: string[] = [];
  for (const module of SHARED_MODULES) {
    const path = join(root, module);
    const recorded = baseline.modules[module];
    if (!recorded || !existsSync(path)) {
      rows.push({ module, verdict: "MISSING" });
      missing.push(module);
      continue;
    }
    const observed = digestModule(readFileSync(path, "utf8"));
    let verdict: ModuleVerdict;
    if (observed.raw === recorded.raw) verdict = "IDENTICAL";
    else if (observed.normalized === recorded.normalized) verdict = "COMMENT-ONLY";
    else verdict = "DIVERGENT";
    rows.push({ module, verdict });
    if (verdict === "DIVERGENT") divergent.push(module);
  }
  return { rows, divergent, missing };
}

function sourceSha(root: string): string {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short", "HEAD"]);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : "unknown";
}

function main(): number {
  const args = process.argv.slice(2);
  const learn = args.includes("--learn");
  const mainIdx = args.indexOf("--main");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  if (!learn && mainIdx === -1) {
    const baselinePath = join(root, BASELINE_PATH);
    if (!existsSync(baselinePath)) {
      console.error(
        `[C4] no baseline at ${BASELINE_PATH} — run --learn --main <checkout> first (no verdict).`
      );
      return 3;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as ContractBaseline;
    const { rows, divergent, missing } = compareTree(root, baseline);
    console.log(
      `[C4] contract pin vs baseline captured from ${baseline.sourceSha} at ${baseline.capturedAt}`
    );
    for (const row of rows) console.log(`[C4] ${row.verdict.padEnd(12)} ${row.module}`);
    if (missing.length > 0) {
      console.error(
        `[C4] INSTRUMENT: ${missing.length} module(s) absent from the tree or baseline — no verdict.`
      );
      return 3;
    }
    if (divergent.length > 0) {
      console.error(
        `[C4] DIVERGENT — ${divergent.length} module(s) moved off the contract: ${divergent.join(", ")}`
      );
      return 1;
    }
    console.log("[C4] OK — no code divergence from the baseline.");
    return 0;
  }

  if (!learn || mainIdx === -1 || !args[mainIdx + 1]) {
    console.error("[C4] usage: --learn --main <checkout> | no args (verify)");
    return 3;
  }
  const sourceRoot = args[mainIdx + 1];
  const modules: Record<string, ModuleDigest> = {};
  for (const module of SHARED_MODULES) {
    const path = join(sourceRoot, module);
    if (!existsSync(path)) {
      console.error(`[C4] INSTRUMENT: ${module} absent from ${sourceRoot} — baseline not written.`);
      return 3;
    }
    modules[module] = digestModule(readFileSync(path, "utf8"));
  }
  const baseline: ContractBaseline = {
    schemaVersion: 1,
    sourceSha: sourceSha(sourceRoot),
    capturedAt: new Date().toISOString(),
    modules,
  };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(
    `[C4] baseline written from ${sourceRoot} @ ${baseline.sourceSha} (${SHARED_MODULES.length} modules)`
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
