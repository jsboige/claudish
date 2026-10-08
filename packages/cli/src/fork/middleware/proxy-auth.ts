/**
 * Proxy authentication middleware (fork extension).
 *
 * Anthropic pass-through is exempt (OAuth or proxy-key swap handled by NativeHandler).
 * Non-Anthropic providers require the proxy key in x-api-key / authorization / x-proxy-key.
 * GET requests and health endpoints are exempt for Docker healthcheck and model discovery.
 *
 * #400 — scoped inbound keys authenticate like a proxy key but are gated to
 * their allowModels BEFORE anything else (including the native exemption: a
 * scoped key never rides the Anthropic passthrough). Everything outside the
 * allowlist is a labeled 403 — wording deliberately free of quota-class words
 * (same doctrine as #296: isQuotaExhaustion must never arm on this refusal).
 */

import type { MiddlewareHandler } from "hono";
import { wrapAnthropicError } from "../../handlers/shared/anthropic-error.js";
import { matchesProxyKey } from "../../handlers/shared/proxy-keys.js";
import {
  inboundModelAllowed,
  matchesInboundKey,
  markInboundKey,
  type InboundKeyEntry,
} from "../../handlers/shared/inbound-keys.js";
import { logStderr } from "../../logger.js";
import { parseModelSpec } from "../../providers/model-parser.js";

export function createProxyAuthMiddleware(
  proxyKeys: string[],
  inboundKeys: InboundKeyEntry[] = []
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "GET") {
      return await next();
    }

    // Peek at body.model to determine target provider.
    // Hono caches parsed JSON — safe to call again from the route handler.
    let model: string | undefined;
    try {
      const body = await c.req.json();
      model = body?.model;
    } catch {
      return await next(); // Malformed body — let handler return 400
    }

    const authHeader = c.req.header("authorization");
    const apiKeyHeader = c.req.header("x-api-key");
    const proxyKeyHeader = c.req.header("x-proxy-key");

    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    const provided = proxyKeyHeader || apiKeyHeader || bearerToken;

    // #400 — scoped inbound keys: gate BEFORE the native exemption. A scoped
    // key sees only its allowlist, on every ingress route this middleware
    // covers (/v1/messages, /v1/chat/completions, count_tokens included).
    if (inboundKeys.length > 0 && typeof model === "string" && model.length > 0) {
      const scoped = matchesInboundKey(provided, inboundKeys);
      if (scoped) {
        markInboundKey(c.req.raw, scoped.name);
        if (!inboundModelAllowed(scoped, model)) {
          // Countable marker via logStderr — the hub runs with debug off, where
          // log() alone is file-only and invisible to docker logs (#212 lesson).
          logStderr(
            `[InboundKey] refused key=${scoped.name} model=${model} (allowlist: ${scoped.allowModels.join(", ")})`
          );
          return c.json(
            wrapAnthropicError(
              403,
              `[InboundKey] key '${scoped.name}' is not permitted to use model '${model}' — allowed models: ${scoped.allowModels.join(", ")}`,
              "permission_error"
            ),
            403
          );
        }
        return await next();
      }
    }

    // Anthropic pass-through: skip proxy key validation entirely.
    // NativeHandler will either swap proxyKey → stored Anthropic key,
    // or pass the client's OAuth token through unchanged.
    if (model) {
      const spec = parseModelSpec(model);
      if (spec.provider === "native-anthropic") {
        return await next();
      }
    }

    // Non-Anthropic: enforce proxy key
    if (!matchesProxyKey(provided, proxyKeys)) {
      return c.json(wrapAnthropicError(401, "invalid proxy authentication"), 401);
    }
    await next();
  };
}
