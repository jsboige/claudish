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
 * capture the six modules (plus the label probes below) from `main` once
 * (`--learn --main <checkout>`), then any v14 checkout verifies against the
 * recording. The wire contract is the CODE, so the comparison is three-way per
 * module:
 *
 *   IDENTICAL     raw bytes equal (after \r\n → \n: a CRLF checkout and an LF
 *                 checkout read the same file IDENTICAL)
 *   COMMENT-ONLY  raw differs, comment/whitespace-stripped source equal —
 *                 cosmetic, the contract still matches (a reviewer is told,
 *                 a gate is not failed)
 *   DIVERGENT     comment-stripped source differs — the contract moved, the
 *                 divergence needs an adjudicated reconcile line
 *
 * Review 1 (c.6897776887) measured that a naive normalizer can pass a code
 * change as COMMENT-ONLY: whitespace collapse inside string contents, a
 * newline-as-space inside a template (contents), ASI (`return\nx`), and a `//`
 * inside a regex literal swallowing code. The normalizer below answers each:
 * string and template contents are kept VERBATIM, a newline is its own token
 * (ASI depends on it), and regex literals are tracked (heuristic below), so
 * those four pairs all read DIVERGENT — pinned in the suite.
 *
 * The remaining honest limits, stated: the regex heuristic (last significant
 * character decides) can still mis-read an exotic case; when it does the raw
 * hash has already broken, and a mis-read that HIDES a difference requires the
 * normalized forms to coincide — the adversarial suite is the check on that
 * class. IDENTICAL therefore never depends on the normalizer at all.
 *
 * Label probes: #641's C4 definition also names the rate-limit banner, which
 * lives in `stream-parsers/anthropic-sse.ts` OUTSIDE the six (a file that is
 * heavily divergent by design). Each probe extracts one literal by pattern and
 * requires byte-identity — cheap, and it keeps the C4 scope honest. The other
 * two C4 assertions (the 3-arg `finalizeAbandonedStream`, v14-only, and the
 * `messageStartUsage` seeding at the five parser call sites) are recorded on
 * #641 as outside this pin, not silently dropped.
 *
 * Exit codes follow the same discipline as test:strict: 0 = every module
 * IDENTICAL or COMMENT-ONLY and every label identical, 1 = at least one
 * DIVERGENT (named), 3 = the instrument itself could not measure (missing or
 * malformed baseline, missing module, bad args) — never read as a pass. CI
 * runs the suite (hermetic · macOS runner 3, `./scripts/*.test.ts`); the
 * verify itself is a land-time instrument, deliberately NOT a CI gate while
 * the recording is red by design (see the PR body).
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

export interface LabelProbe {
  name: string;
  module: string;
  pattern: RegExp;
}

/** Byte-identity probes for load-bearing literals outside the six modules. */
export const LABEL_PROBES: LabelProbe[] = [
  {
    // #641 C4 definition, third assertion: the rate-limit banner. The refusal
    // wording is load-bearing (isQuotaExhaustion must never match it).
    name: "rate-limit banner",
    module: "packages/cli/src/handlers/shared/stream-parsers/anthropic-sse.ts",
    pattern: /\[The model provider is rate limited right now[^\n]*?\]/,
  },
];

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
  /** extracted literal text per label probe */
  labels: Record<string, string>;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** CRLF checkouts and LF checkouts must read the same file IDENTICAL. */
export function normalizeLineEndings(src: string): string {
  return src.replace(/\r\n/g, "\n");
}

/**
 * Strip comments and canonicalize CODE whitespace, keeping string and template
 * contents verbatim, a newline as its own token (ASI), and regex literals.
 *
 * A hand-rolled state machine, not a parser — and deliberately not a regex.
 * The ONLY property that must hold is that the SAME transformation runs on
 * both trees, and that a behavioural difference in the classes pinned by
 * review 1 cannot normalize equal. A mis-read can produce a false DIVERGENT
 * (visible, adjudicated); a false COMMENT-ONLY needs the normalized forms to
 * coincide, which the adversarial suite pins against.
 */
export function normalizeSource(src: string): string {
  const text = normalizeLineEndings(src);
  let out = "";
  type State = "code" | "line" | "block" | "single" | "double" | "template" | "regex";
  let state: State = "code";
  // Brace depth inside each active `${ … }` of each nested template literal.
  const templateExpressions: number[] = [];
  // True while inside a [...] character class of a regex literal.
  let inClass = false;
  // Last significant CODE character (not whitespace/comment), for the
  // regex-vs-division decision; "" = start of file.
  let lastCodeChar = "";
  let i = 0;

  const emitCode = (c: string) => {
    out += c;
    lastCodeChar = c;
  };
  // A newline in code position is its own token: `return\nx` and `return x`
  // differ in behaviour (ASI), so they must differ normalized.
  const emitNewline = () => {
    if (out.endsWith(" ")) out = out.slice(0, -1);
    if (!out.endsWith("\n")) out += "\n";
  };
  // Collapse runs of spaces/tabs to one space, never across a newline.
  const emitSpace = () => {
    if (out.length === 0 || out.endsWith("\n") || out.endsWith(" ")) return;
    out += " ";
  };
  const lastWord = (): string => {
    const m = out.match(/([A-Za-z_$][A-Za-z0-9_$]*)$/);
    return m ? m[1] : "";
  };
  // A `/` starts a regex literal (vs division) at the start of a file, after
  // an operator or an opening bracket, or after these keywords. After an
  // identifier, `)`, `]` or a quote it is division.
  const REGEX_KEYWORDS = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "case",
    "throw",
    "yield",
    "await",
    "do",
    "else",
  ]);
  const regexCanStart = (): boolean => {
    if (lastCodeChar === "") return true;
    if (/[A-Za-z0-9_$)\]"'`]/.test(lastCodeChar)) {
      return REGEX_KEYWORDS.has(lastWord());
    }
    return true; // operator, comma, opening bracket, colon, semicolon…
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        emitNewline();
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      // A multiline comment counts as a line terminator for ASI.
      if (c === "\n") emitNewline();
      i++;
      continue;
    }
    if (state === "single" || state === "double") {
      out += c; // string contents are VERBATIM
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if ((state === "single" && c === "'") || (state === "double" && c === '"')) {
        state = "code";
        lastCodeChar = c;
      }
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
        lastCodeChar = c;
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        out += c + next;
        templateExpressions.push(0);
        state = "code";
        lastCodeChar = "{";
        i += 2;
        continue;
      }
      out += c; // template contents are VERBATIM
      i++;
      continue;
    }
    if (state === "regex") {
      out += c; // regex bodies are VERBATIM
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        state = "code";
        lastCodeChar = "/";
        // regex flags are plain identifier chars, keep consuming them
        while (i + 1 < text.length && /[a-z]/.test(text[i + 1])) {
          out += text[i + 1];
          i++;
        }
      }
      i++;
      continue;
    }
    // state === "code"
    // `//` and `/*` are ALWAYS comments: an empty regex literal is illegal, so
    // the comment-vs-regex question only exists for a `/` followed by anything
    // else. (Checking regexCanStart() here was the review-1-class bug: after
    // `;` a `//` read as an empty regex and swallowed the rest as its body.)
    if (c === "/" && (next === "/" || next === "*")) {
      state = next === "/" ? "line" : "block";
      i += 2;
      continue;
    }
    if (c === "/" && regexCanStart()) {
      state = "regex";
      inClass = false;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      state = c === "'" ? "single" : "double";
      out += c;
      lastCodeChar = c;
      i++;
      continue;
    }
    if (c === "`") {
      state = "template";
      out += c;
      lastCodeChar = c;
      i++;
      continue;
    }
    if (templateExpressions.length > 0 && c === "}") {
      if (templateExpressions[templateExpressions.length - 1] === 0) {
        // closing the `${`: back inside the template literal
        templateExpressions.pop();
        state = "template";
        out += c;
        i++;
        continue;
      }
      templateExpressions[templateExpressions.length - 1]--;
      emitCode(c);
      i++;
      continue;
    }
    if (c === "\n") {
      emitNewline();
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      emitSpace();
      i++;
      continue;
    }
    if (templateExpressions.length > 0 && c === "{") {
      templateExpressions[templateExpressions.length - 1]++;
    }
    emitCode(c);
    i++;
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);
  return out.trim();
}

export function digestModule(src: string): ModuleDigest {
  const text = normalizeLineEndings(src);
  return { raw: sha256(text), normalized: sha256(normalizeSource(text)) };
}

export function extractLabel(src: string, probe: LabelProbe): string | null {
  const m = normalizeLineEndings(src).match(probe.pattern);
  return m ? m[0] : null;
}

export type ModuleVerdict = "IDENTICAL" | "COMMENT-ONLY" | "DIVERGENT" | "MISSING";
export type LabelVerdict = "IDENTICAL" | "DIVERGENT" | "MISSING";

export interface PinRow {
  kind: "module" | "label";
  name: string;
  verdict: ModuleVerdict | LabelVerdict;
}

export interface TreeComparison {
  rows: PinRow[];
  divergent: string[];
  missing: string[];
}

export function compareTree(root: string, baseline: ContractBaseline): TreeComparison {
  const rows: PinRow[] = [];
  const divergent: string[] = [];
  const missing: string[] = [];
  for (const module of SHARED_MODULES) {
    const path = join(root, module);
    const recorded = baseline.modules[module];
    if (!recorded || !existsSync(path)) {
      rows.push({ kind: "module", name: module, verdict: "MISSING" });
      missing.push(module);
      continue;
    }
    const observed = digestModule(readFileSync(path, "utf8"));
    let verdict: ModuleVerdict;
    if (observed.raw === recorded.raw) verdict = "IDENTICAL";
    else if (observed.normalized === recorded.normalized) verdict = "COMMENT-ONLY";
    else verdict = "DIVERGENT";
    rows.push({ kind: "module", name: module, verdict });
    if (verdict === "DIVERGENT") divergent.push(module);
  }
  for (const probe of LABEL_PROBES) {
    const recorded = baseline.labels[probe.name];
    const path = join(root, probe.module);
    if (!existsSync(path)) {
      rows.push({ kind: "label", name: `${probe.name} (${probe.module})`, verdict: "MISSING" });
      missing.push(probe.name);
      continue;
    }
    const observed = extractLabel(readFileSync(path, "utf8"), probe);
    let verdict: LabelVerdict;
    if (observed === null)
      verdict = "DIVERGENT"; // the literal is gone: the contract moved
    else if (recorded === undefined || observed !== recorded) verdict = "DIVERGENT";
    else verdict = "IDENTICAL";
    rows.push({ kind: "label", name: `${probe.name} (${probe.module})`, verdict });
    if (verdict === "DIVERGENT") divergent.push(probe.name);
  }
  return { rows, divergent, missing };
}

/**
 * Load and VALIDATE the baseline. A malformed file (unparseable JSON, wrong
 * schema, missing modules) is an instrument failure — exit 3 — never a
 * DIVERGENT-looking exit 1 (review 1, blocker 3).
 */
export function loadBaseline(path: string): ContractBaseline | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const b = parsed as Partial<ContractBaseline>;
  if (b.schemaVersion !== 1 || typeof b.sourceSha !== "string" || typeof b.capturedAt !== "string")
    return null;
  if (typeof b.modules !== "object" || b.modules === null) return null;
  for (const module of SHARED_MODULES) {
    const d = b.modules[module];
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.raw !== "string" ||
      typeof d.normalized !== "string"
    )
      return null;
  }
  if (typeof b.labels !== "object" || b.labels === null) return null;
  return parsed as ContractBaseline;
}

function sourceSha(root: string): string {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short", "HEAD"]);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : "unknown";
}

/** The verify run against a recording; returns the process exit code. */
export function runVerify(root: string, baselinePath: string): number {
  const baseline = loadBaseline(baselinePath);
  if (!baseline) {
    console.error(
      `[C4] INSTRUMENT: baseline at ${baselinePath} missing or malformed — no verdict (exit 3).`
    );
    return 3;
  }
  const { rows, divergent, missing } = compareTree(root, baseline);
  console.log(
    `[C4] contract pin vs baseline captured from ${baseline.sourceSha} at ${baseline.capturedAt}`
  );
  for (const row of rows)
    console.log(
      `[C4] ${row.verdict.padEnd(12)} ${row.kind === "label" ? "label: " : ""}${row.name}`
    );
  if (missing.length > 0) {
    console.error(
      `[C4] INSTRUMENT: ${missing.length} entr${missing.length > 1 ? "ies" : "y"} absent from the tree or baseline — no verdict (exit 3).`
    );
    return 3;
  }
  if (divergent.length > 0) {
    console.error(
      `[C4] DIVERGENT — ${divergent.length} entr${divergent.length > 1 ? "ies" : "y"} moved off the contract: ${divergent.join(", ")}`
    );
    return 1;
  }
  console.log("[C4] OK — no code divergence from the baseline.");
  return 0;
}

/** Capture a baseline from another checkout; returns the process exit code. */
export function runLearn(root: string, sourceRoot: string): number {
  const modules: Record<string, ModuleDigest> = {};
  for (const module of SHARED_MODULES) {
    const path = join(sourceRoot, module);
    if (!existsSync(path)) {
      console.error(`[C4] INSTRUMENT: ${module} absent from ${sourceRoot} — baseline not written.`);
      return 3;
    }
    modules[module] = digestModule(readFileSync(path, "utf8"));
  }
  const labels: Record<string, string> = {};
  for (const probe of LABEL_PROBES) {
    const path = join(sourceRoot, probe.module);
    if (!existsSync(path)) {
      console.error(
        `[C4] INSTRUMENT: ${probe.module} absent from ${sourceRoot} — baseline not written.`
      );
      return 3;
    }
    const text = extractLabel(readFileSync(path, "utf8"), probe);
    if (text === null) {
      console.error(
        `[C4] INSTRUMENT: label probe "${probe.name}" matched nothing in ${probe.module} — baseline not written.`
      );
      return 3;
    }
    labels[probe.name] = text;
  }
  const baseline: ContractBaseline = {
    schemaVersion: 1,
    sourceSha: sourceSha(sourceRoot),
    capturedAt: new Date().toISOString(),
    modules,
    labels,
  };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(
    `[C4] baseline written from ${sourceRoot} @ ${baseline.sourceSha} (${SHARED_MODULES.length} modules, ${LABEL_PROBES.length} label probes)`
  );
  return 0;
}

function main(): number {
  const args = process.argv.slice(2);
  const learn = args.includes("--learn");
  const mainIdx = args.indexOf("--main");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (learn || mainIdx !== -1) {
    if (!learn || mainIdx === -1 || !args[mainIdx + 1]) {
      console.error("[C4] usage: --learn --main <checkout> | no args (verify)");
      return 3;
    }
    return runLearn(root, args[mainIdx + 1]);
  }
  return runVerify(root, join(root, BASELINE_PATH));
}

if (import.meta.main) {
  process.exitCode = main();
}
