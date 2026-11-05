/**
 * Step-skip signal — #431: how a cascade step says "I cannot take THIS request".
 *
 * The signal is a response header, `x-claudish-step-skip`, read by exactly one
 * consumer (`handleWithCascade`) and acted on only for a NON-LAST cascade step
 * that has a successor: advance (skip), no failure mark, no wall, no arm, no
 * dwell pin on the skipped step. Everywhere else — nominal, last step,
 * non-cascade path — the response surfaces unchanged, header and all (same
 * doctrine as `x-claudish-failover-notice`, #229: a namespaced diagnostic
 * header is harmless to a client that ignores it, and greppable for one that
 * looks).
 *
 * Why a skip is not a failure: the step is HEALTHY and will take the next
 * request. Marking it would bench it for `[10m…24h]` on evidence that says
 * nothing about its health — a conversation that outgrew a 128k engine exiles
 * that engine for everyone else, and the very next turn of the same session
 * (after compaction) would still be paying the deeper step.
 *
 * ── What this port carries, and what it does not ─────────────────────────────
 *
 * On `main` the header is EMITTED by `ComposedHandler` from three sites
 * (`context` overflow recovery turn, `busy` bounded concurrency 529, `media`
 * per-prompt image cap #575) and the transports carry `classifyConcurrencyRefusal`
 * / `isConcurrencyRefusalResponse` (#679). `replatform/v14` now carries TWO of
 * the handler sites — the `media` emitter (#575, `media-cap.ts`, row 7a) and
 * the `busy` concurrency-refusal emitter (#679/#684, row 7b, this port):
 * z.ai's GLM Coding plan answers request-concurrency overuse with HTTP 429 +
 * `error.code 1302` — a busy slot the plan frees on its own, not a step
 * failure; the classifier below is byte-faithful to main's. Deliberately NOT
 * ported: main's `isConcurrencyRefusalResponse` (a Response-shaped helper that
 * reads a body through a bounded `readBodyWithDeadline` in
 * `providers/transport/quota-wall.ts` — both of THIS base's consumers, the
 * transport 429 ladders and the handler emitter, classify text they have
 * already read, so the helper and the module would arrive dead), and the
 * eligibility WeakSet (`markStepSkipEligible`), which exists on main ONLY to
 * exempt non-last steps from the patient overload backoff — this base has no
 * patient backoff to exempt anyone from. The vocabulary is kept identical to
 * main on purpose: the same header read by the same loop on both branches, so
 * a later port of an emission site needs no second spelling.
 *
 * v14's producers today: the loop itself (`handleWithCascade` classifies a
 * step's own error body with `isContextOverflowError` (`request-shape.ts`) and
 * writes a `context` skip directly — it would be its own reader otherwise),
 * the loop-construction sites (`unroutable` #769, `busy` #654), and the two
 * handler-side emitters — `media` (#575, row 7a) and `busy` (#684, this port)
 * — which reach the loop through the header path below, the seam this wire
 * contract was pinned for.
 */

export const STEP_SKIP_HEADER = "x-claudish-step-skip";

export type StepSkipReason = "context" | "busy" | "media" | "unroutable";

/** Every reason the loop will act on. A producer adding one must extend this
 *  AND `readStepSkip` together — a header the reader drops is a silent no-op.
 *  `unroutable` (#769) is produced on the loop's OWN refusal only — no upstream
 *  ever carries it, so no response-shape skip fires on it. Produced on v14
 *  today: `context` (loop, #815), `unroutable` (loop construction, #769),
 *  `busy` (budget gate, #654), `media` (handler emitter, #575). */
const STEP_SKIP_REASONS: readonly StepSkipReason[] = ["context", "busy", "media", "unroutable"];

export interface StepSkipInfo {
  reason: StepSkipReason;
  /** Free-form `key=value` tokens for the marker, e.g. `status=400`. */
  detail?: string;
}

export function encodeStepSkipHeader(reason: StepSkipReason, detail?: string): string {
  return detail ? `${reason}; ${detail}` : reason;
}

/**
 * Parse-tolerant reader. Unknown reasons read as null (the loop never acts on
 * a value it does not understand — a future producer adding a reason must
 * extend the reason union AND the loop's handling together).
 */
export function readStepSkip(response: Response): StepSkipInfo | null {
  let raw: string | null = null;
  try {
    raw = response.headers.get(STEP_SKIP_HEADER);
  } catch {
    return null; // exotic Response — never act on what cannot be read
  }
  if (!raw) return null;
  const semi = raw.indexOf(";");
  const reason = (semi === -1 ? raw : raw.slice(0, semi)).trim();
  // Membership in ONE list: a reason added to the union but not here reads as
  // null and the loop silently ignores its header — the failure mode this
  // constant exists to make impossible to write twice, in two spellings.
  if (!STEP_SKIP_REASONS.includes(reason as StepSkipReason)) return null;
  const detail = semi === -1 ? undefined : raw.slice(semi + 1).trim() || undefined;
  return { reason: reason as StepSkipReason, detail };
}

// ── Concurrency refusal, `busy` (#679/#684, port-map row 7b) ──────────────────

/** z.ai's GLM Coding plan refuses REQUEST-concurrency overuse with HTTP 429 and
 *  `error.code 1302` — two measured wordings, one stable code. The code is the
 *  contract; the status gate keeps every other 429 on its ordinary route. The
 *  USAGE wall is `1308` (isQuotaExhaustion's) and must NEVER match here: that
 *  one is a real quota signal, not a slot that frees itself. */
export const CONCURRENCY_REFUSAL_SKIP_DETAIL = "code=1302";

/** Byte-faithful to main's #684 classifier. `bodyText` is text the caller has
 *  ALREADY read (the transport 429 ladders clone-read the body; the handler
 *  reads `errorText`) — this base has no unread-Response consumer, which is
 *  why the bounded-read helper was not ported (see the module header). */
export function classifyConcurrencyRefusal(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  try {
    const code = JSON.parse(bodyText)?.error?.code;
    return code === "1302" || code === 1302;
  } catch {
    return false;
  }
}

// ── Kill switch (re-read per request) ─────────────────────────────────────────

/** `CLAUDISH_FAILOVER_STEP_SKIP=0` restores pre-#431 behavior for the whole
 * feature: no skip-advance, so a step that refuses the request fails exactly
 * as it did before (mark, backoff, advance). Only an explicit "0" disarms —
 * the same convention as every house kill switch. */
export function stepSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_FAILOVER_STEP_SKIP || "").trim() === "0";
}
