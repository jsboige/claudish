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

## Grain 1 (30/10, measured): the ×4 is partly a mixture shift

Instrument: GitHub REST `pulls` over the 14 PR-bearing repos (complete counts; commits/size
on a ≤12-PR detail sample per repo·window). Snapshot: `.tmp/lean-pr-anatomy.json` (scratch).

| Repo | Jul merged | Oct merged | Oct commits/PR | Oct +/− lines | Oct files/PR |
|---|---:|---:|---:|---:|---:|
| jsboige/claudish | 0 | **301** | 1.4 (med 1) | +175/−3 | 2 |
| jsboige/roo-extensions | 0 | **236** | 1.7 (med 1) | +132/−4 | 2 |
| jsboigeEpita/2025-Epita-Intelligence-Symbolique | 0 | **235** | 1.6 (med 1) | +4387/−4272 | **202** |
| jsboigeEpita/2026-Epita-Intelligence-Symbolique | **22** | **0** | Jul: 5.5 | Jul: +3182/−40 | Jul: 20 |
| jsboigeEPF (4 repos) | 0 | 40 | 1.0–5.4 | mixed | 2–55 |
| jsboigeEpita/CoursIA + 4× jsboigeECE | 0 | 0 | — | — | — |

Findings, each answering part of question 1:

- **The October merge population did not exist in July.** ~812 merged PRs in October across
  repos that merged ~zero in July; the ONE repo carrying July's real student work
  (22 PRs × 5.5 commits × +3.2k lines × 20 files) merged **nothing** in October. The
  fleet-average "~520 vs ~117 requests/PR" therefore mixes populations: it is dominated by a
  **denominator change** (three new lanes of small agent-infra PRs), not yet by proven
  per-PR inflation. Whether per-PR cost ALSO rose, within each lane, is W1's job (captures).
- **GitHub-side review round-trips are ≈ zero everywhere** — `review_comments` = 0.0 on every
  repo·window, issue comments ≈ 0–13 per sampled repo, **bot share 0 %**. Two consequences:
  (a) the user's "useless review back-and-forth" hypothesis is **not visible on GitHub** —
  if it exists, it lives in dashboards/DMs/session loops (→ W2); (b) the "CI comments paid in
  reading" cost is near-zero *as text* today — CI's real cost is the **agent cycles each
  check-run notification triggers** (every cycle re-pays the ~100–144 k-token harness floor,
  → W6).
- **The secrétaire lane (CoursIA-3 → 2025-Epita repo) merged 235 PRs in October at
  202 files/PR** (+4.4k/−4.2k lines each) — a shape that smells of whole-tree regeneration
  rather than editing. That lane is 7.1 % of fleet requests. Solidification or paperasse is
  exactly W3's question; 202 files per PR is the first flag.

## Workstreams

| # | Question | Owner | Instrument / first probe |
|---|---|---|---|
| W1 | Requests+tokens+€ **per poste** (coordinateur / adjoint / secrétaire / worker / organes / étudiants), July vs Oct, *within* lane | hub seat | extend `.tmp/payg-attribution.py`: role inference from machine×workspace×profile markers (Hermes/Nanoclaw/agent) over paired captures; within-lane req/PR is the number that answers "×4" cleanly |
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
