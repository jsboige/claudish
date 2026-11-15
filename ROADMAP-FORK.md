# Fork Roadmap

Planned-but-unimplemented work specific to THIS FORK (the fleet). Same discipline as `ROADMAP.md`: explicit **trigger conditions**; if a trigger is not met, the item stays parked. Items here are kept out of `ROADMAP.md` so the upstream file can merge cleanly (#897 P1).

> **Provenance**: `ai-docs/` is a gitignored local research-session dir — every citation below is provenance, not a repo path.


## Adaptive / shared backoff pacer for burst rate-limits

Status: not started. Deliberately deferred — current per-request backoff is judged sufficient for the present load.

**What ships today** (the in-stream rate-limit fix): when an `anthropic-sse` provider (notably Z.AI) delivers its burst/RPM limit as HTTP 200 + an in-stream `[1302]` SSE error, ComposedHandler peeks the stream start, detects it, and **temporizes with a per-request jittered exponential backoff** (1s/2s/4s + 0–750ms), retrying the same provider up to 3× before returning 429 so FallbackHandler switches providers (e.g. Z.AI → GLM Coding, a separate quota). The transport layer (`AnthropicProviderTransport.enqueueRequest`) adds a second jittered backoff on genuine HTTP 429. Both are **per-request and independent** — there is no shared, cross-request pressure gauge.

This produces *implicit* aggregate self-throttling: under a storm, more requests hit 429 → more requests back off → offered load drops. It does not, however, make *new arrivals* probe more cautiously while a storm is in progress — each new request still fires at full rate on its first attempt. With the stated load (≤50% of the 5h sustained quota even at peak; only the instantaneous burst limit is hit occasionally, and the cluster shares one key per provider), that residual gap is acceptable and a coordinated pacer would be over-engineering.

**What this item would add**: a shared per-provider pressure gauge (e.g. AIMD — additive-increase/multiplicative-decrease — with time decay) that admission-paces *new* requests as the recent error rate climbs, so the fleet spreads requests **more** under a sustained storm rather than only after each individual request fails. This is the "écarter encore plus les requêtes quand le taux d'erreurs augmente" idea — correct in principle, but only worth the complexity (shared state across 6 machines, or per-process approximation; tuning; new failure modes) if the simpler per-request backoff proves insufficient.

**Trigger conditions** (any one):
- Sustained-quota utilization regularly approaches its ceiling (not just the instantaneous burst limit) — i.e. the "we have headroom" premise stops holding.
- Capture/telemetry shows the in-stream-rate-limit fix's 3-retry budget is frequently exhausted (turns still failing over to fallback or to the client) despite the backoff — meaning synchronized full-rate probing during storms is the dominant remaining failure.
- The cluster grows enough that uncoordinated per-request backoff visibly re-collides on the burst limit even with jitter.

**Effort**: medium. A per-process AIMD gauge is small; a genuinely *shared* cross-machine gauge needs a coordination point (shared store or a designated pacer) and is the bulk of the cost.

**Reference**: in-stream rate-limit fix — `packages/cli/src/handlers/shared/stream-peek.ts`, `composed-handler.ts` (peek+retry block), `providers/transport/anthropic-compat.ts` (`enqueueRequest`). Root-cause analysis in this session's capture diagnosis.

---

## Signature-based role routing — MultiConnector absorption (#82)

Status: design proposition, not arbitrated. No code.

A per-signature offload policy: compute a prompt-shape signature (tools + system prefix + client model) once at the `/v1/messages` route, and when an operator-armed table (`CLAUDISH_SIGNATURE_ROUTING=1` + bind-mounted `CLAUDISH_SIGNATURE_TABLE`) matches, route by the table's role instead of the client's named model — one `effectiveModel` for every downstream consumer (bucket, cascade, dwell, handler), never at failover depth > 0, never onto a native lane the client didn't name. Tables are produced by offline vetting campaigns against the capture corpus (oracle: Opus on ai-01, post-reset) and proposed, never auto-applied. Full design, measured ground and invariants: `docs/reference/signature-routing.md`.

**Trigger conditions** (all must hold):
- Explicit arbitration GO from the user on the design doc (routing changes get specified, arbitrated, then built — #79/#21 precedent).
- Gate M1 measured: per-session signature stability on one archived capture day (the sigres exports carry no session key, so this needs a re-run keyed by `sessionKey`); if the p90 session carries > 1 signature, the per-session pin variant is the design that gets built.
- The extractor is unified (one module serving the online route and the offline measurer) before any table is trusted — a drift silently orphans entries.

**Effort**: medium — route-level signature read + table load + pins; the vetting campaign machinery is the larger half and is owned with CoursIA (semantic-fleet side, `IChatClient` over `/v1/chat/completions`).

**Reference**: `docs/reference/signature-routing.md`; capability map + concentration measurements in issue #82; coordinator review of the first draft in PR #339.

---

## Haiku → swift debrayage — staged widening (Q-po2025-31)

Status: design arbitrated in vehicle (option b, ai-01 coordination 2026-10-27), gates not met. No config change pending.

The mechanics are already live (cascade step 0 = `vllm-myia@swift-1.5-27b!own`, three machines armed, `AUTO=1`, ai-01 STEP_EXCLUDEd, po-2028 excluded by user decision) and the six armed machines' haiku already touches zero MiniMax. The remaining surface is the one that matters: **lifting the ai-01 exclusion — 66 % of the residual MiniMax haiku burn (~1.8 B cache-read / 21.6 h)** — behind two measured gates: Gate R (engine reliability: ECONNRESET rate < 2 %, ttft p95 < 10 s, no UNEXPLAINED ENDINGs over 24 h — **failed as of 2026-10-27 04:10Z**, wedge active) and Gate C (a 30-min agent-sdk-shaped load probe at target concurrency, engine capacity numbers from the vllm lane). Each widening step is one drained recreate with a prior `global` announce; po-2028 is durably out.

**Trigger conditions** (all must hold before the ai-01 proposal goes to the user):

- Gate R green for 24 h (hub-seat canaries + `failover-events.log` mark rate).
- Gate C probe passed at the agent-sdk shape (52 % of ai-01 haiku; sessions re-read 120–190k context per turn).
- User arbitration on Q-po2025-31 lifting the STEP_EXCLUDE line.

**Effort**: small config + one drained recreate; the cost is the measurement discipline, not the change.

**Reference**: `docs/reference/haiku-swift-debrayage.md`; mandate + measurements provenance therein.
---

## Workload routing — agent-sdk vs interactive, refining the 25/10 machine-level arbitration

Status: design proposition, not arbitrated. No code.

The 25/10 arbitration ("ai-01 = MiniMax, never swift") is machine-level, but the census says the MiniMax burn driver is a workload (52 % `agent-sdk` planned work), not the machine. The hub already sees the workload marker in the request body (`cc_entrypoint=` / `cc_workload=`, the same fields `scripts/traffic-consumption.py` buckets the census by) — so the route can divert *planned* haiku to swift while *interactive* ai-01 stays MiniMax, and the #693 `STEP_EXCLUDE` narrows from machine-wide to workload-scoped so the two rules share one vocabulary. Full design (signal verification, seam choice, composability, pins): `docs/reference/workload-routing.md`.

**Trigger conditions** (both must hold):

- The user refines the 25/10 arbitration to workload level (routing changes get specified, arbitrated, then built — same precedent as #82).
- The haiku→swift unlock's reliability door passes (PR #704 porte R — engine ECONNRESET/hairpin fixed and capacity measured); this item is the mechanism inside that design's W door and does not bypass it.

**Effort**: small-medium — one per-request substitution at the `resolveNativeModelPin` seam + `STEP_EXCLUDE` predicate extension + three-request pin.

**Reference**: `docs/reference/workload-routing.md`; dispatch context in issue #641 QUEUE v6 (ai-01, 27/10); census ground in the MiniMax consumption investigation (ai-01, 26/10).

---

## Relay verdict — continuous refutation evidence (WAN false positives)

Status: not started. The **bounded** mitigation shipped — `CLAUDISH_RELAY_HEARTBEAT_TIMEOUT_MS` (#714/#715, range 2000-9000 ms) and its documentation (`docs/deployment/relay-sidecar-deployment.md`, `docs/reference/relay-internals.md`) — and was deployed on the first WAN-upstream seat on 2026-10-27. This item is the structural fix the same incident exposed, deliberately not folded into that PR.

The asymmetry, read from the code: `proberTick` (`relay.ts:1105`) does exactly one thing while NOMINAL — a `/health` GET — and acts on its result; `deepProbe`, the only instrument that could refute the verdict, runs **solely** in the AUTONOMOUS branch, behind 3 OK heartbeats and the 60 s cooldown. So the state that decides whether traffic reaches the hub is held by the cheapest instrument available, a false positive is cheap to enter and expensive to leave, and once flipped nothing upstream is sent — no client request can refute it. Measured 2026-10-27 on po-2027: 20 AUTONOMOUS windows, 380 requests served locally (121 answered, 259 refused by the provider wall), while the deep probe answered `message_stop` in 1.0-1.4 s every time it was finally consulted. Raising the bound shrinks the false-positive rate; it does not give the harness an instrument that can say *"the hub would have served that"*.

Candidate designs (unarbitrated, listed so the arbitration has something concrete to reject):

- **Low-rate real probe while NOMINAL** — a bounded tool-call stream at a period long enough to cost nothing measurable, so a false positive is contradicted before the second heartbeat failure lands.
- **A "would-have-worked" counter** — on the first request served after a flip, replay the forward once **without diverting the client** and record the outcome; the metric is *flips contradicted within one turn*, which today does not exist at all.

**Trigger conditions** (both must hold):

- Either a second WAN-upstream sidecar is onboarded, **or** a flap is measured on a seat already running the `9000` bound — a false positive that survives the raised bound means the bound is the wrong *instrument*, not merely undersized.
- The coordinator accepts one of the designs above. A liveness probe spends provider budget on every tick it runs; that cost, not the code, is why this is parked rather than done.

**The minimal form of the second design — one replay per switch, nothing else** (the shape to implement *if* the trigger fires; recorded here so the arbitration can price it without designing it):

- **Seam**: once per AUTONOMOUS *entry*, on the first request that got served locally, and only **after** the client's answer is complete. One replay of the identical body down the existing forward path, bounded by the heartbeat bound, result reduced to a boolean.
- **What it answers**: `flipContradicted` — *did the hub that this node just declared dead serve the very request it refused to send it?* Logged as one greppable line, never a capture (a replay is a measurement, not traffic), and never counted as a served turn.
- **Cost**: one request per flip, zero on a seat that does not flap — which is why this form is priced against the periodic probe, not beside it. A quiet seat pays nothing.
- **Not in scope, on purpose**: no client diversion (the local answer has already been produced), no re-arm (the hysteresis machine owns that path and a replay is not a liveness measurement), no second replay for the same entry, and nothing that can throw — a replay that fails is `flipContradicted=false`, not an error on a request that already succeeded.
- **Acceptance**: synthetic flap with the hub reachable by replay → `flipContradicted=1` and the **client still received the local answer**; genuine outage → `0`; every terminating path still emits `message_stop`; and a pin that a second request in the same AUTONOMOUS entry does *not* replay.

**Effort**: small-to-medium — one probe path (or one replay seam) + counters + a hysteresis regression pin.

**Reference**: `docs/reference/relay-internals.md` §heartbeat knob and §"where the liveness harness stops seeing"; issue #711, PRs #714/#715; the 27/10 measurement in `docs/deployment/relay-sidecar-deployment.md`.

---
## Capture pipeline port to v14 (#641 blocker 2)

Status: executed 27/10 — PR #722 (port: 3 verbatim files + 10 wired, 8 invariants mutation-tested) and PR #723 (the 17 mechanical lint errors) sit on `replatform/v14` awaiting coordinator review. Remaining for acceptance: the consumer read-back of a live v14 capture corpus (needs a v14 build with `CLAUDISH_CAPTURE_DIR`), and the spec doc deletion on main at merge time. The `test:strict` baseline learn for v14 is blocked: the strict runner itself is among the manifest-absent files.

The go/no-go evaluation for `replatform/v14` → `main` (#641) lists the absent capture pipeline as hard blocker 2: v14 carries zero capture writers, so the traffic-measurement apparatus (`claudish_traffic`, `traffic-*.ps1`, attribution #98/#400/#566/#662, leak-policy greps, `turn-autopsy.py`) dies at landing. The port is narrow — v14 already has the parsers, `instance-id.ts`, `inbound-keys.ts` and `HOPS_HEADER`; it moves 3 files and wires 9 call sites, with producer-side format pins traveling along.

**Trigger conditions** (both must hold):

- Direction (B) — finishing the re-stack INTO v14 — is confirmed as the landing strategy (the NO-GO verdict on direct landing is accepted; re-stacking direction recommended, not yet user-arbitrated).
- The coordinator schedules the blocker (it gates every GO re-evaluation of #641 alongside channel mode and context admission).

**Effort**: small-to-medium — 3 file copies, 9 anchored wires, test carry-over; the real risk is silent invariant drift (reqN freeze at ingestion, hops seating, pre-strip capture), covered by the acceptance run in the spec.

**Reference**: `docs/reference/capture-pipeline-port-v14.md`; go/no-go evaluation on #641 (comment 6434476328).

---

## Catalog cache write on read-only mounts — honor a writable cache path

Status: not started. The fallback chain (disk cache → passthrough-unchanged) works by design and nothing user-visible degrades, so this is polish plus log hygiene, not a defect fix.

Docker deployments that mount `/root/.claudish` read-only make every catalog refresh log `[Catalog] cache write skipped (unwritable path): EROFS…` — `openrouter.ts:392` catches the failed `all-models.json` write. Measured on the hub seat: it fires on every catalog refresh, including mid-run (14:21:51Z on 28/10 with no restart in the window), not only at container boot. The container already carries `CLAUDISH_MODEL_CACHE_PATH=/var/cache/claudish/all-models.json`, yet the write still lands on the read-only home — either the catalog writer ignores the var or the var postdates the code path.

**Trigger conditions** (either holds):

- Cold-start catalog latency is measured as a problem on a read-only-mount seat (the in-container warm cache never persists), or
- The per-refresh stderr warning is reported as operational noise by a fleet coordinator.

**Effort**: small — route the catalog write through `CLAUDISH_MODEL_CACHE_PATH` (first verify why it is ignored today), or demote the warning to debug level when the fallback succeeds. One unit test with a mocked unwritable path.

---

## Catalog refresh on a running proxy — a bare name keeps the chain it was first given (#893)

Status: not started. Parked on 13/11 by the coordinator's arbitration of #893. The design carried there (routing-miss trigger, two-class TTL, `stale` state in the version watch) is not adopted as written; the reasons are in the arbitration comment and its correction.

What the code does today:

- The container proxy (`standalone-proxy.ts`) loads the model catalogue at startup, then refreshes it on a timer: the native-pin watch calls `refreshCatalog` every 6 hours (`CLAUDISH_NATIVE_PIN_AUTO_INTERVAL_MS`). A refresh that fails keeps the catalogue in memory and waits for the next tick. An id published upstream is therefore unknown to a running proxy for up to one interval, longer while refreshes fail. A proxy started by the CLI has no such timer and keeps the catalogue it started with.
- An explicit `or@…` target is resolved again on every request, so it picks a new id up at the next refresh.
- A bare name does not. The provider chain built for it on its first request is cached for the life of the process (`fallbackHandlerCache` in `proxy-server.ts`), with the OpenRouter id as the catalogue resolved it at that moment. A bare name whose chain has an OpenRouter hop, first requested before the catalogue knew it, keeps that hop unresolved until the next restart, whatever the catalogue has learnt since.
- The resolver is consulted for `openrouter` targets only. An explicit `kc@…` or `qwen-token-plan@…` step never reaches it, which is why nothing here would have caught the two manual re-pins that motivated #635.

What would be built: a refresh that changes the catalogue drops the cached chains, so the next request for a bare name is routed against the catalogue in memory. Resolution stays synchronous and the request in flight keeps its path. Optional second step, only if one interval is measured as too long: on a resolver miss, one background `refreshCatalog`, single-flight, behind a global cooldown, and never again for the same id on the same catalogue (an id legitimately outside it would otherwise fetch forever). No new TTL: three already read the cache file (launcher, interactive picker, MCP server).

**Trigger condition**: a request is measured leaving for OpenRouter with an unresolved bare id while the live catalogue already listed that id, on a proxy that had not restarted since the id appeared.

**Effort**: small — invalidate one map from the refresh's success path, and one pin per guard (a changed catalogue rebuilds the chain, an unchanged one does not, a failed refresh keeps both the catalogue and the chains).

**Reference**: #893 (the design, the arbitration comment of 13/11 and its correction, with the code locations).

---

