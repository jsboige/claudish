/**
 * Pins for the #1028 predicate: a search_models list load never changes
 * `entries`, `coverage` or `lastUpdated` of an existing all-models.json, and
 * its rows carry the pricing and context length the source gave.
 *
 * The pre-fix red pass ran the same three assertions against the
 * moved-unchanged loader on the shared cache (scratch file, deleted): P1 and
 * P2 failed — the v1 overwrite and the ids-only answer are both real.
 *
 * No real endpoint: fetch is stubbed via test-support/stub-fetch.ts (#604).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenRouterModelRow,
  loadMcpModelsList,
  mcpModelsListPath,
} from "./providers/mcp-models-list.js";
import { installStubFetch } from "./test-support/stub-fetch.js";

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mcpml-"));
  dirs.push(d);
  return d;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/** The v2 shape the OpenRouter catalog resolver writes (#1028 fixtures). */
function v2File(models: unknown[]) {
  return {
    version: 2,
    lastUpdated: isoDaysAgo(3),
    entries: [
      { modelId: "vendor/one", aliases: [], sources: {} },
      { modelId: "vendor/idonly", aliases: [], sources: {} },
    ],
    coverage: { pages: 1, fetched: 2, serverTotal: 2, complete: true },
    models,
  };
}

/** Full OpenRouter API rows — what search_models prints pricing/context from. */
const stubRows = [
  {
    id: "vendor/one",
    name: "One",
    description: "first stub model",
    pricing: { prompt: "0.001", completion: "0.002" },
    context_length: 128000,
  },
  {
    id: "vendor/two",
    name: "Two",
    description: "second stub model",
    pricing: { prompt: "0", completion: "0" },
    context_length: 4096,
  },
];

function stubOk(): () => void {
  return installStubFetch(() => Response.json({ data: stubRows }));
}

describe("mcp-models-list (#1028)", () => {
  const savedShared = process.env.CLAUDISH_MODEL_CACHE_PATH;
  const savedList = process.env.CLAUDISH_MCP_MODELS_LIST_PATH;

  afterAll(() => {
    for (const [key, val] of [
      ["CLAUDISH_MODEL_CACHE_PATH", savedShared],
      ["CLAUDISH_MCP_MODELS_LIST_PATH", savedList],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a load that refreshes the list leaves the shared v2 cache byte-identical", async () => {
    const dir = tmpDir();
    const shared = join(dir, "all-models.json");
    const list = join(dir, "mcp-models-list.json");
    const before = JSON.stringify(v2File([{ id: "vendor/idonly" }]));
    writeFileSync(shared, before, "utf-8");
    // A stale list forces the refresh path (the fetch + the write).
    writeFileSync(list, JSON.stringify({ lastUpdated: isoDaysAgo(3), models: [] }), "utf-8");
    process.env.CLAUDISH_MODEL_CACHE_PATH = shared;
    process.env.CLAUDISH_MCP_MODELS_LIST_PATH = list;

    const restore = stubOk();
    let rows: OpenRouterModelRow[];
    try {
      rows = await loadMcpModelsList();
    } finally {
      restore();
    }

    expect(readFileSync(shared, "utf-8")).toBe(before);
    expect(rows.length).toBe(2);
    // The refresh lands on the tool's own file, in the list shape.
    expect(existsSync(list)).toBe(true);
    const stored = JSON.parse(readFileSync(list, "utf-8"));
    expect(Array.isArray(stored.models)).toBe(true);
    expect(stored.models[0].pricing?.prompt).toBe("0.001");
    expect(mcpModelsListPath()).toBe(list);
  });

  it("a fresh resolver-written shared cache (ids only) does not blind the search rows", async () => {
    const dir = tmpDir();
    const shared = join(dir, "all-models.json");
    const freshV2 = { ...v2File([{ id: "vendor/idonly" }]), lastUpdated: new Date().toISOString() };
    writeFileSync(shared, JSON.stringify(freshV2), "utf-8");
    process.env.CLAUDISH_MODEL_CACHE_PATH = shared;
    // No list file at all yet: the loader must fetch full rows rather than
    // answer from the shared cache's ids-only array.
    process.env.CLAUDISH_MCP_MODELS_LIST_PATH = join(dir, "absent-list.json");

    const restore = stubOk();
    let rows: OpenRouterModelRow[];
    try {
      rows = await loadMcpModelsList();
    } finally {
      restore();
    }

    const one = rows.find((m) => m.id === "vendor/one");
    expect(one?.pricing?.prompt).toBe("0.001");
    expect(one?.context_length).toBe(128000);
    expect(readFileSync(shared, "utf-8")).toBe(JSON.stringify(freshV2));
  });

  it("when the fetch fails, the loader answers from its stored list and writes nothing", async () => {
    const dir = tmpDir();
    const shared = join(dir, "all-models.json");
    const list = join(dir, "mcp-models-list.json");
    const sharedBefore = JSON.stringify(v2File([{ id: "vendor/idonly" }]));
    writeFileSync(shared, sharedBefore, "utf-8");
    const storedRows = [{ id: "vendor/stored", pricing: { prompt: "9" }, context_length: 8 }];
    const listBefore = JSON.stringify({
      lastUpdated: new Date().toISOString(),
      models: storedRows,
    });
    writeFileSync(list, listBefore, "utf-8");
    process.env.CLAUDISH_MODEL_CACHE_PATH = shared;
    process.env.CLAUDISH_MCP_MODELS_LIST_PATH = list;

    const restore = installStubFetch(() => {
      throw new Error("network down (stub)");
    });
    let rows: OpenRouterModelRow[];
    try {
      rows = await loadMcpModelsList();
    } finally {
      restore();
    }

    expect(rows.some((m) => m.id === "vendor/stored")).toBe(true);
    expect(readFileSync(shared, "utf-8")).toBe(sharedBefore);
    expect(readFileSync(list, "utf-8")).toBe(listBefore);
  });
});
