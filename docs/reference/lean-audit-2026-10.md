# Lean Audit — Fleet Productivity (Oct 2026)

**Mandate (user, 30/10 soir).** Hold the current production rhythm without the ~1 k€/month
PAYG overhang: find the *waste*, not the quality. The four questions, verbatim in intent:

1. Why does merging the same amount of commits need **4× more requests** than in July?
2. Are **Hermes** and **Nanoclaw** overzealous?
3. Do the **adjoint / secrétaire** roles produce useless paperwork? What does reading the
   CI's PR comments actually cost?
4. Are review **round-trips** wasteful — or have agents genuinely gained reliability,
   a durability gain invisible in commit/token metrics?

**Team shape (user).** The hub seat coordinates — it is the only vantage point that sees all
traffic pass (central captures + GitHub). The executing siblings are the lanes on the OTHER
machines, which did not exist in July; **their first mandate stays the sidecar relay +
aligned cascades** — Lean grains are P1 behind that, never in front of it.

Companion numbers: `payg-budget-2026-10.md` (what a request costs, who burns it),
`consumption-2026-10.md` (volume vs requests decomposition).

## Grain 1 (30/10, measured — **corrected same evening after user challenge**)

**Instrument correction (lesson first).** The first pass used REST `pulls` paged 4×100 by
`updated desc` — on active repos that window never reaches back to July, so July read "0
merged PR" on repos that demonstrably merged hundreds (the user's commit-activity graphs
caught it). The corrected instrument is the search API + `stats/commit_activity`. Both are
reproducible by any seat with `gh` (no scratch files needed):

```bash
# exact merged-PR count per repo·month (never trust deep pagination for old months)
gh api "search/issues?q=repo:<owner>/<repo>+type:pr+is:merged+merged:2026-07-01..2026-08-01&per_page=1" --jq .total_count
# commits per month (same data as the commit-activity graphs)
gh api repos/<owner>/<repo>/stats/commit_activity   # 52 weekly buckets, retry on 202
# anatomy (comments/review_comments are complete in the list payload;
# commits/additions/changed_files only in the detail view — sample)
gh api "repos/<owner>/<repo>/pulls?state=closed&sort=updated&direction=desc&per_page=100"
```

Merged PRs per month (exact, big six; EPF/ECE small, search-rate-limited in pass 2 — ≤ ~40
combined in Oct per pass 1):

| Repo | Jul | Aug | Sep | Oct | Oct commits/PR | Oct +/− lines | Oct files/PR |
|---|---:|---:|---:|---:|---:|---:|---:|
| jsboige/claudish | 1 | 44 | 149 | **361** | 1.4 (med 1) | +175/−3 | 2 |
| jsboige/roo-extensions | 206 | 235 | 489 | 344 | 1.7 (med 1) | +132/−4 | 2 |
| jsboige/jsboige-mcp-servers | 265 | 116 | 204 | 298 | — | — | — |
| ArgumentumGames/Argumentum | 284 | 159 | 366 | 368 | — | — | — |
| jsboigeEpita/2025-Epita-Intelligence-Symbolique | 189 | 237 | 543 | 235 | 1.6 (med 1) | +4387/−4272 | **202** |
| jsboigeEpita/2026-Epita-Intelligence-Symbolique | 22 | 0 | 0 | 0 | Jul: 5.5 | Jul: +3182/−40 | Jul: 20 |
| **Total** | **967** | 791 | 1 751 | **1 606** | | | |

(`jsboigeEpita/CoursIA` merged 0 PRs ever but shows **2 295 commits in July** — a
direct-push workflow; commits ≈ merged PRs on every agent repo — squash — so "per commit"
and "per merged PR" are the same denominator here.)

Findings, corrected:

- **The mixture-shift claim is RETRACTED.** July was not a quiet month: ~967 merged PRs
  across the big six. October is **×1.71 on PRs/day** (31.2 → 53.5) while fleet requests
  grew **×3.78** (14 441 → 54 636/day) — so **requests per merged PR rose from ~463 to
  ~1 021, ×2.2**. The per-PR inflation is real and is now the chantier's central number.
  (Refinement for W1: the ratio uses fleet-wide requests over these repos' PRs — organ and
  non-merging lanes inflate both months; the per-lane number needs the paired captures.)
- **September was already at 58 PRs/day and Oct DIPPED to 53.5 (−7 %)** — while requests
  per PR kept climbing (late-Sept ~774 → Oct ~1 021, +32 % in a month). The waste
  acceleration is recent, which makes it findable.
- **GitHub-side review round-trips are ≈ zero everywhere** (October anatomy, complete
  counts) — `review_comments` = 0.0, issue comments ≈ 0–13 per sampled repo, **bot share
  0 %**. Two consequences: (a) the user's "useless review back-and-forth" hypothesis is
  **not visible on GitHub** — if it exists, it lives in dashboards/DMs/session loops
  (→ W2); (b) the "CI comments paid in reading" cost is near-zero *as text* today — CI's
  real cost is the **agent cycles each check-run notification triggers** (every cycle
  re-pays the ~100–144 k-token harness floor, → W6).
- **Flag for the secrétaire lane**: 2025-Epita (CoursIA-3) merged 235 PRs in Oct at
  **202 files/PR** (+4.4k/−4.2k lines each) — regeneration-shaped; solidification vs
  paperwork is exactly W3's question. Note it also did 543 PRs in September — this lane's
  volume doubled long before October.

## Grain W1 (31/10, measured — per-poste requests + token legs, one day)

Day measured: **30/10**, the last full day of the pre-audit regime. Corpus: the day's
archived captures (`archive/captures-2026-10-30.7z`, reqs) plus the still-live resp files
— frozen copies, because the nightly compaction moves the day *during* a long scan (two
earlier passes saw 62,691 then 19,351 reqs of the same day at different moments; the
frozen pass sees **65,274 reqs / 14,697 resp captures**). Pairing `resp-1-rNNNN ↔ req-1-NNNN`
on **`(instanceId, seq)`** — restart-proof: 30/10 had four container epochs and `seq`
resets at each start, so a seq-only join would silently cross epochs.
**Paired = 14,695 of 14,697 resps (99.99 %), usage legs recovered on 14,697/14,697** —
the old 6 KB-tail brace-slice lost ~40 % of legs on a truncated `"usage":{` fragment;
parsing the whole `message_delta` data line as JSON is the fix that makes these numbers
opposable.

**Per machine (paired responses; ctx = input + cache read + cache write):**

| machine | n | fresh in | cache read | ctx total | output | **miss ratio** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| myia-po-2024 | 2 592 | 36.9 M | 433 M | 519 M | 2.21 M | **7.1 %** |
| myia-po-2028 | 3 004 | 13.0 M | 417 M | 517 M | 2.71 M | 2.5 % |
| myia-po-2023 | 2 911 | 44.7 M | 462 M | 482 M | 2.33 M | **9.3 %** |
| myia-ai-01 | 2 569 | 9.9 M | 442 M | 447 M | 2.58 M | 2.2 % |
| myia-po-2025 | 1 784 | 7.4 M | 274 M | 309 M | 1.69 M | 2.4 % |
| myia-po-2027 | 965 | 16.5 M | 179 M | 197 M | 0.83 M | **8.4 %** |
| (no machine) | 581 | 8.0 M | 39 M | 44 M | 1.18 M | 18.2 % |
| myia-web2 | 161 | 1.3 M | 23 M | 25 M | 0.11 M | 5.2 % |
| myia-web1 | 128 | 0.4 M | 19 M | 20 M | 0.11 M | 2.0 % |

Fleet total: **14,695 pairs, 138.2 M fresh input, 2,411 M cache read, 9 M cache write,
13.8 M output** — ≈ 941 output tokens and ≈ 173 k input tokens per paired response.

Readings:

- **Re-read is 94 % of all input volume** (2,411 M of 2,558 M): the harnais floor, paid
  again every turn. This is the W1 confirmation of the #445-D2 thesis at the poste grain.
- **The miss ratio varies ×4 across postes, and it is the cheapest lever**: po-2023
  (9.3 %), po-2027 (8.4 %) and po-2024 (7.1 %) pay fresh input at 3–4× the rate of
  po-2028/po-2025/ai-01 (2.2–2.5 %). At the cache-hit/miss price gap of DeepSeek flash
  (~50×) and of every plan that bills re-read 1:1 (MiniMax), a poste's cache hygiene is
  worth more € per token than a smaller prompt. The worst single groups are visible in
  the per-group JSON: po-2024:CoursIA-2 haiku-cron at **25 % miss** (10.4 M fresh of
  41.4 M) and po-2023 haiku-cron at **25 %** (23.7 M of 92.7 M) — both are long cron
  lanes, i.e. sessions whose cache entry dies between cycles rather than within them.
- **Output is small relative to context**: 13.8 M output against 2.5 B input — the bill
  is a *re-reading* bill, not a *writing* bill, everywhere. Any measure that shrinks
  context (compaction floor, request count) hits the 94 %; any measure that improves
  cache reuse hits the miss leg.
- Role mix of the paired set: haiku and sonnet carry the volume; opus appears on ai-01
  (D:\CoursIA, 201 pairs), po-2025 (161) and po-2024 (70, of which 16 served `gpt-6.1-sol`
  through the codex bind) — the po-2025/po-2024 Opus runs are flagged for the policy
  question, not treated as leaks here.

Reproducing (one day, frozen corpus — never scan the live tree while the night
compaction runs; it moves the day mid-scan):

```bash
# 1) freeze the corpus (defensive copy; extraction target must be OUTSIDE the capture dir)
robocopy <capture-dir> .tmp/w1-resps "resp-1-*<DAY>*" /NJH /NJS /NP /NDL /NFL
7z x <capture-dir>/archive/captures-<DAY>.7z -o.tmp/w1-reqs "req-1-*<DAY>*" -y
# 2) pair on (instanceId, seq): req header fields live in the first ~600 B;
#    resp header line carries instance= and served model=; last message_delta in the
#    last 6 KB carries the usage legs — parse that WHOLE data line as JSON (a brace
#    slice on '"usage":{' truncates on nested/partial objects and loses ~40 % of pairs)
# 3) workspace = LAST "Primary working directory:" match in the req body slice
#    (raw text search of the body is worthless — 2026-09-08 measurement); the body is
#    JSON-escaped, so the line ends at a literal \n two-byte sequence, not a real newline
```

## Workstreams

| # | Question | Owner | Instrument / first probe |
|---|---|---|---|
| W1 | Requests+tokens+€ **per poste** (coordinateur / adjoint / secrétaire / worker / organes / étudiants), July vs Oct, *within* lane | hub seat | paired captures: pair `resp-1-rNNNN-*` ↔ `req-1-NNNN-*` by sequence number; workspace = last `Primary working directory:` match in the body; usage legs = last `"usage"` in the resp tail; then role inference from machine×workspace×profile markers (Hermes/Nanoclaw/agent); within-lane req/PR is the number that answers "×4" cleanly |
| W2 | Conversational round-trips per merged PR | hub seat | intercom/DM census from conversation traces; count ASK/ACK/REPLY/claim-release cycles per PR; compare lanes |
| W3 | Adjoint/secrétaire paperasse | po-2027/po-2028 seats + hub captures | classify the 235-PR 2025-Epita population: regeneration vs incremental; % of files never re-touched within 7 days (a regenerated file never read again = paperasse) |
| W4 | Hermes/Nanoclaw zealousness | ai-01 + hub | Hermes: system = 21 k chars, 60 % skills catalog, 7.0 % of fleet requests (measured 30/10, #445-D2) — measure catalog weight vs actual skill usage; Nanoclaw: deploy gated on ai-01, appears in lane contexts — baseline its cycle cost the week it wakes. Zealousness proxy: tool-call fan-out + retry rate per turn |
| W5 | Durability (the invisible quality metric) | any seat | reopened-issue %, revert/hotfix rate, 7-day file re-touch rate, July vs Oct — if Oct commits stick longer, part of the ×4 is solidification, and the audit must not cut it |
| W6 | CI-triggered cycles per PR | hub seat | from captures: cycles whose trigger context names a check-run/PR event; each costs a floor re-read even before work starts |

**Cadence.** Hub seat aggregates at each worker cycle; sibling seats pick one grain per
cycle, P1 behind the sidecar/cascade P0. Every finding lands with its measured request/€
impact — no recommendation without a number (standing fleet rule).

## Ground rules (non-negotiable)

- **No cascade change without explicit user accord** (standing 28/10 rule) — the audit
  proposes, the user disposes.
- **Quality is not the variable to cut.** Dégraissage targets waste — re-read, paperasse,
  dead cycles, duplicate orchestration — never review depth, verification, or the
  organ surveillance that caught real outages.
- The hub seat reads everything from central captures; sibling machines verify their own
  lanes' traces locally. No lane measures itself as its own verifier (standing mini-rule,
  generalized here).
