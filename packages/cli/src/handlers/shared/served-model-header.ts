/**
 * #1128 — publish the concrete that served, as a response header.
 *
 * A client that delegates through claudish (the nb_coder harness, producer ≠
 * verifier guard) needs in-band proof of which model actually produced a
 * response; today it only knows the id it asked for. This header names the
 * concrete, on both ingresses, streaming and JSON.
 *
 * Contract (issue #1128):
 * - AC2: the value is byte-equal to what the capture records for the same
 *   request — on the composed lane that is the parser's modelName
 *   (ComposedHandler.bareModelName: every parser is constructed with it), on
 *   the native lane the post-pin payload.model (NativeHandler's `target`).
 *   One source string feeds both the capture and the header — never a
 *   derived or guessed spelling.
 * - AC4: when the concrete is not knowable the header is OMITTED, never
 *   guessed — the harness reads absence as `unknown` and blocks nothing.
 *   Omission is by construction: only the ComposedHandler/NativeHandler
 *   success returns record a value, so synthetic answers, admission
 *   refusals, error translations and early returns never carry one.
 * - AC6: never-hang is untouched — synchronous, no await, the body object
 *   passes through `new Response(response.body, …)` without being read.
 *
 * Why a WeakMap keyed by Response: handlers are cached per model for the
 * lifetime of a `claudish serve` (many conversations through one instance),
 * but the Response is strictly per request — keying the side-channel by the
 * response object makes the value immune to handler reuse and needs no
 * signature changes anywhere on the serve path. The route applies it right
 * after handleWithCascade; every downstream rebuild (applyFailoverNotices,
 * the capability-vocab condensation) copies existing headers, so an early
 * set survives to the wire.
 */

export const SERVED_MODEL_HEADER = "x-claudish-served-model";

const servedModels = new WeakMap<Response, string>();

/**
 * Record the concrete that served `response`. Written only where the
 * per-request concrete is in scope: the ComposedHandler.handle return sites
 * and the NativeHandler returns. Never throws.
 */
export function setServedModel(response: Response, model: string): void {
  try {
    servedModels.set(response, model);
  } catch {
    // Unreachable for an object key; the accounting side-channel never takes
    // the response path down regardless.
  }
}

/**
 * Apply the recorded value at the route, right after handleWithCascade.
 * Absent → returned untouched (the AC4 omission). Present → the #229 rebuild
 * pattern (failover-stream-notice.ts responseWithNoticeHeader): copy every
 * existing header, add one, rebuild with the body object untouched.
 */
export function withServedModelHeader(response: Response): Response {
  const model = servedModels.get(response);
  if (model === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set(SERVED_MODEL_HEADER, model);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Copy the header across a rebuild that does not carry it natively: the
 * OpenAI-ingress translations and the relay passthrough both rebuild their
 * response headers from fresh literals (#229 precedent — carryNoticeHeader
 * sibling, same shape). `from` may be a local response (value set in-process)
 * or the hub's response on a NOMINAL sidecar (real HTTP header from the hub's
 * own route). No value on `from` → `to` returned untouched.
 */
export function carryServedModelHeader(from: Response, to: Response): Response {
  const value = from.headers.get(SERVED_MODEL_HEADER);
  if (!value) return to;
  const headers = new Headers(to.headers);
  headers.set(SERVED_MODEL_HEADER, value);
  return new Response(to.body, {
    status: to.status,
    statusText: to.statusText,
    headers,
  });
}
