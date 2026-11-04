# Claudish - Development Notes

Planned-but-unimplemented work lives in `ROADMAP.md`, each item with an explicit trigger condition.

**This file is the decision layer: what an agent must know *before* acting.** Detail is deferred, not deleted — each pointer below leads to the full text:

| Topic | Full reference |
|---|---|
| Routing syntax, shortcuts, `defaultProvider`, custom endpoints, vendor prefixes, local models, scoped `inboundKeys` (allowlist-only) | `docs/settings-reference.md` (§5–§7.6, §9, §12) |
| Three-layer adapter architecture, class-name Rosetta stone | `docs/three-layer-architecture.md` |
| `stream:false`, inline system messages, capture, debug logging, translation debugging | `docs/reference/proxy-pipeline-notes.md` |
| Web search interception paths, fallback chains, components | `docs/reference/web-search-interception.md` |
| Relay internals (header build, prober, compression, outage reconciliation) | `docs/reference/relay-internals.md` |
| Budget failover: cascade walk, notices, backoff, Qwen/GLM thinking measurements | `docs/reference/budget-failover.md` · `.env.sidecar.example` |
| Capability vocabulary (#83 — wired, gate `CLAUDISH_CAPABILITY_VOCAB` default off) | `docs/reference/capability-vocabulary.md` |
| Signature-based role routing (#82 — design only, unarbitrated, no code) | `docs/reference/signature-routing.md` · `ROADMAP.md` |
| Haiku → swift debrayage — staged widening (02/11 : po-2028 in swift trial on user directive, revert written if net PAYG rises; po-2024 excluded) | `docs/reference/haiku-swift-debrayage.md` · `ROADMAP.md` |
| OpenAI-compatible ingress (`/v1/chat/completions`) translation | `docs/reference/openai-ingress.md` |
| Ops runbook — watchdog, drain/recreate, events, compaction, archive | `docs/reference/ops-scripts.md` |

## Fleet-Rollout Verification (hard rule, mandate 2026-09-12)

**A fleet-affecting change declared DONE requires a measured per-consumer verification artifact, produced in the same session** — where it actually lands, read from the live config/path, never from the change's intent. "The container moved" is not "the fleet migrated". Founder incident 07-09→11-09: a silently reverted ARR flip served 263.6M tokens off-hub. Consequences:

- **Surveillance covers the path, not just the traffic**: a cycle checking hub health also checks the entry points that feed it (ARR backend, per-machine base URLs) — a silent revert must be catchable within one cycle, not one outage.
- **An outage detected is an outage escalated — in the SAME cycle** (DM URGENT + dashboard). "Chronic" thresholds (#80-style counts) never apply to a total outage.
- **An issue treated halfway is an issue in failure**: no next grain until the current issue's DoD is met or the rescope is explicitly recorded.
- Rollback of a fleet change goes through the same channel as the change: an unlogged revert of shared infra (IIS web.config, .env, NAT) is an incident, not a fix.
- The hub's entry form is the published container port (`.50:3000`); any change to the fleet-facing entry point (ARR rule, forwarder port, socket owner, published port) is announced on `global` BEFORE it is applied — unannounced, the 07/09 ARR revert and the 30/09 orphan socket each cut part of the fleet undetected (detail: `docs/reference/relay-internals.md`).

## Build, Release, Versioning

- `bun run build` (CLI + macOS bridge bundles) · `bun run dev`. Use **bun**, never npm or yarn.
- **Releases are handled by CI/CD — never run `npm publish` by hand.** Bump version → conventional commit → `git tag -a vX.Y.Z -m "…"` → `git push origin main --tags`.
- **Every PR that resolves an issue carries `Closes #NN` in its body.** GitHub only auto-closes on the keyword — a descriptive mention leaves the issue open with its fix merged and live (measured 12/09: three merged fixes, three orphaned issues).
- **A version bump touches three files, all mandatory**: root `package.json`; `packages/cli/package.json` (**this is what CI publishes — stale here and `npm publish` fails**); `packages/cli/src/version.ts` (fallback `VERSION` for compiled binaries).

## Model Routing (v4.0+)

Syntax `provider@model[:concurrency]` — `google@gemini-2.0-flash`, `or@deepseek/deepseek-r1`, `ollama@llama3.2:3`. Bare names auto-detect (`gpt-4o` → OpenAI, `gemini-*` → Google). Shortcuts (`g@ oai@ cx@ or@ openrouter@ mm@ mmax@ mmc@ kimi@ moon@ glm@ zhipu@ gc@ llama@ ll@ litellm@ ollama@ lmstudio@` + aliases) plus any custom-endpoint name: full table in `docs/settings-reference.md` §5.2.

Rules (narratives, measurements and code pointers: `docs/reference/model-routing.md`):

- **A role's `modelMap` entry picks the LANE; since #218 it also pins the VERSION, but only on the native lane and only for `claude-*` targets** — applied per attempt by `resolveNativeModelPin()` inside `handleWithCascade`, never at the route. Kill switch `CLAUDISH_NATIVE_MODEL_PIN=0`, read per request. ⚠ The guard is `startsWith("claude-")`, NOT "is bare" — conflating the two would put a bare `glm-5.3` on the Anthropic wire.
- **The native lane refuses a credential that is not Anthropic's (#296), strips the foreign sibling of a mixed pair (#305), and the vision fallback gates on the same shape predicate (#315)** — one predicate shared by all three sites; kill switch `CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD=0`. The refusal wording is load-bearing (`isQuotaExhaustion` must never match it).
- **`defaultProvider` is a last-resort fallback**, appended to each bare-name chain (deduped — `or` ≡ `openrouter`); explicit `provider@model` is never affected; the proxy applies it too (#468). Strict no-fallback needs `routing["*"] = []` **and** a present-empty `CLAUDISH_DEFAULT_PROVIDER` — **env form only** (a config `""` is dropped by a truthiness guard). Precedence: `--default-provider` > `CLAUDISH_DEFAULT_PROVIDER` > config > `OPENROUTER_API_KEY` > `openrouter`. LiteLLM auto-promotion was **removed** — `docs/settings-reference.md` §6.3.
- **Vendor prefix resolution is exact-match only** — find the right prefix, never guess the model. Dynamic catalogs are PRIMARY; a cold cache falls back to the disk cache (`~/.claudish/all-models.json`), then to **passthrough unchanged**. Resolution is sync (`resolveModelNameSync()`, before handler construction — do not make it async). Paged catalog (#635): one deadline; `coverage` records what was fetched.
- **Custom endpoints**: `apiKey` expands `${VAR_NAME}` from the environment (never hardcode secrets); entries failing Zod validation emit a stderr warning and are skipped — never crash the proxy. Injection via `registerRuntimeProvider()` / `registerRuntimeProfile()`; schema: `docs/settings-reference.md` §7.
- **`omitReasoningContent`** (custom endpoints, default `false`) drops `reasoning_content` from outbound assistant messages for strict-schema backends (Mistral answers `422 extra_forbidden`) — a separate `stripReasoningContent()`, because ComposedHandler's thinking-block strip is a structural no-op on the OpenAI wire.
- **The MiniMax `forced` thinking chain has TWO filters (#295 outgoing, #324 incoming)** — `shouldFilterThinking()` returns false under `forced`; the history strip consults `preserveThinkingBlock(block)` per block. **M3.1-Flash rejects `thinking.type:"disabled"` with 400/2013** — the dialect rewrites it to `adaptive`; M3 keeps disabled.
- **Local model APIs report `prompt_tokens` as the FULL conversation context each request** — `writeTokenFile` assigns (`=`) input tokens, never accumulates (`+=`).
- **The three input counters ship TOGETHER on every terminal `message_delta`, and a zero `input_tokens` is a trap (#179)**: since #444 ALL five parsers seed via `messageStartUsage(priorInputTokens)` and shape through `toAnthropicUsage` — a dialect maps at the parser call site, never in the shared shaper; the seed is keyed **per session** (#518).

Adding an aggregator resolver: implement `ModelCatalogResolver` in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts` — nothing else changes. Catalog extraction, recommendations and portal: [models-index](https://github.com/MadAppGang/models-index).

## Adapter Pipeline (v5.14.0+)

`ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected by model id) + ProviderTransport`

- **L1 FormatConverter** (`adapters/api-format.ts`) — wire format: OpenAI, AnthropicPassthrough, Gemini, Codex, OllamaCloud, LiteLLM. Message/tool conversion: `handlers/shared/format/openai-messages.ts`.
- **L2 ModelTranslator** (`adapters/model-dialect.ts`) — model dialect (context windows, thinking→reasoning_effort, vision rules): GLM, Grok, MiniMax, DeepSeek, Qwen, Codex.
- **L3 ProviderTransport** (`providers/transport/types.ts`) — auth, endpoints, headers, rate limits; aggregators (LiteLLM, OpenRouter) may override the stream format to `openai-sse`.

**Stream parser selection — 3-tier priority, in this order**: `transport.overrideStreamFormat()` → `modelAdapter.getStreamFormat()` → `providerAdapter.getStreamFormat()`. Parsers in `handlers/shared/stream-parsers/`: `openai-sse` (most providers), `anthropic-sse` (MiniMax/Kimi direct), `gemini-sse`, `ollama-jsonl`, `openai-responses-sse` (Codex).

- **Add a provider**: one entry in `PROVIDER_PROFILES` (`providers/provider-profiles.ts`).
- **Add a model**: a ModelTranslator adapter, registered in `adapters/dialect-manager.ts`.
- **Verify wiring**: `claudish --probe <model>` prints the full composition.

## Never-Hang Constraints (non-negotiable)

The proxy sits inside an agentic loop: whatever stalls a turn stalls the agent. Corpora, drain design, filter calibration: `docs/reference/never-hang.md`.

- **A restart is a stream killer, so the drain waits for a true zero, then picks its moment** — `scripts/claudish-drain.ps1`, never a bare `docker restart`. **No scheduled daily restart is left on the fleet** (#280): the watchdog's proactive restart is the single nightly source. A `$null` count means *no signal* → undrained restart, never an unbounded wait. Deploying needs `-Recreate -EnvFile` (refused if it would gut an armed cascade, #141); agent callers `-Detach` + poll `OUTCOME`. Runbook: `docs/reference/ops-scripts.md`.
- **The proxy itself never breaks a stream**: no `controller.error()` in production sources under `packages/cli/src` (test harnesses may call it), and every terminating path emits `message_stop` — `finalizeWithError` and the relay passthrough included. A mid-response drop is never the stream logic; the socket died underneath it.
- **`stream: false` must return a single JSON `message`, never SSE** (`/compact` is the real-world caller; SSE back to it wedges the session). `ComposedHandler.handle()` buffers via `collectAnthropicSseToMessage()`; the collector never throws — a broken stream degrades to a well-formed message with empty text.
- **A failed web search/fetch must never stop the agent** — every backend path degrades to well-formed text. No throws, no hung streams.
- **Never gzip the SSE response** — gzip buffering risks a hang. Request body only, WAN only.
- **A stream admitted with 200 that never produces a first useful event is confined, not held**: `withFirstUsefulEventWatchdog` cancels the upstream after `CLAUDISH_FIRST_EVENT_TIMEOUT_MS` without a first `data:` line (default 300 s, `0`=off). A `: keep-alive` comment or an `event:` line is not one.
- **A retried stream needs its OWN watchdog — the original wrap has already disarmed.** `boundRetryUpstream()` wraps the closure once in `handleStream`; non-ok/bodyless responses pass through untouched; `ollama-jsonl` is excluded. Corollary: **a guard that disarms on a signal cannot protect what that same signal triggers.**
- **An upstream death before any client-visible event is recovered, not finalized (#170).** `anthropic-sse.ts` re-forwards both death shapes, gated to strictly before any client-visible event — past that, a replacement would duplicate what the client holds. Bound `CLAUDISH_PREVISIBLE_REFORWARD_MAX` (default 2); no `markFail`.
- **A policy refusal is retried, then surfaced labeled — never bare, never silent (#65).** Bounded transparent retry of the identical body (`[1000, 3000]ms`, max 2), only while nothing client-visible exists. Persistent refusal becomes `[Upstream policy refusal — invalid_prompt: …]` + `end_turn` + `message_stop`. The classifier excludes transport errors, quota walls and rate limits.
- **A request larger than every DECLARED window is refused at admission, with numbers (#565)** — declared-only: a path with ANY undeclared candidate (nominal, step, `role:` target, native nominal) falls open. The answer is the #79 recoverable turn (200 + real `input_tokens`), never a bare 400 — that reproduces the `/compact` retry loop. Wording never matches `isQuotaExhaustion`. Kill switch `CLAUDISH_CONTEXT_ADMISSION=0`.
- **At the derived wall the estimate only nominates — the engine's tokenizer decides (#674)**: an in-band estimate is probed via `POST {root}/tokenize`; `exact >= window` → the #79 recovery turn locally, zero upstream calls. Probe bounded, never throws. Kill switch `CLAUDISH_EXACT_COUNT=0`. Detail: `docs/reference/proxy-pipeline-notes.md`.
- **A frame's `event:` line and its JSON `type` must agree (#772)** — repaired at the single `emitDataLine` chokepoint (pipeline + relay), the payload arbitrating; coherent frames relay byte-for-byte; `message_start`/`message_stop` never promoted from absence. Kill switch `CLAUDISH_FRAME_COHERENCE=0`.
- **Strip inline `role: "system"` messages** (Claude Code v2.1.153+ injects them) and merge into the top-level `system` field — `anthropic-sse` in `composed-handler.ts` and the OpenAI path in `openai-messages.ts`. Z.AI, MiniMax and Kimi reject anything but `user`/`assistant`.

## Web Search Interception (v7.1+)

Provider web-search tool calls (`web_search`, `brave_web_search`, `tavily_search`) and GLM `<searchWeb>` tags are dispositioned **three ways** — a bare forward fails on non-Anthropic providers, but a tool the client declared under that exact name is the client's to serve.

- **Three lanes, in order**: (1) client declared a web tool under the **provider's exact name** (`web_search`) → **forward verbatim** (#498). (2) `WebSearch` declared, not the exact name → **remap** to a synthetic tool_use. (3) Nothing web-capable declared → suppress and inject as text + `end_turn`. The loop must never stall either way; both names declared → lane 1; the `<searchWeb>` TAG path keeps lanes 2/3.
- **On the Z.AI wire, `server_tool_use` comes with two siblings** (whole-input `content_block_start`, assistant-side `tool_result`) — both suppressed, or the following deltas/stops desync. Regression: `format-translation.test.ts` ("Chantier D").
- **Any frame the parser drops takes its `event:` line and blank separator with it (S4-a)**: `event:` lines are held until the data line is adjudicated; an orphan delta/stop is dropped whole. Synthetic tails preserve an upstream `stop_reason` and never emit a second terminal pair. Pins: `anthropic-sse-s4a.test.ts`.

Backend fallback chain (SearXNG → direct HTTP → error text), retries, size caps: `docs/reference/web-search-interception.md`.

## Relay / Sidecar Mode (v7.2+)

One binary, three modes, selected by `CLAUDISH_RELAY_UPSTREAM`. Each machine runs its own container — the hub is not a single point of failure.

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | **HUB** (po-2025) | Always local. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. **No local capture** (hub captures centrally). |
| set + hub **dead** (hysteresis) | **AUTONOMOUS** | Falls through to the normal local pipeline + local capture. |

Gotchas (internals, capture reading, incidents: `docs/reference/relay-internals.md`; install: `docs/deployment/relay-sidecar-deployment.md`):

- **The cluster key is injected as `x-proxy-key`, NOT `x-api-key`** (which arms `NativeHandler`'s swap and 401s); client `authorization` is kept; `X-Claudish-Machine` must survive the hop. The native lane strips `x-proxy-key` and every `x-claudish-*` header before api.anthropic.com (#282, third strip site #289, shared shape gate #315).
- **Loop topology is detected by identity, on two planes (#156/#279)**: `/health` publishes a per-process `instanceId`, and every forward appends the sender's id to `x-claudish-hops` — a node finding its own id serves locally, never refuses.
- **Hysteresis is asymmetric on purpose**: 2 consecutive `/health` failures → AUTONOMOUS; recovery needs 3 OK heartbeats + 60s cooldown + a deep tool-call probe (`message_stop` required).
- **`CLAUDISH_NO_ANTHROPIC=1` on every machine except ai-01**; **`CLAUDISH_HOST_PORT` is load-bearing** (port 3000 is taken on some hosts).
- **Two capture variables, one letter apart**: `CLAUDISH_CAPTURE_HOST_DIR` (host bind) vs `CLAUDISH_CAPTURE_DIR` (in-container, **empty = write nothing**). Keep capture on; **capture files are not a count of mode switches** (~30× over-count measured).
- **An armed cascade is always hand-added and lives only in the container record (#141)** — `install-sidecar.ps1` never writes failover env, exits non-zero before gutting a live armed cascade; `-RebuildEnvFromContainer` recovers container-only state. Before any recreate: **diff by VALUE** — every container shows all 23 names.
- **The relay branch must stay before `interceptWebTools` / `getHandlerForRequest` / `logRequest`** in the `/v1/messages` route — that ordering makes capture mode-aware for free.
- **A forward connect failure gets exactly one retry (+250 ms) before falling through (#80 part 2)**; an absorbed retry does not `markFail`. A header deadline is never retried, nor is an HTTP 5xx (hysteresis owns it).
- **Two upstream failure signatures — only one is a client-side transport artifact**: a connect failure is client-side only under #80's precondition (hub independently reachable); TCP accepted + an invalid response is hub-end unavailability. Count WAN impact from the ingress IIS log, never the relay's tally.
- **`hub HTTP 500` is the relay's reading — corroborate hub-side before hunting a provider** (#299 A / #318 pass-throughs; an empty hub log was never evidence of a healthy hub).

## Budget Failover (v7.2+)

Substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`/`fable`) when that role's metered plan is exhausted — a subscription concern, distinct from `FallbackHandler` (provider swap, a transport concern); they compose. Every substitution is **announced** (`applyFailoverNotices`); none may ever throw. **Notices state facts, never instructions** (doctrine 2026-08-23). Detail: `docs/reference/budget-failover.md`.

- **A role's failover is an ordered list of steps** (`CLAUDISH_FAILOVER_<ROLE>`, `>`-separated; the last step is typically PAYG).
- **A wall is keyed by provider BUCKET, never by role (#275)**: a qualifying refusal while serving the nominal walls `bucket(nominal)`; only a request whose resolved nominal sits in a walled bucket diverts to *its* role's cascade. A bare `claude-*` takes a per-model native bucket and never consults `route()`. Config-arms (`CLAUDISH_FAILOVER_ACTIVE`) divert the whole role; a `role@machine` piece diverts only that machine's requests.
- **A cascade step can delegate to another ROLE — `role:<r>` (#274)**: the graph is proven acyclic at load; per-step backoff binds the CONCRETE (#331); a failed delegated concrete walks the target's remaining path in-request without re-paying (#609).
- **Per-step backoff `[10m, 30m, 1h, 4h, 24h]`**, one rung per failure EPISODE (a mark on an already-benched step refreshes it without climbing, #553); overridden by a known reset; ⚠ a future `..._RESET` is a **CLOSURE (#261)** — read `_RESET` **by value** before any deploy. The bucket-wall TTL grows while the wall holds (capped); any nominal success on that bucket resets it.
- **A session keeps its resolved step for a minimum dwell** (`CLAUDISH_FAILOVER_SESSION_DWELL_MS`, default 10 min, sliding): yields on a pinned-step TTL failure, on VERIFIED nominal recovery (`..._RECOVERY_GRACE_MS`, default 2 min) and on a VERIFIED earlier-step recovery past that grace (#619); a NON-quota death of the pinned step forfeits the dwell (#276).
- **A nominal's transient OVERLOAD walks the cascade once, writing no failure state (#299-B)**: no arm, mark, wall or pin; a failing step surfaces the ORIGINAL overload; skipped when the nominal already spent `CLAUDISH_FAILOVER_WALK_BUDGET_MS` (default 300 s); native lane excluded.
- **A cascade step that cannot take THIS request skips forward (#431)** — context overflow, a saturated limiter, or the engine's image cap (#575), signaled by `x-claudish-step-skip` (`context`/`busy`/`media`), acted on only for a non-last step: **no markStepFailed, no wall, no arm**, the dwell pin yields. `CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS` bounds step attempts only; kill switch `CLAUDISH_FAILOVER_STEP_SKIP=0`.
- **`CLAUDISH_FAILOVER_STEP_EXCLUDE=<stepTarget>:<machine>[ <machine>…][,…]` subtracts a step for ONE machine's walks (#693)** — the cascade stays ONE global list (indexes never renumber); that machine's walks skip it like a #431 skip, a pinned dwell yields, an excluded LAST step refuses the PAYG fallback. Startup read — a flip needs a recreate (#310).
- **An endpoint's in-flight token budget rides the #431 busy wire (#654)** — `CLAUDISH_ENDPOINT_TOKEN_BUDGET_<NAME>` (Σ estimated) + `CLAUDISH_ENDPOINT_BIG_LIMIT_<NAME>` (concurrent >100K), evaluated BEFORE the upstream call: never called, never marked; the nominal refusal feeds the #299-B walk; no diversion ⇒ serve anyway. Unset/garbage = inert; registry per-process (hub + sidecar Σ must fit engine KV).
- **`resolveFailoverTarget(role)` is the single resolution path** (swap + `handleWithCascade` re-read state; no override passed in); **`handleWithCascade` is bounded** (nominal → steps, capped `steps.length + 1`); a handler must not mutate the Hono `Context` before returning a non-ok `Response` (c-reuse invariant).
- **Serving banners have TWO readers, split since #747** — the client-visible banner is UNCHANGED; models forged their own from history (measured 28/10), so the model's channel is a note appended to the top-level `system` of every substitute-served request, and `stripServingNoticesFromRequestBody` strips banner segments from assistant history — AFTER `logRequest`. Kill switches: `CLAUDISH_FAILOVER_REQUEST_NOTE=0`, `CLAUDISH_FAILOVER_NOTICE_STRIP=0`.
- **`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`**: 402 on status; 429 only when the body names a quota wall. **401 and 404 never arm** — swapping would hide a wiring mistake behind a plausible answer.
- **With nothing set every code path is inert** — configuring a target does not activate it; arming is separate and deliberate. Unset `_DIRECTION` means degraded.
- **A failover target must resolve on the machine that calls the models** — arm sidecars too. ⚠ Count armed state **by VALUE** (`grep -cE '^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+'`), never by name; `roleFromModelName()` matches only the four role keywords — set `CLAUDISH_FAILOVER_ROLE_MODELS` for bare provider ids.
- ⚠ **In a compose-deployed container the environment is fixed at create time (#310)** — a name absent from `docker-compose.yml`'s `environment:` never reaches the process (`compose-env-coverage.test.ts` cross-checks); a NEW value enters only at the next **recreate**.
- **A session's UPSTREAM output tokens can be capped (#317 option B, `fork/session-budget.ts`)** — counter per `(X-Claudish-Machine, session_id)`, 24 h sliding, every cascade attempt counted. `CLAUDISH_SESSION_BUDGET_CEILING` (local labeled 429 + `retry-after`, **before any upstream is paid**; wording load-bearing — no quota-class word would arm off our own ceiling) and `CLAUDISH_SESSION_BUDGET_WARN` (marker-only, 80%); both inert without env — **fleet pose: WARN-only until the user fixes the values** (an agent never arms the ceiling alone).

### `CLAUDISH_QWEN_THINKING`

`disabled` (default) · `passthrough` · `budget:<n>`. **Unset is not neutral** — Qwen reasons by default and the Token Plan bills on **output**; re-read per request. **Two switches on two wires** (OpenAI: `enable_thinking` + `thinking_budget`; Anthropic: the native `thinking` object) — each ignores the other's form.

### `CLAUDISH_GLM_THINKING`

`passthrough` (default) · `disabled`. GLM's switch is **binary** on the OpenAI wire (`thinking: {"type":"enabled"|"disabled"}`), no budget control; only an explicit `disabled` sets the field on the unprobed `zai@` anthropic wire. Re-read per request.

## OpenAI-Compatible Ingress (v7.2+)

`/v1/messages` is the **native** ingress; `POST /v1/chat/completions` is a **translated** one — converted to Anthropic shape, run through the **same** `getHandlerForRequest` → `ComposedHandler.handle` pipeline, then translated back. An OpenAI client inherits the routing cascade, budget failover, accounting and leak policy for free, by changing `base_url` alone. Detail: `docs/reference/openai-ingress.md`.

- **Never-hang holds here too**: a malformed stream degrades to a single terminal chunk + `data: [DONE]`; `thinking` blocks surface as `reasoning_content`; `stop_reason` maps to `finish_reason`.
- **A failover notice never rides the content here (#229)** — it arrives in the `x-claudish-failover-notice` response header (base64 UTF-8), streaming and JSON alike. The gate is the route (`noticePolicyForIngress`), never a user-agent. `/v1/messages` keeps the in-content block 0 for the Claude Code agent loop.
- **Request-side thinking controls are mapped (#435)** — `enable_thinking` / `reasoning_effort` land on the house `thinking` object; an enabled block is always legal (≥1024, `< max_tokens`), clamped against a client `max_tokens` and *raising* our own 4096 placeholder.
- **A reasoning model can return no text (`content: null`) with `finish_reason:"length"` here** — `reasoning_content` shares the `max_tokens` budget and can consume it all before any text; a `content` consumer gets no answer and no error. Raise the budget, disable thinking (`enable_thinking:false`, #435), or use `/v1/messages`.
- **The relay is path-aware** — a sidecar forwards to the same route the client hit; the deep liveness probe stays on `/v1/messages`.

## Traffic Analysis & Anthropic Policy

**Default instrument for a live trace question is the `claudish_traffic` MCP tool (#72)** — histogram rendered up to now, declarative `GAP`, cron/interactive split, `UNKNOWN` on a rotated corpus. The scripts remain for scheduled surveillance and capture-side analysis — never hand-rolled grep (the format false-positives naively). Usage, flags, ⚠ reading rules: `docs/reference/traffic-analysis.md` + `docs/reference/ops-scripts.md`.

The full instrument catalogue (which tool answers what, its traps, its measurements) is `docs/reference/traffic-analysis.md` §Scripts — canonical and richer than any copy here.

Reading rules that change verdicts:

- **`traffic-live.ps1 -Container` defaults to `claudish-proxy`** — pass `claudish-sidecar` on a sidecar; the MCP tool takes the same distinction.
- **On a NOMINAL sidecar, ~0 requests is the correct answer** — a relayed request writes no capture; count `[ttft]` lines instead (real volume is invisible to `[Request]` counting by ~100×). `model=` means the client's requested id pre-remap on a NOMINAL sidecar, the resolved concrete that served on the hub or in AUTONOMOUS.
- **Counting AUTONOMOUS episodes by grepping `AUTONOMOUS` overcounts ~6×** — anchor on the word ALONE at line end.
- **Policy (user 20/10): every machine authenticates its own Anthropic use — no hard per-machine restriction.** Opus off ai-01 stays exceptional (po-2024 CoursIA-3 only, durably); a DURABLE Opus elsewhere is flagged, a one-off never. A client `settings.json` carrying `ANTHROPIC_API_KEY` sends that key instead of its login and is refused by #296 shape B — fleet settings read each cycle with `scripts/settings-matrix.py`.
- **`cc_is_subagent=true` is the leak signature, and it lives in the request body, not stdout** — `docker logs` cannot see it; inspect a capture. A confirmed sub-agent leak is fixed client-side (rules pinning `model: "sonnet"`), not in the proxy.

Capture format, archive/GDrive retention, device-id attribution, exact commands: `docs/reference/traffic-analysis.md`.

## Channel Mode (MCP, v6.4.0+)

Async model sessions with push notifications, on the low-level `Server` class declaring `experimental: { 'claude/channel': {} }`. 11 tools, gated by `CLAUDISH_MCP_TOOLS` (`all` default · `low-level` · `agentic` · `channel`). Wire contract pinned by `channel-wire-format.test.ts`.

- **`meta` keys must match `[a-zA-Z0-9_]+`** — Claude Code **silently drops** keys with hyphens or other characters. Keep new `extraMeta` keys underscore-only.
- **Emitting a correct frame is not enough.** Rendering is gated client-side: CC ≥ v2.1.80; Anthropic auth via claude.ai or Console key; an **interactive** session (`-p` mode drops frames silently); the server declared in `.mcp.json` / `~/.claude.json` (**`--mcp-config` is not consulted**); and the server **named in `--channels`** or `--dangerously-load-development-channels`.
- `CLAUDISH_CHANNEL_TRACE=1` (+ `CLAUDISH_CHANNEL_TRACE_FILE` when the host swallows stderr) traces producer → bridge → wire, so a server-side drop is distinguishable from client-side gating. Off by default.

Full contract, launch commands, diagnostics: `docs/reference/channel-mode.md`. Tests: `bun test --cwd . ./packages/cli/src/channel/*.test.ts` (win32 counts and skip classes in that reference).

## Debugging & Tests

Failed-translation workflow: `claudish --model X --debug "say hello"` → `claudish --probe X` (verify the composition) → `/debug-logs logs/claudish_*.log` (diagnoses the mode, extracts SSE fixtures, writes a regression test) → `bun test packages/cli/src/format-translation.test.ts`. Templates: `docs/reference/proxy-pipeline-notes.md`.

**Keep debug logs verbose** — empty chunks and raw deltas included; suppress noise at registration/initialization, **never at the streaming-data level**. Under `--debug` both parsers emit greppable `[SSE:openai]` / `[SSE:anthropic]` lines. `format-translation.test.ts` replays `.sse` fixtures from `test-fixtures/sse-responses/`.

**`bun run test:strict` (#175) is how a review gets an opposable verdict from a noisy suite.** Comparison is by **reproduction, never by count**; the runner **refuses a verdict** (exit 3) when it cannot account for bun's own counters; the failing population is machine-dependent, in the gitignored `.test-strict-baseline.json`. First use: `--learn`; re-learn after any land removing a cause of load-time death. ⚠ The repo pins no bun; CI installs `bun-version: latest`. Mechanics: `docs/reference/test-strict.md`.

**Never mock HTTP with `Bun.serve` in a test file (#604).** Once any `node:http` server has lived in the `bun test` process — every `proxy-server-*.test.ts` route test is one — every `Bun.serve` created afterwards is unreachable. Use `packages/cli/src/test-support/stub-fetch.ts` (`installStubFetch` / `hangUntilAborted`): same wire semantics, no socket.

**PowerShell ops scripts have their own suite**: `bun run test:scripts` (pwsh 7) and `test:scripts:win51` — **the interpreter the scheduled tasks actually use**; run both, they do not agree, and 5.1 ships. ⚠ **Dot-sourcing `claudish-drain.ps1` clobbers `$ClaudishHome`** — a sandboxed test must assert on the log path too. Runbook: `docs/reference/ops-scripts.md`.

**The always-loaded files have byte budgets, and a gate** — `packages/cli/src/test-support/harness-budget.test.ts` refuses `CLAUDE.md` above **36 864 B** (36 KiB); the failure message names the `docs/reference/<theme>.md` file the detail belongs in.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
- Use Grep/grep tool for code investigation instead of mnemex — prefer built-in search tools during investigation phases

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
