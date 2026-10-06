# Budget failover + Qwen thinking — full reference

**Deferred from `CLAUDE.md` (v7.2+ section).** The config table and the arming/quota gotchas stay in `CLAUDE.md`; this file holds the rationale and the measurements. Canonical env template with inline comments: `.env.sidecar.example`.

## Not the same thing as `FallbackHandler`

`FallbackHandler` swaps *providers* for the *same* model when a provider is unhealthy — a transport concern. Budget failover substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`/`fable`) when that role's metered plan is exhausted — a subscription concern. They compose: a failover target still gets the normal provider fallback chain.

## Why it exists

The cluster runs on weekly-metered plans (Anthropic, MiniMax, Z.AI). When a plan burns faster than its reset window, the choice is to stop working or to serve the role from another pool. Serving it *silently* is the dangerous option: the agent keeps assuming capabilities it no longer has, or — in the MiniMax→DeepSeek direction — fails to use capabilities it just gained. So every substitution is announced.

## Where the notice goes: condensation

`ComposedHandler` appends it to the collected message on the non-streaming path (`stream: false`), which in practice is `/compact`. That boundary is chosen because it is the only moment in an agentic session where the context is rebuilt from scratch anyway — the notice costs nothing there, is guaranteed to survive into the continuing context, and the prompt cache is already cold so re-routing is free. `appendFailoverNoticeToMessage` targets the **trailing** text block (clients may read `content[0]`) and **never throws**: a thrown error would turn a working condensation into a failed one, and a session that cannot condense eventually stalls.

## Configuration (env, read at proxy startup)

| Var | Meaning |
|---|---|
| `CLAUDISH_FAILOVER_<ROLE>` | Routing target for the role. Any spec `getHandlerForRequest` accepts. |
| `..._LABEL` | Human name used in the notice. Defaults to the target string. |
| `..._DIRECTION` | `degraded` (default) · `improved` · `lateral`. Unset means degraded — never flatter the substitute. |
| `..._NOTE` | Extra guidance appended to that role's notice line. |
| `CLAUDISH_FAILOVER_ACTIVE` | Roles armed **now**, comma-separated, or `none`. Use to conserve a plan *before* it dies. |
| `CLAUDISH_FAILOVER_AUTO` | `1` = also arm on genuine upstream quota exhaustion. |

**With nothing set, every code path is inert** — no routing change, no notice, zero added bytes. Configuring a target does **not** activate it; arming is separate and deliberate.

**`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`.** 402 arms on status alone; 429 arms only when the body names a quota/credit/balance/weekly/plan wall — a plain per-minute rate limit must **not** burn the weekly switch because a burst hit a 60-second window. 401 and 404 **never** arm: those are wiring mistakes, and swapping the model would hide a bad key or a bad model id behind a plausible-looking answer.

**Placement.** These belong on the machine that actually *calls* the models. A NOMINAL sidecar only relays, so on a sidecar they matter solely for AUTONOMOUS (hub-down) mode — the hub is the normal home. A failover target must be resolvable *on that machine*: pointing a sidecar at a custom endpoint defined only in the hub's `config.json` configures a fallback that fails exactly when it is needed.

## `CLAUDISH_QWEN_THINKING`

Qwen reasons by default, so an unset `thinking` is not neutral — it means "think, at length", and the Token Plan bills on **output**. Values: `disabled` (default) · `passthrough` · `budget:<n>`. Re-read on **every request**, deliberately: the fleet flips this during a budget crunch, and a cached value would require restarting the proxy that is at that moment the thing keeping everyone working.

The subtlety this encodes: Qwen exposes **two switches on two wires, and each endpoint ignores the other's form**. The OpenAI-compatible endpoint takes `enable_thinking` + `thinking_budget`; the Anthropic-compatible one takes the native `thinking` object. `QwenModelDialect.prepareRequest` therefore branches on `ctx.wireFormat` (`PrepareRequestContext`, threaded from `ComposedHandler.resolveStreamFormat()`). Before this, the adapter converted `thinking` → `enable_thinking` unconditionally, which on the Anthropic wire **deleted the only switch that works**.

Measured against Qwen Token Plan, `max_tokens: 400`, prompt `"Reponds exactement: ok"` (2026-08-11): baseline `67 in / 43 out` with a thinking block; `enable_thinking: false` → `67 / 48`, still thinking; `thinking: {type: "disabled"}` → `31 / 1`. Note the **input** count moves too (67 → 31) — Alibaba appears to inject a reasoning preamble when thinking is on. That makes a crisp post-deploy check: **if `input_tokens` drops from 67 to 31 on that prompt, the native switch reached Qwen.**

---

# Cascade, notices and backoff (merged from `CLAUDE.md`, 2026-08-23)

Detail deferred from the decision layer when `CLAUDE.md` was restructured. Source commits:
`823e614` (transitive cascade + recovery notices), `7a94e23` (stream notice + `NativeHandler`
status propagation), `30a974f`, `a84f509` (auto-arm TTL), `65e1822`/`d211972`
(`CLAUDISH_FAILOVER_ROLE_MODELS`), `6bd6f7a` (fail-forward), `b8e47ba`/`ffb7f39` (reset-time),
`ca97e58` (`CLAUDISH_GLM_THINKING`).

## Transitive cascade of degradations (2026-08-12)

A role's failover is an **ordered list of substitute steps**, not a single target. When the nominal
walls, serve step 0; when step 0 *also* walls, serve step 1; and so on. Opus to GLM today is not a
special route — it is Opus to Qwen where Qwen is also dead, so the walk falls to Qwen's own successor
GLM. The last step (typically PAYG) is always served when everything above is down, because PAYG has
no weekly wall.

**GLM is a rolling ~5h window** — it dies AND restarts every 5h, not a consumable pool like the Qwen
weekly quota; DeepSeek PAYG fills GLM's holes. Modeling the cascade as a walk means the expected
end-of-week state (GLM down 3-4h, PAYG holding everyone for ~1h until the GLM reset) needs no new
routing: each step simply walls in sequence.

## Pin the PAYG step to a rolling alias, not a versioned id (2026-09-10)

A versioned id pinned in a cascade never updates itself: a new provider build arrives and the step
keeps serving the old one until an operator edits the env and recreates. DeepSeek PAYG exposes
`deepseek-flash` as a **rolling alias** alongside versioned ids — and its `/models` listing is
incomplete: versioned ids it does not list still serve (probe before trusting either direction).
Pinning the final PAYG step to the alias (`ds@deepseek-flash`, hub po-2025 since 2026-09-10) adopts
each new Flash release **the moment the provider rolls the alias**, no nudge. Trade-off: an alias
roll is unreviewed — after any provider release, check which build the alias actually serves.
Subscription steps (`qwen-token-plan@deepseek-v4.1-flash`, hub po-2025 since 2026-09-23) stay version-pinned because plans
publish versioned builds only: those DO need the manual env-edit + drained recreate. Build selection is
evidence-based: on 2026-09-23 the HF catalog showed `DeepSeek-V4-Flash-0731` (2026-07-31) superseded by
`DeepSeek-V4.1-Flash` (2026-09-10) — the old id was replaced after an acceptance probe (`deepseek-v4.1-flash`
200 on the MaaS subscription; the dash spelling `deepseek-v4-1-flash` is 400). When probing
an id one-shot (`stream:false`), give it `max_tokens ≥ 64` — the thinking block consumes the budget
first and a low cap returns empty text, which reads like a failure but is not.

## Environment, per step

All `>`-separated fields are position-preserving against the step list.

| Variable | Meaning |
|---|---|
| `CLAUDISH_FAILOVER_<ROLE>` | Ordered cascade of substitutes, `>`-separated. Step 0 serves when the nominal walls, step 1 when step 0 also walls. No separator = single-step (backward compatible). The nominal itself is NOT in the list. Any spec `getHandlerForRequest` accepts, per step. |
| `..._LABEL` | Human name(s) for the notice. Missing/padded entries default to the step's target string. |
| `..._DIRECTION` | Per step: `degraded` (default) · `improved` · `lateral`. Unset means degraded — never flatter the substitute. |
| `..._NOTE` | Extra guidance appended to that step's notice line. |
| `..._RESET` | Operator-declared wall-lift time per step, ISO 8601 (empty entry = none). While set and in the future the step is skipped entirely — no probe — then probed the moment it passes, so recovered budget is consumed rather than stranded. For walls whose body carries no date (Mistral's subscription 402). A body-parsed date (Qwen names its reset instant, MiniMax counts down — `parseResetAtFromBody`) **wins over** the declared one. Log surface: `ttl=until <ISO>` instead of `ttl=<N>min`. |
| `CLAUDISH_FAILOVER_ROLE_MODELS` | Deployment-specific `pattern:role,pattern:role` aliases (lowercase substring match) so clients naming the nominal model directly (`glm-5.3`, `MiniMax-M3`) instead of a role keyword (`claude-sonnet-4-6`) still get cascade protection. Role keywords win when both match; unset = keywords only. Used by `roleFromModelName`, the single role-detection source shared by the swap and the cascade loop. |

### Nominal mapping and failover must not duplicate a target

The nominal itself is never a cascade step. In particular, while the active profile maps Fable directly to `cx@gpt-6-astra`, keep `CLAUDISH_FAILOVER_FABLE` empty. Putting Astra in both places would make a quota wall retry the same target, consume an extra upstream round trip, and emit a misleading fallback notice.

The future Fable cutover is atomic: remove the direct Astra mapping so native `claude-fable-5-1` becomes nominal, and set Astra as Fable step 0 in the same configuration change. Native Anthropic Fable remains restricted to ai-01 by the fleet leak policy.

⚠ **Compose passes these one by one.** `_RESET` was missing from the passthrough until `ffb7f39`,
so only the body-parsed path (Qwen) worked; Mistral's silent 402 fell back to a 10-60 min backoff and
was re-probed in a loop instead of being held until its real reset date. Verify with
`docker exec <container> printenv CLAUDISH_FAILOVER_SONNET_RESET`.

## Resolution and the cascade loop

**Resolution is a single source of truth.** `resolveFailoverTarget(role)` walks the rule's steps,
skipping TTL-failed ones, returning the first live step (or the last step anyway, since PAYG is meant
to always work). It is the ONLY resolution path — used by BOTH the swap in `getHandlerForRequest`
AND the `handleWithCascade` loop. The loop never passes an override target in: it mutates failover
state (`armFailover` / `markStepFailed`), and the next iteration re-reads through the same resolver.

**`handleWithCascade`** (`proxy-server.ts`, on both `/v1/messages` and `/v1/chat/completions`)
replaces the old single-shot retry with a bounded loop: nominal, then step 0, then step 1, and so on,
capped at `steps.length + 1` attempts.

- On `response.ok`: nominal success resets all step failures for the role (fresh episode); step
  success resets just that step.
- On `!ok` plus `isQuotaExhaustion`: a nominal wall arms the role; a step wall marks that step failed.
- Non-quota errors: wiring (401/404) returns as-is without advancing; any OTHER non-quota error on an
  INTERMEDIATE step fail-forwards to the next step (`STEP-ADVANCE`) and marks the step
  `nonQuota` — which **forfeits the dwell of any session pinned there** (#276, see below)
  instead of re-pinning the session at the successor.

**Per-session dwell, in brief.** With a session key (`metadata.user_id`), `resolveFailoverTargetForSession`
pins a conversation to its resolved step for `CLAUDISH_FAILOVER_SESSION_DWELL_MS` (default 10 min,
sliding — renewed by activity, never pins the nominal): the pin HOLDS while the step is servable, even
through role-level disarm/re-arm churn; it YIELDS on genuine advancement (re-pins at the new step) and
on verified nominal recovery past `CLAUDISH_FAILOVER_RECOVERY_GRACE_MS` (#294 — `onNominalSuccess`
stamp, no re-pin back to the nominal). **#276 carve-out:** when the pinned step died of a NON-quota
error, the yield does NOT re-pin — the dwell is forfeited for one dwell window (a tombstone covering
the same request's sibling resolution), so the session rejoins the general resolution each request and
returns to the nominal as soon as its bucket wall expires. Measured driver (2026-09-28): a pinned
session rode the PAYG tail for hours past a healthy 47%-credit nominal because the re-pinned pin was
the only thing outliving the 10-min wall. Markers: `DWELL … yielded — nominal recovered Ns ago`
(#294) · `DWELL … yielded — step N (…) died non-quota; dwell forfeited, re-resolving unpinned` (#276).

Bounded, no `while(true)`, never hangs. The **c-reuse invariant** is load-bearing: handlers must not
mutate the Hono `Context` before returning a non-ok `Response`, so re-calling `handler.handle(c, body)`
across iterations is safe.

## Per-step backoff (cascade TTL)

Each step tracks its own failure count plus last-failure timestamp in
`stepFailures: Map<role, StepFailure[]>`. `stepTtlMs(count)` indexes
`BACKOFF_MS = [10m, 30m, 1h, 4h, 24h]` (caps at 24h). A TTL-failed step is skipped by
`resolveFailoverTarget` until its TTL elapses.

**Reset-time dominance.** The backoff assumes the wall's duration is unknown. When it IS known —
body-parsed, or declared via `..._RESET` — `StepFailure.resetAt` holds the step skipped until that
instant, overriding the backoff entirely (a 24h-capped re-probe cycle against an 11-day wall is pure
waste). The moment the reset passes, the step becomes probeable again, so a recovered budget is
consumed rather than stranded behind its own backoff. Success on the step, or nominal recovery,
clears `resetAt` with the rest of the failure state.

**Critical invariant: `stepFailures` survives the role-arm TTL cycle.** The role-level auto-arm TTL
(10 min) re-probes the nominal on expiry — but it must NOT re-probe a TTL-failed step. Without this,
the 10-min nominal re-probe would re-probe a weekly-walled Qwen every 10 minutes, defeating the
backoff that caps it at ~6 probes over 6 days. The schedule fits both failure shapes: Qwen's weekly
wall is probed a handful of times then left alone; GLM's 10m+30m+1h+4h is about 5h30, which naturally
lands a probe shortly after its 5h window resets. `stepFailures` IS cleared (whole role) when the
**nominal** recovers — a healthy nominal means a fresh episode.

## The three notice moments

Notices are centralized in `applyFailoverNotices` (`proxy-server.ts`), covering `ComposedHandler`
AND `NativeHandler` — moving them out of `composed-handler` closed the gap where Opus-on-native
recovered silently.

1. **Condensation** (`appendFailoverNoticeToMessage`, non-streaming / `/compact` path). Appended to
   the collected message. That boundary is chosen because it is the only moment in an agentic session
   where the context is rebuilt from scratch anyway — the notice costs nothing there, is guaranteed to
   survive into the continuing context, and the prompt cache is already cold so re-routing is free.
   Targets the **trailing** text block (clients may read `content[0]`) and **never throws**: a thrown
   error would turn a working condensation into a failed one, and a session that cannot condense
   eventually stalls. Fires at every condensation while a role is armed, naming the
   **currently-resolved step** with depth ("the 2nd fallback") plus which prior steps are exhausted.

2. **Moment of failover** (`consumeStreamNotice` plus `prependNoticeToAnthropicStream`, streaming
   path). The FIRST streamed response a session receives under an active role failover gets a notice
   prepended as content block 0, with every real block's `index` shifted by `+1`. The substitute model
   then reads its own prior turn — starting with this notice — on the next turn's history.
   **Depth-aware re-notify:** `notifiedSessions` is `Map<role, Map<sessionKey, stepIndex>>`, so when the
   resolved step changes mid-session the notice fires *again* naming the new depth — one notice per
   resolved step per session. Never-throws: any stream parse anomaly degrades to passthrough; the
   worst case is a missing notice, never a broken stream. Zero bytes on non-failover traffic. Tests:
   `handlers/shared/failover-stream-notice.test.ts`.

3. **Recovery** (`buildFailoverNotice` / `buildStreamRecoveryText`, same two channels). When a role
   returns to nominal, a symmetric notice fires. Detection is the auto-arm TTL probe (no background
   timer): when the 10-min TTL expires, the next request probes nominal; on success,
   `onNominalSuccess` seeds a `recovering` state (`RECOVERY_CONDENSATIONS=3`) carrying the step it WAS
   serving. Re-arming a role clears stale recovery — we are back in failover, and a stale recovery
   notice would mislead. Config-arms do not self-probe, so their recovery is the operator lifting them.

The three compose: one stream notice at the moment of failover (per resolved step), then one at each
condensation for the rest of the window, then recovery notices when nominal returns.

### ✅ Resolved defect (2026-08-23, issue #34 / PR #36) — the recovery notice read as a prompt injection

Until 2026-08-23, recovery from a `degraded` step emitted, under the header
`**[claudish] Nominal model restored.**`, in content block 0:

> ~~The context you inherit was built under a weaker model (LABEL) — recalibrate upward: resume your
> normal capability and risk appetite, and clean up any over-conservative decisions made under the
> substitute.~~

A fleet agent reported this as a suspected prompt injection in its own invocation context, and was
right to: nothing in the frame lets a recipient distinguish "my proxy is talking to me" from "someone
wrote this into my context". The `[claudish]` prefix is a naming convention, not evidence. Two
specific problems:

- **"risk appetite"** named a *safety* posture, while the intent is *capability* calibration. An agent
  applying security rules must treat "resume your normal risk appetite" as suspect — and should.
- **"clean up any over-conservative decisions"** asked the agent to **undo** decisions already taken.
  That was the phrasing closest to an actual injection.

PR #36 rewrote every recovery site (condensation + stream, both directions) to working-scope
language — `resume your normal working scope: you can take on tasks you deferred under the
substitute` — with a regression guard in `failover.test.ts` asserting the notices never match
`/risk appetite/i`, `/clean up (any )?over-conservative/i`, or `/recalibrate upward/i` again. The
factual announcement (role, model, direction) is unchanged. Standing rule for any future notice
wording: keep it **factual**, express capability or working scope rather than risk posture, and
never instruct an agent to reverse prior decisions.

## `CLAUDISH_GLM_THINKING` measurements

Probed 2026-08-20 against the `gc@` Coding Plan (`glm-5.3`, prompt "Reponds exactement: ok",
`max_tokens: 500`):

| `thinking` sent | HTTP | output tokens | reasoning chars |
|---|---|---|---|
| absent | 200 | 37 | 131 — **GLM thinks by default** |
| `{"type":"enabled"}` | 200 | 41 | 148 |
| `{"type":"disabled"}` | 200 | **3** | **0** — the switch works |
| enabled plus `budget_tokens` | 200 | 35 | tolerated, **ignored** |

History this encodes: `GLMModelDialect` used to delete `thinking` unconditionally (a GLM-4.x-era
artifact), and the OpenAI `buildPayload` never emitted the field either. Net effect: GLM silently
thought by default on **every** request, the client's ask was meaningless, and no lever existed to
stop it while the Coding Plan's 5h window burned. `passthrough` preserves the effective historical
behavior; the `zai@` anthropic wire is unprobed, so only an explicit `disabled` sets the field there
(mirroring Qwen's anthropic-wire bet).

# Decision records moved from `CLAUDE.md` (2026-10-05, #23 pass 2)

Each section below is the CLAUDE.md bullet verbatim at `main@ac279833`; CLAUDE.md keeps a decision line that points here.

## Role delegation `role:<r>` (#274)

**A cascade step can delegate to another ROLE — `role:<r>` (#274), the operator's "when X maxes, become role Y" made config.** The delegation resolves to the target role's NOMINAL when its bucket is healthy, else the target's currently-resolved cascade step (shared walk state — delegated traffic joins the existing resolution instead of re-walking walled steps); e.g. `CLAUDISH_FAILOVER_OPUS=cx@gpt-6-sol>role:sonnet` serves Sol, then sonnet's nominal `gc@glm-5.3`, then whatever sonnet itself is serving when its own bucket walls. This removes the interim duplication (deployed 2026-09-28 13:41Z) where a healthy role's nominal had to be copied as step 0 of every other role's cascade — that step-0 duplication is removed from the `.env` once #274 deploys. Rules that keep it safe: the cascade lists fallbacks only (a role's own nominal NEVER appears in its cascade); the delegation graph is proven **acyclic at load** (`delegationAcyclic` — Sonnet's chain stays model-only by design, so delegations terminate there; a cycle is refused with a loud log, never a runtime loop); the **dwell pin and the notices pin/name the CONCRETE resolved step, never the role reference** (a `role:` step's `target` is refreshed at every resolution to the model actually serving it, so a pinned delegation step HOLDS while the delegation still resolves — never a provider switch back to an earlier probeable step inside the dwell; a `wasNominal` yield that did exactly that was removed in review 01/10, its flag surviving delegated successes — which reset the OWNER's coordinate, not the delegating step's — so one nominal wall unpinned every session on the step for hours); and failover bookkeeping happens on **both levels, each exactly once** — the delegating role's step records dwell/skip/notice, while the concrete model ALSO records against the owning cascade, whose coordinate is DERIVED FROM THE RESOLUTION ITSELF (`resolveDelegationOwner` — a reverse target→step lookup cannot find it: a role-step's `target` is refreshed in place, so the search returns the delegating step; measured by the coordinator's probe 29/09): a delegated qualifying wall of the target's nominal goes through the TARGET's `onNominalRefusal` (delegated traffic itself accumulates the target's arm — it never waits for direct traffic), and a delegated wall of the target's step marks THAT step's backoff. Route-level pin: `proxy-server-role-failover-route.test.ts` (S1/S2/S4, one mutation per branch). The nominal resolver is injected by proxy-server (`setRoleNominalResolver((r) => modelMap?.[r])`) — unset (tests), a role-step falls to the target's own cascade, and if the target has none the delegation is skipped (never a placeholder).

**A `role:` step's per-step backoff binds only the CONCRETE it was recorded against (#331).** `resolveSkippingFailed` used to test `isStepTtlFailed` BEFORE ever re-resolving the delegation, so the delegating step's backoff — recorded off a refusal of ONE concrete the delegation happened to serve — froze it for up to the 24 h cap even after the target role's own resolution had advanced to a healthy step. Measured on the hub (po-2025, 2026-10-04, `modelMap` absent so the delegation resolved straight into sonnet's cascade): `haiku[1]` = `role:sonnet` accumulated **408 walls at TTL 1440 min** while sonnet served healthily from its own cascade; haiku went unanswered for hours (the last-resort fallback re-served the delegation each request and every refusal re-marked the same step). The fix, per the author's decision of record: `markStepFailed` records the CONCRETE the failed attempt served (`StepFailure.concrete`, threaded from `delegation.concrete` at every proxy-side mark), and the TTL of a `role:` step binds **only while `resolveRoleStep` keeps resolving to that same concrete** — at the walk (`stepTtlBinds` in `resolveSkippingFailed` AND in the one-shot overload walk `resolveTransientStep` — the walk kept the bare test in the first cut, review 06/10 point 1), at the dwell pin's servable test, and at the last-step fallback (where a role-step frozen on its CURRENT concrete now surfaces the refusal instead of re-paying it — the anti-408 half). Non-negotiables preserved: intra-request advancement (within one request the resolution cannot move, so the same concrete stays skipped), the #274 two-level bookkeeping (untouched — reads only), a record WITHOUT a concrete binds (the pre-#331 shape — conservative; the #263 revisit re-mark now CARRIES the concrete: intra-request the delegation cannot move so the record binds identically, but a concrete-less re-mark would re-freeze the step for its whole backoff the moment the delegation advances — review 06/10 point 2), and a #261 config closure binds a role-step regardless of where the delegation points. One intersection the fix had to touch: the **#263 revisit guard was index-keyed** — a delegation that advanced mid-request re-resolved the same step INDEX on a different concrete, and the guard re-marked it WITHOUT a concrete, re-freezing it in-request (the intra-request half of the freeze, found while writing pin R1); the guard is now keyed by the concrete PAID (`triedConcretes: Map<stepIndex, Set<concrete>>`), which is the same-concrete rule the decision of record states — the #263 cascade-revisit pin holds unchanged. Seam pins T1-T6 (`failover.test.ts` §#331) + route pins R1/V1 (role-failover) and W17 (overload walk) through the real loop (hub shape: delegation resolves the target's cascade steps, s0 walls, the next attempt follows the advance to s1, the direct tail never paid).

## Per-step backoff and `_RESET` closures (#261, #275)

- **Per-step backoff `[10m, 30m, 1h, 4h, 24h]`, and a known reset time overrides it entirely.** Re-probing a 24h-capped cycle against an 11-day wall is pure waste, so `..._RESET` (or a date parsed from the body — Qwen names its reset, MiniMax counts down) holds the step skipped until that instant, then makes it probeable the moment it passes. ⚠ **A `..._RESET` in the future is a CLOSURE, on two planes (#261)**: it closes a HEALTHY step outright (never selected by the walk, never the last-step fallback — "PAYG always serves" yields to an explicit closure, and a dwell pin on the step yields), and `initFailover` logs one `[Failover] CLOSED <role>[<i>] … until <date>` marker per closed step at startup so the gesture is visibly biting. A step that HAS failed is governed by its failure record's own date instead — body-parsed wins over the config value at mark time ("the live body knew better"); the two planes trade places only across a restart, whose state wipe leaves every step healthy (which is exactly why the closure is evaluated on the config plane — measured 2026-09-25 on the hub: a `_RESET` deployed by drained recreate on healthy Qwen steps served **865 responses** over the weekend because the config date only ever extended the backoff of already-walled steps). **`stepFailures` survives the bucket-wall TTL cycle**: without that, the 10-min nominal re-probe would re-probe a weekly-walled step every 10 minutes, defeating the backoff. It is cleared for the role when the nominal recovers AND no wall remains anywhere (probe-storm guard, #275): while a sibling bucket is still walled the early reset is withheld — a long-lived wall (a Kimi weekly, 7 days) holds it off, but the steps still expire on their own ladder, so it is only a loss of *early* reset, never a leak.

## Session dwell and verified-recovery yield (#91, #294)

- **A session keeps its resolved step for a minimum dwell** (`CLAUDISH_FAILOVER_SESSION_DWELL_MS`, default 10 min, `0` = off) — the role-level dampers bound how often switches *happen*; the dwell bounds how often *one conversation* rides them. `resolveFailoverTargetForSession` (the routing seam for `getHandlerForRequest` and the cascade loop) pins a session to its step: the pin **holds** while the step is servable, even as the role-level state churns (disarm→nominal probe→re-arm — that oscillation moves traffic only *between* conversations), and **yields** on genuine advancement (the pinned step itself TTL-failed). The dwell is *sliding*: an active session renews it every request; an idle session's pin lapses after the window. Nominal is never pinned — pinning it would feed a session back into the wall its own refusal just armed (#91 point 4). The pin **also yields on VERIFIED nominal recovery**: the **FIRST** nominal request served since the last arm (`onNominalSuccess` stamps only on first success AND only when no wall is live — a busy nominal must not keep pushing the stamp forward, or the grace would measure since the LAST success and a nominal serving anyone every <grace would hold every pin forever; and an in-flight success landing under a live wall proves nothing about the meter — its stamp would age unseen and mass-un-pin at the wall's TTL expiry; both coordinator probes P1/P3, 01/10), held for `CLAUDISH_FAILOVER_RECOVERY_GRACE_MS` (default 2 min, `0` = yield immediately) — without this exit an active conversation rode its fallback until it *ended*, measured 2026-10-01 on a MiniMax wall: new sessions returned to the nominal within ~2 min of the lift while pinned cron conversations were still ~70% on the Kimi fallback 20 min later. The grace bounds an intermittent wall's isolated success to one switch per arm cycle, a re-arm voids the marker (the pin re-holds), a config-armed role never stamps (always active), and the marker is keyed role|bucket so a sibling bucket's recovery cannot un-pin sessions whose own nominal is still walled (the mixed state of 2026-09-28: role-keyed, every request of the still-walled bucket would yield→re-resolve→re-pin with two log lines each). A delegated success stamps the OWNER's role|bucket — a real success in that bucket, wherever the request came from. `[Failover] DWELL <role> session …<id> yielded — nominal recovered Ns ago` is the countable marker.

## Non-quota death forfeits the dwell (#276)

- **A NON-quota death of the pinned step forfeits the dwell instead of re-pinning the successor (#276).** `markStepFailed(..., { nonQuota: true })` — set only at the proxy's STEP-ADVANCE site, so quota marks and unmarked records keep the ordinary advancement/re-pin — makes a live pin on that step yield with **no re-pin**, under a one-dwell-window **tombstone** that also covers the sibling resolution of the same cascade attempt (the loop resolves twice per attempt, swap + loop read; without the tombstone the second resolution re-pins the deeper step in-request and the fix is erased). The walk itself still fail-forwards within the request — what changes is that the session rejoins the general resolution on every subsequent request, so it returns to the nominal the moment its bucket wall expires. Measured driver (2026-09-28, hub po-2025): armed 11:05Z, a session dwell-pinned to step 2 received the wrapped content-filter false positive `HTTP 400 {"code":"InvalidParameter", … "data_inspection_failed"}` at 12:31Z, the advance re-pinned it at the PAYG tail and the renewed dwell held it there for **hours** while the nominal sat healthy at 47% — the re-pinned pin was the only thing outliving the 10-min bucket wall, and with every active session pinned the nominal was never probed, so no #294 recovery stamp ever landed either. A resolution landing on the nominal clears the tombstone (forfeit served); after one dwell window, ordinary dwell resumes. `[Failover] DWELL <role> session …<id> yielded — step N (label) died non-quota; dwell forfeited, re-resolving unpinned` is the countable marker (the step-level verb distinguishes too: `failed (non-quota)` vs `walled`). Route pins + 3 mutations (predicate / tombstone / quota-scope): `proxy-server-nonquota-unpin-route.test.ts`; seam pins incl. the bounded forfeit: `failover.test.ts` (#276 describe).

## One-shot overload walk (#299-B)

- **A nominal's transient OVERLOAD walks the cascade once, writing no failure state (#299-B).** A 529 on the nominal — or a 429/503 the patient backoff already exhausted into a 529, or a `400 connection_error` (the proxy's own synthesis of a transport failure, #298 A; clause carried from #302) — (`isOverloadWalkClass`, `composed-handler.ts`; deliberately NOT folded into `isTransientOverload`, which also gates the ~5-min patient backoff and would delay every overloaded turn by minutes) — is the PROVIDER saying "unreachable/overloaded", not the role's plan being walled: before this, the refusal reached the client verbatim and a cron conversation retried a dozen times against the same refusing provider, then dropped (measured 2026-10-02: MiniMax-M3, the haiku nominal, ~30 % of attempts 529). `handleWithCascade` now tries the **FIRST SERVABLE** cascade step ONCE for that request only — `resolveTransientStep` (`failover.ts`, the #302 idea) picks it read-only, skipping TTL-failed steps (per-step backoff), steps in walled buckets (a weekly wall on step 0 must not turn every 529 into a round-trip at a target we know is dead) and role-steps whose delegation cannot resolve concrete (so a ROLE NAME can never reach the wire as a model id); null ⇒ no servable step ⇒ surface the original rather than substitute blind — the attempt goes through `getHandlerForRequest(..., forceTarget)` (bypasses the modelMap and the 2a swap, so the walk neither re-resolves the nominal nor writes the dwell pin) and changes NO failure state: **no arm, no stepFailures mark, no bucket wall, no dwell pin** (no *failure* state — a served attempt still mirrors the loop's *success* bookkeeping, `resetStepSuccess` + owner-side `onNominalSuccess`, which a wall never feeds; review of #326) — the #170 re-forward's separation (`no markFail`). The **native lane is excluded** (`anthropic-native/*` buckets): its meter is the client's own Anthropic credential, and serving the turn from a non-Claude step without a notice would contradict "every substitution is announced" on the one model the client picked deliberately, while Claude Code already retries its 529s itself. A step that also fails (or throws — a step with no credential makes routing throw, and the catch is what keeps the turn retryable: without it the client gets a terminal 400 instead of the 529) surfaces the ORIGINAL overload — never the step's own incident — after draining the dead walk response's body (`cancel()`, so no upstream connection hangs on it); bounded by construction to one attempt. `[Failover] WALK <role> one-shot (HTTP <status> on nominal <model>) → <concrete> (step N)` is the countable marker (`log(..., true)` → stdout, not `logStderr` — a test capturing only stderr is blind to it). Kill switch `CLAUDISH_FAILOVER_OVERLOAD_WALK=0`, read per request (a container needs the name in compose, #304; `docker-compose.yml` carries it). Route pins W1-W4, W7-W14 + predicate pins P1-P6; mutations (remove the walk / let it arm / drop the kill switch / shrink the predicate to 529-only / drop the native exclusion / walk `steps[0]` instead of first-servable / drop the walled-bucket skip / drop the step arg at the TTL check — the #261 rebase hazard, an optional param that compiles either way / rethrow in the walk's catch): `proxy-server-overload-walk-route.test.ts`.

## Failover targets on sidecars; armed state by value

- **A failover target must resolve on the machine that calls the models.** Pointing a sidecar at a custom endpoint defined only in the hub's `config.json` configures a fallback that fails exactly when it is needed. The hub is the normal home — but **"only in AUTONOMOUS mode" is not the same as "rarely"**. ⚠ **The ai-01 sidecar is NOT armed — and a count that says otherwise is counting names.** `docker inspect` shows **23 `CLAUDISH_FAILOVER_*` present and 0 non-empty** (re-measured 2026-09-19). Compose injects all 23 with a `${VAR:-}` default, so **they exist whether or not anything is armed**: `grep -c '^CLAUDISH_FAILOVER_'` on a container's env returns 23 on every machine and can never answer the question. A 2026-09-18 edit here claimed "it is armed now — 23 in the live container" on exactly that miscount; it is **withdrawn**. What refuted it is `install-sidecar.ps1 -RebuildEnvFromContainer` (#141), whose `Get-ArmedCascadeCount` requires `=.+` and reported **0 armed recovered** from the same container. **Count armed state by value — `grep -cE '^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+'` — never by name.** Measured on the ai-01 sidecar over the 5 days to 2026-08-25: **124 requests served locally, 70 completed, 54 failed — every one of them the same `HTTP 429 [GLM Coding]`**, ~62s each walking the full retry ladder against a plan wall with nowhere to fall to. ⚠ That window is the **worst** one, not the norm, and it must not be quoted as a current loss rate: ai-01 re-counted by file on 2026-09-02 (623 req / 539 resp = 84 unanswered at most, which refuted its own finer-grained 132) and found the deficit concentrated on 20-25/08 — **28-30/08 and 02/09 show a deficit of zero, and the sidecar logged no 429 or 402 at all in the preceding 12h**. The benefit of arming is real but episodic, contingent on a wall being up at that moment. AUTONOMOUS is rare *and* it is exactly when the hub cannot help, so an unconfigured cascade there costs whole agent turns — one of the captures is four consecutive `msgs=2` startup attempts over four minutes, an agent that never booted. **Arm the cascade on sidecars too.** Note that arming is not enough on its own: `roleFromModelName()` matches only `opus|sonnet|haiku|fable`, so a client naming a bare provider id (`glm-5.2`) resolves to `null` and the cascade stays blind — either set `CLAUDISH_FAILOVER_ROLE_MODELS`, or have clients name roles neutrally.
