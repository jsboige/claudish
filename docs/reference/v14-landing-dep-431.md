# v14 landing dependency — #431 patient-overload / eligibility WeakSet

Status: **recorded, not ported** (grain v45-4). This is a note for the v14
landing plan, not a speculative port. The mechanism it describes is already
half-present on v14 and the other half is **deliberately absent** — the code
says so itself at `packages/cli/src/handlers/shared/step-skip.ts:35-39`.

## What #431 needs that main has and v14 does not

Three cooperating pieces make a *busy* cascade step yield in seconds instead of
holding the turn:

| Piece | main | v14 (`r1-port`) |
|---|---|---|
| `x-claudish-step-skip` header + `readStepSkip` consumer in `handleWithCascade` | ✅ | ✅ already ported (step-skip.ts; proxy-server.ts:2216) |
| `busy` emitter for concurrency-refusal (#679/#684, 429 + `error.code 1302`) | ✅ | ✅ already ported (step-skip.ts `classifyConcurrencyRefusal`, proxy-server.ts:1820) |
| `media` emitter (#575 image cap) | ✅ | ✅ already ported (media-cap.ts, row 7a) |
| `context` emitter (overflow recovery turn → skip) | ✅ | ⚠ partial — the loop classifies a step's own error body and writes `context` directly (step-skip.ts:41-43) |
| **Bounded limiter wait** — `ConcurrencyLimiter.run(task, waitBudgetMs)` | ✅ `concurrency-limiter.ts` | ❌ v14 has `local-queue.ts` (= main's `local-queue.ts`, AbortSignal-based, **no** `waitBudgetMs`); `concurrency-limiter.ts` is main-only |
| **Request-scoped busy budget** — `busyBudgets` WeakMap, `markCascadeStepAttempt` / `cascadeStepBusyWaitMs` | ✅ step-skip.ts:183 | ❌ absent on v14 |
| **Eligibility WeakSet** — `markStepSkipEligible` / `isStepSkipEligible` (#679) | ✅ step-skip.ts:210 | ❌ absent on v14 — **on purpose** |

## Why the WeakSet is NOT a port target

`markStepSkipEligible` exists on main for exactly one reason: to exempt a
**non-last** cascade step from the **patient overload backoff** — the ~5-minute
wait a saturated step would otherwise impose before yielding, so the successor
can serve in seconds (#679: "the step's whole job is to yield in seconds").

**v14 has no patient overload backoff to exempt anyone from.** The WeakSet would
arrive with nothing to gate. step-skip.ts:35-39 states this verbatim: the
eligibility WeakSet "exists on main ONLY to exempt non-last steps from the
patient overload backoff — this base has no patient backoff to exempt anyone
from."

## The real dependency for landing

The ordering constraint is **not** "port the WeakSet." It is:

1. **If** a future row brings main's *patient overload backoff* (the bounded
   `ConcurrencyLimiter` with its multi-minute patient wait) to v14,
2. **then** that row **must also** bring the two request-scoped markers in the
   same landing, or busy steps regress to multi-minute holds:
   - `busyBudgets` WeakMap + `markCascadeStepAttempt(c, ms)` (set by the cascade
     loop at the step-attempt site) + `cascadeStepBusyWaitMs(c)` (read by
     `ComposedHandler` at its `enqueueRequest` call), and
   - `stepSkipEligibleContexts` WeakSet + `markStepSkipEligible(c, on)` — kept
     **distinct** from the budget on purpose: zeroing
     `CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS` (an operator tuning the *limiter*
     wait) must not silently restore the patient backoff for a
     concurrency-refused step.
3. **Until then**, the WeakSet/WeakMap stay unported. Porting them now would add
   dead request-scoped state with no consumer — the exact "dead module" outcome
   step-skip.ts:30-34 already avoids for `isConcurrencyRefusalResponse`.

## Blocking relationship for the landing plan

- **Not a blocker** for the v14 landing as scoped (port-map 9/9). The busy/context/
  media/unroutable skip *signals* all work; only the patient-backoff *exemption*
  is absent, and v14 has no patient backoff.
- **A blocker only if** the landing later pulls in main's bounded
  `ConcurrencyLimiter`. At that point the WeakMap budget + WeakSet eligibility
  become mandatory companions in the same PR, with the #431 AC3 pin ("the
  nominal path keeps its unbounded FIFO wait") held green.
