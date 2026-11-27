/**
 * #1213 — mark a 5xx that a LIVE hub relays from its upstream provider.
 *
 * The hub returns the provider's status as its own HTTP status (an upstream 502
 * leaves the hub as a 502), and a relaying sidecar read EVERY 5xx as the hub's
 * own death: `markFail("forward-http-502")` + a local replay. Measured on
 * myia-po-2028, 2026-11-26, one provider down while the hub was serving every
 * other role: 32 forwards refused in 45 minutes, all for the one dead model,
 * each replayed locally against the SAME dead provider (35 local 502s); two in
 * a row flipped the whole seat AUTONOMOUS for 66.7 s. One client attempt
 * measured 42 s: about 22 s at the hub, about 21 s on the local replay.
 *
 * 529 (#299 A) and a drain-freeze 503 (#318) are the two statuses a relay
 * already passes through, on one principle: the hub spoke, so it is liveness
 * evidence. This header extends that to the provider's own 5xx. An explicit
 * header, never body sniffing — a hub's own 500 and a relayed 500 carry the
 * same Anthropic-shaped envelope, and #318 states why the discrimination has
 * to be a header our own hub writes.
 *
 * Written at the ONE site that relays an upstream status (the ComposedHandler
 * non-OK envelope), carried across the OpenAI-ingress error translation and
 * the relay's non-streaming rebuild. Only the hub writes it: that envelope is
 * a Response the hub builds itself, so a provider's own headers can never
 * carry it in. A relay honours it on a 5xx only, with the exact marker value.
 *
 * Deliberately a leaf module with NO env var (same rule as
 * admission-freeze.ts): every CLAUDE/CLAUDISH_* name the code reads must also
 * reach the containers. An old hub never sets the header, so a relay's
 * behaviour against one is unchanged; an old relay ignores one extra header.
 */

export const UPSTREAM_ERROR_HEADER = "x-claudish-upstream-error";
export const UPSTREAM_ERROR_MARKER = "1";

/**
 * True when `res` is a 5xx carrying our marker — the only shape a relay passes
 * through on it. Both conjuncts are load-bearing: the status keeps a 4xx that
 * happens to carry the header on its ordinary 4xx path (it still gets the
 * relay's upstream-nonok trace), the exact value keeps a foreign value inert.
 */
export function isMarkedUpstreamError(res: Response): boolean {
  return res.status >= 500 && res.headers.get(UPSTREAM_ERROR_HEADER) === UPSTREAM_ERROR_MARKER;
}

/**
 * Copy the header across a rebuild that does not carry it natively — the
 * #229 carry pattern (`carryNoticeHeader`, `carryServedModelHeader` siblings).
 * `from` is always a response our own hub built: a local handler's envelope on
 * the OpenAI ingress, or the hub's real response on a NOMINAL sidecar. No value
 * on `from` → `to` returned untouched. Never throws.
 */
export function carryUpstreamErrorMarker(from: Response, to: Response): Response {
  try {
    const value = from.headers.get(UPSTREAM_ERROR_HEADER);
    if (!value) return to;
    const headers = new Headers(to.headers);
    headers.set(UPSTREAM_ERROR_HEADER, value);
    return new Response(to.body, {
      status: to.status,
      statusText: to.statusText,
      headers,
    });
  } catch {
    return to;
  }
}
