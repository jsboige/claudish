# Review, test and merge protocol — rules earned by incident

This page is for an agent about to review, test or merge a pull request on `jsboige/claudish`, or about to close an issue. It records what this fleet has learned about the *measurement* — what a diff, a test, a CI run and an issue state actually prove — and the order in which to distrust them. Every rule below was paid for by an incident; the dates and numbers are the ones the notes carry.

## How to use this page

Rules are grouped by the moment they apply: before reading the PR, while reading the diff, while judging tests, while mutating guards, while reading CI, while merging, and while writing the review. "The coordinator" is the agent lane that reviews and merges for the fleet; most of these incidents are its own. House terms are defined on first use: a **pin** is a regression test that fixes one behaviour; a **mutation** is breaking a guard on purpose to watch a test go red; an **AC** is an acceptance criterion of an issue; the **merge base** is `git merge-base <target> <branch>`, the last common commit — not the target's head. Rules already stated in `CLAUDE.md`, `docs/reference/` or the skills are only pointed to in the table at the end, never restated.

## Before you read the PR: the state you are measuring

### Measure the merge base; the diff you are shown is not the diff you are merging

**Why.** On 2026-09-21 PRs #195 and #196 announced disjoint scopes, but against the common base #196 showed 7 files, including the 5 TypeScript files of #195: it had been branched on #195's branch. Merging #196 first would have landed #186's unreviewed work under #184's name. The same error ran the other way on 2026-09-20: `git diff main..pr162` showed 91 deletions of a file a peer appeared to have erased, but `main` already contained #163 merged 12 minutes earlier and the branch predated it; against the merge base the diff was empty.

**Apply.**

```bash
mb=$(git merge-base origin/main origin/<branch>)
git log --oneline -1 "$mb"
git rev-list --count "$mb..origin/main"
git merge-base --is-ancestor origin/<A> origin/<B> && echo "B is stacked on A"
```

Merge in the order of the stack and re-measure the next PR's perimeter: after #195 merged, #196's diff fell back to its 2 real files. The shrinkage is the confirmation that the order was right. The coordinator skill forbids stacking, but a reviewer meets stacks already open.

### A control is only as independent as its instrument

**Why.** On 2026-09-13 a valid negative control (a manual backup taken before the edit, 5/5 failures) was redone "cleanly" with `git show HEAD:<file>` — HEAD was the change itself — and returned 5 pass / 0 fail, the exact inverse. On 2026-10-26 eleven v14 test failures were reproduced identically on three "bases" that were all checked out by the same CRLF process: one environment variable fabricated the constancy (LF fixtures 126/0; the same 32 fixtures in CRLF: exactly the 11 failures). The same variable inflates counters — `bun run lint` read 1 243 errors on a Windows checkout against 67 in the LF CI — and a tracked-file byte gate counts the blob, not the working tree (+1 B per CRLF line).

**Apply.** Put the baseline outside the commit's lineage: a copy taken before the edit, `git show <sha-parent>:<file>`, or a stash. Prove the baseline does not contain the change (`grep -c <new-symbol>` → 0). A "pre-existing everywhere" claim requires bases served by independent instruments. For line-ending-sensitive measurements, check `git ls-files --eol <file>` first, compare with `git diff --ignore-cr-at-eol`, and read the blob with `git cat-file -s <ref>:<path>`; the byte gate is `packages/cli/src/test-support/harness-budget.test.ts`.

### Open the evidence you cite, and ask an artifact's producer whether it has finished

**Why.** On 2026-10-13 a [DONE] cited two comments as proof whose bodies were the literal `@C:/…` path: `gh --body @file` publishes the string, not the file — six empty publications had accumulated since 07/10. On 2026-10-18 a cited SHA did not exist (`git cat-file -t` → "Not a valid object name"). On 2026-09-21 an archive read 5.25 MB against 194-285 MB for the four previous days and looked failed; the producer's log ended in `START` with no `OK`: the job was 15 minutes into a task that normally takes 63-130 minutes, and the file was being read through a lagging replica.

**Apply.** Open the comment, and check the SHA (`git cat-file -t <sha>`, `gh api repos/jsboige/claudish/pulls/N --jq .head.sha`). For an artifact, read the producer's journal for a `START` without a closing line and compare elapsed time with the typical duration, not size with final size; name the layer you read (replica or source). Publish bodies with `--body-file`, never `--body @file`.

### Before you run the suite or clean the clone, read what the tree actually contains

**Why.** Until #243 (`cb4d7c8`, 24/09) three test files overwrote the real `~/.claudish/config.json`; on 23/09 that destroyed two production configs, and on ai-01 two concurrent suites left `{}` because the second copied the first's fixture. On this fleet `~/.claudish` is live state — containers bind-mount it. Symmetrically, an untracked file is not garbage: a VBS launcher left untracked in the clone was yet run nightly by a user-level scheduled task; deleting it during "clean clone" housekeeping would have stopped the nightly compaction with no signal.

**Apply.** `packages/cli/bunfig.toml` must carry `[test] preload = ["./src/test-preload.ts"]`; without it, do not run the suite. Do not kill bun by image name; `process.on("exit")` never fires under `bun test` (a preload's global `afterAll` does), and Bun on Windows reads `USERPROFILE`, not `HOME`. Before deleting an untracked file, check `Get-ScheduledTask | ? { $_.Actions.Arguments -match '<name>' }` and report the file as a justified exception until it is moved out.

## Reading the diff: the claim against the code

### A stated reason is an assertion: test it

**Why.** Commit `67a3431` added `--host 127.0.0.1` and justified it by a proxy key reachable from the LAN; `standalone-proxy.ts` had defaulted to loopback since `985643d`, three months earlier — a behavioural no-op whose false justification travelled into an upstream PR and made the real fix (two test `Bun.serve()` calls, PR #17) look redundant.

**Apply.** Keep two verdicts separate: "is this diff harmful?" and "is the stated cause true?" Test the claim against the code the diff itself carries. A no-op justified by a false cause is worse than a plain no-op, because it closes an investigation that was still open.

### A comment is a dated spec, and the executable copy wins

**Why.** In `relay.ts` the `FORWARD_HEADERS_TIMEOUT_MS` docstring said "This is NOT a liveness detector"; 150 lines below, the same deadline's `catch` called `markFail`, the liveness counter — the comment was right and the code had drifted (fixed by subtraction, PR #47; 23 fallthroughs on the deadline, 21 on a single threshold failure, one machine-wide AUTONOMOUS flip of 3 min with the hub healthy). On 2026-09-19 the coordinator skill read 5 h in prose and `37 */3` in the `CronCreate` template; the template is what re-arms a lost cron. And a registry entry spent three cycles claiming a bold `CLAUDE.md` line was contradicted while the sentence after it already stated the reservation.

**Apply.** On a code/comment conflict, arbitrate by finding which version produces the observed behaviour; grep the function name, not the concept. When a document holds prose plus a template, grep the old value across the file and patch the executable copy in the same gesture. Before declaring a rule contradicted, read the paragraph to its end — the reservation often follows the bold sentence.

### Establish that the replaced code ever ran

**Why.** PR #209 changed a connection error from 503 to 400; its comment was right that both stop the fallback chain. But the 503 branch never ran: on Bun, `fetch` does not fill the Node errno names, so the guard matched nothing and real failures took the final `throw` — which `FallbackHandler` catches and turns into the next provider. The diff compared 503 with 400; the real "before" was a successful provider failover, and that regression appears nowhere in the diff.

**Apply.** Before comparing behaviour with what you replace, name the path that actually executes on the real runtime. A guard that never matches, a branch behind a disabled flag, a `catch` whose condition is false on Bun — each moves the behaviour to a third place the diff does not show. A green test pinning the old behaviour proves the author's intent, not that the intent was right: read the invariant's justification, not only its assertion.

### A verified premise is not a verified conclusion; a correction needs a discriminant

**Why.** On 24/08 a premise was verified exactly (`providerConcurrency["glm-coding"]=6` → `ConcurrencyLimiter(6)`) and an effect was published from it: PR #46 would reduce aborts. False — the request releases its slot but still runs its own 62.5 s ladder and still aborts at the 30 s deadline. On 25/08 a correct diagnosis ("starved runners") was "corrected" into a false one from `created_at`→`updated_at` wall-clocks; `job.started_at` later showed 9 seconds of work behind 6 h 24 of queue. The correction felt like humility and had no discriminant.

**Apply.** After verifying a premise, ask what proves the conclusion — "the premise" is not an answer; walk one concrete case end to end before publishing. Before publishing a self-correction, name the measurement that separates the old version from the new; if you cannot, you have a second hypothesis, not a correction. A wall-clock is never an execution time.

### A clean application is not a covering change

**Why.** The Qwen pick `9199adb4` for #602 applied without conflict and `test:strict` showed no regression, but upstream's line sat at the end of a method with no early return, while the fork's `disabled` (the default) and `budget` policies `return request` before it: the fix ran only under `passthrough`. On 2026-11-05 PR #865 ported `admission-freeze.ts` "verbatim" with 8 pins and 3/3 mutations; the module was identical, but the gate in `proxy-server.ts` had lost the `x-claudish-drain-freeze: 1` header that the target base already consumed — a freeze would have flipped every sidecar to AUTONOMOUS, exactly what the freeze exists to prevent.

**Apply.** For every port, cherry-pick or extraction: (1) diff each call site against the source, not only the module called "verbatim"; (2) count `test(` in the source suite against the ported suite and justify each gap one by one; (3) for each header or field the source emits, `git grep` its consumer on the target base — if the consumer exists, the omission is a wire defect, not a scope reduction; (4) read the whole arrival method, list the paths that reach the added line, add one pin per path, and kill the mutant that restores upstream's position.

### A diff that removes more than the task asked is a regression in disguise

**Why.** On 2026-08-20 a compose recreation meant to remove one variable also removed every `CLAUDISH_FAILOVER_*` cascade line, unannounced. The recreated container was `healthy` and answered `/health`, but served nobody; and the recreation cut the container the machine's agents were running through.

**Apply.** Reject or ask about any removal beyond the task's scope. After editing compose, compare the rendered environment by value before recreating (`docker compose config`): a name absent from the render is a regression even when the file "works". The fleet rule for recreates is in `CLAUDE.md` §Relay / Sidecar Mode.

### A pointer is not preservation

**Why.** On 2026-10-19 PR #523 replaced a measured line ("67 across 5 files on win32, bun 1.4.2 — 31 env-gated skips") with a pointer to `docs/reference/channel-mode.md`; that file never held the numbers, and `git log -S` only touched `CLAUDE.md`. The fact was deleted, not moved. For a deletion the analogous proof is per item: on 2026-11-10 `7z t` plus size and double sha proved an archive sound, not that it contained every file about to be purged, while the test stub wrote the same body whatever names it received.

**Apply.** For a thinning change, extract the distinctive tokens of each removed line (backticked identifiers, measured numbers, versions) and `git grep -F` each in the result; read every hit by hand (odd backticks manufacture false positives, two-digit numbers escape length filters). For a purge, require a per-item listing (a 7-Zip `l -slt` Path/Size listing against the purge list, through the binary the machine actually has); container integrity is not that proof, and a stub that ignores its inputs cannot pin a guard about those inputs.

## What a test proves — and what it does not

### A missing dependency must fail, not skip — and a green test can measure the wrong process

**Why.** The fork's must-not-regress suite probed an export that never existed; the test took a `[skip]` branch on every run, asserted nothing and counted as green — and its assertion encoded the pre-fix header contract. Of its 12 `[skip]` guards, one other actually fired. On 2026-08-25 a stats-buffer test passed on both sides of its fix because an unused named import was elided by bun/esbuild, module side effects included: 0 listeners were registered, and the test observed an unrelated process (a single unused named import gives 0 listeners; a namespace import plus one reference, or a bare import, gives 1).

**Apply.** In a non-regression suite a missing module fails; skip is reserved for genuinely optional dependencies and must be loud. Before trusting a green, run it against the unfixed code — and if removing the fix also removes the API the fixture imports, re-simulate the old bug with the API in place. When a test depends on a module-load side effect, make the fixture assert that the effect happened. On Windows `process.kill(pid, "SIGTERM")` is `TerminateProcess` and delivers no JS signal; use `process.emit("SIGTERM")`.

### A synthetic fixture encodes what you believed, not what the provider sends

**Why.** `regression-zai-server-tool-use.sse` was hand-written. A live capture on 2026-08-11 showed the input arriving whole in `content_block_start` with zero `input_json_delta` (the delta path the fixture exercised never runs), an assistant-side `tool_result` block, and an index-desync bug — three real defects the fixture could not reach. Variants: tests that pass the bucket in hard-coded bypassed `nominalBucketOfModel()`; a reader invented a `metadata.user_id` field where the flag lives in the system header, so every row read `0/0`; and a flattened `usage` regex read 0 of 123 real native captures because real `usage` objects contain nested objects.

**Apply.** Capture once against the real provider — the raw SSE is the fixture. Assert on the parsed type (`blockTypesOf`), never on a `"type":"…"` substring, whose spacing varies by provider. For a parser, run the branch's real functions on a real sample per handler and compare "files containing the raw field" with "files where the parser found it"; a uniform zero on every row is a blindness signal, not a measurement. Make the instrument count parse failures instead of absorbing them.

### Read what a red test demands before making it green

**Why.** On 2026-09-21 `failover-stream-notice.test.ts` was red on `main`, in isolation: `expect(first).toContain("conservative")` demanded the exact wording #126 had removed after a fleet agent flagged it as prompt injection. The obvious way to green was to reintroduce the defect; the real guard (`not.toContain("conservative")`) sat unread in the same file, because a durably red file stops being opened.

**Apply.** Run the red test alone; if it survives isolation it is an ordinary defect, not the environmental class. If the assertion demands a behaviour the doctrine forbids, fix the assertion to the sanctioned form and add the absence of the retired wording. When a wording is retired by decision, grep the tests too.

### A test that passes the parameter itself proves the callee, never the caller

**Why.** PR #284 covered `markStepFailed(..., wasNominal=true)` and the branch reading it with green unit tests that passed `true` themselves; the production caller computes the flag by an equality that, by construction, can never hold — dead branch, green suite. Variants: a fix silenced the diagnostic its own test fed with an empty value (PR #290); a boot-injected vision policy was 47/47 green with the boot wiring commented out (PR #313); a PowerShell `-Detach` shipped 5 green Pester tests while the entry block `$detach = Start-DrainDetached …` collided case-insensitively with the typed `[switch]$Detach`, so 100 % of real calls exited 4 with a live child (PR #338).

**Apply.** For every new flag, seam or parameter, find the production caller and check each tested value is reachable from it; if that layer has no test, replay its calculation on a realistic config. For a boot-injected seam (`set*Policy`, `set*Resolver`), require one test through `createProxyServer` and mutate the boot line. For a PowerShell script, require one end-to-end `powershell.exe -File <script> <args>` test and grep every `$name` for a case-insensitive collision with the `param()` block.

### A counter that moves the right way is not proof if the instrument cannot see the defect

**Why.** On 2026-10-17 PR #511 replaced `<span bold>` with `<sb>` in `tui/App.tsx` and cited tsc 227 → 130 as proof; `sb` appears 83 times and is not an intrinsic in the opentui catalogue, yet tsc gives the same 130 with `<sb>` and with `<b>`, because it does not type unknown lowercase JSX tags. A `testRender` probe showed `<b>` rendering `[bold?]` and `<sb>` rendering an empty frame plus `console.error` — and React reports the failure through `console.error`, it does not throw.

**Apply.** For a UI/TUI PR, mutate the tag to an invented name and re-measure tsc; if the number does not move, tsc is not a guard. Require a guard that catches the class: catalogue membership for every lowercase tag, or a `testRender` probe capturing both the frame and `console.error`.

### Test the branch the first deployment will meet

**Why.** On 2026-10-03 PR #314's drain read `admissionFreeze` from `/health`; the tests covered a confirmed flag, a mount mismatch and a dead URL, but not "valid answer, field absent". The mutation "absent ⇒ flag" survived 25/25. That is exactly the branch the first `-Recreate` on every machine meets: the drain interrogates the container it is about to replace, which predates the PR by definition.

**Apply.** Whenever a script reads a field the same PR adds to the proxy, require a pin for "valid response, field absent", mutation-checked separately from "no response", and a distinct log token (the shipped drain uses `proxy=absent`) so the first deployment's line explains itself.

## Mutating the guards

### Mutate every guard the change transports — and run any mutation a comment promises

**Why.** On 2026-09-29 PR #278 extracted the prober loop "behaviour-identical"; the author's mutations on the new detection all held, but the transported "one deep probe in flight" guard (`!probingStates.has(state)` → `true`) produced 0 failures — it had never been tested. Variant 2026-10-24 (#628): an extraction moved a shared-state read across an `await`, so another request could change the credited owner; suite and author's mutants stayed green. Separately, PR #715's test carried "Mutation pin: drop the empty guard and this goes red with 0"; removing `raw.trim() === ""` left 6/6 green, because `Number("") === 0` is caught below by `n < MIN` (2000).

**Apply.** List the guards the moved code carries — locks, bounds, early returns — and mutate each. A guard that survives its own removal is a non-blocking "pin it" issue, never "nothing to report". In an extraction, check every shared-state read stays on the same side of each `await`, and pin the order if it moved. For any comment promising a red, apply the mutant yourself before merging, even on a peer's healthy diff: if nothing goes red, the code is not condemned — the sentence is, and it must be corrected at the author's before it is copied into a doc. A redundant guard may be legitimate defence in depth; do not remove it to make the claim true.

### A mutation counts only if it proves it applied

**Why.** On 2026-11-13, on PR #1020, two mutations launched to prove the guards of a structural pin both returned "7 pass": a `sed -i` whose pattern carried regex characters the shell had escaped, then an inline `python -c` whose bytes the shell had rewritten. In both cases the file had not changed — zero occurrences replaced. The green said nothing about the guard; it said the mutation had not happened. A mutation that does not apply produces exactly the output of a useless guard: read without proof of application, it leads either to removing a guard that works or to declaring proven a pin that was never tried.

**Apply.** Mutate with an exact-replacement script that counts the occurrences of its target and refuses (non-zero exit) unless there is exactly one, then prints `applied <name>`; read and write with `newline=""` so line endings are untouched. Never `sed -i` with a regex pattern for a mutation, never an inline one-liner carrying quotes or backslashes. Read both lines in the output: `applied …`, then the expected red with the test's name. A green after `applied` is a real result (the guard is not covered); a green without it is not a result. Restore from a copy, check the hash, and confirm `git status --short` is empty. Give a reviewing sub-agent the same instruction in its brief.

### Replay the whole mutation pass after adding an exception

**Why.** On 2026-11-09 #953 added a tolerated "truncated window" case; replaying all mutations, the old `string-key` mutation survived because the pairing test's request was also the first of its corpus, so its now-unmatched response fell into the new tolerated window and the verdict passed anyway. The fix was an anchor request much earlier in the corpus, plus `assert "Fenetre tronquee" not in out`.

**Apply.** After any new exception, fallback or "declared, not refused" path, re-run every mutation, old ones included. In each test that guards something else, assert the exception did not fire.

### A strict guard is right only relative to what it guards — and never arm a kill whose residue it will misread

**Why.** On 2026-09-22 the remedy proposed for #214 (make the VBS launcher wait so the exit code reaches the scheduler) would have activated an inert 3-hour task limit. `compress-captures.ps1` copies straight to the final name with no rename, so a kill mid-copy leaves a truncated file under the definitive name; the next night's size guard (`Get-OffsiteWriteVerdict`) sees two different sizes and refuses, the purge skips, and while the local archive survives (no data is lost) the day never leaves off-site again and every night re-refuses. A guard designed against an external producer read an internal residue as one.

**Apply.** Before arming a timeout, a kill or a cancellation on a path that writes, ask what the interrupted write leaves behind and what downstream guards will make of it. Do not loosen the guard to accommodate the residue — do not arm the kill. When a remedy is observed at a value that never varied, demand a provoked failure to prove the value can move. The size guard and the downstream purge are documented in `docs/reference/ops-scripts.md` §Nightly compaction and the watchdog.

## The CI and what it cannot see

### Every commit goes through every gate, the test-only ones included

**Why.** On 2026-11-13, the second commit of PR #1020 touched one test file. The test and the lint were re-run on it; the typecheck was not, on the reasoning that a test-only change could not break it. CI's gating `typecheck` job went red: an expected-findings array held in a `const` had widened a union-typed field to `string` (TS2769, two call sites). The first commit of the same PR had passed all three gates, which is what made skipping one feel safe.

**Apply.** The gate of a commit is the same three commands whatever the commit touches: the test files concerned, `bun run --cwd packages/cli typecheck`, and biome on the touched files. Test files are in the typecheck's population. Quote each gate in the PR body with the SHA it ran on, so that a gate run on an earlier commit cannot stand for the head.

### A Windows-only hang is invisible to CI: replay on a seat

**Why.** On 2026-11-05 #868's `relay.test.ts` hung under bun 1.3.13 on Windows: an `AbortSignal.timeout(ms)` timer is the only pending handle, so the abort never fires and bun's own per-test timeout does not fire either — the whole process hangs with no output. CI stayed green because it has no Windows runner. A standalone probe fired at 1011 ms as soon as any ref'd `setTimeout` existed, and never without one.

**Apply.** For any PR whose tests wait on an abort or a timeout, replay locally on Windows whatever CI says. The test-side fix is a keep-alive timer cleared in the abort listener; production is unaffected when a heartbeat interval is pending. When a suite hangs with no output, bisect with `bun test -t '<name>'` before suspecting the code under test. The bun trap itself is documented in `docs/reference/test-strict.md` §bun test traps.

### A merge into `replatform/v14` runs no CI; replay the combination locally

**Why.** Measured 2026-11-13: `.github/workflows/test.yml` triggers on `pull_request` and `push: main` only; `gh run list --branch replatform/v14` is empty and the merge head carries no check-runs. A post-merge CI observer polled 25 times in vain. Each v14 PR is therefore tested only against the base it had; two PRs merged one after the other are tested together only at the final v14 → main PR.

**Apply.** After stacked merges on v14, replay in a detached worktree under `.tmp/` with its own `bun install --frozen-lockfile`: typecheck, then the test files of the touched modules. Compare the names of failures with the commit before the first merge — an empty diff means no regression; do not count failures. Do not use local lint on a Windows seat (1 364 CRLF errors) or seat-specific pre-existing reds as evidence. The durable fix is to add `replatform/v14` to the `push:` branches.

## Merging, and closing the issue

### Merge a stack in order, and never `--delete-branch` on a parent

**Why.** On 2026-10-15, on stack #466→#468→#471→#472, `gh pr merge <parent> --squash --delete-branch` CLOSED child #468 without retargeting it; a closed PR whose base is gone cannot be reopened or retargeted. After the parent's squash, each child conflicts, because the squash and the child's rewrite appear as two concurrent edits of the same lines. On 2026-10-25 a parent closed without merge and without a comment read exactly like lost work until a child's history was checked.

**Apply.** Merge the parent WITHOUT `--delete-branch`, then `gh pr edit <child> --base main`. For a conflict, resolve with `git merge-tree --write-tree --merge-base=<old parent head> origin/main <child>`; prove equivalence with `git patch-id` (the patch must equal `git diff <old parent head> <child>`), then `git commit-tree <tree> -p <child> -p origin/main` and a fast-forward push, no force. Delete branches only once the whole stack is merged, refresh each child on the new head after each merge, and if a parent was closed, prove preservation from the child's history (`git log origin/<child>` shows the parent head) before calling it a loss. Comment every stack closure with who, why, and where the content lands.

### Three channels close issues; verify their union, not the one you aimed at

**Why.** On 2026-09-20, merging #174, the PR body said `Closes #173 / Refs #172` and the squash message supplied said `Closes #172 / Refs #173` — in mirror — and GitHub closed BOTH at the same second. Supplying `commit_message` controls the history text, not the closing keywords. On 2026-10-07 a conditional in prose — « (Closes #72 sur la dernière mergée) » — closed #72. On 2026-10-09 #421's branch commit message carried `Closes #418` while `closingIssuesReferences` was empty: that instrument answers for the body only, and the default squash copies branch commit messages.

**Apply.** Before a merge, read the PR body's keywords, `git log --format=%B origin/main..origin/<branch>`, and the graphql `closingIssuesReferences` (`gh api graphql -f query='{repository(owner:"jsboige",name:"claudish"){pullRequest(number:N){closingIssuesReferences(first:5){nodes{number}}}}}'`); after the merge, check every issue cited by ANY channel. Never write `Closes|Fixes|Resolves #NN` to talk about a closure. Do not park a follow-up on a closed issue: open a tracker and post a linking note. Check author identities before the squash (`git log --format='%an <%ae>' origin/main..pr/N`) and supply the merge message with `--body-file` if a placeholder appears.

### An issue is judged on its predicate and its ACs, not on its merge or its pin list

**Why.** On 2026-09-12 #65 looked finished — PR #88 merged, an ancestor of the live checkout, regression test and negative control present — but its AC3 said "No retry of the unmodified body", exactly what the shipped fix does (transparent retry of the identical body); AC1 and AC2 were unmet and the fix covered one lane of three. On 2026-11-10 #967 implemented the issue's `SEED MISMATCH` with `-gt` (file newer than the record) while the issue's definition said `LastWriteTime < recorded`; both Pester pins were written in the same inverted direction, so 102/102 + 9/9 passed on both interpreters. The issue's own step 3 carried an ambiguous phrase contradicting step 2, and the PR followed the ambiguous line.

**Apply.** Reread the full body, AC section first, and verify each AC in the code rather than the title's symptom. If an AC is deliberately contradicted by the fix, publish the divergence and ask — a design supersession is an arbitration, never a silent close. Before merging an implementation of an issue step, restate the step's predicate from the issue's definition AND rationale and compare the code's operator; when the issue contradicts itself, the rationale arbitrates, and the review says so. A green pin count, a green bar or a CI conclusion never arbitrates. A PR that resolves an issue carries `Closes #NN` in its body (`CLAUDE.md` §Build, Release, Versioning).

## Writing the review, and talking to the producer

### A review is a measurement at an instant: write the SHA and re-fetch before posting

**Why.** On 2026-09-20 a complete review of PR #174 was written against head `3837030`; meanwhile the peer pushed `c2dc8eb`, which removed the wedge actuator per AC4. Two sections became false in opposite directions: the review approved an actuator that no longer existed and withdrew a constraint the peer had just satisfied. Only a rejected non-fast-forward push caught it. Structural corollary: every machine pushes under the same account, so `POST /pulls/N/reviews -f event=APPROVE` returns 422 "Can not approve your own pull request"; a cross-machine review is a comment, and the merge carries the responsibility.

**Apply.** First line of the review: "measured on `<sha>`". Re-fetch and compare `git rev-parse origin/<branch>` with the cited SHA before each post. If the head moved, re-measure — do not patch. Tell the pair about the near-miss.

### Impute a spec defect to the spec, and search the source before accusing fabrication

**Why.** On 2026-09-20 AC1 for #176 was conditioned on "when Docker Desktop already runs", while the only call site of `Test-EngineRelaunchReady` was guarded by the absence of the Docker Desktop process. The worker implemented it exactly — 83/83 on both interpreters, seams injected, AC2 asserted — and the branch is structurally unreachable in production; the follow-up was #185, opened with the blind spot named as the AC author's. On 2026-09-21 the coordinator wrote publicly that a sub-agent had "fabricated 193 flips and 4h40"; it was verbatim in a `relay.ts` comment the accuser had not read. The same report had a dead proof (`0 hit node:os` against one real `import homedir`) under a valid conclusion.

**Apply.** Before writing an AC conditioned on a state, locate the call sites and check at least one PERMITS that state; write the AC with its call site ("called from Y, where X is true"). When a review finds such a defect, impute it to the AC publicly, not to the implementer. Before writing "fabricated X", search what the agent could have read — a sub-agent with `Read` can quote any comment; say "I did not find the source of X" until the search is done. Separate a report's conclusion from its proof and correct only what is false. Scope greps to `packages/cli/src` and `scripts`: residual worktrees make `grep -r` counts lie.

## Already covered elsewhere in this repository

| Lesson | Where |
|---|---|
| A guard that disarms on a signal cannot protect what that same signal triggers | `CLAUDE.md` §Never-Hang Constraints |
| A guard placed inside the loop it protects cannot detect the loss of its trigger | `.claude/skills/claudish-coordinate/SKILL.md` §Phase 0 — Cron (entrée) |
| A change request posted as a PR comment is invisible to a worker's review counter | `.claude/skills/claudish-coordinate/SKILL.md` §Phase 4 — Dépôt et PRs |
| Which checks block, that `claude-code` is never evidence, and that a PR without a run needs a dispatched run | `.claude/skills/claudish-coordinate/SKILL.md` §Phase 4 — Dépôt et PRs · `.github/workflows/test.yml` job `test` (Run test suite (packages/cli)) |
| CI does not run every population; replay the uncovered suite locally | `.claude/skills/claudish-coordinate/SKILL.md` §Phase 4 — Dépôt et PRs · `.github/workflows/test.yml` job list |
| A parser strict enough to gate a purge must not be reused to gate an enumeration | `docs/reference/ops-scripts.md` §Nightly compaction and the watchdog (`compress-captures.ps1` · `claudish-watchdog.ps1`) |

## Provenance

| Rule | Source note (ai-01 memory slug) | Dated |
|---|---|---|
| Measure the merge base | `stacked-pr-launders-unreviewed-code` · `head-is-not-a-baseline-for-your-own-change` | 21/09/2026 · 13/09–26/10/2026 |
| A control is only as independent as its instrument | `head-is-not-a-baseline-for-your-own-change` · `local-lint-on-windows-measures-crlf` | 13/09–26/10/2026 · 27/10 and 01/11/2026 |
| Open the evidence; ask the producer | `a-cited-comment-can-be-an-empty-path` · `ask-the-producer-before-judging-its-artifact` | 13–18/10/2026 · 21/09/2026 |
| Read the tree before running or cleaning | `test-suite-wrote-production-home` · `untracked-file-in-clone-can-be-production` | 23–24/09/2026 · 28/09/2026 |
| A stated reason is an assertion | `a-noop-fix-can-carry-a-false-claim` · `firewall-prompt-was-a-test-listener` | 11/08/2026 (both) · 27/10/2026 (variant) |
| A comment is a dated spec; the executable copy wins | `docstring-was-the-spec-code-was-the-bug` · `prose-and-template-hold-the-same-decision` · `bold-sentence-is-not-the-whole-rule` | undated · 19/09/2026 · 22/09/2026 |
| Establish that the replaced code ever ran | `dead-code-makes-a-diff-lie` | 22/09/2026 |
| Verified premise vs verified conclusion | `verified-premise-is-not-verified-conclusion` · `self-correction-can-be-the-error` | 24–25/08/2026 · 25/08/2026 |
| A clean application is not a covering change | `clean-cherry-pick-is-not-a-covering-pick` · `a-verbatim-module-port-can-drop-the-call-site-contract` | 22/10/2026 · 05/11/2026 |
| A wider diff is a regression in disguise | `sawed-off-own-branch` | 20/08/2026 · 24/10/2026 |
| A pointer is not preservation | `thinning-pointer-can-point-at-nothing` · `pins-built-from-the-pr-reading-pass-by-construction` | 19/10/2026 · 10/11/2026 |
| A missing dependency must fail, not skip | `silent-skip-worse-than-missing-test` | 11/08/2026 · 25/08/2026 |
| A synthetic fixture encodes belief | `synthetic-fixture-encodes-the-believed-shape` | 11/08/2026 · 28/09, 05/10, 09/10/2026 |
| Read what a red test demands | `a-red-test-can-demand-a-forbidden-behaviour` | 21/09/2026 |
| A test-passed parameter proves the callee only | `param-tested-directly-is-not-param-passed` | 29/09/2026 · 01/10, 03/10, 05/10/2026 |
| A counter blind to the defect class proves nothing | `a-typecheck-drop-is-not-a-render-proof` | 17/10/2026 |
| Test the branch the first deployment meets | `first-deploy-probe-reads-the-old-image` | 03/10/2026 |
| Mutate transported guards and promised mutations | `behavior-identical-extraction-hides-unpinned-guards` · `a-noop-fix-can-carry-a-false-claim` | 29/09/2026 · 24/10/2026 · 27/10/2026 |
| A mutation counts only if it proves it applied | `a-mutation-must-prove-it-applied` | 13/11/2026 |
| Replay the whole mutation pass after an exception | `an-exception-path-can-mask-an-existing-guard` | 09/11/2026 |
| A strict guard and the residue of its kill | `a-correct-guard-can-make-a-transient-failure-permanent` | 22/09/2026 |
| Every commit goes through every gate | no note: PR #1020, commits `7af5bffd` → `d92fa0f9` | 13/11/2026 |
| A Windows-only hang is invisible to CI | `windows-only-test-hang-invisible-to-ubuntu-ci` | 05/11/2026 |
| A merge into v14 runs no CI | `v14-merge-runs-no-ci` | 13/11/2026 |
| Merge a stack in order | `stacked-pr-delete-branch-closes-the-child` | 15/10/2026 · 25/10/2026 |
| Three channels close issues | `two-independent-issue-closing-channels` | 20/09, 07/10, 09/10/2026 |
| Judge an issue on its predicate and ACs | `close-on-acs-not-on-merged-code` · `pins-built-from-the-pr-reading-pass-by-construction` | 12/09/2026 · 10/11/2026 |
| A review is an instant | `a-review-is-stale-the-moment-the-branch-moves` | 20/09/2026 |
| Impute spec defects; search before accusing | `an-ac-whose-precondition-the-call-site-forbids` · `accused-a-subagent-of-fabricating-what-the-code-said` | 20/09/2026 · 21/09/2026 |
