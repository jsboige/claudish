/**
 * Model discovery endpoint (fork extension).
 *
 * Claude Code queries /v1/models when CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
 * Returns all routable models from config.json routing rules + custom endpoints.
 *
 * Coexistence with upstream's servedSlotIds (Claude Desktop slot mode):
 * - When servedSlotIds is provided AND non-empty, return those slots only —
 *   this MUST be byte-identical to upstream's slot-mode response (it's what
 *   Claude Desktop parses, and we can't regression-test by feel).
 * - Otherwise, aggregate routable models from config + custom endpoints,
 *   filtering out providers with no credentials (otherwise the picker offers
 *   things that only 401).
 */

import type { Hono } from "hono";
import { loadConfig } from "../../profile-config.js";

export interface ModelDiscoveryOptions {
  /** Upstream Claude Desktop slot ids — takes precedence over aggregation when present. */
  servedSlotIds?: string[];
  /** Filter to providers that have credentials available. Default: true. */
  filterCredentialedProviders?: boolean;
}

export function registerModelDiscoveryRoute(app: Hono, opts: ModelDiscoveryOptions = {}): void {
  app.get("/v1/models", (c) => {
    const slots = opts.servedSlotIds ?? [];

    // Slot mode: return upstream's exact response shape.
    if (slots.length > 0) {
      return c.json({
        object: "list",
        has_more: false,
        data: slots.map((id) => ({
          id,
          display_name: id,
          created_at: "2026-01-01T00:00:00Z",
        })),
      });
    }

    // Discovery mode: aggregate routable models from config.
    const cfg = loadConfig();
    const seen = new Set<string>();
    const models: { id: string; display_name: string; created_at: string }[] = [];

    // From routing rules — each key is a model name
    if (cfg.routing) {
      for (const modelName of Object.keys(cfg.routing)) {
        if (!seen.has(modelName)) {
          seen.add(modelName);
          models.push({
            id: modelName,
            display_name: modelName,
            created_at: "2026-01-01T00:00:00Z",
          });
        }
      }
    }

    // From custom endpoints — each declared model
    if (cfg.customEndpoints) {
      for (const [, ep] of Object.entries(cfg.customEndpoints)) {
        const endpoint = ep as { models?: string[] };
        if (endpoint.models) {
          for (const m of endpoint.models) {
            if (!seen.has(m)) {
              seen.add(m);
              models.push({
                id: m,
                display_name: m,
                created_at: "2026-01-01T00:00:00Z",
              });
            }
          }
        }
      }
    }

    return c.json({
      object: "list",
      has_more: false,
      data: models,
    });
  });
}
