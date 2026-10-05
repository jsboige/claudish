# Signature-Based Role Routing — MultiConnector Absorption Design (#82)

Status: **design, no code** (the #79/#21 precedent: routing changes get specified, arbitrated, then built). Owner: po-203 (component pivot, user mandate 2026-09-08); junction with CoursIA (user decision 2026-09-29: « travail à quatre mains, avec des issues de chaque côté » — semantic-fleet side: MyIntelligenceAgency/semantic-fleet#82, CoursIA#1210).

## 1. Mandate and provenance

The user directive (2026-09-08) makes po-203's post-migration role the pivot of claudish's improvement, first track: **absorb the semantic-fleet intelligent-routing competence**. The 2026-09-29 decision redirects the source: CoursIA restored the complete semantic-fleet line (branch `restore/integration` → `stable-from-v0343`, v0.34.3 + 17 May-2025 commits, 36 `.md`), and the competence in question is the **MultiConnector**: a primary model answers by default and vets secondary models on each prompt signature; secondaries that pass take over that signature, weighted by cost and duration; replay tests re-qualify them over time. That is a **per-signature offload policy learned online** — which claudish does not have: today routing is role-level and failure-driven (modelMap, walls, cascades, dwell).

The capability map (issue #82, 2026-10-01, with the coordinator's review) and the measured concentration (2026-10-02) precede this doc; both are inputs, and where the map's claims were downgraded this doc carries the corrected numbers only.

## 2. Measured ground (what the design rests on)

Corpus: two archived hub days (2026-09-28: 42 909 req; 2026-09-29: 40 498 req), 100 % parsed. Fleet volume: 37–90 k responses/day, typical ~42 k. Signature = `md5(sorted tool names) | md5(normalized 512-char system prefix) | named model id`.

| Measure | Value |
|---|---|
| Distinct signatures per day | ~420–425 |
| Top-10 share | 26–43 % |
| Top-50 share | 64–76 % |
| Sub-agent population (`cc_is_subagent`) | **2/3 of volume** (68.6 % / 65.6 %), ~280 forms, top-10 ~50 % |
| Interactive population | ~1/3, 147/141 forms, top-10 50–62 % |
| 512-char prefix stability | 0/83 407 requests carry a date motif in the prefix — RAW ≡ STRIPPED; the truncation length is the only sensitive parameter, and 512 c is the operating choice |

Reading: **moderate concentration, long tail** — not "a few dominant shapes". The radix matcher stays trivial (~420 keys/day, µs lookup), but the vetting universe is the ~50–100 classes above 1 %/day, not ~10. The most actionable population is the sub-agent one (high volume, repetitive forms, budget-model tolerant) — exactly the population the leak policy already wants off the native lane.

## 3. Design

### 3.1 Where signature matching sits

**`signatureRoleOverride(shape) → role | null`, consumed at the entry of step 1 of `getHandlerForRequest`'s target resolution** (`proxy-server.ts`, `resolveNominalTarget` / `resolveRoleMappedModel`). The override rewrites the *requested model* to the override role's canonical placeholder before `resolveNominalTarget` and `roleFromModelName` run — so modelMap, failover step 2a, bucket derivation, cascade and dwell all see ONE coherent path, the same discipline `failover.ts:161` demands of `classifyNominalBucket` ("the two must not drift").

Three placement rules, each anchored in an existing constraint:

1. **Sync, in the hot path.** The lookup is a radix/hash hit over ~420 keys — the same cost class as `resolveModelNameSync` (in-memory caches + `readFileSync`, never async before handler construction). No new async seam.
2. **Never on an explicit target.** A `provider@model` (or any model with `/` or `@`) does not consult the table — same predicate family as `classifyNominalBucket`'s explicit-target branch. Silently rerouting an explicitly named target is invisible routing (non-goal).
3. **One override, then the ordinary machinery.** The table yields a ROLE, never a step, never a provider. Everything downstream (modelMap → bucket → cascade walls → dwell) is untouched code.

### 3.2 The signature

```
signature(request) = md5(sort(tool_names)) | md5(normalize(system_prefix_512)) | named_model_id
```

- `tool_names`: the client-declared tools of the request (`tools[].name`, sorted, deduped).
- `system_prefix_512`: first 512 chars of the concatenated top-level system text (string or text blocks), normalized by stripping date/path/UUID/number tokens. Measured ≈ no-op on the 512-char prefix (§2) — kept for robustness against deeper prefix drift, not for effect.
- `named_model_id`: the client's model string, pre-resolution — sub-agent shapes naming `opus` and `sonnet` are different signatures even if the offload table later routes both to the same budget model.

The signature is computed on the request envelope as captured today (`request-logger.ts` already extracts tools/system for `req-*.json`); the SAME extractor must serve the offline measurement and the online lookup, or the table's keys and the traffic's keys drift.

### 3.3 The offload table (the policy surface)

```
CLAUDISH_SIGNATURE_TABLE=<path>   # JSON: [{ "sig": "<hex>", "role": "sonnet", "until": "2026-11-01" }]
```

- Loaded at startup (an `initFailover`-class read, not per-request: the table is immutable per process; a refresh is a recreate — the standard container rule).
- Malformed entries are skipped with a stderr warning and **never crash the proxy** (custom-endpoints precedent, Zod-refuse-not-crash).
- Entries carry an `until` date: a table is a *campaign result*, not a standing law. An expired entry stops matching without operator action (a stale offload cannot outlive its measurement by accident).
- Kill switch `CLAUDISH_SIGNATURE_ROUTING=0` (default **off** — like every claudish policy surface, configuring the table does not activate it).
- The table is written by the vetting campaign (§3.4) as a **PROPOSAL** — dashboard post + config diff, operator applies. No auto-apply: the GLM lesson (routing policy stays operator-gated) and the map's Q4.4.

### 3.4 The vetting campaign (offline, on the corpus that exists)

The MultiConnector's online vetting (shadow completions in the request path) is **deliberately not absorbed** — see §5.2. What is absorbed is the campaign shape, run offline against the capture corpus (`req-*.json` + `resp-*.sse`, per machine + GDrive archives):

- **Classes**: the ~50–100 signatures above 1 %/day.
- **Candidates**: the models the campaign wants to qualify (typically the 6–8 budget-lane models).
- **Protocol**: 3 test completions per (class × candidate) + 1 oracle evaluation per pair ≈ 1 250 shadow completions, ~600 k output tokens per campaign — one-off per campaign, $2–5 on PAYG lanes or marginal-zero inside coding-plan windows.
- **Oracle**: **Opus, served from ai-01 only**, drawing on the fleet's weekly Claude plan. Cadence: **one campaign per week, launched after the reset, never at end-of-week** (~50–80 oracle evaluations × ~1 k tokens ≈ 50–80 k output tokens — fits a fresh weekly envelope without endangering interactive lanes). The budget-model pre-filter for dissenter-arbitration-only (~10 % to Opus) is an economy option **not taken by default**: a budget judge over-values budget models (circularity).
- **Replay re-qualification**: rerun a campaign when a candidate's serving population changes materially (new provider version, wall pattern shift) — the table's `until` bounds the blast radius of not doing it.

### 3.5 Composition invariants (with cascade #275 and dwell)

- **The signature resolves the ROLE, never the STEP.** Walls, per-step backoff `[10m..24h]`, reset-times, escalating bucket TTLs: untouched. The bucket derives from the resolved nominal via the existing `classifyNominalBucket` — if a signature changes this request's nominal, the bucket follows the same derivation; contagion stays provider-scoped, never signature-scoped.
- **Keys stay independent: signature ≠ sessionKey.** The dwell pins `(role, sessionKey)`; a mid-session signature flip does not bypass the pin — the pin yields on genuine advancement as today. **The nominal case to pin by test**: an interactive session spawning sub-agents (different shapes: no web tools, different system) legitimately resolves a different role — measured as the NOMINAL case (2/3 of volume), not an exception; per-role pins must not trample each other.
- **Notices (#126 doctrine, verbatim application)**: when the served model differs from the client's named model because of a signature override, the change is announced through the existing failover-notice channels (content block 0 + condensation header on `/v1/messages`; the `x-claudish-failover-notice` header on `/v1/chat/completions`) — facts (which role, which model, why: shape-based offload), never instructions.
- **Countable marker**: `[Signature] hit|miss role=<r> sig=<8hex> table=<n>` on each resolution (forceConsole-class) — the campaign and the surveillance can answer "is the table doing anything" from the hub log.

### 3.6 Junction with CoursIA (the four-hands split)

The OpenAI-compatible ingress (`POST /v1/chat/completions`, `docs/reference/openai-ingress.md`) is the natural backend for a semantic-fleet `IChatClient` MultiConnector: pointed at claudish, the vetting client inherits role routing, the cascade, accounting, captures and the leak policy by changing `base_url` alone.

| Side | Owns |
|---|---|
| semantic-fleet / CoursIA | the matcher (radix `PromptMatcher`), the vetting client, the replay harness |
| claudish | the policy surface: signature→role resolution, the offload-table format, the notice channels, the capability vocabulary (#83) |

Zero shared code, one wire. The shared bench is semantic-fleet's vetting run against claudish-served models; the offload table it measures is then the input to any claudish-side policy (this doc's §3.3).

## 4. Rollout gates

1. Table absent / switch off → **byte-identical behavior** (the `initFailover` inertness standard).
2. Table present + switch on → override applies only to non-explicit, role-derivable requests; one log marker per resolution; notices fire on model change.
3. Every table load validated (malformed → skip + warn, count reported at startup: `[Signature] table loaded entries=<n> valid=<m> expired=<k>`).
4. Route-level pins: signature override + explicit target (no effect), + dwell (pin independence), + cascade (role-scoped), + notice emission — one test per branch, mutations on the override predicate.

## 5. Deliberately left out (from the capability map, Q4 — unchanged)

1. **All `PromptTransform` layers** (global/type/connector templates, interpolation). Boundary #65 §4: no invisible prompt mutation. The only sanctioned channel toward the model is the negotiated capability vocabulary (#83); L1 keeps doing structural wire translation, never content rewriting.
2. **Adaptive detection in the serving path** (Levenshtein caches, async pattern extraction mid-request). Never-hang + harness cost: signature discovery runs offline on the capture corpus.
3. **Per-signature generation-parameter mutation** (temperature/max_tokens on the fly): touches the body, client-visible; L2 dialects stay per-model owners. Possible later grain, explicitly arbitrated first.
4. **Auto-apply of vetting suggestions**: a suggestion lands as PROPOSAL, a human applies.
5. **The MultiConnector's fallback strategy**: subsumed by the bucket cascade (#275) — strictly richer. Nothing imported.

## 6. Open questions (carried, not solved here)

- **Campaign operator**: who fires the weekly campaign (ai-01 seat, post-reset) and where the diff lands — coordinator dispatch question, not a design one.
- **Table provenance on the wire**: whether a table entry should record its campaign id (audit trail inside the config, vs. dashboard-only) — decide at implementation review.
- **Signature extractor unification**: the offline measurer (`sigres-*` exporter) and the online lookup must share one module — implementation detail, but a drift here silently orphans table entries (hit rate → 0 without any error).
