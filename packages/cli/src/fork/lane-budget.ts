/**
 * #1055 g2 — a per-(lane, model) daily ceiling on UPSTREAM output tokens for
 * HARNESS lanes, plus an operator emergency stop. The harness-lane seam is the
 * `x-claudish-lane` header (the same attribution chain g1 persists to the
 * capture envelope): a request that does not carry it is byte-identical to
 * pre-#1055 traffic — null admission, zero work.
 *
 * Modeled on #317 (session budget), with the key coarsened from
 * (machine, session_id) to (lane, model) — "un budget par jour et par modèle
 * pour cette lane". The counter unit is UPSTREAM output tokens for the same
 * reason as #317: the token is the quantity every seam already counts and the
 * only denominator lanes share.
 *
 * Two mechanisms, each INERT without its env knob:
 * - `CLAUDISH_LANE_BUDGETS` — a FLAT comma-separated list of
 *   `lane/model:bar` entries (a per-model bar) and `lane:bar` entries (the
 *   lane-wide default for models without their own entry). One STATIC env
 *   name on purpose: compose-env-coverage's scanner sees direct
 *   `env.CLAUDISH_*` property accesses, a per-lane constructed name would be
 *   invisible to it and the compose allowlist would stop enforcing (#304/#310).
 *   At the bar the request is answered locally with a labeled 429 +
 *   `retry-after` + the `x-claudish-lane-refusal: budget` header, BEFORE any
 *   upstream is paid. The body wording is load-bearing exactly like #317's:
 *   no quota-class word, or `isQuotaExhaustion` would arm the budget failover
 *   off our own ceiling.
 * - `CLAUDISH_LANE_STOP_DIR` — emergency stop by FILE, not env: a container's
 *   environment is frozen at create time (#310), so an env-flag stop would
 *   need a recreate to toggle — not an emergency control. The operator
 *   touches/removes `<dir>/<lane>` (a bind-mounted volume survives); a
 *   present file refuses that lane ONLY, immediately, with
 *   `x-claudish-lane-refusal: stop`. Other lanes and lane-less traffic are
 *   untouched.
 *
 * The refusals are TYPED for the harness (AC2/AC3 of #1055): the response
 * carries the `x-claudish-lane-refusal` header so a driver can distinguish
 * "defer this notebook and retry after N s" from any upstream failure — never
 * a silent queue.
 *
 * Sliding window and the in-flight/sealed attempt ledger follow #317: usage
 * reports may repeat within one attempt (streaming parsers), so the sink takes
 * the MAX per attempt token and seals it once quiet; two paid attempts of one
 * request land in two slots. All state is in-memory; a restart clears it,
 * which is fine — the window is shorter than any plausible hub uptime.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import { wrapAnthropicError } from "../handlers/shared/anthropic-error.js";
// #1055 CR N6 — the ONE sanitizer, shared with the g1 capture envelope so the
// attribution key and the budget key cannot drift. Leading dot refused there.
import { sanitizeHarnessLane } from "./middleware/request-logger.js";

export const LANE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A stream that reported nothing for this long is done or dead — seal it (#317). */
export const LANE_ATTEMPT_SETTLE_MS = 15 * 60 * 1000;
const MAX_TRACKED_LANES = 1024;

export const LANE_HEADER = "x-claudish-lane";

/** Kept as the module's historical export name; the CONTRACT lives in
 *  sanitizeHarnessLane (request-logger.ts, the g1 site). */
export const sanitizeLane = sanitizeHarnessLane;

interface LaneBudgetEvent {
  ts: number;
  tokens: number;
}

interface LaneBudgetEntry {
  events: LaneBudgetEvent[];
  inFlight: Map<object, { max: number; lastTouch: number }>;
  sealed: Map<object, LaneBudgetEvent>;
  lastActivity: number;
}

const entries = new Map<string, LaneBudgetEntry>();

interface AttemptToken {
  key: string;
}

/** raw request → the CURRENT attempt's token (fresh per upstream attempt). */
const attempts = new WeakMap<object, AttemptToken>();

/** Clock seam so tests can slide the window without sleeping. */
let nowMs: () => number = () => Date.now();

export function setLaneBudgetClockForTests(fn?: () => number): void {
  nowMs = fn ?? (() => Date.now());
}

export function resetLaneBudgetForTests(): void {
  entries.clear();
  budgetsCache = null;
}

export interface LaneBudgets {
  /** `lane|model` → bar. */
  perModel: Map<string, number>;
  /** `lane` → lane-wide default bar. */
  laneWide: Map<string, number>;
}

let budgetsCache: { raw: string; parsed: LaneBudgets } | null = null;

/**
 * Parse `CLAUDISH_LANE_BUDGETS`. Cached keyed on the RAW value so a test (or
 * an operator with a restarted-env quirk) changing the string re-parses —
 * within one process life the env is frozen anyway (#310).
 *
 * Grammar (flat, comma-separated):
 *   nb-coder/nb-minimax:500000, nb-coder:1000000, other-lane/x:20000
 * A `lane:bar` entry is the lane-wide default; `lane/model:bar` wins for that
 * model. Malformed entries are skipped with a stderr warning, never thrown —
 * an ops typo must not take the ingress down.
 */
export function parseLaneBudgets(raw: string | undefined): LaneBudgets {
  if (budgetsCache && budgetsCache.raw === (raw ?? "")) return budgetsCache.parsed;
  const parsed: LaneBudgets = { perModel: new Map(), laneWide: new Map() };
  if (raw) {
    for (const partRaw of raw.split(",")) {
      const part = partRaw.trim();
      if (!part) continue;
      const m = /^(.+?):(\d+)$/.exec(part);
      if (!m) {
        log(`[LaneBudget] skipping malformed CLAUDISH_LANE_BUDGETS entry "${part}"`, true);
        continue;
      }
      const subject = m[1];
      const bar = Number(m[2]);
      if (bar <= 0) continue;
      const slash = subject.indexOf("/");
      if (slash > 0) {
        const lane = sanitizeLane(subject.slice(0, slash));
        const model = subject.slice(slash + 1).trim();
        if (lane && model) parsed.perModel.set(`${lane}|${model}`, bar);
      } else {
        const lane = sanitizeLane(subject);
        if (lane) parsed.laneWide.set(lane, bar);
      }
    }
  }
  budgetsCache = { raw: raw ?? "", parsed };
  return parsed;
}

function entryKey(lane: string, model: string): string {
  return `${lane}|${model}`;
}

function getOrCreateEntry(key: string, now: number): LaneBudgetEntry {
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_TRACKED_LANES) {
      for (const [k, e] of entries) {
        if (e.lastActivity < now - LANE_BUDGET_WINDOW_MS) entries.delete(k);
      }
    }
    entry = { events: [], inFlight: new Map(), sealed: new Map(), lastActivity: now };
    entries.set(key, entry);
  }
  return entry;
}

function maintainEntry(entry: LaneBudgetEntry, now: number): void {
  while (entry.events.length > 0 && entry.events[0].ts < now - LANE_BUDGET_WINDOW_MS) {
    entry.events.shift();
  }
  for (const [token, slot] of entry.inFlight) {
    if (slot.lastTouch < now - LANE_ATTEMPT_SETTLE_MS) {
      const ev: LaneBudgetEvent = { ts: slot.lastTouch, tokens: slot.max };
      entry.events.push(ev);
      entry.sealed.set(token, ev);
      entry.inFlight.delete(token);
    }
  }
}

function consumedOf(entry: LaneBudgetEntry): number {
  let total = 0;
  for (const ev of entry.events) total += ev.tokens;
  for (const slot of entry.inFlight.values()) total += slot.max;
  return total;
}

/** Test/ops seam: the live consumed total for a (lane, model) pair. */
export function laneBudgetConsumed(lane: string, model: string): number {
  const entry = entries.get(entryKey(lane, model));
  if (!entry) return 0;
  maintainEntry(entry, nowMs());
  return consumedOf(entry);
}

export type LaneRefusalType = "budget" | "stop";

export interface LaneBudgetAdmission {
  refused: boolean;
  /** "budget" (daily bar crossed) or "stop" (operator emergency file). */
  type: LaneRefusalType;
  lane: string;
  model: string;
  consumed: number;
  bar: number;
  retryAfterSec: number;
  message: string;
}

/**
 * #1055 g2 CR B4 — the STOP half of the admission, split out so the route can
 * run it ABOVE the relay branch: the stop file belongs to THIS node's
 * operator, so the stop must hold in BOTH relay modes — a NOMINAL forward
 * would otherwise relay a stopped lane to the hub and keep spending (measured:
 * 200 with the hub called, on both ingresses). The BUDGET half stays at the
 * admission site, BELOW the relay: only the node that serves counts tokens,
 * and for relayed traffic that is the hub. Inert without a lane header or a
 * stop dir — the pre-#1055 path is byte-identical.
 */
export function laneStopRefusal(
  laneRaw: string | null,
  model: string,
  env: NodeJS.ProcessEnv
): LaneBudgetAdmission | null {
  const lane = sanitizeLane(laneRaw);
  if (!lane) return null; // not a harness-lane request — instrument inert

  const stopDir = env.CLAUDISH_LANE_STOP_DIR;
  if (stopDir && existsSync(join(stopDir, lane))) {
    log(`[LaneStop] REFUSE lane=${lane} (operator stop file present)`, true);
    return {
      refused: true,
      type: "stop",
      lane,
      model,
      consumed: 0,
      bar: 0,
      retryAfterSec: 900,
      message:
        // CR N2 — the CLIENT message never echoes the lane/model names: the
        // client sent the header, it knows its own lane, and a hostile-enough
        // name ("credit-analyst-v1") would put a quota-class word in our own
        // 429 body (isQuotaExhaustion measured true on those echoes).
        `[LaneStop] this lane is under an operator emergency stop — defer this ` +
        `notebook and retry later (the stop is lifted when the operator removes the stop file)`,
    };
  }
  return null;
}

/**
 * BUDGET admission only. Call ONCE per request, BEFORE any handler resolution
 * (a refused request pays nothing upstream and writes no failover state).
 * Returns null when inert: no lane header, or no bar for this (lane, model) —
 * the pre-#1055 byte-identical path.
 *
 * CR3 B5: the STOP half lives route-side ONLY (`laneStopRefusal`, above the
 * relay branch — B4). That pre-relay check is UNCONDITIONAL, so it refuses
 * first on every ingress, hub included; this function no longer re-checks the
 * stop file — the second `existsSync` per lane'd request bought no behavior
 * (the module stop pins call `laneStopRefusal` directly).
 */
export function admitLaneBudget(
  laneRaw: string | null,
  model: string,
  env: NodeJS.ProcessEnv
): LaneBudgetAdmission | null {
  const lane = sanitizeLane(laneRaw);
  if (!lane) return null; // not a harness-lane request — instrument inert

  const budgets = parseLaneBudgets(env.CLAUDISH_LANE_BUDGETS);
  const key = entryKey(lane, model);
  const bar = budgets.perModel.get(key) ?? budgets.laneWide.get(lane) ?? 0;
  if (bar <= 0) return null; // armed lanes only — a lane without a bar serves

  const now = nowMs();
  const entry = getOrCreateEntry(key, now);
  entry.lastActivity = now;
  maintainEntry(entry, now);
  const consumed = consumedOf(entry);

  if (consumed >= bar) {
    // How long until enough of the oldest events leave the 24h window for the
    // total to drop under the bar (#317's prefix walk).
    let prefix = 0;
    let horizonTs = 0;
    for (const ev of entry.events) {
      prefix += ev.tokens;
      horizonTs = ev.ts;
      if (consumed - prefix < bar) break;
    }
    const retryAfterSec =
      horizonTs > 0 ? Math.max(1, Math.ceil((LANE_BUDGET_WINDOW_MS - (now - horizonTs)) / 1000)) : 60;
    log(
      // #1063 CR B1 — `consumed=` (equals sign), the spelling the lane report
      // reader pins; the two sides cannot drift again (emitter pin in
      // lane-budget.test.ts, reader pins in test_lane_daily_report.py).
      `[LaneBudget] REFUSE lane=${lane} model=${model} consumed=${consumed} >= ${bar} ` +
        `(retry-after ${retryAfterSec}s)`,
      true
    );
    return {
      refused: true,
      type: "budget",
      lane,
      model,
      consumed,
      bar,
      retryAfterSec,
      message:
        // CR N2 — no lane/model echo in the CLIENT body (quota-word hazard);
        // the numbers stay (the harness needs them to defer, not queue).
        `[LaneBudget] this lane's daily output budget is consumed (${consumed} of ` +
        `${bar} output tokens in a 24h sliding window) — defer this notebook; retry after ${retryAfterSec}s`,
    };
  }
  return null;
}

/**
 * Attach a FRESH attempt token to the request's raw object before EVERY
 * upstream attempt — two paid attempts of one request must never share a slot
 * (the max-per-attempt ledger would under-count them). No-op when the
 * instrument is inert for this (lane, model).
 */
export function openLaneBudgetAttempt(
  raw: object | undefined,
  laneRaw: string | null,
  model: string,
  env: NodeJS.ProcessEnv
): void {
  if (!raw) return;
  const lane = sanitizeLane(laneRaw);
  if (!lane) return;
  const budgets = parseLaneBudgets(env.CLAUDISH_LANE_BUDGETS);
  const key = entryKey(lane, model);
  if ((budgets.perModel.get(key) ?? budgets.laneWide.get(lane) ?? 0) <= 0) return; // inert
  attempts.set(raw, { key });
}

/**
 * Usage sink — called by the handlers whenever an upstream reports output
 * tokens, alongside #317's sink. MAX per attempt token, sealed once quiet.
 * Never throws.
 */
export function recordLaneBudgetOutput(raw: object | undefined, outputTokens: number): void {
  try {
    if (!raw || !Number.isFinite(outputTokens) || outputTokens <= 0) return;
    const token = attempts.get(raw);
    if (!token) return;
    const now = nowMs();
    const entry = getOrCreateEntry(token.key, now);
    entry.lastActivity = now;
    const slot = entry.inFlight.get(token);
    if (slot) {
      if (outputTokens > slot.max) slot.max = outputTokens;
      slot.lastTouch = now;
      return;
    }
    const sealed = entry.sealed.get(token);
    if (sealed) {
      if (outputTokens > sealed.tokens) sealed.tokens = outputTokens;
      sealed.ts = now;
      return;
    }
    entry.inFlight.set(token, { max: outputTokens, lastTouch: now });
  } catch {
    // never throw from a sink
  }
}

/**
 * The /v1/messages refusal response: Anthropic error envelope + retry-after +
 * the TYPED `x-claudish-lane-refusal` header the harness reads to defer
 * (AC2/AC3) — never a silent queue.
 */
export function laneBudgetRefusalAnthropic(admission: LaneBudgetAdmission): Response {
  const body = wrapAnthropicError(429, admission.message);
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "retry-after": String(admission.retryAfterSec),
      "x-claudish-lane-refusal": admission.type,
    },
  });
}
