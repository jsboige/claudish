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
| Connect failures | ECONNRESET wedge 01:47→~05:20Z 27/10 (hairpin NAT flap, self-resolved); **zero** connect failures in the post-05:20Z window | DM `po2025-swift-econnreset-wedge-20261027T0412Z`, hub `[ttft]` scan |
| Overflow advances (400 >262,144) | **83 STEP-ADVANCE events on 27/10** (06:0x→09:14Z, one every 1–3 min at peak), each pairing a non-quota mark on step 0 | `failover-events.log` 27/10 |
| Corroboration, independent path | RSM condensation LLM via the same front: 3/3 connection errors at 04:14Z | dashboard append log |
| Contention | external consumers (Jamin, Candy — persons, inbound keys) share the same engine; their traffic takes the same resets | inbound-key attribution 26/10 |

Failure accounting (hub side, corrected 2026-10-27 ~09:30Z: this paragraph's 04:20Z draft said "no PAYG leak"; measured the same day, that holds **only while the sonnet lane keeps a healthy prepaid step**): a swift failure — connect error or the far more frequent **HTTP 400 context overflow** (83 advances on 27/10, the dominant shape) — gets one retry only on the connect branch (#80-2), then surfaces as a **non-quota mark on step 0** (`!own`, 30 s) with the session's dwell forfeited, and the request advances to `role:sonnet`. What that advance **costs** is decided by the sonnet lane's state, not by swift:

- **sonnet lane healthy (GLM nominal)** — the advance rides the subscription. Quota displacement, the original wording, correct in this state.
- **sonnet lane walled** — the advance lands on the cascade's last step. Measured 27/10: the Qwen step is closed by a #261 record-plane closure until 2026-11-11T16:00Z, and GLM re-walled (402) at 06:14Z, so from **06:14Z to 08:35:58Z** (GLM `RECOVERED → nominal`) every haiku advance billed PAYG. That window's fleet PAYG total: **8 706 resp / 8.73 M OUT / 28.9 M IN** over the day, of which h06–h08 (the cliff) is 4 819 resp — the bulk is the sonnet role's own overflow (the whole role was on PAYG), with haiku's share bounded by its 83 advances (≈1 % of PAYG responses, each carrying a ~170–190k-token prompt).

Standing consequence while the Qwen closure holds (until 11/11): **any GLM wall sends the entire sonnet role — including haiku's overflow tail — straight to PAYG.** GLM walls daily; the exposure is structural, not exceptional (this is the Q-po2025-30 march, already arbitrated-open at user level). A widening step that adds haiku volume to step 0 adds overflow tail to exactly this exposure; Gate C's sizing must quote PAYG landings per wall-hour as a first-class number.

### Incident 2026-10-31 — 3 h 02 without swift: it was the WAN edge, not the engine

Measured hub-side (`docker logs -t claudish-proxy`), same day. Last swift response **10:01:43Z** (reqN 12700, 27 s, `stop=tool_use`); the two long streams in flight then ended `stop=max_tokens` at **10:04:15Z** (229 s and 483 s, one 1.46 MB / 21 296 chars — runaway generations, not failures). From **10:04** to **10:14:22Z** the step took repeated non-quota marks, each preceded by the same line:

```text
Error: Cannot reach api.medium.text-generation-webui.myia.io for Vllm-myia. This is a network
problem on your machine — check your internet connection, VPN, or DNS resolver …
[Failover] STEP-ADVANCE haiku — HTTP 400 (non-quota) from step 0; trying next step
[Failover] step haiku[0] (Swift 1.5 local (vllm-myia)) failed (non-quota) — count=1 ttl=30s own
```

escalating `count=1 ttl=30s` (10:07:00Z) → `count=2 ttl=2min` (10:08:58Z), then fresh episodes every 60–90 s until 10:14:22Z. No further mark after that; what is measured is the effect: **zero swift responses between 10:04:15Z and 13:03:37Z** (3 h 02 m), while the engine itself was healthy throughout (ai-01's view: health 200, 0 restart, zero refusals).

**The mute is the WAN edge.** `api.medium.text-generation-webui.myia.io` resolves to **90.65.170.144**, po-2023's own WAN IP (`fleet-state.md`, VERIFIED 27/10): the swift path enters the fleet through **po-2023's IIS edge**, not through ai-01 directly. po-2023's host **froze at ~10:00Z** (Event 41 + 6008, no BugCheck; memory asphyxia — 6.08 → 3.26 GB free in 30 min) and **booted back at 12:59Z** (container Up 13:00:10Z). First swift response after the mute: **13:03:37Z**, 4 minutes after the edge returned. The silence is bracketed by the edge's death and rebirth.

Refuted by measurement: key rotation (a 401 would have *reached* the engine — ai-01 saw none), arms down (`docker inspect`: `Created=2026-10-30T16:57:48Z`, and `…_ACTIVE` holds four arms by value, below), configuration change (nothing changed between 10:01 and 13:03 except the edge's availability).

Two consequences worth keeping:

1. **A connect failure wears an "HTTP 400" label.** The classifier reports `HTTP 400 (non-quota) from step 0` for a request that never received an HTTP answer. Read `failover-events.log` alone and you diagnose an engine refusing work it never got. Instrument fix is a candidate issue (not opened unilaterally).
2. **Gate R measures the engine; the availability of step 0 is the *edge's* health.** Same single-homing as Q65's WAN edge (po-2023). A green Gate R clock says nothing while the edge depends on one host that freezes under memory pressure.

Drift observed the same day (measured, no gesture): live `…_ACTIVE` = `haiku@myia-po-2027,haiku@myia-po-2023,haiku@myia-po-2024,haiku@myia-po-2028` — **four arms**, versus the three recorded at the 27/10 00:52Z arm. `po-2028` is armed although ladder step 4 parks it forever — benign while `STEP_EXCLUDE` holds (its walk skips step 0 and lands on its nominal MiniMax), material at a MiniMax wall (it then walks `role:sonnet` → PAYG). Restoring the three-arm form is a cascade change and therefore waits on explicit user accord.

Day-level cost of the same window (13:05→14:40Z, after the 13:30:44Z MiniMax wall): swift 166 responses, and the haiku overflow that could not wait rode `role:sonnet` to `ds@deepseek-flash` — 2 784 PAYG responses in 95 minutes.

### The third hop: hub and engine share a LAN, and the path leaves it (proposal, 31/10 — no gesture)

Measured: `customEndpoints.vllm-myia.url` is
`https://api.medium.text-generation-webui.myia.io/v1`; that name resolves to
`90.65.170.144`, **po-2023's WAN IP** (IIS site 49). The hub (po-2025) and the
engine (ai-01) are on the **same LAN**. So every hub→swift call leaves the LAN
through the public façade and comes back — and dies when po-2023's host does,
which is exactly what happened on 31/10 (3 h 02, §Incident above).

The engine's lane (DM 17:12Z, on the user's 31/10 routing mandate) proposes
routing the **internal hub→swift flow over the LAN** — `http://<ai-01-LAN>:5002/v1`
with the MEDIUM key — while **external seats keep the public name and the
`external-vllm` key** (po-2023/2027/2024/2028 sidecars, Jamin and Candy's inbound
keys). Blast radius of such a step, stated exhaustively: the `url` field of one
custom endpoint in `config.json` (bound into the container, read at startup →
one drained recreate), and the credential the engine accepts from a LAN source.
`maxConcurrency`, `contextLimit`/`deriveContextLimit`, `STEP_EXCLUDE`, the
cascade list and the ladder are untouched.

Preconditions — each must be measured, none assumed. **Three of the four are
measured true (31/10 ~23:5xZ); the fourth is a user arbitration, not a
measurement:**

1. **The engine's LAN address, and a successful `GET /v1/models` on it with the
   MEDIUM key.** Measured by the engine's lane: **`192.168.0.47:5002`** (interface
   `MyIA-AI-Gigabit`), listening on `0.0.0.0`, `200` in 8 ms from ai-01's host,
   `401` without a key. Never guess the address — this one is on record now.
2. **Reachability from inside the hub's container** (Docker Desktop NAT), not
   from the Windows host. Measured from `claudish-proxy` on po-2025: **`200` in
   15 ms**; the same call through the public name answers **`200` in 86 ms**. The
   LAN route is ~5.7× faster on the handshake alone and never leaves the switch.
   `frognano` at `host.docker.internal` was never evidence for this — the
   measurement is.
3. **The engine's own view of a LAN client — key and header shape.** Decided by
   the engine's lane: **MEDIUM**, on the argument that the hub→engine flow already
   carries that key today through the edge, so a LAN route distributes no new
   secret and leaves the revocation surface unchanged (`external-vllm` stays
   reserved for the public path, cap 2, for Jamin and Candy). Two operational
   facts that will bite anyone testing it: the engine accepts
   **`Authorization: Bearer` only** (`x-api-key` on the same LAN URL answers
   `401`), and the credential that actually works is the container's
   **`VLLM_API_KEY`** (sha256 `db2738ab1328…`), **not** the 15-character `apiKey`
   literal still present in `config.json` — a probe that reads the config file
   tests the wrong secret and reports a false 401.
4. **A `global` announce before the recreate**, per the entry-form rule: a change
   to how the fleet reaches the engine is announced before it is applied. **Still
   open — this is the user arbitration (Q65).**

What it would and would not fix: the hub's own traffic stops crossing the edge
(the 31/10 failure mode disappears for it); the **engine stays a single point**,
and the four external seats still cross the WAN, so Q65 stands for them. Rollback
is the same size as the change — put the public name back, recreate, announce —
and the public name stays documented as the fallback that carried the whole
afternoon of 31/10. Side effect on the engine's census, stated by its owner: hub
calls then appear without `x_forwarded_for` (the `?` bucket, like local calls) and
never under `90.65.170.144` again, so before/after is distinguishable.

Proposal only; the three measurements are in and the arbitration is what remains.

## 3. Design — three gates, then one ladder

### Gate R — engine reliability (precondition; **running green since 05:20Z 27/10** — closes 28/10 05:20Z if it holds)

Rolling 24 h, measured hub-side (cheap, per cycle). Window since 05:20Z 27/10 (post-wedge): **0 connect failures** (n=125 `[ttft]`), **ttft p95 8 933 ms** (< 10 s, p50 1 816 ms), **0 `UNEXPLAINED ENDING`** (the 4 logged UNEXPLAINED all sit inside the 03:40–04:08Z wedge window and do not count).

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

Mandate thread: user evening 26/10 (swift proposition → Q-po2025-31), ai-01 coordination 00:12Z 27/10 (option b), user night 27/10 ~04:45Z (mandate restated). Measurements: `minimax-plan-watch.log` lines 39–45, census files `.tmp/cons-evening.json` / `cons-1530.json` (2026-10-26), swift capture scans 26–27/10, DM `po2025-swift-econnreset-wedge-20261027T0412Z`. Engine incidents: 20/10 16:17Z wedge (deploy-2 incident, repli lesson), 27/10 01:47Z restart window + wedge. 27/10 ~09:30Z correction pass: `failover-events.log` 27/10 (83 STEP-ADVANCE, GLM wall 06:14Z → `RECOVERED` 08:35:58Z, Qwen closure until 11/11), PAYG tail-sum over 27/10 captures (8 706 resp / 8.73 M OUT / 28.9 M IN), sonnet demand p50 **159.2k** tok (n=2 436, 1 h window 27/10 07:00Z+, `prompt-size-dist.py` @ PR #708) — July sonnet p50 was 43.8k, so the 120–190k session shape is now the sonnet lane's too, not only haiku's. Related: `docs/reference/budget-failover.md` (#431, #693), `docs/reference/model-routing.md` (context limits), issue #700 (sobriety program — the demand side of this ledger).
