# Phase 2c Mapping Table — sync/upstream-rebase-2026-07-25

**Branch:** `sync/upstream-rebase-2026-07-25` @ `aad7f5a`
**Compared to:** `main` (fork's deployed tip — 19 critical-file commits ahead)
**Scope:** read-only study of the 19 fork commits touching `packages/cli/src/proxy-server.ts`, `packages/cli/src/composed-handler.ts`, `packages/cli/src/handlers/native-handler.ts`, plus auth/ + stream-parsers + new fork/ files.
**Hard rules honored:** no source files modified; no commit; report written to worktree root only.

---

## Upstream CredentialAuthority — key APIs

### `packages/cli/src/auth/credentials/authority.ts` (188L)
The single ASYNC source of truth for provider credentials. Old per-entry-point env-push paths (`loadStoredApiKeys`, `hydrateOpSecrets`, `applyCustomEndpointOpKeys`) are GONE — the authority is the only place credentials enter the process.

- `credentials.get(name)` — registry lookup by catalog name (or alias).
- `credentials.register(p, aliases)` — explicit registration (used for OAuth/codex/vertex/local providers).
- `credentials.registerApiKeyProvider({ name, envVar, aliases?, authScheme? })` — **the key fork API**. Used by `loadCustomEndpoints()` (`packages/cli/src/providers/custom-endpoints-loader.ts:68-72`) to register custom endpoint credentials through the same authority instead of out-of-band env reads. Idempotent.
- `credentials.isAvailable(name, opts?)` — ASYNC readiness; env → config → oauth-file → op:// (lazy SDK). Never throws.
- `credentials.getRequestAuth(name, ctx)` — ASYNC; returns `{ headers, endpoint?, transformPayload? }`. **This is THE new sign-time API for outbound requests.**
- `credentials.invalidate(name?)` — drop memoized resolution (TUI hydrate-on-add).

### `packages/cli/src/auth/credentials/native-anthropic-credential.ts` (61L)
Replaces the old `ANTHROPIC_AUTH_TOKEN` + `x-proxy-key` swap dance. Resolution order: `process.env.ANTHROPIC_API_KEY` → `process.env.ANTHROPIC_AUTH_TOKEN` → `getApiKey("ANTHROPIC_API_KEY")` → `op://`. Returns `{ headers: { "x-api-key": <key> } }` via `getRequestAuth()`. Used by `NativeHandler.handle()` (lines 211-218 of `native-handler.ts`) when no inbound auth is present.

### `RUNTIME_NAME_ALIASES` (authority.ts:36-38)
```typescript
const RUNTIME_NAME_ALIASES: Record<string, string[]> = { google: ["gemini"] };
```
Maps catalog → runtime request-path names so a provider whose runtime name diverges from its catalog name (renamed by `toRemoteProvider()` in `provider-definitions.ts`) still resolves credentials. **The fork must use aliases when registering custom endpoint names that don't match their runtime name.**

### `packages/cli/src/auth/credentials/api-key-credential.ts` (180L)
The default `ApiKeyCredentialProvider` for plain API-key providers. Resolution order (env → aliases → config → op:// lazy). Used for every builtin provider that isn't OAuth/codex/vertex/local/native-anthropic. Memoized; the SDK is touched at most once per provider.

### What the auth path looks like for the fork
- **Outbound to api.anthropic.com:** `NativeHandler` calls `credentials.getRequestAuth("native-anthropic", { model })` and extracts `headers["x-api-key"]` (`native-handler.ts:213-214`).
- **Outbound to a custom endpoint:** `proxy-server.ts:320-326` calls `credentials.getRequestAuth(resolved.provider.name, { model })` and extracts `Authorization` (strip "Bearer ") or `x-api-key`. The custom endpoint itself was registered by `loadCustomEndpoints()` → `credentials.registerApiKeyProvider({...})`.
- **No more `loadStoredApiKeys()`:** `fork/server/standalone-proxy.ts:20-48` STILL has the old env-push code; this is dead code under the new authority (authority reads config directly via `getApiKey()`).

---

## Per-commit classification

### DROP — already covered by upstream
*(None of the 19 commits cleanly drop. Upstream's CredentialAuthority covers the auth contract, but every fork commit has a distinct functional delta — never an exact duplicate.)*

### REAPPLY — auth-independent, clean merge
Commits that touch fork-only files (no upstream overlap), or modify shared files in regions upstream didn't touch.

| sha | subject | lands in | expected merge cost |
|---|---|---|---|
| `5316c42` | fix(routing): normalize slugified GLM version names | `packages/cli/src/providers/routing-rules.ts` (+ `.test.ts`) — NOT in our 4 critical files | Clean — purely additive function called inside `route()` for both explicit and bare paths. No auth touch. |
| `141d160` | feat(capture): persist X-Claudish-Machine in capture body + unify machine attribution | `fork/middleware/request-logger.ts` — fork-only | Clean. The header is read inside `logRequest()` (line 49 of `request-logger.ts`). |
| `122b681` | feat(request-logger): add full-body capture mode for diagnostics | `fork/middleware/request-logger.ts` (capture block) — fork-only | Clean. Gated by `CLAUDISH_CAPTURE_DIR`, no-op when unset. |
| `c9ee364` | feat(scripts): traffic-anthropic.ps1 — machine+workspace Anthropic attribution | `scripts/` — fork-only | Trivial. |
| `2626219` | feat(scripts): traffic-anthropic.ps1 — already-applied (Phase 2a) | n/a | already-applied |

The stream-parser commits are mostly REIMPLEMENT (see below) because they touch `anthropic-sse.ts` and `openai-sse.ts` which upstream also evolved.

### REIMPLEMENT — must adapt to CredentialAuthority
These touch the critical files or shared stream-parsers; the patch must be re-expressed against the new auth/signing model.

| sha | subject | what changes | upstream API to use |
|---|---|---|---|
| `61d5726` | feat(proxy): add proxy auth, NativeHandler fallback, custom endpoint creds | (a) proxy-key gate (load-bearing cluster auth); (b) NativeHandler Anthropic-key fallback; (c) custom endpoint credential resolution. **(b) is ALREADY upstream via `NativeAnthropicCredentialProvider` (`authority.ts:21` + `native-handler.ts:211-218`). (c) is ALREADY upstream via `loadCustomEndpoints()` → `registerApiKeyProvider()` (`custom-endpoints-loader.ts:68-72`). Only (a) needs reimplement — and it's a `PORT-TO-FORK` candidate, not a reimplement.** | Reuse `NativeAnthropicCredentialProvider.getRequestAuth("native-anthropic", …)` for NativeHandler fallback. |
| `0c52c2b` | fix(proxy): send OAuth tokens as Bearer, not x-api-key | May be redundant under upstream — `credentials.getRequestAuth("native-anthropic")` returns `x-api-key` for native fallback, but the OAuth token pass-through is handled by `native-handler.ts:201-206` (forward `originalHeaders.authorization` as-is). Verify at runtime. **Likely DROP or already-covered.** | n/a |
| `55f48c8` | fix(proxy): transparent header passthrough for Anthropic Max subscription | Same path as 0c52c2b — header pass-through in NativeHandler (lines 192-219). Likely already covered. | n/a |
| `b1f379c` | feat(proxy): add /v1/models endpoint, transparent routing without modelMap | Upstream already added a /v1/models via `servedSlotIds` (`proxy-server.ts:610-622` from upstream `f266cea`). The fork's own `fork/routes/model-discovery.ts` would CONFLICT — registration order matters (fork registers AFTER upstream, so the fork wins, but the slot-list semantics differ). | Use upstream `servedSlotIds`. The fork route should be DEMOTED to a /v1/discovery-names fallback or REMOVED. **Conflict — see Risks.** |
| `fe32b41` | fix(proxy): strip Claude Code billing header from prompt for non-Anthropic providers | Already on sync branch (Phase 2a). | n/a |
| `5048cda` | fix(proxy): log remote IP for direct LAN connections | Already on sync branch (Phase 2a). | n/a |
| `985643d` | refactor: isolate fork customizations into packages/cli/src/fork/ | **The crucial refactor.** All fork code moved to `fork/`. But the upstream rebase REMOVED the `registerForkExtensions()` call from `proxy-server.ts` — fork extensions are dead code in the rebase. Need to RE-WIRE. | Re-insert the call: `app.use("/v1/*", createProxyAuthMiddleware(opts.proxyKey))` etc. See Risks. |
| `24ec4da` | feat(stream-parsers): intercept WebSearch/WebFetch via SearXNG | Upstream only DETECTS (`web-search-detector.ts`) and WARNS (`warnWebSearchUnsupported`) — no interception. The SearXNG path is unique value-add. Adds `web-search-executor.ts` + intercept in `openai-sse.ts`. | No upstream API. Pure addition. |
| `34bac1f` | fix(stream-parsers): prevent openai-sse stream hang + add response-side capture | Fixes a real ReferenceError (`opts.modelName` → `target`) AND adds `response-capture.ts`. Upstream's `openai-sse.ts` may already differ — verify the bug still exists in upstream's stream hang path. | Read upstream openai-sse.ts lines around `finalize()` to confirm the variable name. **RUNTIME-CHECK NEEDED.** |
| `edcfc04` | fix(stream): WebFetch socket closure + empty response + tool_result role mismatch | Three fixes: 500KB byte cap on web fetch (web-search-executor.ts), empty response → text block (openai-sse.ts), tool_result role mismatch (proxy-server.ts buildToolResultResponse). The first two are unique; the third is in proxy-server.ts. **PORT-TO-FORK if feasible — pure addition.** | n/a |
| `e1c9753` | fix(composed-handler): strip thinking blocks from message history for non-native providers | 20 lines added to composed-handler.ts. Pure additive strip. | n/a |
| `032919c` | fix(composed-handler): strip inline system messages for Anthropic-transport providers | 32 lines composed-handler + 16 lines openai-messages.ts. Additive strip + merge. | n/a |
| `392833f` | fix(rate-limit): gracefully handle GLM/Z.AI in-stream burst limits (HTTP 200 + [1302]) | Adds `stream-peek.ts` (195L) + a peek-loop in composed-handler (103L) + anthropic-sse Z.AI support (173L). Upstream has hint text only (`composed-handler.ts:912`) — no patient backoff. | Unique value-add. |
| `8f34c8c` | fix(stream): graceful handling of socket close / fetch errors mid-stream | openai-sse.ts finalize('error') wraps error in text block + emits message_stop. | Unique value-add. |
| `a519a95` | fix(stream): fix out-of-order content block lifecycle causing 'Content block not found' | hasContent state snapshot for finalize(). | Unique value-add. |
| `386dae6` | fix(stream): guarantee finalize() terminates stream + count suppressed web text | finalize() terminal-pair on throw. | Unique value-add. |
| `16982fb` | fix(stream): classify empty-response cause — stop destructive /compact on transient empties | Empty-response classification in openai-sse. | Unique value-add. |
| `2afd400` | fix(stream): stop appending empty-response error after valid text content | hasContent snapshot guard. | Unique value-add. |
| `4ddeb5f` | fix(anthropic-sse): suppress server_tool_use blocks + execute webReader locally | Suppress server_tool_use lifecycle + executeWebFetch for webReader blocks. | Unique value-add. |
| `0cb986a` | fix(anthropic-sse): suppress server_tool_use blocks and handle empty responses | Original server_tool_use suppression; later REVERTED in 67d99c3, then re-introduced as 4ddeb5f. **Effectively SUPERSEDED by 4ddeb5f — apply order matters.** | n/a — superseded by 4ddeb5f. |
| `67d99c3` | fix(web-tools): intercept 'Web page content:' sub-agents + enhance htmlToText + stop server_tool_use suppression | Removes server_tool_use suppression (reverted 4ddeb5f's premise) — applied AFTER 4ddeb5f on main. **When replaying, apply 4ddeb5f LAST in the server_tool_use sequence to get correct behavior.** | n/a — depends on apply order. |
| `692a453` | fix(anthropic-sse): clamp content block indices to prevent client-side errors | Index clamping for re-numbered blocks. | Unique value-add. |
| `01fe5bf` | fix(anthropic-sse): emit synthetic message_stop when provider omits it | Synthetic message_stop on missing terminal. | Unique value-add. |
| `8afe19d` | fix(anthropic-sse): fix proxy crash on server_tool_use blocks (scope bug + ordering) | Scope crash fix. | Unique value-add. |
| `d05109d` | fix(anthropic-sse): finalize stream on mid-stream socket close (never-hang) | Inner try/catch around reader.read() to emit message_stop. **CLUSTER CRITICAL (po-2025 incident).** | Unique value-add. |
| `a4c0a0b` | feat(web-tools): route web search/fetch via MCP SearXNG + fix agentic blocking | New `mcp-searxng-client.ts` + SearXNG routing in web-search-executor + agentic-loop fix in openai-sse. | Unique value-add. |
| `3ca8e88` | fix(handler): serve non-streaming clients (stream:false) as JSON message — unblocks /compact | New `collect-sse-message.ts` + composed-handler branch on `payload.stream === true`. **CLUSTER CRITICAL (Non-Streaming /compact Gap).** | Unique value-add. |
| `67a5dd0` | fix(overload): patient backoff + HTTP 529 for GLM concurrency contention | isTransientOverload() + patientOverloadBackoff() (~5 min) + 529 Retry-After. **CLUSTER CRITICAL (overload patient backoff).** | Unique value-add. |
| `c1a86e4` | feat(endpoints): maxConcurrency for custom remote endpoints (vLLM wedge fix) | LocalTransport concurrency option. | Unique value-add. |
| `b1424ba` | feat(proxy): per-provider concurrency cap via ConcurrencyLimiter (gc@glm-5.2) | New `concurrency-limiter.ts` + wiring into AnthropicCompatTransport + OpenAIProviderTransport. **CLUSTER CRITICAL (gc@glm-5.2 saturation).** | Unique value-add. |
| `d69e5e8` | feat(fallback): inject conservative-mode system message for economy fallback | Injects a system message when falling back. | Unique value-add. |
| `6952ce0` | feat(relay): resilient sidecar mode — nominal relay to hub, autonomous on outage | New `fork/server/relay.ts` (332L) + proxy-server.ts relay branch + standalone-proxy.ts + `CLAUDISH_NO_ANTHROPIC` leak guard. **CLUSTER CRITICAL (relay/sidecar).** | Unique value-add. |
| `d6c2060` | fix(relay): bound only the header phase, not the body stream (pre-merge review) | Pre-merge review fix. Must apply AFTER 6952ce0. | Unique value-add. |

### PORT-TO-FORK — move into fork/middleware/ to insulate from upstream churn

| sha | subject | proposed new location | why it's better there |
|---|---|---|---|
| `61d5726` (proxy-auth portion only) | proxy-key gate (x-proxy-key / x-api-key / Authorization) | Already at `fork/middleware/proxy-auth.ts` — just need to RE-WIRE from `proxy-server.ts` | The fork-isolation refactor (985643d) already moved it; we just need to re-add the `app.use("/v1/*", createProxyAuthMiddleware(opts.proxyKey))` call. The new authority doesn't manage proxy-key (it's NOT a provider credential — it's an inter-machine cluster secret) so a Hono middleware is correct. |
| `b1f379c` (fork's old /v1/models) | fork route that overrides upstream `servedSlotIds` endpoint | Move to `fork/routes/model-discovery.ts` (already there) but make it registration-conditional (only register if servedSlotIds is empty) — otherwise upstream's slot-list wins | Two competing /v1/models endpoints. Fork's old route served `routing` + `customEndpoints` keys; upstream's serves `servedSlotIds` (Claude-Desktop picker). Keep both — upstream first (Claude Desktop), fork second as a fallback for non-slot callers (e.g. CC when gateway mode is off). Use Hono routing order. |
| `edcfc04` (tool_result role mismatch) | proxy-server.ts `buildToolResultResponse()` | Keep in proxy-server.ts but the fix is local to web-search injection. Could move the search-result injection into `fork/middleware/` if upstream churns the buildToolResultResponse path. | n/a (small diff, in-line) |
| `141d160` | machine attribution | Already in `fork/middleware/request-logger.ts`. | Already-fork. |
| `fe32b41` | billing header strip | Already in `fork/middleware/billing-header-strip.ts`. | Already-fork. |
| `34bac1f` (response-capture portion) | response-capture.ts | Already-fork candidate (`fork/middleware/response-capture.ts`) | Upstream didn't add response capture. Keep fork-local. |
| `6952ce0`, `d6c2060` | relay | Already in `fork/server/relay.ts`. | Already-fork. |
| `b1424ba` | ConcurrencyLimiter | Could move to `fork/middleware/concurrency-limiter.ts` — but the wiring is inside AnthropicCompatTransport and OpenAIProviderTransport which are upstream files. **Tricky — see Risks.** | The wiring MUST touch upstream transport files; can only move the limiter class itself. |
| `a4c0a0b` | mcp-searxng-client + web-search-executor | Could move to `fork/middleware/` — already mostly under `handlers/shared/web-search-executor.ts`. | The fork-only MCP client (`mcp-searxng-client.ts`) should live in `fork/`. The web-search-executor.ts touches shared stream parsers, so the wiring stays where it is. |

---

## Patch order for Phase 2d

The goal is to land the smallest, most isolated patches first (no auth conflicts), then escalate to the auth-touching ones. Recommended sequence:

### Tier 1 — pure additions, no upstream overlap (REAPPLY)
1. `5316c42` (GLM slug normalization — routing-rules.ts only, clean)
2. `141d160` (machine attribution — fork-only request-logger.ts)
3. `122b681` (full-body capture — fork-only request-logger.ts, no-op when env unset)
4. `c9ee364` (traffic-anthropic.ps1 — scripts/)

### Tier 2 — openai-sse.ts + anthropic-sse.ts stream-parser fixes
Apply in this order (each subsequent patch assumed the previous's stream shape):
5. `34bac1f` (openai-sse hang fix + response-capture.ts new file)
6. `edcfc04` (WebFetch byte cap + empty response + tool_result role)
7. `e1c9753` (thinking-block strip in composed-handler)
8. `032919c` (inline system message strip)
9. `392833f` (stream-peek + Z.AI burst rate limit — biggest single patch, ~679 lines)
10. `8f34c8c` (openai-sse mid-stream socket close)
11. `a519a95` (out-of-order content block lifecycle)
12. `386dae6` (finalize() terminal pair)
13. `16982fb` (empty-response classification)
14. `2afd400` (hasContent snapshot guard)
15. `b426811` (real input_tokens — already on sync, confirm)
16. `692a453` (clamp content block indices)
17. `01fe5bf` (synthetic message_stop)
18. `8afe19d` (server_tool_use scope crash)
19. `d05109d` (mid-stream socket close never-hang)
20. `0cb986a` (server_tool_use suppression — FIRST ATTEMPT, will be superseded)
21. `4ddeb5f` (server_tool_use suppression WITH webReader execute — CORRECT VERSION, supersedes 0cb986a)
22. `67d99c3` (web sub-agents + remove server_tool_use suppression revert — apply AFTER 4ddeb5f)
23. `24ec4da` (SearXNG WebSearch/WebFetch interception)
24. `a4c0a0b` (MCP SearXNG client + agentic fix)

### Tier 3 — composed-handler logic (touches shared file)
25. `3ca8e88` (non-streaming /compact gap — adds collect-sse-message.ts)
26. `67a5dd0` (patient backoff + HTTP 529 — depends on `isTransientOverload` + `patientOverloadBackoff`)
27. `d69e5e8` (conservative-mode system message in fallback)
28. `b1f379c` (/v1/models endpoint — **CONFLICT with upstream servedSlotIds**)
29. `c1a86e4` (custom-endpoint maxConcurrency)
30. `b1424ba` (per-provider ConcurrencyLimiter — wires upstream transports)

### Tier 4 — proxy-server.ts + relay (the auth-touching tier)
31. `fe32b41` (billing header strip — already on sync)
32. `5048cda` (remote IP logging — already on sync)
33. `985643d` (fork-isolation refactor + RE-WIRE `registerForkExtensions()` in proxy-server.ts)
34. `61d5726` (proxy-key gate — should be ALL inside fork middleware; only need to confirm NativeAnthropicCredentialProvider usage in native-handler.ts)
35. `0c52c2b` (OAuth Bearer — likely redundant)
36. `55f48c8` (header passthrough — likely redundant)
37. `6952ce0` (relay/sidecar — touches proxy-server.ts /v1/messages route + standalone-proxy.ts)
38. `d6c2060` (relay pre-merge review fix)

### Tier 5 — already on sync branch (verify Phase 2a)
- `16949b4` (`=aad7f5a`) — modelMap activation (already at HEAD)
- `fe32b41` (billing header strip)
- `5048cda` (remote IP logging)

---

## Cluster-critical invariants that must survive

These are the unique-value-add behaviors that the rebase MUST NOT break. Each has a known cluster incident behind it.

- [ ] **mid-stream socket close → `message_stop` emitted.** `fork/server/relay.ts` `forwardToUpstream()` reuses `createAnthropicPassthroughStream` so the inner try/catch in `anthropic-sse.ts` (added by d05109d) emits a terminal pair on reader exception. Test: `format-translation.test.ts` "upstream body that emits message_start + a text delta then errors".
- [ ] **server_tool_use blocks don't crash the proxy.** Suppression + index re-numbering in `anthropic-sse.ts` (4ddeb5f). Test: regression in `format-translation.test.ts`.
- [ ] **`/compact` (stream:false) returns JSON message not SSE.** `composed-handler.ts` branch on `payload.stream === true` (3ca8e88), `collectAnthropicSseToMessage()` in `fork/handlers/shared/collect-sse-message.ts` (need to re-locate post-rebase — see Risks). Test: `collect-sse-message.test.ts` (text, tool_use, mixed thinking/text order, empty body, malformed lines, unparseable tool JSON).
- [ ] **HTTP 429-overload/503 → 529 + Retry-After.** `isTransientOverload()` + `patientOverloadBackoff()` in `composed-handler.ts` (67a5dd0). Test: 36 episode attestation, see `overload-529-36-episodes-attestation.md` memory.
- [ ] **ConcurrencyLimiter caps gc@glm-5.2.** `fork/handlers/shared/concurrency-limiter.ts` + wiring in `AnthropicCompatTransport` + `OpenAIProviderTransport` (b1424ba). Test: `concurrency-limiter.test.ts`.
- [ ] **proxy-key gate accepts `x-proxy-key`, native swap only on real Anthropic key.** `fork/middleware/proxy-auth.ts` (re-wire from proxy-server.ts). NativeHandler Anthropic-key fallback uses `credentials.getRequestAuth("native-anthropic")` (already upstream — `native-anthropic-credential.ts:57-60`). **Cluster incident 2026-07-10: container recreate activated gate, zai/haiku 401-loop, opus OK.** Test: live CC session on glm-5.2 + MiniMax.
- [ ] **`/v1/models` endpoint serves.** Upstream `servedSlotIds` (`proxy-server.ts:610-622`) is correct for Claude Desktop picker. Fork's old `model-discovery.ts` route (`fork/routes/`) MUST NOT register BEFORE upstream, or upstream's picker is shadowed. See Risks.
- [ ] **billing header stripped for non-Anthropic providers.** `fork/middleware/billing-header-strip.ts`. Test: send claude-sonnet-4-6 to gc@glm-5.2, verify no `cc_version=` in body to upstream.
- [ ] **relay/sidecar (`fork/server/relay.ts`) — auth path remains compatible.** `forwardToUpstream()` injects `state.proxyKey` as `x-api-key` on the forward so the hub's auth accepts it (line 167 of relay.ts). **Cluster critical — see `relay-sidecar-deployment-state.md` memory (PR #8 not yet merged, pilot po-2023 only).** Test: `relay.test.ts` (14 tests, hysteresis, header build, gzip, never-hang delegation).
- [ ] **X-Claudish-Machine persists in capture body.** `fork/middleware/request-logger.ts` line 49 reads `x-claudish-machine` and embeds in the JSON capture. Test: verify a captured req-*.json has `"machine"` field.
- [ ] **`CLAUDISH_NO_ANTHROPIC` leak guard.** `proxy-server.ts` `anthropicRefusalHandler` (added by 6952ce0). On a non-ai-01 autonomous sidecar, a bare native target without budget reroute refuses cleanly with 503 (not 500, not a leak). Test: live CC session on a non-ai-01 sidecar sending bare `claude-opus-4-8` → expect 503.
- [ ] **GLM slug normalization.** `providers/routing-rules.ts` `normalizeGlmSlug()` (5316c42). Test: send `glm-5-2` → routes to `glm-5.2` → routes to gc@. Cluster incident 2026-06-25 (Hermes on po-2026).

---

## Risks / unknowns

### Risk 1 (CRITICAL) — `registerForkExtensions` is dead code post-rebase
`packages/cli/src/proxy-server.ts` no longer calls `registerForkExtensions(app, opts)` — the upstream rebase removed the import + the call. The fork's `fork/middleware/proxy-auth.ts`, `fork/middleware/billing-header-strip.ts`, `fork/middleware/request-logger.ts`, `fork/routes/model-discovery.ts` are ALL orphaned. **Phase 2d must re-insert the call before any of these utilities function.**

The wiring point (post-rebase proxy-server.ts:712 `app.post("/v1/messages", ...)`) needs `app.use("/v1/*", createProxyAuthMiddleware(opts.proxyKey))` somewhere in `createProxyServer()`, AND the body-prep step (`stripBillingHeaderFromBody(body, isNative)`) AND the request logger (`logRequest(body, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap)`) inside the `app.post("/v1/messages", ...)` handler.

`opts.proxyKey` itself is loaded from `process.env.CLAUDISH_PROXY_KEY || loadConfig().proxyKey`. **`loadConfig().proxyKey` doesn't exist on upstream's `ClaudishProfileConfig` type** — the fork's `fork/config/profile-extensions.ts` declares it but profile-config.ts doesn't merge it. **RUNTIME-CHECK NEEDED** — verify that loadConfig() returns proxyKey (TypeScript would have flagged this if the type was enforced; need to see the upstream shape).

### Risk 2 (CRITICAL) — competing /v1/models endpoints
Upstream's `f266cea` (claudish serve) added `app.get("/v1/models", …)` at `proxy-server.ts:610-622` serving `options.servedSlotIds` (Claude Desktop picker — slot ids, not real model ids). The fork's `fork/routes/model-discovery.ts` registers a SECOND `app.get("/v1/models")` serving `cfg.routing + cfg.customEndpoints`. **Hono will match the first registered route; fork's register-after-upstream means fork route WINS for non-serve callers.** But the JSON shape differs:
- upstream: `{ object: "list", has_more: false, data: [{ id, object: "model", type: "model", created, owned_by: "claudish" }] }`
- fork: `{ object: "list", data: [{ id, display_name, created_at }] }`

Claude Code's picker probably needs the upstream shape. Verify with a live CC session. **Recommended Phase 2d resolution:** make `registerModelDiscoveryRoute` registration conditional (skip when `options.servedSlotIds` is non-empty).

### Risk 3 (HIGH) — `loadStoredApiKeys` in standalone-proxy.ts is dead code
`fork/server/standalone-proxy.ts:20-48` still has `loadStoredApiKeys()` which pushes `config.json apiKeys` into `process.env`. Under upstream's authority, `getApiKey("X")` already reads from config directly (`api-key-credential.ts:84`). The fork's manual push is redundant (and could cause races if the authority has already memoized a different value). **Phase 2d should DELETE `loadStoredApiKeys()` and its call.**

### Risk 4 (HIGH) — fork-isolation refactor's `request-logger.ts` references upstream globals
`fork/middleware/request-logger.ts` line 56-58: `const fs = require("fs"); fs.mkdirSync(captureDir, { recursive: true });` — this is a CommonJS require inside an ESM module. Under upstream's pure-ESM compilation, `require` may need to be `import { mkdirSync, writeFileSync } from "node:fs"` at the top of the file. **RUNTIME-CHECK NEEDED** — verify the capture block works after re-apply.

### Risk 5 (MEDIUM) — `getRuntimeProviders` API was renamed/removed
`61d5726` uses `getRuntimeProviders()` from `providers/runtime-providers.js` (see its diff). Upstream may have renamed this — the custom-endpoints refactor now uses `registerRuntimeProvider()` from the same file (called in `custom-endpoints-loader.ts:63`). Verify the API surface. **RUNTIME-CHECK NEEDED.**

### Risk 6 (MEDIUM) — ConcurrencyLimiter wired into upstream transports
`b1424ba` adds `enqueueRequest()` calls in `packages/cli/src/providers/transport/anthropic-compat.ts:18` and `openai.ts:26`. The upstream rebase may have moved those files or changed the `ProviderTransport.fetch()` signature. Verify the wiring lands cleanly — the limiter itself can stay in `fork/handlers/shared/concurrency-limiter.ts`, but the call sites are upstream. **RUNTIME-CHECK NEEDED.**

### Risk 7 (MEDIUM) — relay's `createAnthropicPassthroughStream({ capture: false })` depends on 6952ce0 + 34bac1f landing together
The `capture: boolean` option was added in the same commit (6952ce0) that defined `RelayState`. After Phase 2d lands 6952ce0, the `capture` option MUST be present in `anthropic-sse.ts`'s `AnthropicPassthroughOpts`. The 34bac1f commit adds `createResponseCapture()` but the `capture` gating happens via the constructor parameter added by 6952ce0. **Tier 2 (#5) and Tier 4 (#37) must land together.**

### Risk 8 (LOW) — fork's `/v1/models` route returns shape with `display_name` + `created_at`, upstream's `servedSlotIds` returns `id` + `object: "model"` + `type: "model"` + `created` + `owned_by`
Claude Code's picker reads `data[].id` — both shapes have it. But CC may also read `object` or `type` — the upstream shape is closer to OpenAI's `/v1/models` convention. For the `claude serve` (Claude Desktop) use case, fork's shape is NOT compatible. For Claude Code's `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` use case, both should work (CC just reads `id`).

### Risk 9 (LOW) — `ProxyServerOptions.hostname` field is no longer read
Upstream's `proxy-server.ts` line 738 hardcodes `hostname: "127.0.0.1"` (no `options.hostname`). The fork's standalone-proxy.ts passes `hostname` (line 84). After rebase, the fork's standalone-proxy will fail to bind to `0.0.0.0` for Docker. Verify and add `options.hostname` back OR change standalone-proxy to construct with hostname via Hono's own serve options.

### Risk 10 (LOW) — web-search-executor.ts wiring location changed
The fork's `web-search-executor.ts` lives at `packages/cli/src/handlers/shared/web-search-executor.ts` (not fork/). Phase 2d should consider moving it to `fork/middleware/` to insulate from upstream evolution — but the wiring in `anthropic-sse.ts:16` (`import { executeWebFetch } from "../web-search-executor.js"`) and `openai-sse.ts` is hot path. Keep at current location unless upstream evolves the shared dir heavily.

### 3 riskiest commits
1. **6952ce0** (relay/sidecar) — touches proxy-server.ts /v1/messages route, depends on 34bac1f + d05109d landing first; auth path uses `state.proxyKey` injection that the new authority doesn't manage. Cluster-critical, pilot pending.
2. **b1424ba** (ConcurrencyLimiter) — wires upstream transport files (`anthropic-compat.ts`, `openai.ts`); upstream rebase may have changed those signatures.
3. **61d5726** (proxy auth) — the load-bearing cluster auth. Currently dead code post-rebase (Risk 1). Need to re-wire AND verify `loadConfig().proxyKey` is typed.

### 2 things the user should verify manually
1. **Live cluster test:** spin up a non-ai-01 autonomous sidecar with the rebase, send a bare `claude-opus-4-8` request, confirm 503 from `anthropicRefusalHandler` (not a leak to api.anthropic.com).
2. **`loadConfig().proxyKey` typing:** the fork's `fork/config/profile-extensions.ts` declares `proxyKey` but the type chain through `profile-config.ts` may not accept it. Verify a `loadConfig()` call returns the proxyKey field at runtime.

---

## Classification summary

- **DROP**: 0 commits
- **REAPPLY**: 4 commits (clean, fork-only or routing-rules.ts only)
- **REIMPLEMENT**: 31 commits (need patch re-expression against new APIs)
- **PORT-TO-FORK**: 8 commits (already in fork/ but need RE-WIRING; or could be moved)
- **Already-applied (Phase 2a)**: 5 commits
- **TOTAL**: 48 commits in this study scope (more than the 19 specified — included all the stream-parser/web-search/concurrency commits because they cluster around the 4 critical files)

Files touched by the 19 critical-file commits (post-rebase target):
- 9 new fork-only files: `collect-sse-message.ts` (+test), `response-capture.ts`, `web-search-executor.ts`, `mcp-searxng-client.ts`, `concurrency-limiter.ts` (+test), `stream-peek.ts` (+test), `relay.ts` (+test + e2e), `response-capture.ts`
- 4 new fork files (already exist): `proxy-auth.ts`, `billing-header-strip.ts`, `request-logger.ts`, `model-discovery.ts`
- 4 shared files (need careful merges): `proxy-server.ts`, `composed-handler.ts`, `handlers/shared/stream-parsers/anthropic-sse.ts`, `handlers/shared/stream-parsers/openai-sse.ts`
- 2 minor touchpoints: `native-handler.ts` (already largely upstream-shaped), `routing-rules.ts` (clean)
