/**
 * API Key Provenance — traces where an API key comes from across all resolution layers.
 *
 * Resolution order (first non-empty wins):
 *   1. process.env (shell profile, e.g. ~/.config/env-keys.sh sourced by .zshenv)
 *   2. .env file in CWD (loaded by dotenv at startup, does NOT override existing env vars)
 *   3. ~/.claudish/config.json apiKeys (loaded at startup, does NOT override existing env vars)
 *
 * Since dotenv and config.json never override, the value in process.env at runtime
 * always comes from whichever source set it first. This module inspects all three
 * sources independently so the user can see what WOULD have been used from each layer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseDotenv } from "dotenv";

export interface KeyLayer {
  source: string;
  maskedValue: string | null;
  isActive: boolean;
}

export interface KeyProvenance {
  envVar: string;
  effectiveValue: string | null;
  effectiveMasked: string | null;
  effectiveSource: string;
  layers: KeyLayer[];
}

function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.substring(0, 8)}...`;
}

/**
 * Resolve the provenance of an API key by checking all possible sources.
 *
 * @param envVar - Primary env var name (e.g. "GEMINI_API_KEY")
 * @param aliases - Alternative env var names to check
 */
export function resolveApiKeyProvenance(envVar: string, aliases?: string[]): KeyProvenance {
  const layers: KeyLayer[] = [];
  const effectiveValue = process.env[envVar] || null;
  let effectiveSource = "not set";

  // Check all env var names (primary + aliases)
  const allVars = [envVar, ...(aliases || [])];

  // Layer 1: .env file in CWD
  const dotenvValue = readDotenvKey(allVars);
  layers.push({
    source: `.env (${resolve(".env")})`,
    maskedValue: maskKey(dotenvValue),
    isActive: false, // determined below
  });

  // Layer 2: ~/.claudish/config.json
  const configValue = readConfigKey(envVar);
  layers.push({
    source: `~/.claudish/config.json`,
    maskedValue: maskKey(configValue),
    isActive: false,
  });

  // Layer 3: process.env (final runtime value — includes shell profile, dotenv, config.json)
  // Check aliases too
  let runtimeVar = envVar;
  let runtimeValue = process.env[envVar] || null;
  if (!runtimeValue && aliases) {
    for (const alias of aliases) {
      if (process.env[alias]) {
        runtimeVar = alias;
        runtimeValue = process.env[alias]!;
        break;
      }
    }
  }

  layers.push({
    source: `process.env[${runtimeVar}]`,
    maskedValue: maskKey(runtimeValue),
    isActive: !!runtimeValue,
  });

  // Determine which source is active
  if (runtimeValue) {
    if (dotenvValue && dotenvValue === runtimeValue) {
      effectiveSource = ".env";
      layers[0].isActive = true;
      layers[2].isActive = false;
    } else if (configValue && configValue === runtimeValue) {
      effectiveSource = "~/.claudish/config.json";
      layers[1].isActive = true;
      layers[2].isActive = false;
    } else {
      effectiveSource = "shell environment";
      // layers[2] already marked active
    }
  }

  return {
    envVar: runtimeVar,
    effectiveValue: runtimeValue,
    effectiveMasked: maskKey(runtimeValue),
    effectiveSource,
    layers,
  };
}

/**
 * Format provenance for debug log output (single line).
 */
export function formatProvenanceLog(p: KeyProvenance): string {
  if (!p.effectiveValue) {
    return `${p.envVar}=(not set)`;
  }
  return `${p.envVar}=${p.effectiveMasked} [from: ${p.effectiveSource}]`;
}

/**
 * Format provenance for --probe TUI output (multi-line with all layers).
 */
export function formatProvenanceProbe(p: KeyProvenance, indent: string = "    "): string[] {
  const lines: string[] = [];

  if (!p.effectiveValue) {
    lines.push(`${indent}${p.envVar}: not set`);
    return lines;
  }

  lines.push(`${indent}${p.envVar} = ${p.effectiveMasked}  [from: ${p.effectiveSource}]`);

  for (const layer of p.layers) {
    const marker = layer.isActive ? ">>>" : "   ";
    const value = layer.maskedValue || "(not set)";
    lines.push(`${indent}  ${marker} ${layer.source}: ${value}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readDotenvKey(envVars: string[]): string | null {
  try {
    const dotenvPath = resolve(".env");
    if (!existsSync(dotenvPath)) return null;
    const parsed = parseDotenv(readFileSync(dotenvPath, "utf-8"));
    for (const v of envVars) {
      if (parsed[v]) return parsed[v];
    }
    return null;
  } catch {
    return null;
  }
}

function readConfigKey(envVar: string): string | null {
  try {
    const configPath = process.env.CLAUDISH_CONFIG_PATH ?? join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
      apiKeys?: Record<string, string>;
    };
    return cfg.apiKeys?.[envVar] || null;
  } catch {
    return null;
  }
}
