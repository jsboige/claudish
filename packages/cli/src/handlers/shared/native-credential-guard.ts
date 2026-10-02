/**
 * #296 — native-lane credential guard (forms A and B).
 *
 * The native passthrough used to forward whatever credential state the swap
 * left behind, and the hub holds no Anthropic credential, so two request
 * shapes reached api.anthropic.com with no chance of success:
 *
 *  - **A — no credential at all.** The client's token matched a proxy key, the
 *    swap deleted both auth headers, and with no stored `apiKey` to substitute
 *    the request left unauthenticated. The client saw the upstream's opaque
 *    401 and both WAN reporters spent a diagnosis cycle on their own token
 *    (measured 30/09–01/10: 40 × `Invalid Bearer <redacted>`).
 *  - **B — a foreign credential.** The client passes the gate on a valid
 *    `x-proxy-key` and also sends a Bearer that belongs to another party
 *    (another provider's key, a pre-rotation cluster key). The swap does not
 *    match it, so it was forwarded verbatim — a third party received a token
 *    it should never see, on every request. Same class as #282, closed for
 *    `x-proxy-key` but not for the client's own foreign Bearer.
 *
 * Both shapes are refused locally, labeled, with zero upstream fetch. The
 * marker carries NOTHING derived from the token — no prefix, no length, no
 * fingerprint — the shape letter is the whole diagnosis.
 *
 * Deliberately out of scope ("must not change", #296):
 *  - an `sk-ant-*` credential (OAuth Bearer or API key — the ai-01
 *    passthrough) forwards untouched;
 *  - the swap when a stored `apiKey` exists — the substituted credential is
 *    the operator's own choice;
 *  - the `CLAUDISH_NO_ANTHROPIC` reroute, which resolves before the handler.
 *
 * Shared by `NativeHandler.handle` AND the native `count_tokens` path in
 * proxy-server.ts, same contract as `stripProxyOwnHeaders`.
 */

import { wrapAnthropicError } from "./anthropic-error.js";

/**
 * Kill switch: `CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0`, read per request
 * (mirrors `CLAUDISH_NATIVE_MODEL_PIN`). Only an explicit "0" disarms — if
 * Anthropic ever changes its credential prefix, the labeled refusal makes the
 * breakage visible on the first request and this switch restores the
 * passthrough without a deploy.
 */
function guardDisabled(): boolean {
  return process.env.CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD === "0";
}

/**
 * Which refusal shape (if any) the post-swap credential state represents.
 *
 * @param postSwapHeaders       headers as they would leave for api.anthropic.com
 *                              (after the hop-by-hop filter, the #282 strip and
 *                              the proxy-key swap)
 * @param credentialSubstituted whether the swap substituted a stored `apiKey`
 */
export function nativeCredentialRefusalShape(
  postSwapHeaders: Record<string, string>,
  credentialSubstituted: boolean
): "A" | "B" | null {
  if (guardDisabled()) return null;
  // The substituted credential is the operator's stored key — the
  // swap-with-apiKey path is explicitly exempt.
  if (credentialSubstituted) return null;
  const auth = postSwapHeaders["authorization"] ?? "";
  const apiKey = postSwapHeaders["x-api-key"] ?? "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const hasCredential = bearerToken.length > 0 || apiKey.length > 0;
  const anthropicShaped =
    bearerToken.startsWith("sk-ant-") || apiKey.startsWith("sk-ant-");
  if (!hasCredential) return "A";
  if (!anthropicShaped) return "B";
  return null;
}

/**
 * The labeled refusal body. 403 `permission_error` fits: the proxy key IS
 * valid — the lane is what is not served (and 401 would push Claude Code
 * toward its own re-auth flow, which is the reporters' dead end).
 *
 * ⚠ The wording is load-bearing: `isQuotaExhaustion` (fork/failover.ts) arms
 * the role cascade on a 403 body naming a quota wall ("usage limit",
 * "quota exceeded", "insufficient balance"…). None of those words may ever
 * appear here — a wiring refusal must not arm anything. Pinned by test
 * against the real predicate, not a copied keyword list.
 */
export function nativeCredentialRefusalResponse(model: string): Response {
  return new Response(
    JSON.stringify(
      wrapAnthropicError(
        403,
        `claudish: native model ${model} is not served on this proxy (no Anthropic credential to send) — use a role alias or a non-native model`,
        "permission_error"
      )
    ),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}
