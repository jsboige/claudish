# Signature-Based Role Routing — MultiConnector Absorption Design (#82)

Status: **design proposition, not arbitrated, no code** (the #79/#21 precedent: routing changes get specified, arbitrated, then built). Owner: po-203 (component pivot, user mandate 2026-09-08); junction with CoursIA (user decision 2026-09-29 — semantic-fleet side: MyIntelligenceAgency/semantic-fleet#82, CoursIA#1210). This revision incorporates the coordinator review of the first draft (PR #339, 2026-10-05): route-level placement, the native-lane invariant, the signature-key corrections, recalculated dimensioning, the campaign's prod-bucket and egress boundaries, and the per-session stability gate.

## 1. Mandate and provenance

The user directive (2026-09-08) makes po-203's post-migration role the pivot of claudish's improvement, first track: **absorb the semantic-fleet intelligent-routing competence**. The 2026-09-29 decision redirects the source: CoursIA restored the complete semantic-fleet line (branch `restore/integration` → `stable-from-v0343`, v0.34.3 + 17 May-2025 commits, 36 `.md`), and the competence in question is the **MultiConnector**: a primary model answers by default and vets secondary models on each prompt signature; secondaries that pass take over that signature, weighted by cost and duration; replay tests re-qualify them over time. That is a **per-signature offload policy learned online** — which claudish does not have: today routing is role-level and failure-driven (modelMap, walls, cascades, dwell).

Inputs: the capability map (issue #82, 2026-10-01, coordinator-reviewed), the measured concentration (2026-10-02). Where the map's claims were downgraded, this doc carries the corrected numbers only.

## 2. Measured ground

Corpus: two archived hub days (2026-09-28: 42 909 req; 2026-09-29: 40 498 req), 100 % parsed. Signature = `md5(sorted tool names) | md5(normalized 512-char system prefix) | named model id`.

| Measure | Value |
|---|---|
| Fleet responses/day (archive listings, 09-25→09-29) | 37 428 – 87 240, typical ~42 k |
| Distinct signatures per day | 421 / 425 |
| Classes above 1 %/day | **43 / 47** (measured — this, not "50–100", is the vetting universe) |
| Top-10 share | 42,6 % / 26,4 % |
| Top-50 share | 76,1 % / 64,2 % |
| Sub-agent population (`cc_is_subagent`) | 68,6 % / 65,6 % of volume, 277/281 forms, top-10 **52,0 % / 33,4 %** |
| Interactive population | 147/141 forms, top-10 61,8 % / 50,2 % |
| Date motifs in the first 512 chars of system | **0 / 83 407 requests** (only this was searched — no broader "RAW ≡ STRIPPED" identity is claimed) |

Reading: **moderate concentration, long tail**. Note the correction this forces: by concentration, the sub-agent population is the **least** concentrated of the two (top-10 52,0 %/33,4 % vs 61,8 %/50,2 % interactive) — its candidacy for signature routing rests on volume, budget-model tolerance and the leak policy's desire to keep it off the native lane, **not** on repeatability. That argument is weaker than the first draft claimed.

## 3. Design

### 3.0 Options considered

| Option | Where the override applies | Cost | Verdict |
|---|---|---|---|
| **A — route** | signature computed once at the `/v1/messages` route, before role/bucket derivation; a single `effectiveModel` replaces the client's model for every downstream consumer | one body-shape read on the request path (µs, a `Map` lookup over ~420 keys — a radix tree is not warranted at this size); touches the route's plumbing | **chosen** — the only placement where all consumers see one model |
| B — handler | inside `getHandlerForRequest` | the function receives only `requestedModel` — it has no body to sign; rewriting there forks the resolution (route-derived bucket vs handler-derived target), exactly the #275 drift | rejected |
| C — do nothing | no signature layer | zero | retained as the standing default until arbitration; the campaign (§3.4) can run and produce tables with no serving change at all |

### 3.1 Where signature matching sits (option A, in detail)

**The signature is computed ONCE, on the `/v1/messages` route, from the parsed request body, BEFORE any role or bucket derivation.** The result is a single `effectiveModel` — the client's model, or the table's role placeholder when an entry matches — which then circulates to **every** consumer: `roleFromModelName`, the nominal-bucket derivation (`classifyNominalBucket`), the cascade, the dwell, and `getHandlerForRequest`. There is one resolution path; no consumer ever sees the pre-override model.

- The override is **never** applied at `depth > 0` (failover re-entry) — the cascade owns depth ≥ 1.
- An explicit target (`provider@model`, or any id with `/` or `@`) skips the table entirely — same predicate family as `classifyNominalBucket`'s explicit-target branch. Silently rerouting an explicitly named target is invisible routing (non-goal).
- Sync, in the hot path: a `Map` lookup over ~420 keys, the cost class of `resolveModelNameSync` (never async before handler construction).
- **Relay mode**: the override applies at the **hub only**. A NOMINAL sidecar forwards raw and never resolves; the signature table lives with the cascades, which is where the hub's policy surface already lives.

### 3.2 The signature (and the two capture/run-time asymmetries it must survive)

```
signature(request) = md5(sort(tool_names)) | md5(normalize(system_prefix_512)) | client_model_id
```

- `tool_names`: `tools[].name` from the parsed body, sorted, deduped.
- `system_prefix_512`: first 512 chars of the concatenated top-level system text, normalized by stripping date/path/UUID/number tokens **and the whole `x-anthropic-billing-header:` line** before the 512-char prefix is taken. Two asymmetries measured by the review: (a) `request-logger.ts` extracts neither tools nor system — the signature reads them from the **body**, and the same extractor module must serve the online route and the offline measurer or the table's keys and the traffic's keys drift; (b) the billing line carries `cc_version` (changes every Claude Code release) **and `cch=`, a token that changes on every request** (`billing-header-strip.ts` header comment) — normalizing `cc_version` alone would leave a per-request token inside the prefix, so the extractor drops the line whole. The line's presence is not an online/offline asymmetry under option A: capture (`logRequest`) and the route-level signature both read the body **before** `stripBillingHeaderFromBody`, which runs after handler selection and only for non-native handlers (`proxy-server.ts`, `/v1/messages` route). Dropping the line in the extractor makes the key independent of that ordering anyway. (Correction 2026-10-05: the coordinator review stated the asymmetry the other way.)
- `client_model_id`: the **original, pre-override** model id. Once an override is active, a capture keyed on the rewritten model would feed the table with its own decisions — the capture path must record the client's ask.

### 3.3 The native-lane invariant (black on white)

**A signature override must never produce a native target the client did not already name.** On the hub, `modelMap.opus` resolves to a bare `claude-*` → `NativeHandler`, which relays `payload.model` verbatim; off ai-01 that traffic has no Anthropic credential and takes the #296 403 — an override to `opus` would break a turn that worked. The invariant: the table stores **roles**, and a role whose nominal **resolves to `NativeHandler`** is **skipped** for this request unless the client's own model already resolved to that same native lane. The test is the resolved handler (or the #218 guard, `startsWith("claude-")`) — **never** "is bare" (`isNative`: no `/`, no `@`): on this hub `sonnet: "glm-5.3"` is bare too and is kept off the native lane only by resolving to a remote handler, so a bare-name test would skip every override to `sonnet` and leave the feature inert on its main target (CLAUDE.md, Model Routing, #218 gotcha). Guarded by a route-level test the day code exists.

### 3.4 The offload table (the policy surface)

```
CLAUDISH_SIGNATURE_ROUTING=1        # arming switch — default empty/off (compose injects ""; only "1" arms)
CLAUDISH_SIGNATURE_TABLE=<path>     # bind-mounted JSON: [{ "sig": "<hex>", "role": "sonnet", "until": "2026-11-01" }]
```

Both names must be carried by `docker-compose.yml`'s `environment:` list (#304 — `compose-env-coverage.test.ts` refuses an unreachable knob), and the table file arrives by bind mount next to the captures config. The table is read **at boot only**; a reload is a recreate (the standard container rule — no hot half-state, a request either sees the old table whole or the new one whole). Malformed entries are skipped with a stderr warning and never crash the proxy (custom-endpoints precedent); the startup line `[Signature] table loaded entries=<n> valid=<m> expired=<k>` counts what loaded. Entries carry `until` — a table is a campaign result, not a standing law. The table is written by vetting campaigns as a **PROPOSAL** (dashboard + config diff); there is no auto-apply.

Marker discipline: emit `[Signature] hit role=<r> sig=<8hex>` **on hits only**; misses are a periodic counter (`[Signature] miss-window total=<n> matched=<m>`), never per-request lines — at ~42 k requests/day a per-request miss line would drown the log.

### 3.5 The vetting campaign (offline, on the corpus that exists)

The MultiConnector's online vetting (shadow completions in the request path) is deliberately not absorbed (§5.2). The campaign shape, run offline against the capture corpus:

- **Classes**: the **43/47** measured above 1 %/day (§2).
- **Candidates**: 6–8 budget-lane models.
- **Protocol**: classes × candidates × (3 test completions + 1 oracle evaluation) = 47 × 8 × 4 ≈ **1 500 shadow completions** (ESTIMÉ — the arithmetic, shown as demanded; the first draft's "1 250" did not follow from its own factors).
- **Cost (ESTIMÉ, nothing measured)**: output ~600 k–750 k tokens; **input is the dominant post** — at fleet context sizes the campaign's prompt re-reads are on the order of **10⁸ tokens**, cache-priced where the lanes cache, but never zero. Planning number: a campaign is priced like a small day of hub traffic, not like a rounding error.
- **Oracle**: Opus, served from ai-01 only, drawing the fleet's weekly Claude plan — one campaign per week, launched after the reset, never at end-of-week (~50–80 k output tokens). Budget-judge pre-filter documented as an economy option **not taken by default** (circularity).
- **Prod-bucket isolation (review blocker)**: campaign completions draw on the **same buckets as production** — a quota 429 mid-campaign arms a #275 wall that exiles real traffic. The campaign therefore runs **off-peak** (the 03:00–06:00 window the watchdog already uses), rate-limited, and aborts on the first qualifying wall-class refusal. And because explicit targets remain subject to failover, a campaign completion can be served by a cascade step and measure the wrong model — the campaign runs against a **dedicated instance with no `CLAUDISH_FAILOVER_*` value set** (every path inert only when nothing is set — unsetting `CLAUDISH_FAILOVER_ACTIVE` alone is not enough: with `CLAUDISH_FAILOVER_AUTO` on and a `CLAUDISH_FAILOVER_<ROLE>` cascade configured, a wall still auto-arms and diverts; check by value, not by name) so what is measured is what was asked. "Off-peak" is read in UTC and must also avoid the hub's nightly compaction (00:47Z → ~03:05Z) and its daily drained restart, which cuts in-flight streams (read both times from the hub logs when scheduling — they have moved before).
- **Egress boundary (review blocker, named)**: the corpus is the fleet's real prompts; the campaign sends them to third-party providers, and the oracle sees prompts that production routed to *other* providers. Boundaries: sampled prompts only (the minimum per class), run from the ai-01 seat, no persistence beyond the campaign's own outputs, and the same traffic already transits these providers in production — the *new* exposure is cross-provider visibility, which the sampling cap bounds.

### 3.6 Composition invariants

- **The signature resolves the ROLE, never the STEP.** Walls, per-step backoff, reset-times, escalating bucket TTLs: untouched. The bucket derives from `effectiveModel` through the existing `classifyNominalBucket` — contagion stays provider-scoped, never signature-scoped.
- **Per-session stability — gate M1 (measurement required before any build).** The signature is per-request; within one conversation the shape changes (tools added, system-reminders), so the role can oscillate turn to turn, and each flip costs a cold prompt cache — exactly what the #91 dwell exists to prevent. The existing sigres exports carry no session key (measured limitation: signature fields only), so **M1**: re-run the concentrator on one archived day keyed by session, reporting distinct signatures per `sessionKey`. Rule fixed in advance: **if the p90 session carries more than one signature, the override is pinned per session (first-signature-wins, re-evaluated only after the session idles past one dwell window); otherwise per-request application stands.** In both cases the dwell keys stay `(role, sessionKey)` and a mid-session spawn of sub-agents (different shapes) remains legitimate — per-role pins must not trample each other.
- **Notices (#126 doctrine)**: fire on the **effective-model change against the session's pinned model**, not per request — an oscillation must not produce a notice per turn. Channels unchanged (content block 0 + condensation on `/v1/messages`; the response header on `/v1/chat/completions`); facts, never instructions.

### 3.7 Junction with CoursIA (the four-hands split)

Unchanged from the first draft: the OpenAI-compatible ingress (`POST /v1/chat/completions`) is the natural backend for a semantic-fleet `IChatClient` MultiConnector — pointed at claudish, the vetting client inherits role routing, the cascade, accounting, captures and the leak policy by changing `base_url` alone. CoursIA owns the matcher and the vetting client; claudish owns the policy surface (signature→role resolution, the table format, the notice channels, the capability vocabulary #83). Zero shared code, one wire. The shared bench is semantic-fleet's vetting run against claudish-served models.

## 4. Rollout gates

1. Switch unset/empty or table absent → **byte-identical behavior** (the `initFailover` inertness standard).
2. Table present + switch armed → override applies only to non-explicit, role-derivable, non-native-violating requests; one `hit` marker per match; notices only on session-level model change.
3. Startup load line counts valid/expired/malformed entries.
4. Route-level pins (the day code exists): override + explicit target (no effect); override + native resolution (skipped — §3.3); override + dwell (pin independence incl. the sub-agent spawn case); notice emission cadence — one test per branch, mutations on the override predicate.

## 5. Deliberately left out (unchanged from the capability map, Q4)

1. **All `PromptTransform` layers** — boundary #65 §4: no invisible prompt mutation; the sanctioned channel toward the model is the negotiated vocabulary (#83).
2. **Adaptive detection in the serving path** — never-hang + harness cost: signature discovery runs offline on the capture corpus.
3. **Per-signature generation-parameter mutation** — client-visible body change; possible later grain, explicitly arbitrated first.
4. **Auto-apply of vetting suggestions** — PROPOSAL channel only.
5. **The MultiConnector's fallback strategy** — subsumed by the bucket cascade (#275).

## 6. Open questions (carried to arbitration, not solved here)

- Campaign operator and cadence owner (ai-01 seat, post-reset) — coordinator dispatch.
- Table provenance on the wire (campaign id inside the config vs. dashboard-only) — implementation review.
- **Extractor unification** — one module for the online route and the offline measurer; a drift here silently orphans table entries (hit rate → 0 with no error).
- M1's per-session measurement (§3.6) — required before any build starts.
