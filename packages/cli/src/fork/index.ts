/**
 * Fork extensions barrel export + registration.
 *
 * All fork-specific features are wired through this single entry point.
 * proxy-server.ts calls registerForkExtensions() to activate them.
 * This keeps the diff between our fork and upstream minimal.
 */

import type { Hono } from "hono";
import { log } from "../logger.js";
import type { InboundKeyEntry } from "../handlers/shared/inbound-keys.js";
import { createProxyAuthMiddleware } from "./middleware/proxy-auth.js";
import { registerModelDiscoveryRoute } from "./routes/model-discovery.js";

export { createProxyAuthMiddleware, collectRoutedBareNames } from "./middleware/proxy-auth.js";
export { registerModelDiscoveryRoute } from "./routes/model-discovery.js";
export { stripBillingHeaderFromBody } from "./middleware/billing-header-strip.js";
export { resolveSourceIp, logRequest } from "./middleware/request-logger.js";
export { createHostnameConfig, type HostnameConfig } from "./server/hostname-binding.js";
export { resolveInboundKeys } from "../handlers/shared/inbound-keys.js";

export interface ForkExtensionsOptions {
  proxyKeys?: string[];
  /** Scoped inbound keys (#400) — resolved by proxy-server from config at startup. */
  inboundKeys?: InboundKeyEntry[];
  /**
   * #410 — bare model names that resolve to a non-native route (routing-map
   * keys + custom-endpoint model ids). The native pass-through exemption must
   * never admit these: the handler would run them with the cluster's stored
   * credentials (measured: no-auth frognano-4b → 200).
   */
  routedBareNames?: ReadonlySet<string>;
}

/**
 * Register all fork extensions on the Hono app.
 * Called once from proxy-server.ts during startup.
 */
export function registerForkExtensions(app: Hono, opts: ForkExtensionsOptions): void {
  // 1. Proxy authentication middleware
  if (opts.proxyKeys?.length) {
    app.use(
      "/v1/*",
      createProxyAuthMiddleware(opts.proxyKeys, opts.inboundKeys ?? [], opts.routedBareNames ?? new Set())
    );
    // Count logged unconditionally (lengths, never values): closing a rotation
    // window must be as greppable as opening one (review feedback on #95).
    log(
      `[Proxy] Authentication enabled (Anthropic pass-through; ${opts.proxyKeys.length} proxy key(s) accepted, lengths ${opts.proxyKeys.map((k) => k.length).join("/")}; proxy key required for other providers)`
    );
    // #400 — names only (never values): the count of scoped keys must be as
    // greppable as the proxy-key rotation state, and the hub log is what an
    // operator greps after an external misbehaves.
    if (opts.inboundKeys?.length) {
      log(
        `[Proxy] ${opts.inboundKeys.length} scoped inbound key(s) active: ${opts.inboundKeys.map((k) => `${k.name}→[${k.allowModels.join(",")}]`).join("; ")}`
      );
    }
  }

  // 2. Model discovery endpoint
  registerModelDiscoveryRoute(app);
}
