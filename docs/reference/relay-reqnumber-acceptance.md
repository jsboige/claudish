# #1193 reception — the per-seat acceptance table for `reqN` on a relay seat

**What this page is.** The table that records, seat by seat, whether the fix for #1193 (PR #1194) is live, and the rules for filling a row without being lied to by it. Every number below was measured on po-2024 on 2026-11-26 unless a date says otherwise.

**What it is not.** Not a request to recreate anything. A seat takes the fix at its next drained recreate (`scripts/claudish-drain.ps1 -Recreate -EnvFile`, detached — `CLAUDE.md` §Never-Hang Constraints). The table describes what runs, whenever it is read.

The instrument is `scripts/relay-reqnumber-audit.py` (PR #1207; until it merges, use the manual path under [Filling a row](#filling-a-row--read-only)). It produces both rows a line of this table needs.

## Two axes — never merge them

A row is wrong if either axis is missing:

- **Revision** — which build serves. `/health` carries `version` / `revision` only from #1143; older images have both fields **absent**, which is a different state from `unknown`. The identity that always exists: the image id and build date (`docker image inspect`) and the process start (`docker inspect … {{.State.StartedAt}}`). "Has #1194" is read from the build date against the merge date, never from intent.
- **NOMINAL window** — the interval the numbers were counted in. It starts after the last transition back to NOMINAL *and* after the last `[Request]` line. A window is identified by its start and its end ("measured at"); the counts are what they were at that instant.
- **The end is a bound, not a minute.** The instrument's `--until` is the row's end and it is written in the row. `--until` given at the second keeps that whole second; given at the minute, it stops before that minute. A count noted without its bound cannot be read back: on po-2024 two reads, both first noted as "10:20Z" without their bound, gave 2 523 (its bound turned out to be 10:20:04Z) and 2 528 (no bound stated, not reproducible). The row below is the bounded read, the one a reader gets back from the same log.

Measured on one seat, one process, no deploy in between:

| read at | window | `[ttft]` | distinct `reqN` | `[Request]` | reads as |
|---|---|---|---|---|---|
| 00:50Z | whole life, process started 25/11 11:04:53Z | 4 438 | 1 (`0`) | 0 | FROZEN at 0 |
| 05:23Z | whole life | 5 983 | 7 | 6 | "not frozen" |
| 05:23Z | after 02:07:08.634Z | 1 155 | 1 (`6`) | 0 | FROZEN at 6 |

Between 00:50Z and 05:23Z nothing was deployed. One autonomous episode (02:06:05Z → 02:07:08Z, the hub's nightly restart) served six requests locally and moved the frozen base from 0 to 6. A row is dated, or it is not a row.

## The table

| seat | relay container | process started | revision | has #1194 | NOMINAL window since | measured at | `[ttft]` | distinct `reqN` | `[Request]` | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| po-2024 | `claudish-sidecar` | 2026-11-25T11:04:53Z | `cf35e6a5c358`, built 2026-11-19T12:47:41Z | no | 2026-11-26T02:07:08.634Z | before 2026-11-26T10:20Z | 2 522 | 1 (`6`) | 0 | FROZEN — baseline |
| po-2023 | its relay | — | — | — | — | — | — | — | — | to fill |
| ai-01 | `claudish-sidecar` | — | — | — | — | — | — | — | — | to fill |
| po-2026 | `claudish-proxy` | — | — | — | — | — | — | — | — | to fill |
| po-2027 | `claudish-sidecar` | — | — | — | — | — | — | — | — | to fill |
| po-2028 | `claudish-proxy` | — | — | — | — | — | — | — | — | to fill |

Container names are those `docs/deployment/fleet-state.md` records; a seat re-reads its own. po-2025 is the hub (`CLAUDISH_RELAY_UPSTREAM` unset): it has no relay branch, its `[ttft]` numbers come from its own `logRequest`, and it has no row here.

A filled row that says **NO-TRAFFIC** is a valid row. A relay whose clients go hub-direct (`fleet-state.md` records po-2023 in that state) relays nothing; that proves neither pass nor failure, and the seat leaves the count with that reason stated.

## Filling a row — read-only

```bash
docker inspect <container> --format '{{.State.StartedAt}} {{.Image}}'
docker image inspect <image> --format '{{.Id}} {{.Created}}'
python scripts/relay-reqnumber-audit.py --container <container> --until <row end> --by-model
```

The row of this page was read with `--since 2026-11-26T02:07:08 --until 2026-11-26T10:20`; the same two bounds give the same line again while the log is kept. Quote the `acceptance[…]` line, never `window[…]`: `window` is the as-measured count, `acceptance` the one trimmed to the NOMINAL window. `--json` gives both as objects, with one `lives[]` entry per process life inside the acceptance window.

Without the script, on any image:

```bash
docker logs -t <container> > seat.log 2>&1
```

then count the `[ttft]` lines, their distinct `reqN=` values and the `[Request]` lines **after** the last `healthy again → NOMINAL` line. The `2>&1` is not optional: a container writes application lines to stdout and to stderr both (363 of 10 479 lines for po-2024's current process life, cut at 2026-11-26T10:20:00Z), and a pipe or a redirection without it drops every stream death silently.

## Reading a verdict

| verdict | shape | what it means for #1193 |
|---|---|---|
| FIXED | `[Request]` = 0 and distinct `reqN` = numbered `[ttft]` | the fix is live on this revision. Never observed in production on 26/11 |
| FROZEN | `[Request]` = 0 and one distinct `reqN` | an image without the fix. A baseline row, not a seat failure |
| LOCAL-SERVING | `[Request]` > 0 in the window | the window is not an acceptance window; trim it |
| MULTI-LIFE | more than one process life inside the window | one row per life; a frozen value belongs to one life |
| NO-ACCEPTANCE-WINDOW | a local request after the last return to NOMINAL | nothing to quote yet; re-read later |
| INCONCLUSIVE | fewer than 2 numbered `[ttft]` lines | no volume; re-read later |
| NO-TRAFFIC | no `[ttft]` at all | nothing relayed; the seat leaves the count, reason stated |

On a seat with the fix, `distinct == numbered` compares values inside **one** process life: a `stream: false` answer prints no `[ttft]` line, and a forward that dies before its first useful event prints none either. It is never "distinct == requests relayed".

#1193 closes when every relay seat has a FIXED row on a post-#1194 revision, or has left the count with a stated reason.

## Why six local requests freeze the counter at 6

`logRequest` is the only writer of the request number (`reqNumberMap.set`, `++__capN`). On an image without the fix the relay branch returns before `logRequest` runs, so `requestNumberFor` falls back to the global `__capN`: a relayed `[ttft]` line carries the last number the **local** pipeline took.

On po-2024 the episode served six requests locally, and they took numbers 1 to 6. Every relayed line since carries `6`: 2 522 lines across three models before 2026-11-26T10:20Z, one value. Over the whole process life, at the same bound, the counter shows seven values (`0` ×4 822, then `1` to `5` once each, then `6` ×2 523), which is what a working fix looks like when the window is not cut.

Two consequences:

- The frozen value is **not** a request count. It is how many requests the local pipeline served in this life, and it moves only when one does.
- A local request does not need a mode change. A forward that fails on a hub 5xx serves one request locally and stays NOMINAL (`[1/2 before AUTONOMOUS]`, seen 25/11 01:55:03Z): the `[Request]` line is the signal, the transition list is not.

The fix gives a relayed request its own number once the forward is **engaged** — after the last `return null` in `forwardToUpstream`, so a forward the hub refuses still lets the local path take the only number.

## Port to `replatform/v14` — what it depends on

Measured 2026-11-26 on `origin/replatform/v14` at `9fb1f988`: `assignRequestNumber` is absent there, as on `main`.

| dependency | v14 on 26/11 | role in the port |
|---|---|---|
| `packages/cli/src/fork/middleware/request-logger.ts` | `logRequest` l.162, `__capN` l.231, `reqNumberMap.set` l.232 | extract `assignRequestNumber`; `logRequest` calls it (PR #1194: l.71, l.230) |
| `packages/cli/src/fork/server/relay.ts` | `forwardToUpstream` l.491 | import it and call it once the forward is engaged (PR #1194: l.39, l.852) |
| `packages/cli/src/proxy-server.ts` | two callers of `forwardToUpstream`: l.3185 (native ingress), l.3413 (OpenAI ingress) | not edited: both go through the one call inside `forwardToUpstream` |
| readers of `requestNumberFor` | `composed-handler.ts`, `native-handler.ts`, five stream parsers, `response-capture.ts` (which also reads `__capN` as a fallback) | not edited; they resolve through the map the assigner fills |
| `packages/cli/src/fork/server/relay.test.ts` | — | the pins travel with the port |

The cycle-6 replay applied as 6 files (+103/−6) with 3 insertion conflicts and was not pushed. Port only after #1194 is merged **and** v14 has synced from `main`: a port of an unmerged fix is a second source of truth, and these line numbers hold only while v14 stays at `9fb1f988`.
