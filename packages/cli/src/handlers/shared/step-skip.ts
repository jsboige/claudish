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
 * / `isConcurrencyRefusalResponse` (#679). **`replatform/v14` has none of those
 * emission sites** — no `media-cap`, no concurrency refusal marker, no
 * `providers/transport/quota-wall.ts` (the module those helpers read bodies
 * through) — so this port carries the WIRE CONTRACT and its predicates only.
 * The vocabulary is kept identical to main on purpose: the same header read by
 * the same loop on both branches, so a later port of an emission site needs no
 * second spelling.
 *
 * v14's producer today is the loop itself: `handleWithCascade` classifies a
 * step's own error body with `isContextOverflowError` (`request-shape.ts`) —
 * the size-refusal shape, measured as an HTTP 400 whose body names the input
 * and a limit. It writes a `context` skip directly (it would be its own reader
 * otherwise); the header path below is what a handler-side producer will use
 * when v14 gains one, and it is pinned now so the contract cannot rot.
 */

export const STEP_SKIP_HEADER = "x-claudish-step-skip";

export type StepSkipReason = "context" | "busy" | "media" | "unroutable";

/** Every reason the loop will act on. A producer adding one must extend this
 *  AND `readStepSkip` together — a header the reader drops is a silent no-op.
 *  `unroutable` (#769) is produced on the loop's OWN refusal only — no upstream
 *  ever carries it, so no response-shape skip fires on it. On v14 only
 *  `context` is produced today (see the header note above); the other three are
 *  accepted on the wire so the vocabulary does not fork between branches. */
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

// ── Kill switch (re-read per request) ─────────────────────────────────────────

/** `CLAUDISH_FAILOVER_STEP_SKIP=0` restores pre-#431 behavior for the whole
 * feature: no skip-advance, so a step that refuses the request fails exactly
 * as it did before (mark, backoff, advance). Only an explicit "0" disarms —
 * the same convention as every house kill switch. */
export function stepSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_FAILOVER_STEP_SKIP || "").trim() === "0";
}
