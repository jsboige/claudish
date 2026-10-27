# Haiku → Swift Debrayage — Staged Widening Design (Q-po2025-31)

Status: **design proposition, arbitrated vehicle (option b, ai-01 coordination 2026-10-27 00:12Z), no config change in this PR**. Mandate: user, 2026-10-27 ~04:45Z — "haiku doit être porté par swift là où c'est possible"; the form (design PR first, no config flip) follows the Q-po2025-31 arbitration. Owner: po-2025 (hub seat); engine counterpart: ai-01:vllm.

## 1. What is already live (and works)

The mechanical debrayage shipped in stages 19→27/10 and is **deployed now**:

| Piece | Live value (read 2026-10-27 04:20Z) |
|---|---|
| Cascade `CLAUDISH_FAILOVER_HAIKU` | `vllm-myia@swift-1.5-27b!own > role:sonnet > ds@deepseek-flash` |
| Armed diversion `…_ACTIVE` | `haiku@myia-po-2027,haiku@myia-po-2023,haiku@myia-po-2024` |
| Auto-arm at true wall `…_AUTO` | `1` |
| Machine exclusion (#693) | `vllm-myia@swift-1.5-27b:myia-ai-01` (container record #141; banner `STEP-EXCLUDE haiku[0]`, recreate 2026-10-27 00:52Z) |
| Busy guard | `customEndpoints.vllm-myia.maxConcurrency: 8` → #431 busy-skip, no mark |
| Context guard | declared + derived `contextLimit 262,144` → #431 context-skip; deriveContextLimits staged 2026-10-26 |

Effect measured 2026-10-26 (21.6 h census): the six armed machines' haiku-role traffic touches **zero** MiniMax; MiniMax haiku has exactly two remaining consumers — ai-01 (66 % of responses) and po-2028 (34 %, 93 % cron). One of them is STEP_EXCLUDEd by user decision (25/10, Q-po2025-27b), the other is excluded by user decision (20/10: po-2028 is the CoursIA-3 secretary, stays on MiniMax).

**Consequence (the design's real decision point): with no new user arbitration, the addressable surface for further widening is ≈ 0.3 % of haiku volume. The PR's payload is therefore not "arm more machines" — it is the measured preconditions and the procedure for the one widening that matters: lifting the ai-01 STEP_EXCLUDE (the user's own 26/10 evening proposition, held at Q-po2025-31).**

## 2. Measured ground

Demand (haiku role, fleet):

| Measure | Value | Source |
|---|---|---|
| MiniMax-served haiku | 19,212 resp / 21.6 h (2026-10-26) | census `.tmp/cons-evening.json` |
| ai-01 share | 11,298 resp (66 %); by workload: agent-sdk 52 %, interactive 25 %, cron 23 % | same |
| po-2028 share | 5,417 resp (34 %, 93 % cron) | same |
| Prompt size | p50 **179.3k** tok, p90 ~253k, p99 291k, max 304k (n=25,180) | `prompt-size-dist.py`, 2026-10-26 |
| Context fit on swift (262,144) | ~90 % of requests fit; the overflow tail is #431-skipped, and since 2026-10-26 the derived limit gives the #674 exact-count band | measured 19/10 + deploy 26/10 |
| MiniMax cost per haiku turn | ~120–190k cache-read per response for ~850 output tokens (ratio ~150–220:1) | census 2026-10-26 |

Supply (swift = vllm-myia on ai-01, WAN front `api.medium.text-generation-webui.myia.io`):

| Measure | Value | Source |
|---|---|---|
| Observed throughput | ~3,053 resp/24h = 3–7 % of hub volume (peak 11.5 %) | captures 2026-10-26 |
| Latency, warm | ttft 1.4–9.5 s, responses 4–15 s | same |
| Latency under 7+ concurrent streams | **90–390 s per response** | same |
| Silence events | 6 min total (01:47→02:38Z 27/10, engine restart window); 502 burst 01:53–01:56Z | upstream-errors.log |
| Connect failures | **ECONNRESET wedge active at 04:10Z 27/10** — hub canaries 7/7 fail at ~21 s; fleet attempts ~16 marked non-quota in 30 min | DM `po2025-swift-econnreset-wedge-20261027T0412Z` |
| Corroboration, independent path | RSM condensation LLM via the same front: 3/3 connection errors at 04:14Z | dashboard append log |
| Contention | external consumers (Jamin, Candy — persons, inbound keys) share the same engine; their traffic takes the same resets | inbound-key attribution 26/10 |

Failure accounting (hub side, measured 27/10): a swift connect failure gets one retry (+250 ms, #80-2), then surfaces as a **non-quota mark on step 0** (`!own`, 30 s) with the session's dwell forfeited; the request advances to `role:sonnet` → glm (subscription). No PAYG leak measured (the deepseek responses visible in the window belong to a known external OpenAI/JS client). Net effect of a swift outage: armed machines' haiku rides the sonnet lane — a quota displacement, not a money bleed.

## 3. Design — three gates, then one ladder

### Gate R — engine reliability (precondition; **currently FAILED**)

Rolling 24 h, measured hub-side (cheap, per cycle):

- ECONNRESET / connect-failure rate on swift attempts < 2 % (instrument: three tiny canaries per cycle through the explicit `vllm-myia@swift-1.5-27b` route + the `[Failover] step haiku[0] … HTTP 400` rate from `failover-events.log`);
- ttft p95 < 10 s at the then-current load;
- zero `UNEXPLAINED ENDING` from swift in the window.

Gate owner: ai-01:vllm (engine counters: KV, waiting, preemptions — they asked for exactly this signal class on 20/10); hub seat runs the measurement. The 20/10 lesson stands: a first 90–155 s event while `/health` answers 200 is an engine wedge, not our load — check pinned sessions and their counters before any hub-side reaction.

### Gate C — capacity under the agent-sdk shape

Before any widening step, a 30-minute load probe at target concurrency **n+2 sustained streams**, with p95 ttft measured — and the probe traffic must mimic the dominant consumer shape, not small canaries: ai-01's haiku is 52 % agent-sdk, whose sessions re-read 120–190k context per turn (KV pressure concentrated, prefix-cache friendly only while the session lives). Numbers from the current engine tier (fs, deployed 21/10) must come from the vllm lane; the hub-side envelope (`maxConcurrency: 8`) does not move until they publish headroom.

Contention is part of the gate: Jamin/Candy traffic shares the engine. A widening decision weighs their latency knowingly; it is never silent. (Their access is a user-granted service, not spare capacity.)

### Ladder W — widening steps (each = one drained recreate + prior announce on `global`)

1. **Held** — current state: po-2027, po-2023, po-2024 armed (done 00:52Z 27/10). Verify daily: swift share of armed machines' haiku, busy-skip rate, `!own` mark rate.
2. **po-2025 (this seat)** — haiku demand ~8 % of a 19/10 profile; low absolute value; take only if free with another recreate (never its own).
3. **ai-01 — the payload of this design.** Requires: Gate R green 24 h **and** Gate C probe at the agent-sdk shape **and** explicit user arbitration lifting the STEP_EXCLUDE line (a `.env` edit + recreate; never unilateral — the 25/10 exclusion and the 26/10 inversion are both user words). Worth it alone: 66 % of the remaining MiniMax haiku burn (~1.8 B cache-read / 21.6 h measured) moves to a free lane. Watch after lift: engine KV under the concentrated agent-sdk shape, and the po-2028 share becomes 100 % of MiniMax haiku (smaller, crisper signal for its own later arbitration).
4. **po-2028 — excluded, durably.** User decision 20/10 (CoursIA-3 secretary stays on MiniMax). This design does not re-propose it.

What this design deliberately does **not** change: no config-arm at a quota wall (AUTO=1 keeps that), no cascade reorder, no client-side `settings.json` flip (the 19/10 direct-route variant remains a per-machine user gesture), and no change to the `!own` failure semantics of step 0 — a connect-failure mark that benches only swift's own state is the correct containment tonight.

## 4. Trigger conditions (ROADMAP form)

- Gate R: 24 h green per §3 instruments → unlock Gate C measurement.
- Gate C: vllm lane publishes fs-tier capacity numbers + one agent-sdk-shaped probe passes → unlock the ai-01 proposal.
- ai-01 lift: user arbitration on Q-po2025-31 (already open) → one drained recreate, announce first on `global`.
- Parked forever unless the user reopens: po-2028.

## 5. Provenance

Mandate thread: user evening 26/10 (swift proposition → Q-po2025-31), ai-01 coordination 00:12Z 27/10 (option b), user night 27/10 ~04:45Z (mandate restated). Measurements: `minimax-plan-watch.log` lines 39–45, census files `.tmp/cons-evening.json` / `cons-1530.json` (2026-10-26), swift capture scans 26–27/10, DM `po2025-swift-econnreset-wedge-20261027T0412Z`. Engine incidents: 20/10 16:17Z wedge (deploy-2 incident, repli lesson), 27/10 01:47Z restart window + wedge. Related: `docs/reference/budget-failover.md` (#431, #693), `docs/reference/model-routing.md` (context limits), issue #700 (sobriety program — the demand side of this ledger).
