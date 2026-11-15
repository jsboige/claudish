import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ALL_MODELS_CACHE_PATH } from "./all-models-cache.js";
import { mcpModelsListPath } from "./mcp-models-list.js";

const sourceRoot = resolve(import.meta.dir, "..");
const mcpServerPath = resolve(sourceRoot, "mcp-server.ts");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") files.push(...sourceFiles(path));
    } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("catalog cache file separation", () => {
  // Mutation targets: all-models-cache.ts:102 and mcp-models-list.ts:43-48
  // (mcpModelsListPath). Restoring either writer to a retired filename makes
  // these path/source guards fail.
  test("the cloud models catalog uses its v3-specific cache file", () => {
    expect(
      ALL_MODELS_CACHE_PATH.endsWith(`${sep}.claudish${sep}cloud-models-catalog-v3.json`)
    ).toBe(true);
  });

  test("production source does not assign or join the retired cache filenames", () => {
    // `all-models.json` retired by the v3 catalog; `openrouter-models.json`
    // retired by the #1054 merge resolution — this base's MCP list now goes
    // through main's #1028/#1046 mcp-models-list.ts (mcp-models-list.json,
    // per-call path, never-hang degradation), the newer evolution of the SAME
    // separation this suite pins. Two list files would be a fork, not a union.
    const retiredLiteral = /["'](?:all-models|openrouter-models)\.json["']/;
    const pathConstruction = /\b(?:join|resolve)\s*\(|=/;
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (retiredLiteral.test(line) && pathConstruction.test(line)) {
          offenders.push(`${relative(sourceRoot, file)}:${index + 1}`);
        }
      }
    }

    expect(offenders, `retired cache path writers:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the MCP OpenRouter list uses its own cache file without importing the server", () => {
    // Mechanism (written down, #1054 CR B3b): main's loadMcpModelsList, in the
    // dedicated mcp-models-list.ts module — its own file, read per call, never
    // the shared catalog cache, and no cache-path constant inside the server
    // source. v14's OPENROUTER_MODELS_CACHE_PATH / openrouter-models.json
    // variant is retired by that choice.
    expect(mcpModelsListPath().endsWith(`${sep}.claudish${sep}mcp-models-list.json`)).toBe(true);
    const source = readFileSync(mcpServerPath, "utf-8");
    expect(source).toMatch(
      /import\s*\{[^}]*loadMcpModelsList[^}]*\}\s*from\s*["'][^"']*mcp-models-list\.js["']/
    );
    expect(source).not.toMatch(/openrouter-models\.json/);
  });
});
