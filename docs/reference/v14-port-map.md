# Port map v14 ← main — every gap-list entry, its reference PR, its real cost (Epic #641)

**Hand-maintained, but every row is re-checkable: the commands are in §Re-check.**

The gap list in `proxy-server.ts` is accurate about the *state of the code on this base*
and deliberately silent about *whether main already solved it*. That silence is the trap:
a triage that reads the list alone concludes "to design" and mis-prices the grain. All
nine entries below were delivered on `main`; eight have a reference PR, one does not.

Base measured: `replatform/v14` = `09f8e03b` (#865 merged), `main` = `ef841d18` (#871 merged).
Done rows: 9 of 9 (2, 4, 5, 6, 7a/7b, 8, 9, 3 via PR #889, 4 via merged PR #896, and 1 —
this PR, review pending at write time).
Row 7c is not a grain (verified: row 1 restated).

## Two traps this map exists to kill

1. **The list mixes PR numbers and issue numbers, in the same sentence.** `#218` is a
   **PR** (merged 2026-09-22, `43bb3f32`). `#565`, `#598`, `#654`, `#693`, `#769` and
   `#306` are **issues**, each closed by a differently-numbered PR. So "port #769" means
   "port PR #789", never "look for PR #769".
2. **An entry with no PR is not automatically new design.** The billing-strip family has
   no PR because it was never a PR: `stripBillingHeaderFromBody` lives in main's fork layer
   and was moved there by a refactor (`985643d0`). The code exists and ports
   byte-for-byte. Check the file on main before pricing a design.

## The map

| # | gap-list entry (v14) | reference on `main` | +A/−D, files | what is really missing on v14 | size |
|---|---|---|---|---|---|
| 1 | `#565` context-admission census | PR **#573** (`a774f817`), follow-up PR **#610** (`8bb52c70`) | +497/−7, 9 · +182/−57, 6 | **Ported** (this PR): the module half (`handlers/shared/context-overflow.ts` — census, refusal text, kill switch, recovery-turn constructors, the media-aware estimator), the declared-limit registry on `runtime-providers.ts` fed at `registerEndpoint` (the chokepoint both loader paths cross), the `contextLimit` schema field (simple AND complex), and the census call inside `handleWithCascade`, before the loop — both ingresses covered by construction (they funnel through the same loop) and run for real. **Smaller than main by design**: `countMediaBlocks` stays in `media-cap.ts` (the two walks unify at the 7a landing, per that row's note), the #651 derived-limit twin and the #660 loader surfaces are later rows, and `overflowRecoveryText`/`classifyContextOverflow`/the learned cap ride with the #79 step-skip-producers row. Tests: unit suite ported 1:1 (`context-admission.test.ts`, 12 pins incl. the LOAD-BEARING `isQuotaExhaustion` wording) + a 7-pin route suite on the G6/G8 harness (A1/A1b/A1c = both ingresses refuse with zero upstream calls, A2 undeclared nominal stands down, A5 undeclared STEP stands down — new vs main's K-series, it is what kills a dropped-steps mutation — A3 largest-window, A4 kill switch). Mutations 3/3 killed (census block removed ⇒ A1/A1b/A1c; steps never collected ⇒ A5; registry never fed ⇒ A1/A1b/A1c) | ~~M~~ done |
| 2 | `#654` endpoint token budget | PR **#663** (`7784f65e`) | +1656/−251, 9 | **Ported** (module verbatim part 1; loop + walk sites and the B1-B7 route pins in the overload-walk suite part 2). The rest of #663's file list is **main-only surface**: `docker-compose.yml`/`.env.sidecar.example`/`compose-env-coverage.test.ts` landed on main at `9d7048fb`+, after the fork point (`980ea089`), and `7784f65e` is already an ancestor of `origin/main` — recreating them here is an add/add conflict at the v14→main landing, so they stay un-ported by design. The #431 busy wire it rides already existed (#815) | ~~L~~ done |
| 3 | `#218` native-lane version pin | PR **#218** (`43bb3f32`) + PR **#259** (`be19bed0`, closes #219) | +125/−1, 3 · +546/−1, 4 | **Ported** (PR **#889**): both call sites — the cascade loop and `count_tokens`' native branch — plus `providers/native-pin-auto.ts` and the #219 watch wired in `fork/server/standalone-proxy.ts`. Three v14 adaptations, each noted in-file: no `fable` slot in `modelMap` (`subagent` is not a request keyword, so neither can pin), the catalog is read through this base's `catalog-client.ts` rather than main's `model-catalog-resolver.ts`, and the aggregator row spells `sourceProviderId`/`externalModelId` while opt-in rows arrive in `optInConnections`. The `instanceof NativeHandler` test runs on `resolvedHandler`, not the advisor/hooks wrapper | ~~S/M~~ done |
| 4 | `#693` machine-scoped resolution arm | PR **#694** (`a5bd319c`) | +605/−19, 9 | **Ported** (PR **#896**): the whole module half — `stepExclusions` + `excludedStepsForMachine`/`mergeSkips`, the parse with both load-time refusals, the dwell-pin yield, the last-step refusal and the #299-B walk guard. **Smaller than main by design**: this base resolves failover at the CASCADE LOOP, never inside `getHandlerForRequest` (single-arg is a stated invariant here) and `count_tokens` has no cascade, so `machine` threads into three resolution calls and nothing else — main's `getHandlerForRequest` parameter and its three route call sites have no home. Two main-only surfaces stay un-ported, named rather than recreated: `docker-compose.yml`/`.env.sidecar.example` (no compose tree — row 2's add/add trap) and `client-attribution.ts`'s `?? "1"`→`\|\| "1"` (file and `CLAUDISH_CLIENT_ATTRIBUTION` absent, 0 hits). Tests: `fork/failover.test.ts` is absent on this base, so the #693 section lands as a focused 7-pin suite (main's 7 cases, 1:1); the route suite ports X1-X3 with **X3 adapted** — `count_tokens` resolves no role here, so it pins the serving route's machine-scoped dwell pin plus a machine-blind control instead of main's counting path. Mutations 6/6 killed (M5 reproduces main's X1/X3-red signature) | ~~M~~ done |
| 5 | `#769` unroutable-step skip | PR **#789** (`7b9c9d11`) | +319/−48, 4 | **Ported** (PR **#839**, `7bbda62b`): both `proxy-server.ts` construction sites — the loop's (`getHandlerForRequest(serveModel)`) and the walk's swallowed throw — now carry the `unroutable` skip; `handlers/shared/step-skip.ts` already had the reason in its vocabulary. There is no route-level entry resolution to guard here. | ~~S/M~~ done |
| 6 | `#598` connection-class advance past a dead walk step | PR **#628** (`3c0e3a0a`) | +290/−44, 4 | **Ported** (PR **#845**, `e3d959be`): the advance inside the walk block — a walk step dying connection-class advances once instead of surfacing. `resolveTransientStep`/`resolveSkippingFailed` and `isConnectionWalkClass` were already on this base (#820). | ~~S~~ done |
| 7a | `#431` handler-side emitter — image cap | PR **#581** (`b3a5a7b2`, closes #575) | +468/−20, 10 | **Ported** (PR **#856**; module byte-faithful except two non-interpolating template fragments double-quoted for this branch's biome; emitter + `getRecoveryHint` branch in `composed-handler.ts`; K25/K26 relocated into the overload-walk suite, which is where the cascade loop is pinned on this branch — the loop's marker reads `STEP-SKIP` here, not `SKIP`). Two v14 adaptations, noted in-file: `countMediaBlocks` lives in `media-cap.ts` (no `context-overflow.ts` estimator to share a walk with; at the landing take main's `media-cap.ts` and import the count from `context-overflow.ts`), and the emitter counts `claudeRequest`, not the adapter-built wire payload (the Anthropic `source.data` image spelling). Mutations 3/3 killed (m-media-1, m-media-2, mC anchor) | ~~M~~ done |
| 7b | `#431` handler-side emitter — concurrency refusal | PR **#684** (`d78fea09`, closes #679) | +434/−24, 8 | **Ported** (PR **#869**, rebuilt on `398e2406` after #856's squash-merge replaced the commit it was stacked on; #865 (row 8) is a separate PR over the same files). Classifier byte-faithful; the v14 adaptation: NO 529 (this base keeps the upstream 429 per its own non-ok doctrine), the emitter annotates both non-ok envelope shapes, and the transport 429 ladders exit on 1302 reusing the text they already read. Deliberately NOT ported: `isConcurrencyRefusalResponse` + `quota-wall.ts`'s bounded read (no unread-Response consumer here) and the `markStepSkipEligible` WeakSet (main uses it only to bypass the patient overload backoff, which v14 does not have). ⚠ **Future dependency**: when the patient overload backoff (main's 2026-06-25 `patientOverloadBackoff`, the #302/#679 family) ports to v14, `markStepSkipEligible`/`isStepSkipEligible` MUST come with it — without the WeakSet gate, a z.ai 1302 concurrency refusal on an intermediate step burns the whole ~5-minute patient spread before the busy skip fires, the exact regression main's #679 gate closed (measured on main: a concurrency-worded 1302 on a step paid the full spread and THEN benched the step anyway) | ~~M~~ done |
| 7c | `#431` handler-side emitter — admission refusal | PR **#573**, already **row 1** | see row 1 | **Not a separate grain.** Verified by file list: #581 and #684 touch `handlers/shared/step-skip.ts`; #573 touches `handlers/shared/context-admission.ts` and touches the step-skip route test only as a route. The gap list counts the #565 admission work a second time here | — |
| 8 | drain-freeze gate | PR **#314** (`5e3e4269`, issue #306) | +735/−2, 8 | **Ported** (`feat/v14-306-drain-freeze` off `5af7616a`): module verbatim, `/health` field + the three admission gates (messages, count_tokens, chat/completions) and the route suite (9 pins / 4 mutations). The **hub half of #318 is carried**: the gate marks its 503 `x-claudish-drain-freeze: 1`, the marker this base's `fork/server/relay.ts` `drainFreeze503` check already consumes — without it, a frozen hub reads as a hub death (markFail + local replay, sidecars flap AUTONOMOUS). The **writing** half — `claudish-drain.ps1`, `claudish-engine.psm1` and their Pester suites — is main-only surface: this base has no `scripts/` tree, so recreating it is row 2's add/add trap. Ported contract = whatever poses the flag, the proxy honours it | ~~M~~ done |
| 9 | billing-strip family | **no PR** — `fork/middleware/billing-header-strip.ts` (27 lines), moved by `985643d0` | — | **Ported** (PR **#885**): module faithful to main's blob (`d17cdcf3…`) except the two `.replace()` calls collapsed to single lines for this branch's biome (behaviour identical; formatted sha `f45ebcc9…`); ONE call site for main's two — main strips at `/v1/messages` `:3198` and `/v1/chat/completions` `:3350` before `handleWithCascade`, on v14 both ingresses funnel through the cascade loop, so the strip sits in the attempt-0 block next to the notice strip (#747b), on `resolvedHandler instanceof NativeHandler` (the unwrapped handler — the wrapper hides `instanceof`). Attempt 0 only; later attempts reuse the same once-parsed object, exactly as main's single route-level pass leaves its cascade's next steps. **Measured honesty**: `transform.ts`'s `stripBillingHeader` already runs in step 1 of every ComposedHandler request (anthropic-format and Codex legs included) and never for NativeHandler, so upstream cleanliness is transform-guaranteed with or without this call (mutation M1: route pins stay green with the call removed) — the call is fork-seam parity + defense, and its `isNative` argument is the part that is load-bearing: NativeHandler forwards the same body object, so a wrong flag strips Anthropic's own traffic (B3, the one red pin under M2). Main carries the same redundancy (its transform strip arrived later, upstream, in the #499 sync tranche). Tests: main had **zero** for this module; v14 adds 8 unit pins (`fork/middleware/billing-header-strip.test.ts`) + 4 route pins (`proxy-server-billing-strip-route.test.ts`, B4 holds the one-parse-one-object seam claim through a cascade substitution) | ~~S~~ done |

The gap list writes the `#431` emitters as one family. It is **two** grains, not three:
7a and 7b are separate emitters, and the third number it cites (`#573`, #565) is row 1
restated. A scheduler that budgeted three emitter grains would buy one of them twice.

## Supporting measurement — the fork layer

`replatform/v14` carries 23 files under `packages/cli/src/fork/`, `main` carries 27.
Five are missing on v14, one exists only on v14:

```
fork/config/profile-extensions.ts
fork/failover.test.ts                 ← a missing PIN, not a missing feature
fork/index.ts
fork/routes/model-discovery.ts
fork/server/relay-hub-death.test.ts   ← a missing PIN, not a missing feature
(v14 only) fork/middleware/proxy-auth-before-relay.test.ts
```

The two test files matter: the v14 branch did not merely defer features, it deferred
**coverage** for features it does carry. That is invisible to the gap list, which only
enumerates absent behaviour.

## Re-check

```bash
comm -23 <(git ls-tree -r --name-only origin/main -- packages/cli/src/fork/ | sort) \
         <(git ls-tree -r --name-only replatform/v14 -- packages/cli/src/fork/ | sort)
comm -13 <(git ls-tree -r --name-only origin/main -- packages/cli/src/fork/ | sort) \
         <(git ls-tree -r --name-only replatform/v14 -- packages/cli/src/fork/ | sort)
git grep -c "endpoint-token-budget\|EndpointTokenBudget" replatform/v14 -- packages/cli/src/
git grep -c "CLAUDISH_CONTEXT_ADMISSION"                 replatform/v14 -- packages/cli/src/
git grep -c "resolveNativeModelPin"                      replatform/v14 -- packages/cli/src/
git grep -n "drainFreezeGate("                           origin/main     -- packages/cli/src/
```

Each row's reference is verifiable by SHA (`git show --shortstat <sha>`) and, for the
issue-numbered rows, by `gh api repos/jsboige/claudish/issues/<n>` (a PR returns
`pull_request`; an issue does not — that is how row 3 was settled).

## Known CI flake — do not chase it in a port PR

`hermetic · macOS` intermittently fails `team-liveness-exited-slot.test.ts:91`
(`idle_seconds >= 1`, received 0). The test sleeps a fixed 1.1 s and floors idle
to whole seconds, so one late heartbeat frame on a loaded runner drops the value
to 0. First seen on #869 (`65465b4e`), rerun-green same commit, analysis at
`issuecomment-6651130218`; seen again on later PRs. The fix, if ever wanted,
belongs in THAT TEST, never in a port diff — rerun the failed jobs and move on.

## Why this file exists

On 2026-11-03 this lane published a triage calling #769 "the nearest design work". It
read the gap list without checking whether main had already closed the issue. #769 had
been delivered on 31/10 by PR #789. The lesson, written here as an instrument: **the
gap list is a statement about this branch, never a statement about the fleet.**

⚠ This document describes the divergence; `docs/reference/replatform-v14-layer-manifest.md`
describes the fork layer's contents. They are sisters — read both before pricing a port.
