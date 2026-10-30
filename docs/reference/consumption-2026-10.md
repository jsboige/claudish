# Consumption analysis — July vs late September vs now (2026-10-30)

Why the MiniMax weekly plan walls before its reset, what actually burns it, and what removing
MiniMax from the sonnet cascade would cost. Every figure below is measured; the instrument is
named next to it, and the three figures that are *derived* rather than read are marked ⚠.

## 1. Instruments

| Figure | Source | Note |
| --- | --- | --- |
| Responses served per day / per model | `scripts/lane-matrix.py` → `D:\claudish-captures\lane-series.sqlite` (142 days, 2026-06-03 → 2026-10-30) | counts `resp-*` captures, one row per (day, hour, handler, model) |
| Which role a served response belongs to | paired census: `resp-*` ↔ `req-*` by **sequence number** (`resp-1-rNNNN` ↔ `req-1-NNNN`), nearest timestamp as tie-break | 0 unpaired on the hours sampled; envelope carries the requested `model` and `machine` |
| Tokens per response | tail of the `resp-*` file (last 200 kB, `"usage"` blocks): `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | the terminal usage only lives in the tail, never in the 4 kB head (see §6 of the #405 ledger) |
| MiniMax plan quota and daily token totals | console `platform.minimax.io/console/usage`, read via Playwright `evaluate` on the loaded page (`navigate` times out on this page) | the gauge is an **integer**; the heatmap exposes the exact per-day token count |
| Wall events per step | `~/.claudish/failover-events.log` (NDJSON) | survives container recreates; `docker logs` does not |

Two of these are independent of each other and agree: today's console total (2.92 B tokens)
and the capture-side extrapolation (15 710 MiniMax responses × 188 k tokens = 2.95 B), **1 % apart**.

## 2. Volume — the fleet grew 3.8× since July, MiniMax's share moved the other way

Responses served per day (lane-series store, `resp-*` counts):

| Window | resp/day | MiniMax-served/day | MiniMax share |
| --- | ---: | ---: | ---: |
| July 01–31 | 14 441 | 5 608 | 38.8 % |
| Late September 20–30 | 45 187 | 13 519 | 29.9 % |
| October 01–30 | 41 004 | 8 838 | 21.6 % |
| October 20–30 | 54 636 | 10 217 | 18.7 % |
| 29/10 (whole day) | 77 858 | 17 580 | 22.6 % |
| 30/10 (00–14Z) | 32 623 | 15 710 | **48.2 %** |

July was **not** a small-MiniMax month: MiniMax-M3 already carried 38.8 % of a much smaller
fleet. What changed is the fleet, not the model mix.

## 3. Tokens — the provider's own meter, per day

Console heatmap (exact per-day token count, 06/01 → 10/30; total 157.84 B over 112 active days):

| Month | Total | Per day |
| --- | ---: | ---: |
| July | 22.81 B | 0.74 B |
| August | 36.99 B | 1.19 B |
| September | 44.92 B | 1.50 B |
| October 01–30 | 53.12 B | 1.77 B |
| **Late September 20–30** | **20.41 B** | **1.86 B** |
| **October 20–30** | **20.19 B** | **1.84 B** |
| 29/10 | 3.23 B | — |
| 30/10 (as of 14:40Z) | 2.92 B | ~2.9 B pace |

**Late September and the last ten days of October carry the same MiniMax volume (1.86 vs 1.84 B/day).**
The volume has been flat for six weeks; what changed is the *quota*, not the traffic (§5).

Tokens per served MiniMax response (console tokens ÷ lane-series response count):

| Window | Tokens / response |
| --- | ---: |
| July | 131 200 |
| Late September | 137 200 |
| October 20–30 | 219 600 |
| 30/10 (measured directly) | ~186 000 |

⚠ The October figure is inflated by the window's heavier days; the direct measurement of the
last three hours (§4) is the trustworthy one. The direction is unambiguous: **+40 to +60 % of
context per request since July**.

## 4. What burns the plan: cache re-read, not generation

MiniMax-served responses, hours 07 / 10 / 13 of 30/10 (3 359 paired responses):

| Requested role | Responses | OUT / resp | cache-read / resp | cache-read median |
| --- | ---: | ---: | ---: | ---: |
| `claude-sonnet-5-5` | 1 488 (44.3 %) | 1 209 | 167 990 | 177 408 |
| `claude-haiku-5-5` | 1 460 (43.5 %) | 859 | **187 726** | 184 064 |
| `claude-opus-5-5` | 316 (9.4 %) | — | — | — |
| other | 95 (2.8 %) | — | — | — |

The console reports a **96.5 % cache hit rate**: almost every input token is a re-read of
context already paid for once. The ratio is 160:1 in favour of re-read over generation
(187 k vs 859 tokens per request).

This is not a MiniMax property — every paid lane carries the same floor (30/10, hours 08/09/13):

| Served model | OUT / resp | cache-read / resp | IN / resp |
| --- | ---: | ---: | ---: |
| deepseek-flash (PAYG) | 784 | 173 910 | 2 681 |
| glm-5.3 | 809 | 164 239 | 4 180 |
| claude-opus-5-5 | 1 121 | 207 503 | 199 |
| swift-1.5-27b (local vLLM) | 974 | 0 | 87 885 |
| deepseek-v4-flash (Qwen prepaid) | 5 194 | 360 | 11 339 |

⚠ Fleet-wide: 32 623 responses today × ~175 k = **5.7 B tokens re-read**, of which MiniMax
carries 2.9 B (51 %). The plan is burned by the *number of requests carrying a ~175 k context*,
not by model verbosity.

## 5. The wall — pace, derived capacity, and why July never hit it

Console at 14:40Z on 30/10: **weekly 63 % used, resets in 2 d 9 h** (≈ 02/11 00:00Z); **5-hour
limit 100 %** (reset in 8 min); credits 0; auto-credit on.

Weekly gauge trajectory this week (watch journal, append-only):

| Time (Z) | Weekly | Delta |
| --- | ---: | --- |
| 29/10 15:26 | 13 % (fresh week after the early reset) | — |
| 29/10 18:23 | 23 % | 3.4 pt/h |
| 29/10 20:45 | 23 % | 0 (flat, 3 h 33) |
| 30/10 00:22 | 35 % | 3.3 pt/h |
| 30/10 05:21 | 43 % | 1.6 pt/h |
| 30/10 14:40 | **63 %** | **2.15 pt/h average** |

⚠ Derived weekly capacity: 50 points consumed over ~3.6 B tokens ⇒ **~7.2 B tokens/week**,
i.e. **~1.03 B/day sustainable** (43 M tokens/hour). This is derived from the gauge pace, not
read from a quota page — it is the only number here that would move if the plan changed.

Against that capacity:

| Window | B/day | vs sustainable |
| --- | ---: | ---: |
| July | 0.74 | 72 % — **fits** |
| Late September | 1.86 | 180 % |
| Now (30/10) | 2.9 | **280 %** |

At 2.15 pt/h the wall lands **31/10 ~07:50Z**, roughly 40 hours before the 02/11 00:00Z reset.

## 6. Why today is worse than late September — the haiku wall loop

Walls recorded today (`failover-events.log`, 2 356 events), by step:

| Step | Walls | Triggered by |
| --- | ---: | --- |
| `haiku[1]` (Sonnet role) | 1 147 | 2 265 of 2 356 events (**96 %**) were triggered by a `claude-haiku-5-5` request |
| `sonnet[0]` (Mistral GLM) | 567 | 11 by `claude-sonnet-5-5` |
| `sonnet[1]` (Kimi K3) | 557 | 5 by `claude-haiku-4-5-20251001` |
| `haiku[0]` (Swift local) | 74 | |
| `sonnet[2]` (MiniMax M3.1) | 8 | |
| `sonnet[3]` (Qwen prepaid) | 3 | |

Armed topology at the time of writing (`docker inspect claudish-proxy`):

```
CLAUDISH_FAILOVER_HAIKU  = vllm-myia@swift-1.5-27b!own > role:sonnet
CLAUDISH_FAILOVER_SONNET = mistral@zai-glm-5-3 > kc@k3 > mmc@MiniMax-M3.1-Flash
                           > qwen-token-plan@deepseek-v4.1-flash-1017 > ds@deepseek-flash
CLAUDISH_FAILOVER_ACTIVE = haiku@myia-po-2027, haiku@myia-po-2023,
                           haiku@myia-po-2024, haiku@myia-po-2028
```

So a haiku request whose MiniMax nominal is walled walks: swift → `role:sonnet` → GLM (walled)
→ Kimi (walled) → **MiniMax again**, at the sonnet step. The same account refuses the request
as haiku and serves it as sonnet, with a larger prompt (167 k vs 187 k context is a wash, but
OUT is 1 209 vs 859) and one more 5-hour-window charge.

The Qwen prepaid step is not absorbing: 446 responses served today against 4 665 on DeepSeek
PAYG — the cheap buffer between MiniMax and PAYG is effectively missing.

## 7. What removing `mmc@MiniMax-M3.1-Flash` from the sonnet cascade would cost

Effect on the MiniMax plan: MiniMax serves 48 % of today's responses, split by requesting role
≈ 44 % sonnet, 44 % haiku (mostly arriving through `role:sonnet`), 9 % opus. Removing the step
removes the sonnet-origin volume **and** the haiku overflow that lands there — call it ~90 % of
MiniMax traffic. That alone would bring the plan back under capacity, i.e. it would let it
finish the week.

Effect on spend: those requests move to `qwen-token-plan@deepseek-v4.1-flash-1017` (measured
today at 5 194 OUT/resp — reasoning is on by default on that model, see the Qwen note) and then
to `ds@deepseek-flash`. Order of magnitude for the DeepSeek leg: ~6 000 responses/day × 784 OUT
= 4.7 M OUT/day.

⚠ **The euro figure cannot be stated honestly yet.** The only anchor in the ledger is
"DeepSeek Flash ≈ 1 €/M OUT (list, unanchored)" from 2026-10-15, which prices the *generation*
leg only. The dominant term — ~1.0 B cache-read tokens/day — has no price anchor anywhere,
which is exactly the open half of issue #405. Quoting a total in euros today would be
arithmetic on an unmeasured coefficient.

Qualitative: the substitute (DeepSeek Flash) is not a downgrade for sonnet-class work; the real
loss is the 5-hour window relief MiniMax provides, and the PAYG lane has no weekly ceiling to
absorb a bad day.

## 8. Recommendations, in order of confidence

1. **Break the haiku→sonnet→MiniMax loop first** — it costs nothing and it is the single largest
   identified waste: a request refused by an account is re-sent to the same account under
   another role, with more output tokens. Two candidate shapes: let `swift` (local, free) absorb
   the haiku overflow instead of `role:sonnet`, or make the walk skip a concrete whose *account*
   is already walled in the same request. ⚠ Both touch the cascade and need an explicit user
   accord; nothing here authorises a change.
2. **Cut the number of requests, not the model.** 5.7 B tokens/day of cache re-read at ~175 k
   per request means every request costs the same whatever it computes. The July→now growth is
   ×3.8 in request count (14 441 → 54 636/day), and the requests-per-PR ratio (#328) is the
   lever that actually moves the bill.
3. **Price the cache-read leg** (finish #405). Without it, "we moved traffic to PAYG" cannot be
   evaluated against "we burned the plan"; every arbitrage stays qualitative.
4. **Remove `mmc@MiniMax-M3.1-Flash` from the sonnet cascade** — the user's proposal. It is the
   correct move *if* the goal is to let the plan reach 02/11 intact; it is a spend-increasing
   move, and it should be paired with (1), otherwise the haiku overflow simply takes a shorter
   path to the same place.
5. **Restore a real buffer between MiniMax and PAYG.** The Qwen prepaid step served 446 requests
   today against 17 580 on MiniMax and 27 523 on DeepSeek PAYG yesterday: as an étage it is
   absent in practice.

## 9. Reproducing

- Response counts: `python scripts/lane-matrix.py --days 142` (store: `D:\claudish-captures\lane-series.sqlite`).
- Role split: pair `resp-1-rNNNN-*` with `req-1-NNNN-*` by sequence number; read the requested
  model from the `req-*` envelope, the served model from the `resp-*` header.
- Token usage: read the last 200 kB of a `resp-*` file and take the last `"usage"` object; the
  4 kB head only carries `output_tokens: 1` from `message_start`.
- Plan quota: reload `platform.minimax.io/console/usage`, then read it with `evaluate` — the
  heatmap cells carry `aria-label="YYYY-MM-DD <n> Token"` with thousands separators.
