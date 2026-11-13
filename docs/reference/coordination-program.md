# Coordination program — objectives, the issues that carry them, how a queue is built

Written 13/11/2026. Read it at the start of a coordination cycle, before building the workers' queues, and when you take over the coordinator seat.

This page is a map and a set of rules. It holds no state: what is done, what is measured and what is blocked live in the issues. If this page and an issue disagree, the issue is right and this page gets corrected.

## The mandates this program answers

All from the user. The original words are French and are quoted in the issues named here.

| Date | What was asked | Where it is carried |
|---|---|---|
| 26/10 | Act against the inflation of consumption across the fleet | #700 |
| 07/11 | Every machine consolidates, with good practices, guards and bounds, the containers and the workflows it supports | Objective 8 below |
| 11/11 | Managing and aligning the configurations stays in the fleet's mandate; every machine must be resilient | #711, #764, #291 |
| 13/11 | Protocols that let the fleet move forward with or without cloud assistance; the durable work is in git | `docs/reference/delegation-protocol.md` and the three protocol pages next to it |
| 13/11 | Every claudish workspace and sidecar is wired for the Fable role | `docs/deployment/fleet-state.md` §Fable role |
| 13/11 | Correct and complete the issues, keep the coordinator seat and the workers productive on strategic objectives for the coming weeks, finish the consolidation missions, extend the gestures of the rationalisation issues, and see with the Open WebUI lane how access to claudish can be governed by its accounts | This page, and #1031 |

## The objectives

An objective ends on the last column, not on a count of merged pull requests.

| # | Objective | Issues that carry it | It ends when |
|---|---|---|---|
| 1 | **The Fable role, proven per consumer** | No issue: the table in `docs/deployment/fleet-state.md` §Fable role | Every row of that table carries its three readings (what the client sends, what the hub served, what the sidecar does alone) |
| 2 | **Land the v14 re-platform, then keep upstream close** | #641 (re-platform), #897 and #731 (convergence and sync), #29 (features re-engineered for upstream) | `main` is the re-platformed base, and taking an upstream release is a matter of days |
| 3 | **Every machine resilient, configurations aligned** | #711 and #764 (cascades, by value, per machine), #291 (relay and sidecar matrix), #81 (direct keys), #905, #908, #587 (transport faults), #948, #1013 (host and archive residue) | Every seat's cascade is read by value and equals the canon or carries a recorded deviation, and every seat has a fallback that has been exercised |
| 4 | **Sobriety and token productivity** (the "rationalisation" family) | #700 (program and register of levers), #445 (tokens read, turns, output), #23 and #99 (harness weight), #640 (shared prefix), #328 (coordination regime), #21 (cost-aware routing), #82 (signature routing, design only) | Each lever of the #700 register has a measured before and after, and the weekly figures of #445 hold |
| 5 | **Observability and cost** | #116 (datastudy and dashboard, which absorbed #41), #405 (what one euro buys per provider), #362 (session surveillance), #995 (a subscription fallback chosen on measured value) | The user sees the dashboard without asking for it, and the cost register is dated and reproducible |
| 6 | **Never-hang** | #1030 (first-event watchdog), plus the open grain issues | It does not end: it is a standing constraint. It is healthy when each rule of `CLAUDE.md` §Never-Hang Constraints has a pin and no open issue names an unbounded wait |
| 7 | **A service a school can run, with governed access** | #943 (usage and harness part of the dossier), #1031 (access governed by Open WebUI accounts) | The dossier's part is delivered or closed on its own clause, and the access design is chosen by the user and cut into grains |
| 8 | **Consolidation, with guards and bounds** | The Maintenance tracker's bounds issue (one measured line per seat), #1032 (workflow timeouts), and one consolidation grain in every queue | See the next section |

Ready work that needs no arbitration is listed by `gh issue list --label grain`. That list, not this page, says what a worker or a cloud session can take today.

## Consolidation: what "finished" means

A consolidation has three steps, and it is finished only after the third:

1. **Analyse** every function of the old piece.
2. **Merge** each one into the target, citing line numbers as proof that it is there.
3. **Archive or delete** the old piece, after the proof and not before.

Moving a file to an archive directory without step 2 is not a consolidation. It is a loss with a tidy name.

Five kinds of consolidation debt recur here. Each one is a grain, and each grain names its proof.

| Kind | Example | Proof that closes it |
|---|---|---|
| A container without bounds | A sidecar created before the compose file carried `mem_limit`, `memswap_limit` and `pids_limit` | `docker inspect` on the seat: the three values and the creation date, posted as one line per seat. A value in the compose file is not a value in the container (`CLAUDE.md` §Budget Failover, the compose note) |
| A workflow without bounds | A CI job with no `timeout-minutes` | The line in the workflow, and a test that names the job when it is missing |
| An instrument that lives in a comment or in a scratch directory | A script pasted in an issue and run from there | A pull request that versions it with a test, or a dated line saying it is lost |
| A register that was never restated | A list of levers written before the measure that was meant to rank them | The register rewritten with the measured before and after, in the issue |
| An epic absorbed by another | An umbrella issue closed "under" a newer one | The remnants copied into the newer issue with their sources, then the close |

A queue that carries a consolidation grain says which of the three steps it asks for. A grain that stops at step 2 is carried over as "step 3 owed", by name.

## Keeping an issue true: the upkeep comment

An issue is read by someone who was not there: a new coordinator, a worker starting a cycle, a cloud session. When the body no longer says what is true, the coordinator posts one **upkeep comment** and points the body at it.

The upkeep comment is titled `Tenue au <date>` (the fleet's working language is French) and carries, in this order:

1. The state of each acceptance criterion, with the date and the seat of the comment that established it.
2. What the body says that is no longer true.
3. The coordinator's decisions the thread was waiting for.
4. The next grains: what, the proof expected, the seat.
5. What the issue waits on, and from whom. A decision that is the user's is named as such.
6. What was not verified when writing the comment.

Rules:

- It restates the thread, it does not re-measure. A number in it is quoted with its date, or it is absent.
- It refers to earlier comments by date and seat, never by a private numbering.
- The first line of the body becomes a pointer to the latest upkeep comment. The rest of the body is left as written: the edit history is the record.
- The next upkeep comment supersedes the previous one. The old one is not edited.
- An issue whose criteria are all met or moved is closed in the same gesture, with the criteria listed (`docs/reference/review-protocol.md` §Merging, and closing the issue).

## How a queue is built

The cycle's mechanics are in the coordinator skill (`.claude/skills/claudish-coordinate/SKILL.md`, dispatch phase). These rules say what goes in.

- **Depth.** About ten ordered grains per seat, of which three or four are fallback grains that depend on no merge and no window. A worker with an empty queue is a dispatch fault.
- **Order.** A repair first. Then the verification of a fleet rollout in progress. Then review returns. Then the seat's grains on the objectives above. Then consolidation. Then fallback.
- **One consolidation grain per seat, at least,** chosen by the coordinator, with the step it asks for.
- **Every grain names** the issue it decrements, the proof expected (a command, an artifact, a measured line) and its size.
- **A decision the issue was waiting for is written in the issue before the queue is posted.** A grain that needs an arbitration nobody made is not a grain.
- **Carry-over is explicit.** An unfinished grain comes back with the reason it did not land, or is dropped with one line. It never disappears.
- **A grain that stands alone becomes a grain issue** (`docs/reference/delegation-protocol.md`): the same text serves a worker or a cloud session.
- **One measurement, one seat.** A grain goes to the seat that can read the evidence. The table below says which.

## What each seat can see

Details and current values: `docs/deployment/fleet-state.md`. This table is only about who can measure what.

| Seat | It is the one that can read |
|---|---|
| Hub (po-2025) | The hub's corpus and logs, the canonical cascade by value, the request-level attribution of every seat that relays |
| Relay (po-2023) | The relay path and its tunnel, the hub's `/health` as a relay sees it |
| Sidecar seats (po-2024, po-2027, po-2028) | Their own container (environment by value, bounds, image date), their client settings, what AUTONOMOUS serves on that machine. po-2027 reaches the hub over the WAN, so it is the seat that reads that path |
| Coordinator (ai-01) | Reviews, merges and arbitrations; its own sidecar; the provider consoles through the console reader; the question registry for the user |

A seat reports what it read on its own machine. A figure about another seat is quoted from that seat, with its date.

## What only the user decides

The coordinator prepares these and never settles them. They go to the coordinator's question registry and are restated at the end of each session; they are never a blocking question in an issue thread.

- Which plan sits at which rung of a cascade, when the change moves what is paid: the arbitrations recorded in `CLAUDE.md` §Budget Failover are the user's. Aligning a seat on the hub's canon is the fleet's own mandate.
- Any threshold of the session budget (same section).
- Any spend that is not already running: a paid probe against a provider, a cloud session (`docs/reference/delegation-protocol.md`).
- The rotation or retirement of a shared key (#81).
- Which design governs access through Open WebUI accounts, and the thresholds of any per-user or per-group cap (#1031).
- The verdicts the issues name as the user's: slim or migrate the harness (#99), cost-aware routing policy (#21), signature routing (#82), the go for the upstream convergence steps that are gated (#897), and the landing of the re-platform on `main` (#641).
- Anything that needs an elevation window on a machine.

Everything else is decided by the coordinator, written in the issue, and reversible.

## Keeping this page true

- An objective changes here when its carrying issues change: a closed issue leaves the table, a new strategic issue enters it, in the cycle where it happens.
- The first cycle of each week compares the table with `gh issue list --state open`. An open issue that fits no objective is either given one, or closed, or written down in `ROADMAP.md` with its trigger.
- No date, count or percentage is added to this page. If a number seems needed here, it belongs in an issue.
