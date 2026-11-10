# v14 → main landing plan (#641)

Status: **document, not execution** (grain v45-5; refreshed 10/11 after #952/#957
landed). Written when the port map reached 9/9 (8 merged, #900 the last row —
since merged). This is the plan the coordinator executes; a worker does not run
it.

## Where things stand

- Base: `replatform/v14` (= `09f8e03b` at map-write; now `9cf299b7` — advanced
  by the 8 port-map merges, the #919 main sync, and #952/#957 below). Target:
  `main`.
- Port map 9/9 — `docs/reference/v14-port-map.md`. Rows and their landing PRs
  into `replatform/v14`:

  | row | what | PR into v14 | state |
  |---|---|---|---|
  | 1 | #565 context-admission census | **#900** | **merged 06/11** (`6a5ac674`) |
  | 2 | #654 endpoint token budget | (two parts) | merged |
  | 3 | #218 native-lane version pin | #889 | merged |
  | 4 | #693 machine-scoped arm | #896 | merged |
  | 5 | #769 unroutable-step skip | #839 | merged |
  | 6 | #598 connection-class advance | #845 | merged |
  | 7a | #431 media emitter | #856 | merged |
  | 7b | #431 concurrency-refusal emitter | #869 | merged |
  | 8 | #306 drain-freeze gate (proxy half) | #865 | merged |
  | 9 | billing-strip family | #885 | merged |

- Post-map merges into the branch: **#919** (main sync, `b18fb317` + docs #922),
  **#952** (native credential guard, `6a5ac674`), **#957** (oat Bearer shaping,
  `9cf299b7`). **Zero open PR targets replatform/v14** (checked 10/11).

## Precondition (blocking)

1. **#900 merged into replatform/v14**, CI green on the merge commit —
   **satisfied 06/11** (`6a5ac674`).
2. The #641 G4 never-hang audit (`docs/reference/v14-never-hang-audit.md`)
   reviewed — it certifies no `controller.error()` on the client plane, which is
   the constraint a landing could silently break.
3. No open PR left targeting replatform/v14 (a stacked PR would be orphaned by
   the landing) — **satisfied 10/11** (zero open).

## Landing order

The landing is **one merge of `replatform/v14` into `main`**, not nine
cherry-picks — the rows were built on the branch precisely so the landing is a
single integration. Order of operations:

1. **Sync main forward.** `git merge origin/main` into `replatform/v14` first,
   on the branch, and resolve there. The port map's add/add traps are known and
   named (below) — they are the conflict surface. Never resolve blind; read both
   sides.
2. **Re-run the v14 gates on the synced branch** (the LF-worktree recipe):
   `biome check . --diagnostic-level=error` from `packages/cli` = 0 error;
   `bun run typecheck` (includes tests); the route suites
   (`proxy-server-*-route.test.ts`, overload-walk, billing-strip, drain-freeze,
   context-admission). All green before the landing PR opens.
3. **Open the landing PR** `replatform/v14 → main`, body listing the nine rows
   and their SHAs, `Closes #641`. Full CI matrix must pass (the known
   `hermetic · macOS` `team-liveness-exited-slot` flake is rerun, never fixed in
   the diff — port-map §Known CI flake).

   Two measured blockers found by the step-1 sync (#919) — one still open, one
   resolved since; none may hold at the landing PR:

   1. **`controller.error()` in production sources** (never-hang constraint,
      #656 / G4a-2a). **Still open at `9cf299b7`** (allowlist verified 10/11 —
      all 9 sites present): **9 call sites in v14-only
      seam sources** that main never scans (line pins as measured on the sync,
      `6fcaec00`): `hooks/seam-transform.ts:760`, `hooks/raw.ts:676` and
      `:964`, `hooks/seam-tap.ts:114`,
      `handlers/shared/stream-head-sniffer.ts:132`,
      `handlers/shared/stream-parsers/upstream-cancel.ts:97`,
      `handlers/shared/call-context.ts:217`,
      `handlers/shared/devin-stream-head-sniffer.ts:163`,
      `handlers/advisor-decorator.ts:510`. The gate runs green through the
      line-pinned `V14_SEAM_SITES` allowlist in
      `prod-no-controller-error.test.ts` — **the allowlist must be emptied by
      the port: the landing PR cannot merge while one site remains.**
   2. ~~**`native-credential-guard` (×12) + `native-passthrough-strip` (×1)**
      (#296/#305/#410)~~ — **RESOLVED by #952** (`6a5ac674`: swap + #296
      refusal + #305 strip + vision sanitizer, skips re-enabled) **and #957**
      (`9cf299b7`: oat tokens leave as `authorization: Bearer`, one predicate
      at five write sites). Recorded for history: on the pre-#952 branch a
      foreign Bearer beside a valid `x-proxy-key` was served 200 where main
      refuses 403.

4. **Coordinator merges** (worker never merges).

## Blocking criteria (do not land while any holds)

- Any v14 route/mutation pin red after the main sync.
- Any new biome error vs the v14 baseline (the bar on a v14 branch is **0**, not
  main's 1306-baseline rule — the branch is lint-clean and must stay so).
- The add/add surfaces below unresolved or resolved by deletion.

## Known add/add conflict surfaces (port-map rows 2, 4, 8)

These files exist on **main only** and were deliberately NOT recreated on v14
(recreating them = add/add at the landing). At the merge, **main's version wins**
— they are main's own infra, the v14 rows only consume their contract:

- `docker-compose.yml`, `.env.sidecar.example`, `compose-env-coverage.test.ts`
  (row 2's #663 surface, landed on main at `9d7048fb`+ after the fork point).
- `scripts/claudish-drain.ps1`, `scripts/claudish-engine.psm1` + Pester suites
  (row 8's #306 writing half — v14 has no `scripts/` tree).
- `client-attribution.ts` (row 4 — file absent on v14, 0 hits).

The reverse trap (v14-only files) is `fork/middleware/proxy-auth-before-relay.test.ts`
— keep it; it is a pin main lacks.

## Known silent-deletion surface (#641 étape 5, measured 10/11)

The add/add list above is NOT the whole conflict surface. **27 files sit at the
main↔v14 merge base, were never modified by the fork, and are absent from
`replatform/v14`** — upstream restructured around them (channel → mcp-session,
middleware → hooks, TUI panels → components, catalog → catalog-client, Gemini
code-assist → antigravity). At the landing merge, git takes their deletion
**without a conflict** — a silent loss the step-1 sync must pass in review.

Per-file disposition lives on #641 (comment of 10/11, refs `3d955d64` vs
`9cf299b7`): **16 are renamed-covered** (v14 answers under a new path — accept
the deletion, the new path is cited per file), **11 need an explicit
keep-vs-drop** before the landing PR opens:

- 4 TUI panels with no v14 equivalent (`ApiKeysPanel`, `ConfigViewPanel`,
  `StatsPanel`, `TelemetryPanel`) — the fork-TUI/upstream-TUI parity family the
  Epic body leaves unarbitrated → **C5, user call**;
- `channel/diagnostics.ts` (the `CLAUDISH_CHANNEL_TRACE` instrumentation
  documented in CLAUDE.md §Channel Mode) — dropped, and deleting it silently
  leaves `mcp-session/trace-gate.test.ts` gating on a dead feature;
- 4 `channel/test-helpers/*` — follow `diagnostics.ts`'s verdict;
- 2 at-base test files whose coverage would vanish (`mcp-server.test.ts`,
  `team-timeout-repro.test.ts`) — re-add explicitly at the landing if wanted.

Five more files are fork-modified AND absent (modify/delete or rename/modify
conflicts — loud, handled in the landing PR): `middleware/gemini-thought-signature.ts`,
`providers/catalog-resolvers/openrouter.ts` + test, `providers/model-catalog-resolver.ts`,
`config-command.ts`.

## Rollback

The landing is a single merge commit on main. Rollback = revert that merge
(`git revert -m 1 <merge-sha>`), which returns main to its pre-landing state
without touching the v14 branch. Because the rows were reviewed individually on
the branch, a revert is the clean unit — do not partially revert rows out of the
merge; if one row is bad, revert the landing, fix on the branch, re-land.

A fleet-facing revert of the deployed proxy follows the fleet-rollout channel
(announce on `global` before applying) — the git revert and the deploy revert
are separate acts.

## Deliberately OUT of the v14 landing

Recorded so the landing does not silently scope-creep:

- **Patient overload backoff + the #431 eligibility WeakSet** — main-only; v14
  has no patient backoff to exempt anyone from. If a later row ports the bounded
  `ConcurrencyLimiter`, the WeakMap budget + WeakSet eligibility MUST land in the
  same PR (see `docs/reference/v14-landing-dep-431.md`).
- **`isConcurrencyRefusalResponse` + `quota-wall.ts` bounded read** — no
  unread-Response consumer on v14; would arrive dead.
- **The #651 derived-limit twin, #660 loader surfaces** — later rows, per row 1.
- **#79 step-skip-producers** (`overflowRecoveryText`, `classifyContextOverflow`,
  learned cap) — ride a later row, per row 1.
- **`countMediaBlocks` walk unification** — happens at the 7a landing: take
  main's `media-cap.ts`, import the count from `context-overflow.ts`.
- **Two missing PIN files** (`fork/failover.test.ts`,
  `fork/server/relay-hub-death.test.ts`) — v14 deferred *coverage*, not just
  features (port-map §Supporting measurement). Restoring them is a follow-up,
  not a landing blocker, but should be scheduled: main has these pins and v14
  does not.

## First post-landing verification (fleet-rollout rule)

A fleet-affecting change is not DONE on the merge. The landing's verification
artifact is a measured per-consumer read, in the same session, from the live
path: each sidecar's resolved model after the deploy, the hub's `/health`
instanceId, and one cascade walk observed end-to-end — not the merge commit's
intent. See CLAUDE.md §Fleet-Rollout Verification.
