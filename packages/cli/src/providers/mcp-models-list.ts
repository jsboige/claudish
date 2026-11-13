/**
 * Model LIST for the MCP `search_models` tool — a file of its own.
 *
 * Moved UNCHANGED out of mcp-server.ts (#1028, step 1: move, then fix) so it
 * can be pinned by tests without importing the server module.
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
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { allModelsCachePath } from "./all-models-cache.js";

const CACHE_MAX_AGE_DAYS = 2;

export async function loadAllModels(forceRefresh = false): Promise<any[]> {
  const cachePath = allModelsCachePath();
  if (!forceRefresh && existsSync(cachePath)) {
    try {
      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache invalid
    }
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = (await response.json()) as { data?: string[] };
    const models = data.data || [];
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ lastUpdated: new Date().toISOString(), models }),
      "utf-8"
    );
    return models;
  } catch {
    if (existsSync(cachePath)) {
      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      return cacheData.models || [];
    }
    return [];
  }
}
