/**
 * Pins for the cross-contract pin (see contract-cross-pin.ts).
 *
 * Review 1 (PR #1081, c.6897776887) showed the first version could pass a code
 * change: four behaviour-differing pairs normalized equal, and the suite never
 * exercised COMMENT-ONLY or DIVERGENT through compareTree (its only compareTree
 * test was IDENTICAL by construction, so mutating the verdict logic stayed
 * green). This suite answers both:
 *
 * - the four adversarial pairs normalize UNEQUAL (string contents, template
 *   contents, ASI newline, `//` inside a regex);
 * - compareTree/runVerify are driven through REAL temp-dir trees: a
 *   comment-only touch (exit 0, row COMMENT-ONLY), a code change (exit 1, row
 *   DIVERGENT — the reviewer's mutation (b) lands here red), a missing module
 *   (exit 3), a malformed baseline (exit 3), a CRLF rewrite of the whole tree
 *   (still IDENTICAL — raw hash is line-ending-normalized), and a perturbed
 *   label probe (exit 1);
 * - the COMMITTED baseline must load, carry all six modules, and its label
 *   must match the live tree.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  type ContractBaseline,
  LABEL_PROBES,
  SHARED_MODULES,
  compareTree,
  digestModule,
  extractLabel,
  loadBaseline,
  normalizeSource,
  runVerify,
} from "./contract-cross-pin.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

// The label probe's host file, relative — needed when seeding temp trees.
const LABEL_MODULE = LABEL_PROBES[0].module;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A temp tree holding copies of the six modules plus the label host file. */
function seedTree(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `c4-pin-${tag}-`));
  tempDirs.push(root);
  for (const rel of [...SHARED_MODULES, LABEL_MODULE]) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(repoRoot, rel), "utf8"), "utf8");
  }
  return root;
}

function baselineOf(root: string): ContractBaseline {
  const modules: ContractBaseline["modules"] = {};
  for (const rel of SHARED_MODULES)
    modules[rel] = digestModule(readFileSync(join(root, rel), "utf8"));
  const labels: ContractBaseline["labels"] = {};
  for (const probe of LABEL_PROBES) {
    labels[probe.name] = extractLabel(
      readFileSync(join(root, probe.module), "utf8"),
      probe
    ) as string;
  }
  return {
    schemaVersion: 1,
    sourceSha: "seed",
    capturedAt: new Date().toISOString(),
    modules,
    labels,
  };
}

function writeBaseline(root: string, baseline: ContractBaseline): string {
  const path = join(root, "baseline.json");
  writeFileSync(path, JSON.stringify(baseline), "utf8");
  return path;
}

describe("normalizeSource — adversarial pairs from review 1 (behaviour differs ⇒ normalized differs)", () => {
  test('string contents: "a  b" vs "a b" (whitespace collapse must not run inside strings)', () => {
    expect(normalizeSource('const s = "a  b";')).not.toBe(normalizeSource('const s = "a b";'));
  });

  test("template contents: a real newline vs a space inside the literal", () => {
    expect(normalizeSource("const s = `a\nb`;")).not.toBe(normalizeSource("const s = `a b`;"));
  });

  test("ASI: return\\nx vs return x (a newline is its own token)", () => {
    expect(normalizeSource("function f() {\n  return\n  x;\n}")).not.toBe(
      normalizeSource("function f() {\n  return x;\n}")
    );
  });

  test("regex: // inside a regex literal must not start a line comment", () => {
    expect(normalizeSource("const re = /\\/\\//;\nf(1);")).not.toBe(
      normalizeSource("const re = /\\/\\//;\nf(2);")
    );
  });

  test("regex after return is a regex, not division", () => {
    // `return /x/.test(s)` — a //-like body after a keyword must stay regex.
    expect(normalizeSource("function g(s) {\n  return /x/.test(s);\n}")).not.toBe(
      normalizeSource("function g(s) {\n  return /y/.test(s);\n}")
    );
  });
});

describe("normalizeSource — cosmetic-only changes still normalize equal", () => {
  test("trailing line comment", () => {
    expect(normalizeSource("const a = 1; // note")).toBe(normalizeSource("const a = 1;"));
  });

  test("block comment", () => {
    expect(normalizeSource("const a /* x */ = 1;")).toBe(normalizeSource("const a = 1;"));
  });

  test("code whitespace collapses (same line)", () => {
    expect(normalizeSource("const  a   =  1;")).toBe(normalizeSource("const a = 1;"));
  });

  test("line-ending agnostic (\\r\\n vs \\n)", () => {
    expect(normalizeSource("const a = 1;\r\nconst b = 2;\r\n")).toBe(
      normalizeSource("const a = 1;\nconst b = 2;\n")
    );
  });
});

describe("compareTree / runVerify on real temp trees", () => {
  test("comment-only touch → row COMMENT-ONLY, runVerify exit 0", () => {
    const root = seedTree("cmt");
    const rel = SHARED_MODULES[0];
    const path = join(root, rel);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n// touched by the comment-only pin\n`,
      "utf8"
    );
    const baselinePath = writeBaseline(root, baselineOf(root));
    // the baseline was captured AFTER the touch — rebuild it from the pristine module
    const pristine = digestModule(readFileSync(join(repoRoot, rel), "utf8"));
    const baseline = loadBaseline(baselinePath) as ContractBaseline;
    baseline.modules[rel] = pristine;
    writeBaseline(root, baseline);
    const cmp = compareTree(root, baseline);
    expect(cmp.rows.find((r) => r.name === rel)?.verdict).toBe("COMMENT-ONLY");
    expect(cmp.divergent).toEqual([]);
    expect(runVerify(root, baselinePath)).toBe(0);
  });

  test("code change → row DIVERGENT, runVerify exit 1 (reviewer mutation (b) lands red here)", () => {
    const root = seedTree("div");
    const rel = SHARED_MODULES[0];
    const baselinePath = writeBaseline(root, baselineOf(root));
    const path = join(root, rel);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nexport const __c4MutationProbe = 1;\n`,
      "utf8"
    );
    const cmp = compareTree(root, loadBaseline(baselinePath) as ContractBaseline);
    expect(cmp.rows.find((r) => r.name === rel)?.verdict).toBe("DIVERGENT");
    expect(cmp.divergent).toEqual([rel]);
    expect(runVerify(root, baselinePath)).toBe(1);
  });

  test("module missing → row MISSING, runVerify exit 3", () => {
    const root = seedTree("miss");
    const rel = SHARED_MODULES[2];
    const baselinePath = writeBaseline(root, baselineOf(root));
    rmSync(join(root, rel));
    const cmp = compareTree(root, loadBaseline(baselinePath) as ContractBaseline);
    expect(cmp.rows.find((r) => r.name === rel)?.verdict).toBe("MISSING");
    expect(runVerify(root, baselinePath)).toBe(3);
  });

  test("whole tree rewritten CRLF → still IDENTICAL (raw hash is line-ending-normalized)", () => {
    const root = seedTree("crlf");
    const baselinePath = writeBaseline(root, baselineOf(root));
    for (const rel of [...SHARED_MODULES, LABEL_MODULE]) {
      const path = join(root, rel);
      const lf = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      writeFileSync(path, lf.replace(/\n/g, "\r\n"), "utf8");
    }
    const cmp = compareTree(root, loadBaseline(baselinePath) as ContractBaseline);
    for (const rel of SHARED_MODULES) {
      expect(cmp.rows.find((r) => r.name === rel)?.verdict).toBe("IDENTICAL");
    }
    expect(runVerify(root, baselinePath)).toBe(0);
  });

  test("label probe perturbed → DIVERGENT, runVerify exit 1", () => {
    const root = seedTree("lbl");
    const baselinePath = writeBaseline(root, baselineOf(root));
    const path = join(root, LABEL_MODULE);
    const src = readFileSync(path, "utf8");
    const live = extractLabel(src, LABEL_PROBES[0]);
    expect(live).not.toBeNull();
    const mutated = src.replace(
      live as string,
      "[The model provider is rate limited right now. MUTATED PROBE TEXT.]"
    );
    expect(mutated).not.toBe(src); // the probe really matched something replaceable
    writeFileSync(path, mutated, "utf8");
    const cmp = compareTree(root, loadBaseline(baselinePath) as ContractBaseline);
    expect(cmp.rows.find((r) => r.kind === "label")?.verdict).toBe("DIVERGENT");
    expect(runVerify(root, baselinePath)).toBe(1);
  });

  test("label gone entirely → DIVERGENT (exit 1), not MISSING", () => {
    const root = seedTree("lbl2");
    const baselinePath = writeBaseline(root, baselineOf(root));
    const path = join(root, LABEL_MODULE);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/\[The model provider[^\n]*?\]/, ""),
      "utf8"
    );
    expect(extractLabel(readFileSync(path, "utf8"), LABEL_PROBES[0])).toBeNull();
    expect(runVerify(root, baselinePath)).toBe(1);
  });
});

describe("baseline loading — 3 is the instrument-failure verdict", () => {
  test("unparseable JSON ({) → null", () => {
    const root = mkdtempSync(join(tmpdir(), "c4-pin-bad-"));
    tempDirs.push(root);
    const path = join(root, "baseline.json");
    writeFileSync(path, "{", "utf8");
    expect(loadBaseline(path)).toBeNull();
    expect(runVerify(root, path)).toBe(3);
  });

  test('schema-shaped but empty ({"schemaVersion":1}) → null', () => {
    const root = mkdtempSync(join(tmpdir(), "c4-pin-empty-"));
    tempDirs.push(root);
    const path = join(root, "baseline.json");
    writeFileSync(path, '{"schemaVersion":1}', "utf8");
    expect(loadBaseline(path)).toBeNull();
    expect(runVerify(root, path)).toBe(3);
  });

  test("valid JSON, a module digest missing → null", () => {
    const root = mkdtempSync(join(tmpdir(), "c4-pin-hole-"));
    tempDirs.push(root);
    const baseline = baselineOf(seedTree("hole"));
    delete baseline.modules[SHARED_MODULES[0]];
    const path = join(root, "baseline.json");
    writeFileSync(path, JSON.stringify(baseline), "utf8");
    expect(loadBaseline(path)).toBeNull();
  });

  test("absent file → null", () => {
    expect(loadBaseline(join(tmpdir(), "c4-pin-does-not-exist.json"))).toBeNull();
  });
});

describe("the committed baseline", () => {
  test("loads, carries all six modules with sha256-shaped digests, and one label", () => {
    const path = join(repoRoot, BASELINE_PATH);
    expect(existsSync(path)).toBe(true);
    const baseline = loadBaseline(path);
    expect(baseline).not.toBeNull();
    for (const rel of SHARED_MODULES) {
      expect(baseline?.modules[rel]).toBeDefined();
      expect(baseline?.modules[rel].raw).toMatch(/^[0-9a-f]{64}$/);
      expect(baseline?.modules[rel].normalized).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(baseline?.labels ?? {})).toEqual(["rate-limit banner"]);
    expect(baseline?.sourceSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("its label matches the live tree's banner byte for byte", () => {
    const baseline = loadBaseline(join(repoRoot, BASELINE_PATH));
    const live = extractLabel(readFileSync(join(repoRoot, LABEL_MODULE), "utf8"), LABEL_PROBES[0]);
    expect(live).toBe(baseline?.labels["rate-limit banner"]);
  });
});
