# Measurement protocol — rules earned by incident

This page is for the moment before a number, a verdict or a diagnosis leaves your session: you are about to say "the hub was down", "there is no traffic", "the fix is live", "only 20 requests are unexplained" — from a log, a capture corpus, a provider console or a script's output. Every rule below was paid for by a wrong publication on this fleet; most of them are checks that cost seconds and were not done. They apply to any seat, not only the coordinator — the agent lane that reviews, merges and reports for the fleet, and the author of most of the publications below.

## How to use this page

Rules are grouped by the moment they apply: choosing and proving an instrument, knowing what it can see, reading logs and captures, handling time, turning a reading into a verdict, reading per-machine state, publishing. House terms: a **capture** is a `req-*.json` or `resp-*.sse` file written by the proxy to its capture directory; a **seat** is one machine's installation (hub or sidecar); **NOMINAL** and **AUTONOMOUS** are the two relay modes — NOMINAL forwards to the hub and writes no local capture, AUTONOMOUS serves locally; a **pin** is a regression test that fixes one behaviour; a **mutation** is breaking a guard on purpose to watch a test go red; an **AC** is an acceptance criterion of an issue.

## Before you measure

### Build the instrument before you publish the number; a figure you cannot replay is a claim

**Why.** 21/08, on another workspace's harness: the coordinator published 2.54 characters injected per token and that lane cited it in an issue body; the tool written to reproduce it returned 2.15 on the same population (86 pairs, p10 1.97, p90 2.42) — the cost had been understated by 18 %. Three defects hid each other: an unnamed unit (LF blob against a CRLF working tree, bytes divided by characters), pairing by filename instead of by header, and a filter that kept 178 of 179 requests while displaying its option. The retracted figure also survived in the tool's own docstring, and the tool was not versioned, so only matching disk paths let the other lane replay it.

**Apply.**

- Write the measurer first. If it does not reproduce the number, the number falls, not the tool.
- Name the unit in the sentence ("characters injected, LF, frontmatter removed"), and give the raw delta as the hard figure with the token conversion labelled as an order of magnitude.
- Verify that a filter filters: print n before and after; a filter that leaves the population intact is not filtering.
- Version the measurer, and retract into its source — a withdrawn figure left in a docstring re-emits itself to every reader. The retraction is a delivery: ask who, between publication and correction, could already have built on it (one peer had adopted the withdrawn figure as a rule of its own instrument).

### Put the probe at the first point the client's bytes reach

**Why.** 02/10, review of #308: the coordinator's AC 1 of #305 asked to log which credential the authorised client sends, at the native handler on the hub. That client reaches the hub through its sidecar, and the relay deletes `x-api-key` on a keyed forward (`packages/cli/src/fork/server/relay.ts`; since #412 the keyless-exempt branch keeps the client's own) — and a NOMINAL relay never enters `NativeHandler` at all. Anywhere on the hub, the probe could only ever report `authorization` or `(none)`, whatever the client sent.

**Apply.** Trace the real path (client base URL, each hop, what it strips or adds) and place the measure at the first entry point the client reaches, before any branch that rewrites. If the measurement no longer decides anything, say so and re-scope the AC in writing rather than let it be believed done.

### A control that cannot fail proves nothing

**Why.** 19/09 produced three zeros in one cycle, each from a broken instrument: a secret scan whose greps were all `Aborted`, a throwaway clone that failed so the condition under test never existed, and a canary whose extractor read `content[0].text` from a thinking-only answer. On 14/09 two `.env` files were "verified match" against the revoked key they had just been copied from; on 21/09 an upload compared the destination to the bytes it had just written, where 0.6 MB would have overwritten 294 MB.

**Apply.** Before publishing an absence, make the instrument produce the presence on a case whose answer you know is yes, and print that positive control beside the result. After a write, compare against a canon named and external to the gesture — the size expected *before* the copy, a reference digest agreed in advance, or another seat's measurement — never "verified match" against the source you just copied from. Verify at the level where the value is consumed, not where it was written: a task argument re-read from the scheduler proves only that the scheduler stored what you typed.

### A control is parallel, and it must not share the component it is testing

**Why.** 25/08, "13 % loss to the hub against 0 % to the gateway at the same instant" was two 100-ping series of ~100 s run one after the other, against an episodic phenomenon; a later probe that pinged both targets in sequence returned three contradictory path verdicts in 11 s. The same night, 13 % ICMP loss toward two different targets while TCP completed 654/654 put the loss on the source, not on the path — and two instruments that both traversed the hub machine could not distinguish a LAN fault from that host freezing, which is what it was (its own analysis jobs starving the event loop).

**Apply.** Launch control series with `&` and `wait` (~1 ms apart), then time the cycle: a cycle duration equal to the sum of the series means they ran sequentially. Measure the quantity the traffic uses — an agent opens TCP connections, not ICMP — and characterise the noise floor per path before exploiting a comparative verdict. Before calling two instruments a corroboration, check that they measure the same quantity and share no component with the hypothesis; an attribution needs at least one instrument hosted by a healthy third party.

### When the full population is slow or noisy, choose an instrument with a zero baseline

**Why.** 20/09, review of PR #179: the PR announced "39 failures, all the noise family" — a claim that can hide a regression. `bun test` at the root on `main` did not finish in 16 min and its failing population is a rotating ~39; enumerating the test files that reference the six touched modules gave 25 files, 460 pass / 0 fail on `main` against 477 / 0 on the head, in under a minute each. The +17 was exactly the announced new file, and the 39 were thereby shown outside the radius.

**Apply.** Enumerate the radius by reference, not by judgment (grep each touched module name across `*.test.ts`), and say it is direct references only — a floor, not a coverage claim. Prove the tree premises by subtree hash. A zero floor needs no subtraction, so any red on the head is attributable; a mutation is still required to show the new tests test something.

## What the instrument can and cannot see

### A capture is one link in the pipeline, never a mirror of the system

**Why.** 15/09 (#115): a `resp-*.sse` is written after translation, so a field absent there cannot prove the provider omitted it. 11/09: scanning 10 654 response captures for failover notices returned 0, because the notices are injected after the handler returns, downstream of the capture point. 28/08: one report said in a paragraph that a NOMINAL relay logs nothing for relayed requests, then cited exactly those logs as proof of "0 Anthropic" — 581 native Opus responses from that seat were on the hub.

**Apply.** Before citing a capture, name the link that writes it and what happens downstream of that link. A zero is first a hypothesis of blindness — check the parser's coverage (an unwired lane is indistinguishable from a silent one; `lane-capture-coverage.test.ts` enforces the invariant) and the mode (NOMINAL writes nothing locally). For an upstream question the only proof is the raw provider stream (`--debug`) or a probe that logs before translation. A code path that returns an error without logging it answers "empty" to every grep: the `RoutingError` path that maps to a bare 400 in `packages/cli/src/proxy-server.ts` writes no log line.

### Every field an instrument cannot see must print itself

**Why.** 05/11 08:17Z, the claudish lane posted on `global` that no machine denied `Artifact` or `Workflow`, citing `scripts/settings-matrix.py`; two other lanes refuted it from their own `settings.json` within 15 minutes. The policy snapshot publishes `permissions` only as a name in `otherTopLevelKeys`, never its content, and the matrix said nothing about it — so silence read as absence, and the claim went fleet-wide before anyone checked the source (#870).

**Apply.** For every field the instrument reads, ask what it does not read; if that is a field someone will ask about, print an explicit "not visible here" line. Before quoting an instrument's silence as a fleet fact, grep the script for the key. A test fixture that stands for "now" is dated relative to now.

### State the window you actually read

**Why.** 12/09, a window requested 23:06Z → 04:58Z really measured 00:00:00Z → 04:58Z, because the live corpus starts at UTC midnight — the 23h bucket read 0 native, indistinguishable from no traffic. 03/11: the min and max of 24 170 `resp-*` on the live share were the current day only (oldest 00:00Z, newest 12:22Z); the previous days lived only in the daily `.7z` archives. 18/09: 1 336 `req-*` files in a local directory spanned 10/08 to 18/09 with exactly 6 for that day — `ls | tail -N` bounds by rank, not by time.

**Apply.** Read the min/max timestamps of the corpus before interpreting a dip, and declare the window read, never the window asked. The timestamp is in the filename, so filter by day and cross-check a day's file count against the log's line count for the same window. A window longer than the live retention comes from the archives; a live census is current attribution and never a two-window trend.

## Reading logs and captures

### Read the code that writes the label before counting by label

**Why.** 23/08, `[Relay] forward failed (connect: AbortError…) → this request served LOCALLY` looked like "all failures at connection phase"; `connect:` was then a label written by `logFallthrough` (`packages/cli/src/fork/server/relay.ts`) that covered every pre-stream failure, the forward header deadline included (the code has since split it: `connect:`, `header-timeout after <ms>ms`, `aborted-on-autonomous`), and the error text was a timer abort, not a refused connection. Those aborts were then read as proof of hub freezes while the relay's own heartbeat — two consecutive failures trip AUTONOMOUS — showed the hub answering `/health` in ~4.5 ms during 31 of 33.

**Apply.** Find the writer (grep the label string), read every branch that reaches it, and list the states the label covers; if there is more than one, it is not a category. An error label that cites a URL or a host testifies about the environment of the process that emitted it, never about the disk: identify which process failed and who launched it before concluding the configuration is wrong.

### Count an event with a structural marker, never a human string

**Why.** 30/08, "125 Connection error" in the coordinator's transcripts against 6 filtered on `"isApiErrorMessage":true` — the rest was the agent's own prose about the incident, stored in the same files. 21/10, `cc_is_subagent=true` searched anywhere in a body returned 817/817 "sub-agent" on one machine, because the token was injected rule text present in every request of that lane; anchored on the billing header it gave 11 in 3 313 requests (0.33 %). The transcript repeats each assistant turn ~5.3× (2 009 entries, 382 `message.id`): 11.14 M output announced against ~2.03 M, and a scheduled-origin marker counted 503 cron fires where 288 were real — 215 were post-compaction resumptions carrying the same origin.

**Apply.** Use a field the producer typed for that meaning and anchor it in its structural context; print the context of three matches before publishing a share, and treat a uniform 0 % or 100 % on a heterogeneous population as a match on static text. Deduplicate by `message.id` / `uuid` before any total. Ask whether the marker describes a state (it never goes down) or an event — a state is not a counter. Reconstruct a usage counter the way its client merges it (a later frame wins only if greater than zero), never by a per-field max, which added an estimate to a real cache read and doubled a 239 k turn to 476 k.

### Treat every pattern as a hypothesis: print what it kept, and read one window unfiltered

**Why.** 24/08, the coordinator published that a class of relay failures was invisible from `/health` and sent a peer to look for it at the hub; twenty minutes later the failure sat in plain text in a log it had read hourly for two days — the grep held the relay's vocabulary (`forward failed|AUTONOMOUS|upstream`) and the line was the provider's (`Error [GLM Coding]: HTTP 429`), so it did not exist. The claim had slid from "invisible to instrument X" — true and demonstrated — to "invisible from this position", which had been inventoried for no other instrument. 25/08, a parser keyed on probe format v2 discarded 55,934 of 87,523 lines (64 %) in silence and "never above 7.5 h uptime" was published against a real 11.28 h. 20/09, a grep for `controller.error(` returned 2 hits, both comments — 0 real calls against 24 real `controller.close()` under the same filter; 21/09, a grep of a constant computed from another module returned 0 occurrences and "proved" a transition unreachable that executed fine.

**Apply.** Before concluding an event is absent, read ~30 raw lines around the window with no filter. Never widen "instrument X cannot see this" into "nothing at this position can see it" without listing the other instruments. After any parse, print retained/total lines; when several versions of an instrument wrote into the same file, verify they overlap and agree on the common period before merging. For a behaviour question, execute the code rather than grep a name (see *Verify the check ran, not just its exit code*).

### Pair a request with its response on (pid, counter) and a bounded time window, and print the collisions

**Why.** 11/09, pairing on `pid|counter` alone gave 1 394 attributions for 978 keys, with 1 017 on one machine against a total of 1 016 native serves — the result refutes itself. 19/09 the same error recurred eight days after it was written down: six machines in `[LEAK]`; with `0 ≤ ts_resp − ts_req ≤ 180 s`, 741 native responses, 100 % on ai-01, zero unpaired. In a container the proxy is pid 1 at every boot and the counter restarts at 1, so a dictionary key silently overwrites entries (9 236 request files for 7 170 keys = 22.4 % collisions, measured on one day).

**Apply.** Keep a list of candidates per key, filter on the time window, and refuse to pair rather than guess; "no candidate in the window" is a result. `scripts/CaptureUtils.psm1` defaults `-WindowSec 180`; `scripts/traffic-mxws.py` scopes the key by day and prints `keys=` / `collisions=` — a total is publishable only at zero collisions. Validate a dedup or grouping rule against a case read by hand: when the event cadence approaches the dedup window, the total collapses in silence (restarts under 300 s apart merged into one gave 8 published where 13 were real).

### Enumerate names and read heads; measure the cost of an opening first

**Why.** 11/09, over SMB on a 30 921-file corpus, `ls -t` never returned (killed at 240 s) and `find -printf` was killed at 200 s with 0 lines, while `[System.IO.Directory]::EnumerateFiles` listed the same 30 921 in 34.5 s. The cost is the stat per file, not the read.

**Apply.** Enumerate filenames, write the list to local scratch, filter on the timestamp already in the name, and open only the files retained — head reads only (~300 bytes for the envelope; the metadata block sits at the tail and a workspace marker deep in `messages`, so read the whole file only for the few files that need it). Before a long scan over a network share, time a small series of head reads and size the job from the measured cost per opening; on the hub corpus this discipline is mandatory and the readers now run head reads in a bounded pool (`docs/reference/traffic-analysis.md` §Machine attribution).

## Time and dates

### A dateless log needs a day index, and a published "Z" may be local

**Why.** 25/08, a probe log stamped only `HH:MM:SSZ`: two lines quoted at `02:00:40Z` (`uptime=40465` and `uptime=7061`) were 50 852 lines apart — a day — and read as simultaneous they said the two probes targeted different servers. A restart dedup wrote `177 - 81268 < 120` and swallowed the eighth restart. Across agents: a peer's deploy at "19:30Z" was 17:30:53Z in the reader's UTC log, and on 08/11 two hub-host incident reports labelled "Z" lined up with the outages measured from another seat only after a −1 h shift.

**Apply.** Parse to `abs = day*86400 + sec` and keep two named fields — `abs` for arithmetic, `sec` for display only; grep every remaining use of the ambiguous one. Before escalating a contradiction between two lines, print their line numbers. Before quoting another lane's incident time, align it against your own log; a whole-hour shift means local time — mark the time as supposed, not measured, and ask the owner for the UTC timestamp. Stamp your own output as full ISO with a zone.

### Name the population, the denominator and the convention

**Why.** 24–25/08, three conclusions in one night were each anchored on the wrong reference: a control taken 100 s after the measurement, the load of the minute *before* the episode, then "concurrency is correlated" from 3–7 streams — over the 2 488 comparable samples, slow points averaged 4.5 streams against 4.8 for normal ones, and the rate per band was not monotone (0.22 / 0.65 / 0.43 / 0.35 %). 08/09, a request presented as "the only real incident, unique among 20" — the full day held 179 unanswered of 1 370 (13.1 %), so its uniqueness was the sample size; three statistical tests over ~30 events overturned each other and only the last, on disjoint windows, said the resolution was 1/11 = 9 %. On another workspace of the fleet (05/10), `closingIssuesReferences` read 90.1 % of PRs attached where the repo forbids closing keywords by rule and puts the issue in the title scope, and a mirror repo carrying the same SHAs to 18/07 double-counts when added to a series — an API field measures a writing convention, not a practice.

**Apply.** Name the reference population and the denominator by class of event (same machine, same requested model, same day), never by the window that happens to be open. Compute the resolution of the data set before refining a method: an effect finer than that resolution gets no conclusion. A claimed unique or isolated observation is a statistic and needs its N. Before choosing an API field, read the repo's own convention; before summing two repos, compare their SHAs.

### An aggregate window hides the event and confounds the variable

**Why.** 18/09, "no service gap" on 361 responses over 20 minutes hid a 3 min 46 s window at zero (~110 requests lost); the duration of the zero, not the window mean, separates a fast restart from a real cut. 14/09, "×5 step on 13/09" was a bucket artifact: hourly, 5 350 OUT/req at 23h then 7 071 at 00h — a ramp that had started around 18:00Z on the 12th. 25/08, a message was titled "the hub slows from 61 min of uptime" — in that window 61 min of uptime *was* 23:36Z, and the cycle that separated the two was already on disk: 788 samples at high uptime, zero slow.

**Apply.** Around any claimed interruption, histogram per minute (per 10 s if short) over ±10 minutes. Before dating a regime change, print the hourly series across the bucket seam and check continuity at the join. Before naming a variable as a cause, ask what moves in unison with it in the window (uptime and wall clock, image version and restart, load and hour) and segment by cycle, session or deployment before aggregating: a confounded hypothesis does not only produce a wrong conclusion, it produces a protocol that will confirm it.

## From a reading to a verdict

### A return code is a symptom that aggregates states; record the discriminating field

**Why.** 25/08, 104 `rc=28` read as "event loop frozen" — `rc=28` covers "no SYN answer" and "accepted then silent", and the premise "the host is alive" had never been measured: the host was rebooting (856 s attributed to freezes were two reboots). The probe did not write `time_connect` on failure, so no re-read of the log could settle it afterwards.

**Apply.** List the states the code covers before naming a cause; if there is more than one, add the field that separates them (`rc=7` refusal, `rc=28` ambiguous, `rc=52` empty answer, `rc=56` reset; a non-zero connect time means TCP succeeded and the application was silent). A drop to `rc=7` in under 2 s is a restart or a crash, not saturation — congestion rises gradually. Record the discriminant even when it looks redundant: its cost is nil, its absence is final.

### Verify the check ran, not just its exit code

**Why.** Until #994 (measured 11/11), the root `typecheck` chained `bun --cwd packages/macos-bridge run typecheck` — cwd before `run` — a form that prints bun's usage and exits 0: every seat's "0 `error TS`" covered the CLI package only, while the bridge, actually run, was red. 20/09, the never-hang filter written into `CLAUDE.md` returned 5 hits on a PR; the same filter on `main` returned the same 5, all in tests that error a stream on purpose — a legitimate class that appeared after the instrument was written.

**Apply.** Require positive evidence of execution (`$ tsc --noEmit`, a file counter, a plausible duration); a `Usage:` line is a failure whatever the exit code. Split a chained command and verify each half at least once, and inject the mutation into each half. An instrument written into a document carries its date, its perimeter and its positive control, and you re-run it on the merge base before attributing a hit to a change. For a question about behaviour, execute the code rather than grep a name — a constant computed from another module returns nothing to a grep.

### Absence is a claim about a window and a base rate; silence is not DOWN

**Why.** 12/08, the coordinator reported a worker "DOWN" across six coordination fires while it was running an interactive session and shipped a `[DONE]`. 24/08, "the hub never exceeds 1 s" rested on 179 minutes with nothing above 1.03 s; nine hours later `/health` reached 7.8 s at zero load. Two episodes 4 h 36 apart produced a "period", and the next point missed by ×15.

**Apply.** State the window and the base rate in the same sentence ("on 179 min between 15:35 and 01:45, nothing above 1.03 s"). DOWN means no activity of any kind — message, worker report, capture; "no reply to me" is not DOWN. Wait for a second exemplar before characterising frequency, and never derive a period or a threshold from n points with n ≤ k+1. Test one out-of-sample point, with the tolerance announced first, before offering a model as an instrument to someone else.

### An anomaly explained is not an instrument fixed

**Why.** 25/08, "two probes interleave" explained 13 timestamp discrepancies; four hours later `ps -ef` showed four concurrent probes writing one log, 55 906 of 70 806 lines from a pre-fix version — 9 restarts published where 6 were real. The same day, a log line added at "All retries exhausted" sat in dead code (the loop's last iteration exits through `return response`), and a test passed its assertions without printing the line: the absence in stdout was the proof.

**Apply.** When an anomaly is explained by an unexpected tooling state ("there are two probes", "this file has two writers", "that process is still running"), the explanation opens the action: check the state, then fix the source — filtering downstream is not a fix. `ps -ef | grep <script>` before reasoning on a log you feed. Verify a log line by seeing it, never by a green test.

### Measure the mechanism's share before optimizing it

**Why.** 24/08, 16:33–17:12 (39 min, a deployment window): three hub restarts cut at least 13 agent turns, while the abort cascade the day had been spent on cut 0 — the measured abandonment rate was ~1.66/h, so ~1.1 was expected, a ratio of at least 12. On a sidecar an abort is a switch, not a loss: the request is served locally.

**Apply.** Before optimizing a mechanism, count the events it actually caused beside the other mechanisms in the same window. A mechanism that fails over locally costs a switch; a restart cuts every in-flight stream with no recourse. Count episodes, not samples — duplicated independent sampling improves a median and inflates a count.

### A number that breaks a bound refutes itself

**Why.** 29/08, the coordinator published 805 Opus requests from one seat over six hours; the cluster total was 329, and the hub is upstream of everything that seat emits, so `transcripts > hub` is impossible by construction. The cause was that `agent-*.jsonl` files replay the same `message.id` (ratio 2.46; deduplicated 310 against 315) while the search was aimed at the other lane's instrument.

**Apply.** Before publishing a number that contradicts another source, look for the bound it violates — an upstream total, a conservation, a total that includes yours. If it violates one, the defect is yours and the investigation stops there. When a peer names a hypothesis about your own method, test it before the ones about theirs. Keep a column that must be coherent (requested model against served backend) in every table: it is the cheapest self-refuting control.

## Per-machine state

### One row per machine, each cell read on the live object and dated

**Why.** 29/09, the user observed that the coordinator had very quickly lost sight of each machine. Measured the same day: the coordinator's own client pointed at the hub while its sidecar served a single lane, and the deployment documentation still named a host that no longer answered. 24/10: a seat's published snapshot was a day behind a live edit — `.50:3000` and `opus` in the file, `127.0.0.1:3002` and `sonnet` in the snapshot.

**Apply.** Read the fleet with `python scripts/settings-matrix.py --shared <dir>` every cycle. A cell is read on the live object, or on a snapshot republished the same day — a snapshot is republished only by a gesture. A relay's presence is measured by `/health` on the port the settings will name, never by `docker ps`: one lane read "no container, `:3002` silent" while a native process was serving on another port. Every line written in the matrix carries its measurement date.

### A fix on one seat is not a fix on the fleet; verify the entry condition

**Why.** 27/10, one machine's embedder died after a 00:17 reboot: Docker Desktop had been started by the Task Scheduler in session 0 (elevated), `wsl --terminate docker-desktop` fails in that context, and the logon guard (RunLevel=Limited) cannot repair an elevated instance — it fails exactly in the only case it would be needed. The task that launches it at boot is still not established, and the same untested entry condition was common to the rest of the fleet.

**Apply.** At a boot incident, name the entry condition (who launches what, in which context, with which privilege) and check it on the other seats — a per-seat diagnosis is not a fleet diagnosis. Before a scheduled reboot, re-read the recent boot incidents and announce the condition to check: a reboot is a test of the entry condition, not a lottery. A `[ERROR]` another lane posts is a fleet measurement, not an anecdote.

### A disengaged component is a decision until proven otherwise

**Why.** 31/08, the coordinator had spent four cycles presenting a client repoint as an improvement awaiting arbitration; the user answered that the sidecar had been deliberately disengaged after a relay defect. The `[ASK]` on the ordering became moot, not decided — there was a condition to meet, not an order to arbitrate.

**Apply.** Before recommending to restore, enable or repoint anything currently disengaged, look for why it is (archived dashboard, git history, messages to the other lanes), and failing that ask "is this deliberate?" before "why not now?". The absence of a visible reason is not the absence of a reason.

## Publishing the number

### Date and scope every figure you publish

**Why.** 04/11, three false statements in one report, all local-or-dated read as the fleet's present: "swift sees no claudish request" from five lines of *one* sidecar's log (all from 01/11, from an image that did not parse the alias); "GLM walled until 16:19Z" where the provider's clock is UTC+8 — 08:19Z — an hour that had already passed when the user read it, and said so; "105 k tok/req, 64 % MCP", the 13/09 measurement taken *before* the 15/09 change, while MCP measured 5.5 % on 04/11. The same report remade by hand a ratio the owning lane had already published as canonical, in a form two peers had explicitly refused.

**Apply.** Date the source and say whether it is local; read the owning lane's latest report before restating a fleet state; convert every provider reset time explicitly to Z; re-measure a remembered figure before quoting it as current. Before measuring a contested number, read the last two comments of the issue that carries it.

## Already covered elsewhere in this repository

| Lesson | Where |
| --- | --- |
| A rotated log corpus makes `--since` serve a stale segment and an oversized `--tail` return zero lines; the live instrument refuses a verdict (`UNKNOWN`) instead, and a zero is cross-checked with `--tail` ≤ 800 | `.claude/skills/claudish-coordinate/SKILL.md` §Phase 3 · `docs/reference/traffic-analysis.md` §Scripts |
| Reading the hub corpus over UNC costs ~95 ms per file opening; head reads run in a bounded pool (#997) | `docs/reference/traffic-analysis.md` §Machine attribution |
| Off-site archives are machine-tagged, the destination is read before the copy and a different size refuses it, and the local purge stays downstream of that decision (#201/#208/#322) | `docs/reference/ops-scripts.md` §The shared off-site archive namespace |
| Provider consoles are read through one persistent browser profile, reloaded before each reading, never by a guessed URL; a valid sweep reads 11 tabs | `docs/reference/subscription-consoles.md` §The console profile · §A tab is not a live view · `.claude/skills/claudish-coordinate/SKILL.md` §Phase 4b |

## Provenance

| Rule | Source note (ai-01 memory slug) | Dated |
| --- | --- | --- |
| Build the instrument before you publish the number | `build-the-instrument-before-publishing-the-number` | 21/08/2026, extended 24/08 · 08–09/09 |
| Put the probe at the first point the client's bytes reach | `an-instrument-behind-a-hop-measures-the-hop` | 02/10/2026 |
| A control that cannot fail proves nothing | `a-check-against-a-copy-proves-nothing` · `measurement-method-pitfalls` §negative-result | 14–21/09/2026 · 19/09 |
| A control is parallel and shares no suspect component | `measurement-method-pitfalls` §sequential-control · §two-instruments · `icmp-loss-is-not-path-loss` | 25–26/08/2026 |
| Choose an instrument with a zero baseline | `enumerated-blast-radius-gives-a-zero-baseline` | 20/09/2026 |
| A capture is one link, not a mirror | `capture-corpus-reading` §resp-capture-downstream · §captures-cannot-contain · §capture-corpus-is-blind · `proved-my-instrument-blind-then-quoted-it` | 28/08 · 08–11/09 · 15/09 · 29/10 |
| Every unseen field prints itself | `an-instrument-blind-spot-must-print-itself` | 05/11/2026 |
| State the window you actually read | `capture-corpus-reading` §corpus-live-truncates · §local-capture-dir · `captures-retention-7-days-hub` | 12/09 · 18/09 · 28/10 · 03/11 |
| Read the code that writes the label | `log-label-is-not-a-failure-taxonomy` · `error-label-describes-the-process-not-the-disk` | 23/08 · 06–07/09 |
| Count events with a structural marker | `capture-corpus-reading` §corpus-contains-commentary · §transcript-duplicates · `measurement-method-pitfalls` §state-marker · §context-size · `scheduled-turn-origin-includes-continuations` | 30/08 · 14/09 · 21/10 · 29/09 |
| Treat every pattern as a hypothesis | `grep-pattern-is-a-hypothesis` | 24–25/08/2026 · 20–21/09 |
| Pair on (pid, counter) and a bounded window | `capture-corpus-reading` §pid-counter-pairing · `restarts-outrank-the-abort-cascade` (dedup) | 11/09 · 19/09 · 25/08 |
| Enumerate names, read heads, cost the opening | `capture-corpus-reading` §smb-corpus-enumerate · `hub-corpus-over-unc-costs-per-open` | 11/09 · 01/10 · 11/11 |
| A dateless log needs a day index; a "Z" may be local | `dateless-log-needs-a-day-index` · `a-published-z-time-may-be-local` | 25/08 · 08/11 |
| Name the population, denominator and convention | `measurement-method-pitfalls` §wrong-comparison · §refinement · `july-regime-measurement-for-coursia` | 24–25/08 · 08/09 · 05/10 |
| An aggregate window hides the event and confounds | `measurement-method-pitfalls` §wide-window · §day-bucket · §confounded-variables | 18/09 · 14/09 · 25/08 |
| A return code aggregates states | `a-return-code-is-not-a-diagnosis` · `restarts-outrank-the-abort-cascade` | 25/08 · 23/08 |
| Verify the check ran, not just its exit code | `exit-zero-can-mean-the-check-never-ran` · `a-documented-instrument-goes-stale-as-the-corpus-grows` · `grep-pattern-is-a-hypothesis` (execute, never grep) | 11/11 · 20/09 · 21/09 |
| Absence is a window and a base rate; silence is not DOWN | `do-not-conclude-down-on-silence` · `log-label-is-not-a-failure-taxonomy` (points 4–8) | 12/08 · 24/08 |
| An anomaly explained is not an instrument fixed | `explaining-an-anomaly-is-not-resolving-it` · `an-observability-fix-can-be-invisible` | 25/08/2026 |
| Measure the mechanism's share before optimizing it | `restarts-outrank-the-abort-cascade` | 24/08/2026 |
| A number that breaks a bound refutes itself | `measurement-method-pitfalls` §count-exceeding-an-upper-bound | 29/08/2026 |
| One row per machine, read live and dated | `keep-a-per-machine-control-matrix` | 29/09 · 20/10 · 24/10 |
| A fix on one seat is not a fleet fix | `a-fix-on-one-seat-is-not-a-fix-on-the-others` | 27/10/2026 |
| A disengaged component is a decision | `absence-of-a-reason-is-not-absence-of-reasons` | 31/08/2026 |
| Date and scope every figure you publish | `a-local-or-dated-figure-presented-as-current` | 04/11/2026 |
