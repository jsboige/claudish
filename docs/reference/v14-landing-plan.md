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
  | 1 | #565 context-admission census | **#900** | **merged 06/11** (`aeb1b60a`) |
  | 2 | #654 endpoint token budget | (two parts) | merged |
  | 3 | #218 native-lane version pin | #889 | merged |
  | 4 | #693 machine-scoped arm | #896 | merged |
  | 5 | #769 unroutable-step skip | #839 | merged |
  | 6 | #598 connection-class advance | #845 | merged |
  | 7a | #431 media emitter | #856 | merged |
  | 7b | #431 concurrency-refusal emitter | #869 | merged |
  | 8 | #306 drain-freeze gate (proxy half) | #865 | merged |
  | 9 | billing-strip family | #885 | merged |

- Post-map merges into the branch: **#919** (main sync, `35c27ff6` + docs #922
  `b18fb317`), **#952** (native credential guard, `6a5ac674`), **#957** (oat
  Bearer shaping, `9cf299b7`). **Zero open PR targets replatform/v14** (checked
  10/11).

## Precondition (blocking)

1. **#900 merged into replatform/v14**, CI green on the merge commit —
   **satisfied 06/11** (`aeb1b60a`).
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

## Known silent-deletion surface (#641 étape 5 + #968 review, measured 10/11)

The add/add list above is NOT the whole conflict surface, and the surface must
be measured with git's own instrument, not by a file predicate — the first
revision of this section classified files by history ("main modified it after
the fork point") and produced lists git's output contradicts. **Instrument**
(run at the landing and at every sync; the base moves — since #919 it is
`95a3608f`, a commit ON main, so any fork edit older than that sync is base
content now):

```sh
# one instrument, two partitions
git merge-tree --write-tree origin/main origin/replatform/v14 > /tmp/mt.txt
TREE=$(head -1 /tmp/mt.txt)
# LOUD — the modify/delete CONFLICT lines, verbatim (git keeps main's version in the tree)
grep 'CONFLICT (modify/delete)' /tmp/mt.txt
# SILENT — main files absent from the merged tree, in no CONFLICT line, not rename-carried
git ls-tree -r --name-only origin/main -- packages/cli/src | sort > /tmp/main.txt
git ls-tree -r --name-only $TREE -- packages/cli/src | sort > /tmp/tree.txt
comm -23 /tmp/main.txt /tmp/tree.txt > /tmp/absent.txt
git diff --name-status -M origin/main $TREE -- packages/cli/src | grep '^R' | cut -f2 > /tmp/renamed.txt
grep -v -F -x -f /tmp/renamed.txt /tmp/absent.txt
```

Measured at `a89a8a5b` (main, post-#974) vs `9cf299b7` (v14 head): git emits
**34 `CONFLICT (content)`**, **13 `CONFLICT (modify/delete)`** and **zero
add/add** — that shape does not occur at this merge (the port-map "add/add
surfaces" above are a port-time trap, not something this merge outputs); an
earlier revision of this section described a 2+10 split into modify/delete +
add/add that git never printed.

The 13 loud deletions (each needs an explicit resolution, never a blind one;
all deleted in v14, modified in main, main's version left in tree):

- `channel/session-manager.ts`, `channel/session-manager.test.ts`
- `fork/failover.test.ts`, `fork/server/relay-hub-death.test.ts`
- `handlers/shared/stream-parsers/policy-refusal-prestream.test.ts`
- `providers/catalog-resolvers/openrouter.ts`
- `proxy-key-rotation-route.test.ts`
- `proxy-server-{dwell-pin-route,neverhang-wire,openai-notice,routing-error,step-skip-route}.test.ts`
- `tui/test-provider.ts` — was silent at `3d955d64`; #974 touched it on main,
  which promotes it into the loud set. This is the "re-run at every sync" rule
  working: any main commit under `packages/cli/src` can move a file between
  partitions.

The silent set: **57** main files absent from the merged tree with no CONFLICT
line — **6 rename-carried** (git detects the `channel/` → `mcp-session/` move
for `scrollback-buffer.{ts,test.ts}`, `write-json-atomic.{ts,test.ts}`,
`trace-gate.test.ts`, `progress-regression-mock.ts`; content lives on at the
v14 path) leaving **51 pure silent deletions**:

- `adapters/`: `deepseek-model-dialect.test.ts`, `glm-model-dialect.test.ts`,
  `minimax-model-dialect.test.ts`, `openai-api-format.test.ts`
- `auth/gemini-oauth.ts`, `deepseek-adapter.test.ts`, `profile-config.test.ts`
- `channel/`: `channel-wire-format.test.ts`, `diagnostics.ts`,
  `e2e-channel.test.ts`, `index.ts`, `signal-watcher.ts`,
  `signal-watcher.test.ts`, `types.ts`, `test-helpers/{channel-diagnostic,
  claudish-mock,client-diagnostic,fake-claudish}.ts`
- `config-command.ts`, `mcp-server.test.ts`, `team-timeout-repro.test.ts`,
  `team-failure-details.test.ts`, `team-grid-failure-details.test.ts`
- `middleware/`: `gemini-thought-signature.ts`, `index.ts`, `manager.ts`, `types.ts`
- `handlers/`: `composed-handler-tool-name-map.test.ts`,
  `shared/context-overflow.test.ts`, `shared/format/tool-result-images.test.ts`,
  `shared/overflow-caps-store.test.ts`,
  `shared/stream-parsers/{contentless-turn-s4b,ending-taxonomy-s4b,
  usage-cache-split-s4c}.test.ts`
- `providers/`: `catalog-resolvers/openrouter.test.ts`,
  `context-limit-derivation.ts`, `context-limit-derivation.test.ts`,
  `default-routing-rules.ts`, `default-routing-rules.test.ts`,
  `model-catalog-resolver.ts`, `runtime-providers.test.ts`,
  `transport/codex-session-affinity.test.ts`, `transport/gemini-codeassist.ts`
- `proxy-server-role-map.test.ts`
- `tui/panels/`: `ApiKeysPanel.tsx`, `ConfigViewPanel.tsx`, `ProfilesPanel.tsx`,
  `ProvidersPanel.tsx`, `RoutingPanel.tsx`, `StatsPanel.tsx`, `TelemetryPanel.tsx`

**`providers/context-limit-derivation.{ts,test.ts}` is in the silent set, not
a survivor** — the earlier revision filed it under "survives without conflict",
which it does not. Both exist at the base `95a3608f`, are absent from v14, and
vanish from the merged tree with no CONFLICT line. v14 carries
`registerDeclaredContextLimit` (the config literal) but **no derivation
probe**: dropping the pair silently re-opens the exact defect #651 closed —
every declared window on the landed tree is again a number a human typed
(#660's admission census included). Disposition recorded on #641: **keep +
wire** the three callsites (`custom-endpoints-loader.ts`, `proxy-server.ts`,
`builtin-probe-surfaces.json`) at the step-1 sync — opt-in flag, zero default
wire bytes, fails soft.

**Destination rule**: a disposition table exists per file on #641 (comment of
10/11). The keep-vs-drop questions that remain user- or coordinator-level: the
4 TUI panels `ApiKeysPanel`/`ConfigViewPanel`/`StatsPanel`/`TelemetryPanel` →
**C5, user call**; `channel/diagnostics.ts` (the `CLAUDISH_CHANNEL_TRACE`
instrumentation documented in CLAUDE.md §Channel Mode) + its 4
`channel/test-helpers/*`; `mcp-server.test.ts`, `team-timeout-repro.test.ts`,
`config-command.ts`, `gemini-thought-signature.ts`, `model-catalog-resolver.ts`
— all silent now, same question as before. The step-1 sync must pass every
silent deletion in review; nothing in this section is a license to let the
merge decide.

**6 fork-only files survive the merge without conflict** (added on main after
the base, never present on v14 — the merge keeps them): the
`handlers/shared/upstream-compression.{ts,test.ts}` pair (#909), the
`test-support/capture-hermeticity.{ts,test.ts}` pair (#445),
`providers/builtin-probe-surfaces.json`, `probe-live-auth.test.ts`. Their
per-file disposition (« couverture différée » — module present on v14, pins
main-only) lives on #641.

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
