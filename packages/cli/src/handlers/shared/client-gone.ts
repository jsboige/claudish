/**
 * #1209 (2/2) — the mark a departed `stream:false` client's answer carries, and
 * the ONE predicate that recognises it.
 *
 * ComposedHandler answers a client that closed its connection with a marked 200
 * (`x-claudish-client-gone: 1`, empty content): the route always answers, and
 * the departure is never answered with a 5xx a cascade would walk — for a
 * client that is gone.
 *
 * But `ok` is read as SUCCESS by every consumer downstream, and none of it
 * happened — no provider answered. Left alone, the marked answer would:
 * - book a VERIFIED recovery in the cascade (`onNominalSuccess`: lift a bucket
 *   wall, void the refusal run and its TTL escalation, release every dwell pin
 *   on the role, announce `[Failover] RECOVERED`) or clear a step's backoff
 *   (`resetStepSuccess`) — bringing a dead rung back on an answer nobody served;
 * - condense a one-time recovery notice (`applyFailoverNotices`) onto a session
 *   whose substitute model never changed;
 * - credit a FallbackHandler candidate that "served" (`lastSuccessIndex`).
 *
 * A cancelled attempt is a NON-STATE: neither success nor failure. Every
 * `response.ok` consumer on its path says so explicitly, through this predicate
 * — a header test, so a rebuilt Response that copies its headers (the #229
 * pattern) keeps the mark.
 *
 * The mark is set by exactly one producer (ComposedHandler.buildClientGoneResponse)
 * and read by position: a provider can never emit it, the response headers of an
 * upstream answer are not copied wholesale onto the client's (#296 class).
 */

export const CLIENT_GONE_HEADER = "x-claudish-client-gone";

export function isClientGoneResponse(response: Response): boolean {
  return response.headers.get(CLIENT_GONE_HEADER) === "1";
}
