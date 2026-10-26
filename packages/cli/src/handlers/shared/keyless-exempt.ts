/**
 * Keyless native exemption marker (#412).
 *
 * The auth middleware exempts the Anthropic pass-through from key validation:
 * `NativeHandler` either swaps a proxy key for the stored Anthropic key or
 * passes the CLIENT's own OAuth token through, so requiring the cluster key
 * there would break ai-01's keyless OAuth lane.
 *
 * #410 closed the first hole in that exemption (a bare, family-unknown name
 * parsed as `native-anthropic` while the handler resolved it through
 * `routing`/`customEndpoints` to the CLUSTER's credentials). It enumerated the
 * known routed names — which is complete only until the next such path exists.
 *
 * #412 closes the CLASS instead of another instance. The middleware no longer
 * merely admits: it records that this request arrived keyless. At resolution
 * time — wherever the handler that will actually be called is chosen — a
 * keyless request whose handler is NOT the native passthrough is refused
 * before any upstream fetch, because that handler would spend a credential the
 * CALLER does not hold. The paths that land there are enumerated by
 * construction, not by a list: `modelMap` reroute, `routing` entry, custom
 * endpoint, every cascade step (a native bucket that walls diverts the role to
 * a subscription- or PAYG-paid step), the one-shot overload walk, the vision
 * fallback.
 *
 * Same WeakMap-on-Request seam as `markInboundKey`: the middleware
 * authenticates, the resolution site reads seconds later off the same raw
 * Request object. Best-effort like its sibling — a lost mark degrades to the
 * pre-#412 behaviour, never to a crash.
 */

const keylessExempt = new WeakSet<Request>();

/** Middleware: this request passed the native exemption holding no key of its own. */
export function markKeylessExempt(req: Request): void {
  try {
    keylessExempt.add(req);
  } catch {
    /* best-effort */
  }
}

/** Resolution site: was this request admitted on the keyless native exemption? */
export function isKeylessExempt(req: Request): boolean {
  try {
    return keylessExempt.has(req);
  } catch {
    return false;
  }
}

/**
 * The labeled refusal. `lane` names the credential holder the request resolved
 * to — a NAME, never a key value.
 *
 * ⚠ Wording is load-bearing: `isQuotaExhaustion` arms on 401/403 bodies naming
 * a quota/credit/balance wall, so this message must never contain those words
 * (same doctrine as #296 and the #400 per-key cap). Pinned by test against the
 * real predicate — an external caller must not be able to divert the fleet's
 * budget failover with a message we wrote ourselves.
 */
export function keylessRefusalMessage(model: string, lane: string): string {
  return `[ProxyAuth] keyless request for ${model} resolves to a server-held credential (${lane}) — proxy key required`;
}
