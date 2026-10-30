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
