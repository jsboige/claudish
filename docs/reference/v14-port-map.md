# Port map v14 ← main — every gap-list entry, its reference PR, its real cost (Epic #641)

**Hand-maintained, but every row is re-checkable: the commands are in §Re-check.**

The gap list in `proxy-server.ts` is accurate about the *state of the code on this base*
and deliberately silent about *whether main already solved it*. That silence is the trap:
a triage that reads the list alone concludes "to design" and mis-prices the grain. All
nine entries below were delivered on `main`; eight have a reference PR, one does not.

Base measured: `replatform/v14` = `d06f3659` (#829 merged), `main` = `47ea6245`.

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
| 1 | `#565` context-admission census | PR **#573** (`a774f817`), follow-up PR **#610** (`8bb52c70`) | +497/−7, 9 · +182/−57, 6 | module absent; `CLAUDISH_CONTEXT_ADMISSION` = **0 occurrence**; admission call at both ingresses + the #79 recoverable turn | M |
| 2 | `#654` endpoint token budget | PR **#663** (`7784f65e`) | +1656/−251, 9 | **Ported** (module verbatim part 1; loop + walk sites and the B1-B7 route pins in the overload-walk suite part 2). The rest of #663's file list is **main-only surface**: `docker-compose.yml`/`.env.sidecar.example`/`compose-env-coverage.test.ts` landed on main at `9d7048fb`+, after the fork point (`980ea089`), and `7784f65e` is already an ancestor of `origin/main` — recreating them here is an add/add conflict at the v14→main landing, so they stay un-ported by design. The #431 busy wire it rides already existed (#815) | ~~L~~ done |
| 3 | `#218` native-lane version pin | PR **#218** (`43bb3f32`) + PR **#259** (`be19bed0`, closes #219) | +125/−1, 3 · +546/−1, 4 | `resolveNativeModelPin` = **0 occurrence**; `providers/native-pin-auto.ts` absent. The resolution site is v14's own seam (`serveModel`), not main's | S/M |
| 4 | `#693` machine-scoped resolution arm | PR **#694** (`a5bd319c`) | +605/−19, 9 | `resolveFailoverTargetForSession` takes **no machine argument** — the signature and every caller change; plus parse, load-time refusal, docs | M |
| 5 | `#769` unroutable-step skip | PR **#789** (`7b9c9d11`) | +319/−48, 4 | `handlers/shared/step-skip.ts` **exists already**, `unroutable` included in its reason vocabulary; missing are the two `proxy-server.ts` **construction** sites — the loop's (`getHandlerForRequest(serveModel)`) and the walk's (`catch {}` that swallowed the throw). There is no route-level entry resolution to guard here: `logRequest` lives inside the loop | S/M |
| 6 | `#598` connection-class advance past a dead walk step | PR **#628** (`3c0e3a0a`) | +290/−44, 4 | `resolveTransientStep`/`resolveSkippingFailed` exist (11 hits in `fork/failover.ts`); `isConnectionWalkClass` ported with #820. Missing: the advance inside the walk block | S |
| 7a | `#431` handler-side emitter — image cap | PR **#581** (`b3a5a7b2`, closes #575) | +468/−20, 10 | **Ported** (module byte-faithful except two non-interpolating template fragments double-quoted for this branch's biome; emitter + `getRecoveryHint` branch in `composed-handler.ts`; K25/K26 relocated into the overload-walk suite, which is where the cascade loop is pinned on this branch — the loop's marker reads `STEP-SKIP` here, not `SKIP`). Two v14 adaptations, noted in-file: `countMediaBlocks` lives in `media-cap.ts` (no `context-overflow.ts` estimator to share a walk with; at the landing take main's `media-cap.ts` and import the count from `context-overflow.ts`), and the emitter counts `claudeRequest`, not the adapter-built wire payload (the Anthropic `source.data` image spelling). Mutations 3/3 killed (m-media-1, m-media-2, mC anchor) | ~~M~~ done |
| 7b | `#431` handler-side emitter — concurrency refusal | PR **#684** (`d78fea09`, closes #679) | +434/−24, 8 | Same protocol gap, its own emitter: a z.ai 1302 concurrency refusal becomes a busy skip instead of a bench | M |
| 7c | `#431` handler-side emitter — admission refusal | PR **#573**, already **row 1** | see row 1 | **Not a separate grain.** Verified by file list: #581 and #684 touch `handlers/shared/step-skip.ts`; #573 touches `handlers/shared/context-admission.ts` and touches the step-skip route test only as a route. The gap list counts the #565 admission work a second time here | — |
| 8 | drain-freeze gate | PR **#314** (`5e3e4269`, issue #306) | +735/−2, 8 | `drainFreezeGate()` = **0 real occurrence** (only the comment naming its absence); main has 3 call sites in `proxy-server.ts` + its own test file | M |
| 9 | billing-strip family | **no PR** — `fork/middleware/billing-header-strip.ts` (27 lines), moved by `985643d0` | — | file absent from v14's fork layer. The real work is not the 27 lines but the call sites before each serve | S |

The gap list writes the `#431` emitters as one family. It is **two** grains, not three:
7a and 7b are separate emitters, and the third number it cites (`#573`, #565) is row 1
restated. A scheduler that budgeted three emitter grains would buy one of them twice.

## Supporting measurement — the fork layer

`replatform/v14` carries 22 files under `packages/cli/src/fork/`, `main` carries 27.
Six are missing on v14, one exists only on v14:

```
fork/config/profile-extensions.ts
fork/failover.test.ts                 ← a missing PIN, not a missing feature
fork/index.ts
fork/middleware/billing-header-strip.ts
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

## Why this file exists

On 2026-11-03 this lane published a triage calling #769 "the nearest design work". It
read the gap list without checking whether main had already closed the issue. #769 had
been delivered on 31/10 by PR #789. The lesson, written here as an instrument: **the
gap list is a statement about this branch, never a statement about the fleet.**

⚠ This document describes the divergence; `docs/reference/replatform-v14-layer-manifest.md`
describes the fork layer's contents. They are sisters — read both before pricing a port.
