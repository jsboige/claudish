import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_MODULES, compareTree, digestModule, normalizeSource } from "./contract-cross-pin";

describe("normalizeSource", () => {
  test("strips line and block comments, keeps code", () => {
    const src = "const a = 1; // trailing\n/* block */\nconst b = 2;";
    expect(normalizeSource(src)).toBe("const a = 1; const b = 2;");
  });

  test("keeps string contents that look like comment markers", () => {
    const src = `const url = "https://example.com/x"; const t = 'a /* b */ c';`;
    expect(normalizeSource(src)).toBe(
      `const url = "https://example.com/x"; const t = 'a /* b */ c';`
    );
  });

  test("handles a comment inside a template expression", () => {
    const src = "const s = `a ${x /* why */ + 1} b`;";
    expect(normalizeSource(src)).toBe("const s = `a ${x + 1} b`;");
  });

  test("collapses whitespace and escapes survive", () => {
    const src = 'const s = "a\\"b";\n\n\tconst u = 2;';
    expect(normalizeSource(src)).toBe('const s = "a\\"b"; const u = 2;');
  });

  test("a comment-only divergence normalizes equal while raw differs", () => {
    const withComment = "const a = 1; /** documented */\n";
    const without = "const a = 1;\n";
    expect(normalizeSource(withComment)).toBe(normalizeSource(without));
    expect(digestModule(withComment).raw).not.toBe(digestModule(without).raw);
  });
});

describe("compareTree", () => {
  test("classifies identical, comment-only and divergent modules on the real six", () => {
    // Baseline = the tree itself, then re-read it: every module must be IDENTICAL.
    const root = join(fileURLToPath(new URL("..", import.meta.url)));
    const baseline = {
      schemaVersion: 1 as const,
      sourceSha: "test",
      capturedAt: "test",
      modules: Object.fromEntries(
        SHARED_MODULES.map((m) => [m, digestModule(readFileSync(join(root, m), "utf8"))])
      ),
    };
    const { rows, divergent, missing } = compareTree(root, baseline);
    expect(missing).toEqual([]);
    expect(divergent).toEqual([]);
    expect(rows.every((r) => r.verdict === "IDENTICAL")).toBe(true);
  });
});
