# Delegating a grain — to a cloud agent or to a worker

One format of work order, the **grain issue**, that any producer can take: a cloud agent session (Anthropic or OpenAI) when the user has credit to spend there, a fleet worker otherwise. The issue text is the same in both cases and so is the acceptance. This page says what makes a piece of work delegable, how to write it, who takes it, and what the fleet keeps for itself.

Mandate (user, 13/11/2026): protocols that let the fleet move forward with or without cloud assistance, on the OpenAI side or the Anthropic side.

State on 13/11: the format is new here. No pull request from a cloud agent has been opened on this fork yet (0 among the last 400 pull requests have a `claude/*` or `codex/*` head). Everything below about cloud sessions on this repository is design, to be corrected by the first grains that go through it.

## Terms

- **Grain**: the smallest piece of an issue that lands as one pull request and is accepted by a command. "One behaviour, one PR."
- **Producer**: whoever writes the code — a cloud session or a worker. **Verifier**: whoever accepts it — the coordinator, never the producer.
- **Pin**: a regression test that fixes one behaviour. **Mutation**: breaking a guard on purpose to see a pin go red.
- **Cloud session**: an agent running in a vendor's sandbox on a clone of this repository, started from the user's account.

## What a cloud session has, and what it does not

| It has | It does not have |
|---|---|
| A clone of the repository on the branch it is given | The LAN: the hub, the sidecars, the capture corpus |
| `CLAUDE.md`, the decision layer. `AGENTS.md` is a symlink to it (#458), so both vendors' agents read the same file | The dashboards, the RooSync inbox, any machine's local memory |
| The issue text, and whatever it links to inside the repository | The provider consoles, any key or token: it cannot make a live provider call |
| `bun` and the repository's own tests | Windows: no PowerShell 5.1, no `test:scripts:win51`, no CRLF checkout |
| | The history of what was decided on a dashboard and never written in git |

The last row is why the rules belong in git: a decision that lives only on a dashboard does not exist for a cloud session, and it does not exist for a new worker either.

## Delegable or not

A grain is delegable when **every** line holds:

1. Its acceptance is a command that runs inside the repository, with an expected result.
2. Its scope is a list of files or one directory, and what is out of scope is named.
3. No decision is left open. Whatever needed arbitration was arbitrated before, and the issue quotes the outcome.
4. It depends on no unmerged pull request.
5. Its proof needs nothing from the right-hand column above.

Not delegable, whoever asks:

- An infra gesture (a restart, a recreate, an environment change) or anything whose proof is a live measurement.
- A review, a merge, an arbitration between options.
- The PowerShell ops scripts: PowerShell 5.1 is the interpreter that ships, and a cloud sandbox cannot run it.
- Anything that touches a secret.

A grain that fails line 3 is not ready for a worker either. Arbitrate it, then write it.

## Writing the grain

Use the issue template `.github/ISSUE_TEMPLATE/grain.md`. Each field is there because its absence has cost a cycle before.

| Field | What goes in it | Why |
|---|---|---|
| **Parent** | The open issue this grain decrements, and the row or acceptance criterion it closes. For a port to another branch: the open issue that tracks that branch, plus the merged pull request being ported. `None` when the grain stands alone | The grain closes on the parent's criteria, not on "the code merged" (`docs/reference/review-protocol.md`). A closed issue has nothing left to decrement: it is a reference, not a parent |
| **Base branch** | `main`, or `replatform/v14`, spelled out | A session branches from the default branch unless told. A pull request on the wrong base is rework |
| **Predicate** | The behaviour to obtain, as one testable sentence. Quoted from the parent when the parent states it. When the parent's names do not exist on the base branch (a role, a file, a test), restate it in that branch's own terms and say that it is restated | A producer builds its pins from its own reading. If the reading is inverted, the pins pass by construction. The predicate in the issue is what the verifier re-reads |
| **Where** | Permalinks to the code at a pinned commit | Line numbers move. The code is the truth, the prose around it is not |
| **In scope / out of scope** | Files or directory. What looks related and must not be touched | A drive-by change is unreviewed code inside a reviewed pull request |
| **Acceptance** | The commands and their expected result, the pins to add, and the mutation to show (which guard broken, which pin red). A count is written only if someone measured it on the base branch; otherwise the grain asks the producer for the counts before and after its change | "Tests pass" is not an acceptance. A pin that never went red proves nothing. A count nobody measured is a guess the producer will try to match |
| **Binding rules** | The sections of `CLAUDE.md` that apply to this change, by heading | The file is long. Naming the three headings that bind this grain is cheaper than a rejected pull request |
| **Stop conditions** | "If X turns out false, stop and comment here; do not widen the scope" | A producer with no one to ask will otherwise decide alone |
| **Routing** | `cloud-first until <date and time, UTC>`, or `worker` | See below |

Write for a reader who has the repository and nothing else. If a sentence needs a dashboard to be understood, the grain is not ready.

The web form applies the template's title prefix and its `grain` label. `gh issue create` does not: pass `--label grain` yourself, and copy the template's sections into the file given to `--body-file`.

## Who takes it

Worker dispatch stays what it is: conversational, through the dashboards (`.claude/skills/worker-issues/SKILL.md`). Two labels exist for the readers who have nothing but GitHub, the cloud sessions and the user away from a seat:

| Label | Meaning |
|---|---|
| `grain` | The issue is in this format |
| `cloud-ready` | Offered to a cloud session first. Workers leave it alone until the label is removed: it is in the exclusion list of the worker's cycle (`.claude/skills/worker-issues/SKILL.md`) |

The sequence:

1. The coordinator writes the grain, checks the five lines above, and sets `cloud-ready` with a deadline in the Routing field. Only the coordinator sets or removes that label.
2. A cloud session is started on it by the user, or by an agent the user has told to. Cloud credit is the user's to spend: no agent starts a paid cloud session on its own.
3. The session's **draft pull request**, linked to the issue, is the claim. An issue with `cloud-ready` and no pull request is free.
4. At the deadline with no pull request, the coordinator removes `cloud-ready` and dispatches the grain to a worker. The issue text does not change: that is the point of the format.

The deadline is the coordinator's choice: far enough for the user to start a session, near enough that the worker fallback still matters. One day is the starting value, chosen and not measured.

Keep at most **three** grains `cloud-ready` at a time. That number too is a starting value. Two things bound the flow, and neither is how fast sessions can open pull requests:

- **Review.** One coordinator cycle absorbs a few pull requests, not a few dozen. On a neighbouring repository of the same fleet, a cloud marathon opened pull requests faster than CI and review absorbed them (reported 12/11).
- **CI.** On 13/11 the three test jobs of one pull request here were created at 10:04Z and the first of them started at 10:24Z: twenty minutes in the queue. The cause was not measured. GitHub counts concurrent jobs per account, so the account's other repositories can fill that queue.

A pull request on `main` here shows four checks. Three of them test: `test`, `typecheck`, `scripts-tests`, all on Linux. The fourth, `claude-code`, went green in twelve seconds on #1020 (read 13/11): the fork carries no API secret, so it reviews nothing. A green column is three jobs, not a review.

## What the producer delivers

The same from a cloud session and from a worker:

- One pull request against the named base, for this grain only.
- A body that states: what changes; any behaviour change a reader must know before merging; the pins added; the mutation shown; the commands run, with their counts and the commit they ran on; what is out of scope; **what was not verified**.
- `Closes #NN` when the base is `main`. On any other base GitHub does not close the issue: write `Refs #NN`, and the coordinator closes it on its criteria.
- A conventional commit title.

## Acceptance

The same for every producer, and stated in `docs/reference/review-protocol.md`: the verifier reads the body, the comments, the reviews and the diff, replays the pins and mutates each guard.

The merge is pinned to the head that was read: `gh pr merge <N> -R jsboige/claudish --squash --match-head-commit <full sha>`. A commit pushed while the review was running is refused instead of riding in unread.

What a cloud pull request adds to the verifier's list:

- **Replay on a Windows seat.** The session ran on Linux, like CI. Two green Linux runs say nothing about a CRLF checkout or about PowerShell 5.1.
- **Every sentence about live behaviour is a claim.** The session could not measure the hub, a sidecar or a provider. Nothing it says about them is evidence.
- **The pins come from the producer's reading.** Re-read the predicate in the issue before reading the tests.
- **No stacked pull request.** A child merged into a parent branch carries unreviewed code to `main` when the parent merges.

A pull request that fails acceptance is answered on the pull request, with the failing command. If the session is gone, the grain goes back to the queue with that comment attached; the next producer starts from it.

## The same form briefs a sub-agent

A coordinator or a worker that hands a piece of work to a sub-agent inside its own session is writing a grain: the sub-agent knows only what the brief says. The fields that matter are the same — the goal, the sources to read instead of a summary of them, the scope, the hard rules of the machine, and the form of the report. One addition: when the sub-agent is the verifier of the caller's own work, give it the code and the issue, not the caller's conclusions.
