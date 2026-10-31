# PAYG budget — July vs late September vs October (2026-10-30)

> The question (user, 30/10): hold October's productivity without burying ~1 k€/month of
> DeepSeek PAYG — a few hundred €/month is an acceptable ceiling, accounting for the extra
> cost of workspaces that did not exist in July (claudish named explicitly).
> Every figure below is measured; the instrument is named next to it. Prices are the
> platform's published table, read 30/10/2026.

## 1. The price anchor (was the open half of #405 for the PAYG leg)

`ds@deepseek-flash` = `deepseek-flash` = **DeepSeek-V4.1-Flash-1017** on api.deepseek.com
(official pricing page, read 2026-10-30). Per 1M tokens:

| Leg | Off-peak | Peak |
| --- | ---: | ---: |
| input, cache **hit** | **$0.003** | $0.006 |
| input, cache miss | $0.15 | $0.30 |
| output | $0.60 | $1.20 |

Peak = Mon–Fri 01:00–04:00 and 06:00–10:00 **UTC** (i.e. 02–05 and 07–11 local, UTC+1);
everything else off-peak, weekends included.

Measured legs per PAYG response (30/10, n=600 resp tails):

| Leg | Tokens/resp | Share of priced input |
| --- | ---: | ---: |
| cache read (hit) | 174 086 | 99.1 % |
| fresh input (miss) | 1 610 | 0.9 % |
| output | 817 | — |

⇒ **cost per PAYG response ≈ $0.0016 (≈ €0.0015)**, blended at the measured 26.6 %
peak-hours share. The cache-hit leg — 99 % of the tokens — is priced ~50–100× below the
miss leg: **at DeepSeek flash prices, re-read is no longer the dominant € term** (unlike
the MiniMax plan, where every re-read token burns quota 1:1). Per response, € splits
≈ 42 % hit / 39 % output / 19 % miss.

## 2. The curve — July paid zero; October paid ~€350; the 1 k€ is a *run-rate*, not a bill

`lane-series.sqlite` (142 days, `resp-*` counts), priced per day at each day's own
peak/off-peak split:

Every € figure in this doc is **computed, not invoiced** — lane response counts ×
the public price table × the measured legs above. No figure is read from a billing
console (console readings stay on the internal dashboard; only ratios live here).

| Window | PAYG resp/day | €/month run-rate | Estimated (resp × price) |
| --- | ---: | ---: | ---: |
| **July 01–31** | **0** (no DeepSeek model served at all; first deepseek-flash day = 09-10) | €0 | €0 |
| Late Sept 20–30 | 3 824 | ~€170 | ~€62 (11 days) |
| Oct 01–19 | 5 892 | ~€265 | ~€150 |
| **Oct 20–30** | **11 511** | **~€518** | ~€177 (11 days) |
| Worst single days (08-09/10, 23-24/10, 29/10) | 21 000–27 700 | **~€1 170** | €32–41 each |

**October's estimated total ≈ €330–360** (27–28/10 missing from the store — ingestion gap,
not zero traffic). So:

- The monthly average is **already inside the "few hundred €" ceiling**.
- The feared 1 k€/month is the **worst-day run-rate**: days when 27 k responses ride PAYG
  at ~€40 each. The risk is not the level, it's the *frequency of falaise days*.

## 3. Attribution — the burn is CoursIA-class work, not the claudish workspace

Paired census on 30/10 (600 deepseek-flash responses ↔ `req-*` envelopes by sequence
number; workspace = last `Primary working directory:` in the request body, per
`Get-WorkspaceFromBody`):

- **~95 % of PAYG responses come from CoursIA-class workspaces** (CoursIA, CoursIA-2,
  CoursIA-3, Epita), spread across all six machines. Top single row: ai-01:CoursIA 9.8 %.
- **The claudish workspace does not appear in the top 18** (< 1.3 % of the PAYG burn —
  **under €5/month** at October's rate). On ALL traffic (1 500-request sample) claudish
  is **4.3 %** of fleet requests; CoursIA-class is 64.7 %.
- Requested-role split of PAYG: 57 % sonnet, 36 % haiku (the overflow path), 4 % opus.

The user's hypothesis ("votre workspace qui n'existait pas en juillet" as a cost driver)
is measured and **quantified**: claudish is real volume (4.3 % of requests, mostly on
subscription lanes) but is **not** what the PAYG bill buys. The bill buys course sessions.

## 4. The mechanism — PAYG is a *buffer-stack* meter, not a volume meter

October's daily bill is bimodal, and the cheap week is the proof:

| Days | Stack state | €/day |
| --- | --- | ---: |
| 13–19/10 (Qwen credit alive, GLM windows quiet) | buffers hold | **€0–2** |
| 08–09, 23–24, 29/10 (GLM 5h wall + Qwen dead since 24/10 + MiniMax weekly wall) | all buffers dead at once | €32–41 |

GLM (the sonnet nominal) serves 13–19 k responses/day *throughout* — the falaise is not
GLM being down, it is the **windows** (5 h quota resets, UTC+8 — see #729) plus the dead
Qwen step plus the MiniMax wall overlapping. July paid zero for the same reason 13–19/10
paid ~€1/day: **when the subscription stack holds, PAYG is idle**. The PAYG bill measures
stack outages, not fleet size.

## 5. Measures, ranked by € at stake

| # | Measure | Status / owner | Expected € effect |
| --- | --- | --- | --- |
| 1 | **Q-40 — MiniMax out of the sonnet cascade, direct haiku seat** | **DONE 30/10 17:58** (verified by value) | The 96 %-haiku-triggered walls stop re-reaching PAYG through `role:sonnet`; MiniMax's plan should now survive its week. Fewer falaise days. **Measure: daily € curve + falaise count, next 2 weeks.** |
| 2 | **Qwen prepaid returns 11/11 16:00Z** (automatic) | automatic | Restores the free buffer; the 13–19/10 week (€1/day) is what a held stack costs. Worth ~€150–200/month at October's falaise frequency. ⚠ User has ruled recharging it "à ne plus discuter" — no action. |
| 3 | **GLM `mistral@zai-glm-5-3` step is 402 since 28/10 with no reset** (z.ai PAYG budget exhausted) | **proposal — cascade touch, user accord required** | As configured it is a dead hop before Kimi; either refill the z.ai budget or drop the step. Does not burn PAYG by itself (402 ≠ billed) but lengthens every falaise walk. |
| 4 | **Arm the session ceiling now that € is anchored** | fleet pose = WARN-only until the user fixes values — **this is that decision point** | `CLAUDISH_SESSION_BUDGET_CEILING` (already coded, WARN-only) bounds a runaway session. At €0.0015/resp, a fleet daily PAYG ceiling of ~€25 ≈ 15 k resp/day holds the month ≤ ~€700 even if every day were a falaise; ~10 k/day holds ~€450. A ceiling refuses turns when hit — arming it trades availability for a hard bill cap; the value is the user's call. |
| 5 | **Shift heavy lanes off 07–11 local** (peak pricing window) | CoursIA lanes / scheduling | 26.6 % of PAYG responses land in peak hours at 2× price. Moving batch/cron-heavy work out of the window saves ~13 % of the bill (~€45–65/month at late-Oct rates). Secondary. |
| 6 | **Request-count reduction** (the ×3.8 since July) | #445/#328 grain — client-side | The only lever that scales with fleet growth. PAYG-wise it is the same €/resp either way; it matters because every request also burns *subscription* quota (MiniMax 1:1 per re-read token), and the subscription walls are what trigger the falaise. |

## 6. What this closes and what stays open

- **Closes the PAYG half of #405**: the cache-hit leg now has an official price anchor,
  and the per-response € is measured, not estimated.
- **Reframes the user's 1 k€ envelope**: October estimated ~€350; the 1 k€ figure is the
  worst-day run-rate. The controllable variable is falaise-day frequency, not price.
- **Still open on #405**: the *subscription* legs (MiniMax plan, GLM Coding plan) are
  priced per month, not per token — their "€ per response" depends on quota mechanics
  (weekly gauge, 5 h windows) that have no linear price.
- **Watch item**: November = GLM 402 + Qwen dead until 11/11 + first full week under
  Q-40. If falaise days exceed ~8/month, measure #4 (ceiling) becomes the binding
  constraint and should be arbitrated with the November curve in hand.

## 7. Reproducing

```bash
# daily PAYG responses + per-day peak split (all Oct)
python - <<'PY'
import sqlite3, datetime
db = sqlite3.connect(r"D:\claudish-captures\lane-series.sqlite")
for day, n in db.execute("select day, sum(n) from responses where model='deepseek-flash' and day>='2026-10-01' group by day"):
    hrs = dict(db.execute("select hour, n from responses where model='deepseek-flash' and day=?", (day,)))
    wd = datetime.date(int(day[:4]), int(day[5:7]), int(day[8:])).weekday()
    pk = sum(v for h, v in hrs.items() if wd < 5 and (1 <= h <= 3 or 6 <= h <= 9)) / (sum(hrs.values()) or 1)
    print(day, n, f"peak={pk:.0%}")
PY

# attribution by machine+workspace — do NOT re-derive pairing by hand: the
# request counter restarts at 0001 at every hub process start (30/10 alone has
# four container epochs), so pairing on the counter alone can cross lives and
# attribute a response to the wrong machine. `scripts/uncached-attribution.py`
# (#765) implements restart-aware pairing — same counter, nearest preceding
# `req` within a 20-min window — and is the reference instrument. The fields:
#   machine   = capture envelope field
#   workspace = LAST "Primary working directory:" match inside the req body messages
#               (raw text search of the body is worthless — 2026-09-08 measurement)
#   usage legs = last "usage" object in the resp tail (the 4 kB head only carries
#               output_tokens:1 — never read legs from a head slice)

# prices: https://api-docs.deepseek.com/quick_start/pricing (read 2026-10-30)
```

Caveats, stated: 27–28/10 are absent from the store (ingestion gap) — the October total
is a lower bound by ~2 falaise-class days; the per-response legs are a 600-sample of
30/10 (±2 % on the hit leg across the day's earlier samples); the € conversion assumes
$1 = €0.92.
