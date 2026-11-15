/**
 * Model LIST for the MCP `search_models` tool — a file of its own (#1028).
 *
 * This list is NOT the shared catalogue cache (~/.claudish/all-models.json).
 * The two files hold different shapes and each used to erase what the other
 * needs: the shared cache is v2 ({version, lastUpdated, entries, coverage,
 * models-as-ids}) written by the OpenRouter catalog resolver, while the
 * search tool wants full OpenRouter API rows (name, description, pricing,
 * context_length) and used to overwrite the file with a v1
 * {lastUpdated, models} blob — destroying `entries`/`coverage` while
 * `lastUpdated` claimed freshness, so the launcher skipped refreshing it for
 * a day (the exact hazard the header of all-models-cache.ts describes).
 * The reverse loss was real too: when the resolver had written the file
 * last, its `models` array held ids only, and every search row read
 * `FREE` / `N/A`.
 *
 * The fix is the separation itself: this loader reads and writes ONLY its
 * own list file, never the shared cache.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LIST_MAX_AGE_DAYS = 2;

/** A full OpenRouter API model row — the fields `search_models` prints. */
export interface OpenRouterModelRow {
  id: string;
  name?: string;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
}

/**
 * Path of the MCP tool's own list file.
 *
 * Read PER CALL, never captured in a module constant — the house rule for
 * runtime knobs (see `allModelsCachePath()` for the measured failure mode of
 * a memoized path).
 */
export function mcpModelsListPath(): string {
  return (
    (process.env.CLAUDISH_MCP_MODELS_LIST_PATH ?? "").trim() ||
    join(homedir(), ".claudish", "mcp-models-list.json")
  );
}

/** Read the stored list, or null when absent/unparseable/wrongly shaped. Never throws. */
function readStoredList(
  listPath: string
): { lastUpdated: string; models: OpenRouterModelRow[] } | null {
  if (!existsSync(listPath)) return null;
  try {
    const stored = JSON.parse(readFileSync(listPath, "utf-8"));
    if (typeof stored?.lastUpdated !== "string" || !Array.isArray(stored?.models)) return null;
    return stored as { lastUpdated: string; models: OpenRouterModelRow[] };
  } catch {
    return null;
  }
}

/** Fetch the list from OpenRouter and persist it to its own file. Throws on failure. */
async function fetchAndStoreList(listPath: string): Promise<OpenRouterModelRow[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const data = (await response.json()) as { data?: OpenRouterModelRow[] };
  const models = data.data ?? [];
  mkdirSync(dirname(listPath), { recursive: true });
  writeFileSync(
    listPath,
    JSON.stringify({ lastUpdated: new Date().toISOString(), models }),
    "utf-8"
  );
  return models;
}

/**
 * Load the model list for `search_models`, refreshing it from the OpenRouter
 * API when the stored list is older than two days (or absent).
 *
 * Never-hang: a failed fetch degrades to whatever was stored, then to an
 * empty array — a search without network answers with text, it never throws.
 */
export async function loadMcpModelsList(forceRefresh = false): Promise<OpenRouterModelRow[]> {
  const listPath = mcpModelsListPath();
  if (!forceRefresh) {
    const stored = readStoredList(listPath);
    if (stored) {
      const ageInDays = (Date.now() - new Date(stored.lastUpdated).getTime()) / 86400_000;
      if (ageInDays <= LIST_MAX_AGE_DAYS) return stored.models;
    }
  }

  try {
    return await fetchAndStoreList(listPath);
  } catch {
    return readStoredList(listPath)?.models ?? [];
  }
}
