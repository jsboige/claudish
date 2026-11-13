---
name: Grain (bounded work order — cloud agent or worker)
about: One behaviour, one pull request, accepted by a command. Format and rules in docs/reference/delegation-protocol.md.
title: "[grain] "
labels: grain
---

<!--
Write for a reader who has this repository and nothing else: no dashboard, no LAN, no memory of earlier sessions.
Before filing, check the five lines of "Delegable or not" in docs/reference/delegation-protocol.md.
-->

## Parent

<!--
The OPEN issue this grain decrements, and the row or acceptance criterion of that issue it closes.
For a port to another branch: the open issue that tracks that branch, plus the merged pull request being ported.
`None` when the grain stands alone. A closed issue is a reference, not a parent.
-->

## Base branch

<!-- `main` or `replatform/v14`. Spell it out. -->

## Predicate

<!--
The behaviour to obtain, as ONE testable sentence. Quote the parent issue when it states it.
If the parent's names do not exist on the base branch, restate it in that branch's terms and say it is restated.
-->

## Where

<!-- Permalinks to the code at a pinned commit (press `y` on GitHub to pin the URL). -->

## In scope

<!-- Files or one directory. -->

## Out of scope

<!-- What looks related and must not be touched in this pull request. -->

## Acceptance

<!--
- The commands to run and the expected result. Write a count only if it was measured on the base branch;
  otherwise ask the producer for the counts before and after its change.
- The pins to add.
- The mutation to show: which guard, broken how, turns which pin red.
-->

## Binding rules

<!-- The headings of CLAUDE.md that bind this change (for instance "Never-Hang Constraints", "Debugging & Tests"). -->

## Stop conditions

<!-- "If X turns out false, stop and comment on this issue. Do not widen the scope." -->

## Routing

<!-- `cloud-first until YYYY-MM-DD HH:MMZ`, or `worker`. Only the coordinator sets or removes the `cloud-ready` label. -->

## The pull request must state

- [ ] What changes, and any behaviour change a reader must know before merging
- [ ] The pins added and the mutation shown (guard, result)
- [ ] The commands run, with their counts and the commit they ran on
- [ ] What is out of scope
- [ ] What was NOT verified
- [ ] `Closes #<this issue>` if the base is `main`, `Refs #<this issue>` otherwise
- [ ] A conventional commit title
