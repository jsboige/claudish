import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { isEffortLevel } from "./adapters/base-api-format.js";
import {
  isAutoModeClassifierRequest,
  rewriteClassifierForNative,
} from "./classifier-passthrough.js";
import { type CodeModeSetting, parseCodeModeSetting } from "./code-mode/policy.js";
import {
  appendCapabilityQueryToMessage,
  isCapabilityVocabEnabled,
  liftCapabilityDeclaration,
} from "./fork/capability-vocabulary.js";
// #641 G6 — fork extensions carried onto the branch: the per-session output-token
// ceiling (#317 option B) and the negotiated capability vocabulary (#83). Both
// are INERT without their env knobs, so their presence changes nothing on a
// fleet that never opts in.
import {
  ARM_TTL_MAX_MS,
  type DelegationOwner,
  type FailoverStep,
  NATIVE_BUCKET,
  classifyNominalBucket,
  delegationCandidateBound,
  earliestWalledReprobeAt,
  extractSessionKey,
  getArmGraceMs,
  getFailoverRule,
  initFailover,
  isQuotaExhaustion,
  isWiringError,
  markStepFailed,
  onNominalRefusal,
  onNominalSuccess,
  parseResetAtFromBody,
  providerBucketOf,
  recordServedStepForNotices,
  resetStepSuccess,
  resolveDelegationExcluding,
  resolveDelegationOwner,
  resolveFailoverTargetForSession,
  roleFromModelName,
  servedStepForNotices,
  setRoleNominalBucketResolver,
  setRoleNominalResolver,
} from "./fork/failover.js";
import { collectRoutedBareNames, createProxyAuthMiddleware } from "./fork/middleware/proxy-auth.js";
// #641 blocker-2 port — capture pipeline (fork extension). request-logger owns
// the req-*.json capture, the pinned [Request] stdout line and the per-request
// number (requestNumberFor) the stream parsers correlate their [ttft]/[resp]
// markers and resp-* captures by. hostname-binding supplies the direct-address
// WeakMap, fed in Bun.serve's fetch wrapper below.
import { logRequest } from "./fork/middleware/request-logger.js";
import { createHostnameConfig } from "./fork/server/hostname-binding.js";
import {
  HOPS_HEADER,
  type RelayState,
  forwardToUpstream,
  readRequestBody,
  relayHealthFields,
  requestLoopedBack,
} from "./fork/server/relay.js";
// #641 G2 — fork/server re-attachment (relay shell). The stream registry feeds
// /health's liveness fields and bounds shutdown by consumable work; relay.ts is
// the sidecar forward path. Both are fork extensions carried onto the branch
// verbatim (see docs/reference/replatform-v14-layer-manifest.md).
import { createStreamTracker, stallThresholdMs } from "./fork/server/stream-registry.js";
import {
  admitSessionBudget,
  openSessionBudgetAttempt,
  sessionBudgetRefusalAnthropic,
} from "./fork/session-budget.js";
import {
  type AdvisorPresenceMonitor,
  createAdvisorPresenceMonitor,
  withAdvisorSwap,
} from "./handlers/advisor-decorator.js";
import {
  type AdvisorRuntime,
  createAdvisorPanelGateway,
} from "./handlers/advisor-panel-gateway.js";
import { shutdownAdvisorChains } from "./handlers/advisor-route-plan.js";
import type { ComposedHandlerOptions } from "./handlers/composed-handler.js";
import { FallbackHandler } from "./handlers/fallback-handler.js";
import type { FallbackCandidate } from "./handlers/fallback-handler.js";
import { createHandlerSet } from "./handlers/handler-set.js";
import { loadAdvisorSwapConfig } from "./handlers/native-handler-advisor.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
// #641 G7 — OpenAI-compatible ingress (/v1/chat/completions): the two
// translation directions are fork files carried verbatim from main (they are
// fully self-contained), and the notice policy rides the same
// failover-stream-notice module G5 brought over.
import {
  anthropicMessageToChatCompletion,
  createOpenAIChatStreamFromAnthropic,
} from "./handlers/shared/anthropic-to-openai.js";
import {
  SIGNING_SECRETS_KEY,
  createSigningSecrets,
  releaseWhenBodyEnds,
} from "./handlers/shared/call-context.js";
import {
  applyFailoverNotices,
  carryNoticeHeader,
  noticePolicyForIngress,
} from "./handlers/shared/failover-stream-notice.js";
import { convertOpenAIRequestToAnthropic } from "./handlers/shared/format/openai-request-to-anthropic.js";
import { UNHANDLED_ERROR_HEADER } from "./handlers/shared/hop-decision.js";
import { resolveInboundKeys } from "./handlers/shared/inbound-keys.js";
import { resolveProxyKeys } from "./handlers/shared/proxy-keys.js";
import type { ModelHandler } from "./handlers/types.js";
import type { HookEngine } from "./hooks/engine.js";
import { loadHooksOnce } from "./hooks/index.js";
import type { HostMode } from "./hooks/public.js";
import { withHooks } from "./hooks/response-seam.js";
import { getInstanceId } from "./instance-id.js";
import { log, logStderr } from "./logger.js";
import { warmRecommendedModels } from "./model-loader.js";
import { loadConfig } from "./profile-config.js";
import { DISPLAY_NAMES } from "./providers/auto-route.js";
import {
  ensureCatalogReady,
  logResolution,
  resolveTargetForCatalog,
  warmCatalog,
} from "./providers/catalog-client.js";
import { getEndpointUnavailableReason } from "./providers/endpoint-diagnostics.js";
import {
  ensureEndpointsRegistered,
  getCustomEndpointResult,
} from "./providers/endpoint-registration.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { proxyRouteDecision } from "./providers/native-route.js";
import { describeMissingCredential, getProviderByName } from "./providers/provider-definitions.js";
import {
  describeRoutingRuleProblem,
  effectiveDefaultProvider,
  loadRoutingRuleSources,
  loadRoutingRules,
  route,
  routingRuleProblems,
} from "./providers/routing-rules.js";
import { discoverProviderProbeModel } from "./providers/transport/provider-model-discovery.js";
import type { ProviderTransport } from "./providers/transport/types.js";
import {
  describeUnknownShortcut,
  isKnownProviderName,
  typedShortcutOf,
} from "./providers/unknown-shortcut.js";
import { RefusingHandler } from "./providers/wire-handler.js";
import {
  WireMarkerError,
  WireMarkerHandler,
  type WireMarkers,
  splitWireMarkers,
} from "./providers/wire-markers.js";
import { closeAllEpisodes } from "./recovery/coordinator.js";
import { redactExactValues, redactForClient } from "./redact.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import type { ProxyServer } from "./types.js";

/**
 * Routing failures are TERMINAL — no provider can serve the request (missing
 * credential, empty chain, unknown model). They must surface to the client as a
 * non-retryable HTTP 400, not a retryable 500: a 500 makes Claude Code loop on
 * "API error · Retrying · attempt N/10" and hide the real cause. Tagging the
 * error lets the request handlers map it to 400 with the actionable message.
 */
class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

function isTerminalRoutingFailure(e: unknown): e is Error {
  return e instanceof RoutingError;
}

/**
 * A single slot-routing entry for `claudish serve`. Claude Desktop sends
 * `body.model = <slot>` (a Claude-recognized id it accepts into its picker);
 * we route that to the user's real `model` on `provider`.
 *
 *   provider: a pinned provider slug (canonical BUILTIN_PROVIDERS name, e.g.
 *             "x-ai", "google", "openrouter"), or null/undefined = autoroute
 *             (let claudish's existing auto-chain pick).
 */
export interface SlotRoute {
  model: string;
  provider?: string | null;
}

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
  quiet?: boolean; // Suppress informational stderr output (e.g., [Auto-route])
  isInteractive?: boolean; // Whether the current session is interactive (gates consent prompt)
  advisorModels?: string[]; // Advisor models from --advisor flag
  advisorCollector?: string | null; // Collector model (null = no synthesis)
  /**
   * Exact slot-id → real-model map for `claudish serve` (Claude Desktop
   * redirect). Consulted BEFORE the substring tier `modelMap` in
   * getHandlerForRequest, so distinct slots that share a tier substring
   * (e.g. two "opus" slots) don't collide. Optional — existing callers
   * leave it undefined and behavior is unchanged.
   */
  slotMap?: Map<string, SlotRoute>;
  /**
   * Slot ids this gateway advertises on `GET /v1/models` (Claude Desktop
   * builds its picker only from a live /v1/models call). These MUST be the
   * Claude-recognized slot ids, not the real model ids. Defaults to [].
   */
  servedSlotIds?: string[];
  /**
   * An ordered, already-credential-filtered candidate list pinned by a PARENT
   * claudish process (`team` / `create_session`), parsed from a `--model`
   * chain value. Element 0 is also the `model` argument, so a chain is opt-in and
   * additive: absent it, routing behaves exactly as before.
   *
   * See step 2a-chain in `getHandlerForRequest` for why this exists and why it is
   * matched before catalog resolution.
   */
  modelChain?: string[];
  /**
   * Classifier passthrough (opt-in). When `enabled`, Claude Code's auto-mode
   * permission classifier request (detected by content) is rewritten onto
   * `model` and forwarded via the native Anthropic handler (OAuth passthrough),
   * bypassing role-based routing — so the main loop can run on another provider
   * while the safety classifier still runs on a real Claude model. Undefined /
   * disabled by default. See classifier-passthrough.ts.
   */
  classifier?: { enabled: boolean; model: string };
  /**
   * `--effort <level>`: pin the reasoning effort verbatim, skipping the
   * per-model catalog clamp. Undefined leaves the clamped mapping untouched.
   */
  effortOverride?: string;
  /**
   * `--model-params k=v[,...]`: extra request params deep-merged into every
   * outbound payload after the adapter has shaped it.
   */
  modelParams?: Record<string, unknown>;
  /**
   * `--pro-on-ultracode`: apply a model's catalog provider-preset while the
   * session is in ultracode. Opt-in; when false the session-event layer does
   * no filesystem work at all.
   */
  proOnUltracode?: boolean;
  /**
   * `--code-mode`: code mode for `openai-codex` (`auto` | `on` | `off`).
   * Absent ⇒ `DEFAULT_CODE_MODE_SETTING` (`auto`).
   */
  codeMode?: CodeModeSetting;
  /**
   * Every `--advisor` member's startup plan and every routed member's chain,
   * built before the port was bound (advisor-route-plan.ts). Present ⇒ the
   * proxy exposes `advisorPanel` and owns the chains: `shutdown` shuts them
   * down. Absent ⇒ no gateway; nothing is planned lazily.
   */
  advisorRuntime?: AdvisorRuntime;
  /**
   * Bind address for the server (default: "127.0.0.1", "0.0.0.0" for Docker).
   * Fork extension (#641 G2): the hub/sidecar containers publish a port, and a
   * hardcoded loopback bind — the upstream default — makes the container
   * unreachable from sibling machines (the CLAUDISH_HOST_PORT lesson).
   */
  hostname?: string;
  /**
   * Sidecar relay state — fork extension (#641 G2). Undefined → this process
   * is the hub: no relay branch is taken and behavior is exactly as before.
   * Set by standalone-proxy.ts from CLAUDISH_RELAY_UPSTREAM; owned by relay.ts.
   */
  relay?: RelayState;
  /**
   * Skip the startup cache warmers (pricing / recommended / catalog). Default
   * false — warm them. A test that stubs `globalThis.fetch` while a warmed
   * proxy runs in the same process must pass true: the warmers dispatch real
   * fetches in the background, and one landing later resolves against
   * whatever stub is installed THEN, poisoning an unrelated suite (measured
   * on this branch: relay.test.ts counting a warmer's call as its own).
   */
  skipBackgroundWarmers?: boolean;
  /**
   * Run hooks on this proxy's `/v1/messages` traffic. Default true. `--probe`
   * passes false: hooks never see probe traffic. Monitor mode and the
   * classifier passthrough never run hooks whatever this says.
   */
  hooks?: boolean;
  /**
   * Which host this process is, for hook loading and `ctx.host.mode`: the
   * interactive launcher, a pane child, `serve`, the MCP server, or other.
   * Default `"other"`. The first proxy of a process decides it.
   */
  hostMode?: HostMode;
}

/**
 * Ground-truth capture for classifier passthrough. No-op unless the
 * `CLAUDISH_CLASSIFIER_DEBUG` env flag is set. When active, appends the raw
 * model / sampling params / `system` array / relevant headers of an incoming
 * request to a dedicated `logs/classifier-capture.jsonl` file so the auto-mode
 * permission classifier's system marker (and its payload shape) can be verified
 * or discovered. Writes to a purpose-built file — NOT the redacted always-on
 * log — so it never pollutes structural logging. Best-effort; never throws.
 */
let classifierCaptureDirReady = false;
function maybeCaptureClassifierRequest(c: Context, body: any): void {
  if (!process.env.CLAUDISH_CLASSIFIER_DEBUG) return;
  try {
    const dir = join(process.cwd(), "logs");
    if (!classifierCaptureDirReady) {
      mkdirSync(dir, { recursive: true });
      classifierCaptureDirReady = true;
    }
    const record = {
      ts: new Date().toISOString(),
      model: body?.model,
      stream: body?.stream,
      max_tokens: body?.max_tokens,
      temperature: body?.temperature,
      top_p: body?.top_p,
      top_k: body?.top_k,
      thinking: body?.thinking,
      hasTools: Array.isArray(body?.tools) && body.tools.length > 0,
      tool_choice: body?.tool_choice,
      system: body?.system,
      headers: {
        "anthropic-beta": c.req.header("anthropic-beta") ?? null,
        "anthropic-version": c.req.header("anthropic-version") ?? null,
        "x-app": c.req.header("x-app") ?? null,
        authorization: c.req.header("authorization") ? "Bearer <present>" : null,
        "x-api-key": c.req.header("x-api-key") ? "<present>" : null,
      },
    };
    appendFileSync(join(dir, "classifier-capture.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostic capture is best-effort — never break the request path.
  }
}

/**
 * The native-lane predicate: a bare model name with neither an explicit
 * provider (`@`) nor a vendor path (`/`) prefix. Exported (#636, carried by
 * #641 G2) so the route a role-shaped relay probe takes is pinnable with the
 * SAME predicate the router applies — a re-expressed copy in a test would pin
 * the wrong route. The `noAnthropicDecision` half of #636 lands with the
 * leak-policy reroute grain (this branch has no `CLAUDISH_NO_ANTHROPIC`
 * reroute to extract it from yet).
 */
export function isNativeTarget(target: string): boolean {
  return !target.includes("/") && !target.includes("@");
}

export async function createProxyServer(
  port: number,
  // Legacy: the OpenRouter key is now resolved through the credential authority
  // (transport getHeaders()), not passed in. Param retained for signature
  // stability; callers may pass undefined.
  _openrouterApiKey?: string,
  model?: string,
  monitorMode = false,
  anthropicApiKey?: string,
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string },
  options: ProxyServerOptions = {}
): Promise<ProxyServer> {
  // Load user-declared custom endpoints from ~/.claudish/config.json and
  // register them in the runtime provider registry so they appear in lookups
  // and handler creation. Runs once per proxy lifetime; idempotent.
  // `configSnapshot` (assigned inside the try below) keeps that ONE read
  // shareable past its block scope — the keyless marking middleware needs the
  // same object, not a second loadConfig() racing a config edit.
  let configSnapshot: ReturnType<typeof loadConfig> | undefined;
  try {
    // ONE config read for both halves. The bundled catalog's suppression set is
    // `Object.keys(config.customEndpoints)`, so if the two halves ever read
    // different config objects — or different SCOPES — a user entry could
    // suppress a bundled row without its replacement registering, deleting the
    // provider. Sharing the object here makes that impossible rather than
    // merely unlikely.
    const config = loadConfig();
    configSnapshot = config;
    // Registers the bundled catalog AND the user's own `customEndpoints`, in
    // that order. Both used to happen here, which is why a custom endpoint was
    // invisible to `--probe` and the picker (#192) — those surfaces run before
    // any proxy exists. The count is READ rather than recomputed because the
    // picker or `--probe` has usually latched registration already, and
    // re-running the loader for a log line would re-register every endpoint.
    // `force` is REQUIRED here, and it is not an optimisation to remove.
    //
    // The latch is per-PROCESS, while this function is told a SPECIFIC config
    // and is the authority on what this proxy serves. Without `force`, a proxy
    // started after anything else already registered — the picker, `--probe`,
    // a previous `createProxyServer` in the same process — silently inherits
    // that earlier config and drops every `customEndpoints` entry in this one.
    //
    // Caught by `default-provider-e2e.test.ts` C1, which sandboxes HOME and
    // spins a fresh proxy per test: in isolation it passed, in a full-suite run
    // the endpoint never registered. Before this change the same site called
    // `loadCustomEndpoints(config)` unconditionally, so the behaviour was
    // correct by accident and folding it into the latched seam is what broke it.
    //
    // Cheap to force: sync, one already-loaded config object, an in-binary
    // array, and `registerRuntimeProvider` is an idempotent `Map.set` per name.
    ensureEndpointsRegistered({ config, force: true });
    const customEpResult = getCustomEndpointResult();
    if (customEpResult.registered > 0) {
      log(`[Proxy] Registered ${customEpResult.registered} custom endpoint(s) from config`);
    }
  } catch (err) {
    // Config read failure should not crash the proxy — the rest of startup
    // continues and users get the default (builtin-only) set of providers.
    log(
      `[Proxy] customEndpoints load skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Load the hook engine before any handler is built and before the first
  // request, so no request sees a half-loaded registry. Memoised per process.
  // Monitor mode forwards everything to Anthropic untouched, so it runs no hooks.
  let hookEngine: HookEngine | null = null;
  if (options.hooks !== false && !monitorMode) {
    try {
      hookEngine = await loadHooksOnce({ hostMode: options.hostMode ?? "other" });
    } catch (err) {
      // loadHooksOnce never rejects; same posture as customEndpoints if it did:
      // a broken optional extension is skipped, it never blocks startup.
      log(`[Proxy] hooks load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
   * `withHooks` goes on the RESOLVED handler, inside the advisor — never inside
   * `getHandlerForRequest` and never on a FallbackHandler candidate, for the same
   * `instanceof` reasons as the advisor below. Not on the classifier passthrough.
   */
  const withRequestHooks = (handler: ModelHandler): ModelHandler =>
    hookEngine ? withHooks(handler, hookEngine) : handler;

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(
    anthropicApiKey,
    options.advisorModels,
    options.advisorCollector
  );

  /**
   * The advisor for ANY main model. `withAdvisorSwap` is applied to the RESULT
   * of `getHandlerForRequest` at the request site — never inside it, and never
   * to a FallbackHandler candidate: `FallbackHandler` tests its candidates with
   * `instanceof ComposedHandler`, and `count_tokens` tests the resolved handler
   * with `instanceof NativeHandler`; a wrapper in either place hides them.
   *
   * With the advisor off (no --advisor, no CLAUDISH_SWAP_ADVISOR=1) this
   * returns the handler itself: no swap, no scan, no records (BC20). The
   * monitor branch of `getHandlerForRequest` is untouched; a `--monitor`
   * launch without the advisor never reaches the wrapper.
   */
  const advisorPresence = createAdvisorPresenceMonitor();
  // The advisor panel gateway: an in-process Hono app that is never served,
  // over the chains startup built from the advisor plans. It shares nothing
  // with `app` below — no lease middleware (the gateway owns one lease per
  // call), no `resolveHandlerForRequest` (no monitor branch, slot map or
  // `--model` remap), no advisor wrapper.
  const advisorRuntime = options.advisorRuntime;
  const advisorPanel = advisorRuntime ? createAdvisorPanelGateway(advisorRuntime) : undefined;
  const withAdvisor = (handler: ModelHandler, presence?: AdvisorPresenceMonitor): ModelHandler =>
    withAdvisorSwap(
      handler,
      loadAdvisorSwapConfig(options.advisorModels, options.advisorCollector),
      {
        presence,
        ...(advisorPanel ? { panel: advisorPanel } : {}),
        // Without a runtime no launch decision exists, so no bearer may sign.
        ...(advisorRuntime ? { claude: { childAuth: advisorRuntime.childAuth } } : {}),
      }
    );
  /**
   * Request-shaping options that must reach EVERY ComposedHandler, whatever
   * route built it. Defined once and spread at each construction site (and
   * into `ProfileContext.sharedOpts`) because a handler that misses them makes
   * the flags work on some models and silently not on others.
   */
  const requestShapingOpts: Pick<
    ComposedHandlerOptions,
    "effortOverride" | "modelParams" | "proOnUltracode" | "codeMode"
  > = {
    // Narrowed HERE, not at the CLI: createProxyServer is also entered from
    // `serve` and `team`, so the boundary must validate whoever calls it.
    // A non-canonical value is dropped rather than passed through — it could
    // not reach the wire anyway, and `--model-params` is its escape hatch.
    effortOverride: isEffortLevel(options.effortOverride) ? options.effortOverride : undefined,
    modelParams: options.modelParams,
    proOnUltracode: options.proOnUltracode,
    // Narrowed here for the same reason as effortOverride: `serve` and `team`
    // enter too. Anything but auto/on/off is dropped, which reads as off.
    codeMode: parseCodeModeSetting(options.codeMode),
  };

  // The four handler getters and their caches, built by one factory so the
  // advisor can own a second, isolated set (`requestRole: "advisor"`) without
  // sharing a cached handler, its token tracker or a FallbackHandler's
  // routing position with the main session. This set is the session's own:
  // exactly the options these getters captured before the move.
  const sessionHandlers = createHandlerSet({
    port,
    isInteractive: options.isInteractive,
    quiet: options.quiet,
    summarizeTools: options.summarizeTools,
    requestShapingOpts,
  });
  const {
    localProviderHandlers,
    remoteProviderHandlers,
    openRouter: getOpenRouterHandler,
    poe: getPoeHandler,
    local: getLocalProviderHandler,
    remote: getRemoteProviderHandler,
  } = sessionHandlers;

  // Check if model is a Poe model (has poe: prefix)
  const isPoeModel = (model: string): boolean => {
    return model.startsWith("poe:");
  };

  // Direct-provider catalog warmup (LiteLLM, Zen, Zen Go) was removed in
  // commit 5 of the model-catalog and routing redesign. The one catalog claudish
  // fetches is the cloud models catalog, warmed below (`warmCatalog`); every
  // provider's wire id comes from its connections (`resolveExternalId`).

  // Load effective routing rules once at startup: the USER's global config +
  // local config (local wins), and nothing else — there is no shipped table any
  // more. The routing engine consults these via route() for every bare-name
  // request, and falls through to the catalog-gathered chain when none matches.
  const routingRuleSources = loadRoutingRuleSources();
  const effectiveRoutingRules = loadRoutingRules(routingRuleSources);
  // Problems in those rules, reported ONCE, here: before Claude Code owns the
  // terminal, and through logStderr, which the quiet flag and a diagnostics pane
  // both govern. `loadRoutingRules` prints nothing, because it also runs inside the
  // config TUI and the `--probe` TUI (and on every `route()` call). The custom and
  // bundled endpoints were registered above, so a rule naming one is not reported
  // as an unknown provider.
  for (const problem of routingRuleProblems(routingRuleSources)) {
    logStderr(`Warning: ${describeRoutingRuleProblem(problem)}`);
  }
  // The fallback hop, resolved once beside the rules and passed to route() with
  // them. Passing rules alone makes route() read NO default provider (its guard
  // keeps this machine's setting out of tests), so before this every bare name the
  // proxy routed fell back to `openrouter`, whatever `defaultProvider` said —
  // `""` included. `--default-provider` reaches this through the env variable.
  const effectiveFallbackProvider = effectiveDefaultProvider();

  // Cache fallback handlers by target model string.
  // No TTL/invalidation: claudish is ephemeral per session, so env changes
  // (new API keys) take effect on next session start.
  const fallbackHandlerCache = new Map<string, ModelHandler>();

  // Detect the invocation mode for a given target model string.
  // Used to populate stats: how did the user specify this model?
  const detectInvocationMode = (
    target: string,
    wasFromModelMap: boolean
  ): ComposedHandlerOptions["invocationMode"] => {
    if (wasFromModelMap) return "model-map";
    if (!target) return "auto-route";
    const parsedSpec = parseModelSpec(target);
    if (parsedSpec.isExplicitProvider) {
      // Check if this came from env var (CLAUDISH_MODEL or ANTHROPIC_MODEL)
      const envModel = process.env.CLAUDISH_MODEL || process.env.ANTHROPIC_MODEL;
      if (envModel && (target === envModel || parsedSpec.model === envModel)) {
        return "env-var";
      }
      return "explicit-model";
    }
    return "auto-route";
  };

  // `+mode` / `#speed` markers ride on the model spec (`oai@gpt-6-sol+pro#fast`).
  // They are split off the resolved target once, here: everything below sees
  // the model alone, and the markers travel with the REQUEST
  // (`wireMarkerContext`), never with a cached handler or in a body.
  const getHandlerForRequest = async (requestedModel: string): Promise<ModelHandler> => {
    const out: { markers?: WireMarkers; refusal?: string } = {};
    const handler = await resolveHandlerForRequest(requestedModel, out);
    if (out.refusal) return new RefusingHandler(out.refusal);
    return out.markers && (out.markers.mode || out.markers.speed)
      ? new WireMarkerHandler(handler, out.markers)
      : handler;
  };

  const resolveHandlerForRequest = async (
    requestedModel: string,
    out: { markers?: WireMarkers; refusal?: string }
  ): Promise<ModelHandler> => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    // 2. Resolve target model based on mappings or defaults
    // Priority: exact slot map > role mappings > default model (--model) > requested model (native)
    let target = requestedModel;
    let wasFromModelMap = false;

    // 2a. Exact slot-id map (claudish serve / Claude Desktop redirect).
    // Claude Desktop sends body.model = a Claude-recognized SLOT id; route it
    // to the real model the user assigned that slot. Checked BEFORE the
    // substring tier match below so two slots sharing a tier substring
    // (e.g. claude-opus-4-1 + claude-opus-4-20250514) route distinctly
    // instead of colliding. Rewrite `target` and fall through to the existing
    // pipeline (explicit-provider path for pinned, auto-route + catalog
    // resolution for null-provider, native passthrough for claude-* reals).
    let slotMatched = false;
    const slot = options.slotMap?.get(requestedModel);
    if (slot) {
      target =
        slot.provider != null && slot.provider !== ""
          ? `${slot.provider}@${slot.model}`
          : slot.model;
      slotMatched = true;
      if (!options.quiet) {
        logStderr(`[Serve] slot ${requestedModel} → ${target}`);
      }
    }

    const req = requestedModel.toLowerCase();
    if (slotMatched) {
      // Slot map already set `target` — skip the substring tier match and the
      // --model fallback entirely so they can't override the exact mapping.
    } else if (modelMap) {
      // Role-specific mappings take highest priority
      if (req.includes("opus") && modelMap.opus) {
        target = modelMap.opus;
        wasFromModelMap = true;
      } else if (req.includes("sonnet") && modelMap.sonnet) {
        target = modelMap.sonnet;
        wasFromModelMap = true;
      } else if (req.includes("haiku") && modelMap.haiku) {
        target = modelMap.haiku;
        wasFromModelMap = true;
      }
      // Default model (--model) is fallback for all roles
      else if (model) target = model;
    } else if (model) {
      // No role mappings at all - use default model
      target = model;
    }

    try {
      const markers = splitWireMarkers(target);
      if (markers.mode || markers.speed) {
        out.markers = markers;
        target = markers.spec;
      }
    } catch (err) {
      if (err instanceof WireMarkerError) {
        out.refusal = err.message;
        return nativeHandler;
      }
      throw err;
    }

    const invocationMode = detectInvocationMode(target, wasFromModelMap);

    // 2a-chain. A PINNED CHAIN from a parent process.
    //
    // `team` / `create_session` resolve the route in the parent and spawn
    // the child with explicit specs, because a bare name would make the child
    // re-resolve credentials and open its own 1Password client — one dialog per
    // child instead of one per run (auth/credentials/prehydrate.ts). The cost used
    // to be that "explicit" also means "exactly one candidate": step 2c below is
    // the only place a FallbackHandler is built, it runs only for names the child
    // routes itself, and `isRetryableError` has no other caller. So a spawned child
    // could not fall through on a spent subscription, a rotated key, or a provider
    // that rejects the request shape — failures an interactive run recovers from.
    //
    // The parent now pins the WHOLE credential-filtered chain and this branch
    // rebuilds the FallbackHandler from it. Every element is explicit, so no
    // element re-routes and no SDK client is ever built; and the parent's
    // `route()` already called `credentials.isAvailable()` on each candidate,
    // which write-throughs each resolved op:// key into the env this process
    // inherited — so every candidate here resolves from env at step 1.
    //
    // Matched BEFORE 2b, against the UNRESOLVED target: 2b rewrites the primary to
    // its canonical wire id, so a post-2b comparison against `modelChain[0]` would
    // stop matching for exactly the models whose id needs resolving. Each element
    // gets the same catalog treatment individually, inside the loop.
    //
    // Only the default `--model` carries a chain; a role-mapped target (opus /
    // sonnet / haiku) does not equal `modelChain[0]` and falls through untouched.
    if (options.modelChain && options.modelChain.length > 1 && target === options.modelChain[0]) {
      const cacheKey = `chain:${options.modelChain.join("+")}`;
      const cached = fallbackHandlerCache.get(cacheKey);
      if (cached) return cached;

      await ensureCatalogReady(5000);
      const candidates: FallbackCandidate[] = [];
      for (const spec of options.modelChain) {
        const parsed = parseModelSpec(spec);
        const resolvedSpec = resolveTargetForCatalog(
          spec,
          parsed.isExplicitProvider,
          parsed.model,
          parsed.provider
        ).target;
        const handler =
          parsed.provider === "openrouter"
            ? getOpenRouterHandler(resolvedSpec, invocationMode)
            : ((await getRemoteProviderHandler(resolvedSpec, invocationMode)) ??
              getLocalProviderHandler(resolvedSpec, invocationMode));
        // A candidate that cannot be built is DROPPED, never fatal: the parent
        // credential-filtered this chain, so a miss here means the child's view
        // differs (a provider it cannot construct), and the remaining candidates
        // are still strictly better than failing the request.
        if (handler) {
          candidates.push({
            name: DISPLAY_NAMES[parsed.provider] ?? parsed.provider,
            provider: parsed.provider,
            handler,
          });
        }
      }

      if (candidates.length > 0) {
        const resultHandler =
          candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;
        fallbackHandlerCache.set(cacheKey, resultHandler);
        if (!options.quiet && candidates.length > 1) {
          logStderr(
            `[Route] ${candidates.length} pinned providers for ${target}: ${candidates.map((c) => c.name).join(" → ")}`
          );
        }
        return resultHandler;
      }
      // Nothing built — fall through to the ordinary pipeline, which will report
      // the real reason for the primary spec.
    }

    // 2b. Catalog resolution — map the typed name to the provider's own wire id.
    //
    // Runs for EVERY provider, not just OpenRouter. It is one `aggregators[]`
    // lookup, so it answers `mm@minimax-m2.5` → `MiniMax-M2.5` (MiniMax's own
    // api_official spelling, and their API is case-sensitive) and
    // `ag@gemini-3.6-flash` → `gemini-3.6-flash-high` with the same code path
    // that already handled `or@qwen3-coder-next`. Gating it to one provider was
    // why every other provider grew its own bespoke translation.
    //
    // Safe to run unconditionally: a model the catalog doesn't know — a local
    // GGUF, a custom endpoint's private id — resolves to null and passes
    // through unchanged. Providers that ALSO resolve live (against Antigravity's
    // dynamic models catalog) are unaffected: they re-resolve an exact id to
    // itself.
    //
    // ONLY for an EXPLICIT `provider@model` spec. The rewrite emits a
    // `provider@model` string, and for a BARE name `parsedTarget.provider` is the
    // provider auto-DETECTED from the name — so rewriting a bare name manufactures
    // an explicit spec out of a user request that had none. Step 2c then reads
    // `isExplicitProvider === true`, skips routing entirely, and the model goes to
    // the auto-detected provider with the whole subscription chain unconsulted.
    //
    // This bit exactly one family, which is why it survived: the rewrite only fires
    // when `wasResolved` is true, i.e. when the canonical id DIFFERS from what the
    // user typed — and MiniMax is the only family whose wire id differs by case
    // (`minimax-m2.5` → `MiniMax-M2.5`). Measured across glm-5.2, kimi-k2.7, k3,
    // deepseek-v3.2, grok-4.5, gpt-5.6-sol, gemini-3.6-flash and qwen3.7-plus: all
    // pass through unchanged and keep their chains. Bare `minimax-m2.5` became
    // `minimax@MiniMax-M2.5` and went straight to the METERED MiniMax API, past
    // both `minimax-coding` and `opencode-zen-go`. The user-visible symptom was a
    // subscription-covered model billing per token — or reporting no balance.
    //
    // Nothing is lost by skipping it here: the chain resolves each candidate's wire
    // id itself. `buildRoutingChain` calls `resolveExternalId(modelName, provider)`
    // per candidate, which is the same catalog lookup done PER PROVIDER instead of
    // once against a guessed one — that is what yields `mm@MiniMax-M2.5` for the
    // MiniMax candidate and `zengo@minimax-m2.5` for Zen Go in the same chain, two
    // spellings this single rewrite could never produce.
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.isExplicitProvider) {
        await ensureCatalogReady(5000);
        const outcome = resolveTargetForCatalog(
          target,
          parsedTarget.isExplicitProvider,
          parsedTarget.model,
          parsedTarget.provider
        );
        if (outcome.resolution)
          logResolution(parsedTarget.model, outcome.resolution, options.quiet);
        target = outcome.target;
      }
    }

    // 2c. The routing chain for a bare name
    // When no explicit provider@ prefix is given, `route()` calculates the chain:
    // the user's own rules (loaded once above), else the candidates the cloud
    // models catalog publishes plus the fallback hop, each kept only when it has
    // a credential and the account does not deny the model. The kept hops are
    // wrapped in a FallbackHandler.
    // `proxyRouteDecision` IS this gate: only a `bare` target is routed. Every
    // other decision falls through to steps 3-7 below.
    {
      const decision = proxyRouteDecision(target);
      if (decision.type === "bare") {
        const cacheKey = `fallback:${target}`;
        if (fallbackHandlerCache.has(cacheKey)) {
          return fallbackHandlerCache.get(cacheKey)!;
        }

        // Ensure catalog is warm before route() builds OpenRouter modelSpecs.
        await ensureCatalogReady(5000);

        const plan = await route(decision.model, effectiveRoutingRules, effectiveFallbackProvider);
        if (plan.kind === "ok") {
          const chain = [plan.primary, ...plan.fallbacks];
          const candidates: FallbackCandidate[] = [];
          for (const candidate of chain) {
            let handler: ModelHandler | null = null;
            if (candidate.provider === "openrouter") {
              handler = getOpenRouterHandler(candidate.modelSpec, invocationMode);
            } else {
              handler = await getRemoteProviderHandler(candidate.modelSpec, invocationMode);
            }
            if (handler) {
              candidates.push({
                name: candidate.displayName,
                provider: candidate.provider,
                handler,
              });
            }
          }

          if (candidates.length > 0) {
            const resultHandler =
              candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;

            fallbackHandlerCache.set(cacheKey, resultHandler);

            const routeLine = `[Route] ${candidates.length} ${candidates.length === 1 ? "provider" : "providers"} for ${decision.model}: ${candidates.map((c) => c.name).join(" → ")}`;
            if (!options.quiet && candidates.length > 1) {
              logStderr(routeLine);
            } else {
              // The debug log gets the chain even when stderr does not: a single
              // hop, or a quiet `-p` run. Without it a request that went to the
              // fallback hop alone left no line naming the provider it used.
              log(routeLine);
            }
            return resultHandler;
          }
        } else {
          // No routable provider for a bare model name. Routing is fully
          // data-driven now (the user's own rules, else the cloud models
          // catalog) — if the chain is empty and credential filtering produces
          // nothing, that is what the data says. Throw so the request handler
          // surfaces a clean error instead of silently falling through to a
          // legacy OpenRouter fallback. (Pre-commit-5 there was a hidden
          // OpenRouter step 7 that masked the no-route case.)
          const message = plan.hint
            ? `[Route] ${plan.reason}\n${plan.hint}`
            : `[Route] ${plan.reason}`;
          throw new RoutingError(message);
        }
      }
    }

    // 3. Check for Poe Model (poe: prefix)
    if (isPoeModel(target)) {
      const poeHandler = await getPoeHandler(target, invocationMode);
      if (poeHandler) {
        log(`[Proxy] Routing to Poe: ${target}`);
        return poeHandler;
      }
    }

    // 4. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = await getRemoteProviderHandler(target, invocationMode);
    if (remoteHandler) return remoteHandler;

    // 5. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target, invocationMode);
    if (localHandler) return localHandler;

    // 6. Native vs OpenRouter Decision
    // Models with explicit provider prefix (@) should never fall to native Anthropic handler.
    // They were explicitly routed to a provider - if the handler wasn't created above,
    // it's because the API key is missing, not because it's a native model.
    const hasExplicitProvider = target.includes("@");
    const isNative = isNativeTarget(target);

    if (isNative) {
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 6b. Explicit non-OpenRouter spec that produced no handler above means its
    // credential is MISSING — its key didn't resolve, so getRemoteProviderHandler
    // returned null. Per the routing contract, an explicit provider@model must
    // NOT silently fall through to OpenRouter (defaultProvider/last-resort
    // fallback applies to BARE names only). Silently routing e.g. sc@fugu-ultra
    // to OpenRouter caused it to catalog-resolve "fugu-ultra" → an xAI model
    // (status line "Xai") + a confusing "API error", hiding the real cause: no
    // Sakana key. Fail loudly with an actionable hint instead.
    if (hasExplicitProvider) {
      const parsedExplicit = parseModelSpec(target);
      // openrouter@... legitimately uses the OpenRouter handler below.
      if (parsedExplicit.provider !== "openrouter") {
        // A shortcut that names no provider is not a missing credential (D9):
        // say it is unknown, in the same words routing, preflight and --probe use.
        if (!isKnownProviderName(parsedExplicit.provider)) {
          const { reason, hint } = describeUnknownShortcut(
            typedShortcutOf(parsedExplicit.original),
            parsedExplicit.model,
            undefined,
            parsedExplicit.original
          );
          throw new RoutingError(
            `Explicit model "${target}" could not be routed — ${reason} ${hint}`
          );
        }
        // "No handler" has exactly one default explanation here, and for an
        // endpoint provider it is sometimes the wrong one — a malformed
        // base-URL override or a name collision produces no handler too, and
        // reporting that as a missing key sends the user hunting for a
        // credential they already have. Whoever KNEW the real reason recorded
        // it; prefer it over the guess.
        const recorded = getEndpointUnavailableReason(parsedExplicit.provider);
        if (recorded) {
          throw new RoutingError(`Explicit model "${target}" could not be routed — ${recorded}`);
        }
        // Sourced from the provider DEFINITION (runtime-aware) rather than the
        // hand-maintained builtin-only API_KEY_MAP, which is the same
        // second-table coupling that produces silent mis-routes elsewhere: it
        // names no runtime endpoint at all, so every bundled or user-declared
        // provider got the bare message with no variable to set. The three
        // shapes it can produce — local-not-enabled, sign-in-or-key, plain key —
        // are explained at the function.
        const hint = describeMissingCredential(parsedExplicit.provider);
        throw new RoutingError(
          `Explicit model "${target}" could not be routed — its provider has no credential. ${hint}`
        );
      }
    }

    // 7. OpenRouter Handler (default for any model with "/" or explicit OpenRouter spec)
    return getOpenRouterHandler(target, invocationMode);
  };

  /**
   * #83 grain 2: append the capability query to a collected (non-streaming)
   * response — the condensation rail. Streaming passes through untouched
   * (condensation is the non-stream path). The gate is re-read per call
   * (`CLAUDISH_CAPABILITY_VOCAB`, default off), so an operator can flip it
   * without a restart; never throws (a broken body simply serves as-is).
   */
  const applyCapabilityQueryAtCondensation = async (
    response: Response,
    sessionKey: string | null,
    wantsStreaming: boolean
  ): Promise<Response> => {
    if (wantsStreaming || !response.ok) return response;
    if (!sessionKey || !isCapabilityVocabEnabled(process.env)) return response;
    try {
      const message = await response.clone().json();
      if (appendCapabilityQueryToMessage(message, sessionKey, process.env)) {
        log(`[Capability] query appended to condensation (session=${sessionKey.slice(0, 8)})`);
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(message), { status: response.status, headers });
      }
      return response;
    } catch {
      return response;
    }
  };

  const app = new Hono();
  app.use("*", cors());

  // #641 G3 (fork extension): FULL proxy auth, replacing G2's keyless marker
  // wholesale. Registration order is the security property: this middleware
  // runs BEFORE the /v1/messages route handler, hence before its relay branch
  // — a request is authenticated where it lands, never forwarded first (same
  // order as the fork; the relay's forward reads the same #416 keyless mark,
  // which the auth's native-exemption branch now sets). GET and health routes
  // stay exempt inside the middleware. Registered only when a proxy key
  // exists — a keyless deployment keeps serving everything, as on the fork.
  const proxyKeys = resolveProxyKeys(
    process.env.CLAUDISH_PROXY_KEY ?? configSnapshot?.proxyKey,
    process.env.CLAUDISH_PROXY_KEY_PREVIOUS
  );
  const inboundKeys = configSnapshot ? resolveInboundKeys(configSnapshot, proxyKeys) : [];
  const routedBareNames = configSnapshot
    ? collectRoutedBareNames(configSnapshot)
    : (new Set<string>() as ReadonlySet<string>);
  if (proxyKeys.length) {
    app.use("/v1/*", createProxyAuthMiddleware(proxyKeys, inboundKeys, routedBareNames));
    // Count logged unconditionally (lengths, never values): closing a rotation
    // window must be as greppable as opening one (review feedback on #95).
    log(
      `[Proxy] Authentication enabled (Anthropic pass-through; ${proxyKeys.length} proxy key(s) accepted, lengths ${proxyKeys.map((k) => k.length).join("/")}; proxy key required for other providers)`
    );
    // #400 — names only (never values): the count of scoped keys must be as
    // greppable as the proxy-key rotation state, and the hub log is what an
    // operator greps after an external misbehaves.
    if (inboundKeys.length) {
      log(
        `[Proxy] ${inboundKeys.length} scoped inbound key(s) active: ${inboundKeys.map((k) => `${k.name}→[${k.allowModels.join(",")}]`).join("; ")}`
      );
    }
  }

  // Signing-credential redaction (`redact.ts`): every request gets a lease, and
  // every credential value a handler signs with for it is registered there
  // (`ComposedHandler`'s `fetchHeaders`). The lease belongs to the INBOUND
  // request, never to one hop, because `FallbackHandler` logs its combined
  // error after every hop has returned, and it is released only once the
  // response body is fully delivered, cancelled or has errored: a streamed body
  // is still parsed and logged long after the handler returned.
  app.use("*", async (c, next) => {
    const secrets = createSigningSecrets();
    c.set(SIGNING_SECRETS_KEY, secrets);
    const release = () => secrets.lease.release();
    try {
      await next();
    } catch (err) {
      // Hono's compose calls `onError` at the layer that caught a thrown Error,
      // so a route's throw is answered inside `next()` with this lease live.
      // An error reaches HERE only when that inner `onError` itself threw;
      // compose then calls `onError` again for this layer, AFTER the release
      // below. Redact this request's own values out of the error first, so
      // that second pass (its log lines and its 500 body) cannot carry them.
      if (err instanceof Error) {
        try {
          err.message = redactExactValues(err.message, secrets.values);
          if (err.stack) err.stack = redactExactValues(err.stack, secrets.values);
        } catch {
          // A read-only message (DOMException): onError's registry pass stays.
        }
      }
      release();
      throw err;
    }
    c.res = releaseWhenBodyEnds(c.res, release);
  });

  // Did the child ever ask a MODEL for anything? A failed run with this still at
  // zero died inside Claude Code before any model was contacted — the one fact
  // that separates a harness fault from a provider fault. The CLI reads it when
  // a session exits nonzero, because the session log cannot answer the question:
  // it records model traffic, and the whole point is that there was none.
  //
  // Counts `/v1/messages` ONLY. Claude Code pings discovery and health routes
  // while it starts up, and a run that got no further than its trust prompt
  // still leaves those behind — measured, not assumed. Counting every route
  // therefore masked exactly the case this exists for.
  let modelRequestCount = 0;
  app.use("*", async (c, next) => {
    if (c.req.path === "/v1/messages") modelRequestCount++;
    await next();
  });

  // #641 G2 (fork extension): per-request stream registry. /health reads it to
  // answer "serving, and moving" instead of "process alive" (the 2026-09-02
  // outage shape: a constant-time JSON /health answered ok from a hub serving
  // nobody for 2h27), and shutdown waits on it to bound the exit by CONSUMABLE
  // work — streams still writing — rather than by open sockets. See
  // fork/server/stream-registry.ts.
  const streamTracker = createStreamTracker();
  app.use("*", streamTracker.middleware);
  // Capture pipeline (fork extension): bind config + direct-address map. The
  // map is populated in Bun.serve's fetch wrapper (below) and read at capture
  // time by logRequest — x-forwarded-for / x-real-ip take precedence there.
  const hostnameConfig = createHostnameConfig(options.hostname);
  const startedAt = Date.now();

  // ── Budget-failover cascade wiring (#641 G8, first wiring) ────────────────────
  //
  // The module (fork/failover.ts, G5) held the whole state machine — rules, arm,
  // walls, per-step backoff, dwell pins, notices — but nothing called it: both
  // ingress routes resolved through `getHandlerForRequest(model)` alone, so no
  // role could ever substitute and the `applyFailoverNotices` calls were inert
  // by construction. This block is the FIRST wiring: the startup registration,
  // the bucket helpers, and the serve loop (nominal → steps, bounded), adapted
  // to the seams that exist on this base. Deliberately narrower than main's
  // loop — the gap list is enumerated in the PR and each entry lands as its own
  // grain: no #747 serving-note strip (the module snapshot predates it), no
  // #412 keyless suppression, no #565 context-admission census, no #654
  // endpoint token budget, no #431 busy/context skip wire (the Context marker
  // family is not ported), no #299-B overload walk, no #218 native-lane version
  // pin, no #693 machine-scoped resolution arm (the ported
  // resolveFailoverTargetForSession takes no machine argument), no #769
  // unroutable-step skip (a RoutingError at construction surfaces).
  // #609 IS wired below (walkDelegatedTarget): a delegated concrete that fails
  // in-request is followed by the next concrete of the TARGET's path on the same
  // delegating step, before the caller's next step — outside the attempt budget,
  // bounded by the target path's candidate count.
  //
  // Inert with no CLAUDISH_FAILOVER_* env: no rule ⇒ one attempt ⇒ the nominal
  // through the same resolution as before, byte-identical serve.
  initFailover();
  // The v14 modelMap carries no `fable` slot (its role set is opus/sonnet/
  // haiku/subagent) — index by string, not by FailoverRole, so the resolver
  // stays valid the day a slot is added.
  setRoleNominalResolver((r) => (modelMap as Record<string, string | undefined> | undefined)?.[r]);

  /** The request-side nominal target, mirroring resolveHandlerForRequest's own
   * mapping steps (slot map → role keywords → --model default) so the bucketer
   * and the serving resolution can never drift — a nominal bucketed as X while
   * it serves from Y walls a meter nobody draws on (#275). */
  const resolveNominalTarget = (requestedModel: string): { target: string; mapped: boolean } => {
    const slot = options.slotMap?.get(requestedModel);
    if (slot) {
      return {
        target:
          slot.provider != null && slot.provider !== ""
            ? `${slot.provider}@${slot.model}`
            : slot.model,
        mapped: true,
      };
    }
    let target = requestedModel;
    let mapped = false;
    const req = requestedModel.toLowerCase();
    if (modelMap) {
      if (req.includes("opus") && modelMap.opus) {
        target = modelMap.opus;
        mapped = true;
      } else if (req.includes("sonnet") && modelMap.sonnet) {
        target = modelMap.sonnet;
        mapped = true;
      } else if (req.includes("haiku") && modelMap.haiku) {
        target = modelMap.haiku;
        mapped = true;
      } else if (model) target = model;
    } else if (model) {
      target = model;
    }
    return { target, mapped };
  };

  /** Bucket for an ALREADY-CONCRETE cascade step target (#348): classify, never
   * re-map. Narrowed vs main on this base: no user-routing-rule override
   * consultation and no `route()` primary fallback — a bare routing-chain
   * nominal (`glm-5.3`) buckets canonically (`glm`) instead of on the route()
   * primary. Delegations whose nominal is a bare chain name are the one shape
   * that mis-buckets; the armed cascades this base serves today carry concrete
   * `provider@model` steps only. */
  const concreteStepBucketOfSync = (stepTarget: string): string => {
    const decision = classifyNominalBucket(stepTarget, () => false);
    if ("bucket" in decision) return decision.bucket;
    return providerBucketOf(stepTarget);
  };
  setRoleNominalBucketResolver(concreteStepBucketOfSync);

  /** The provider bucket a requested model's NOMINAL draws on (#275) — the meter
   * a quota refusal walls. Same classification chain as the concrete twin. */
  const nominalBucketOfModel = async (requestedModel: string): Promise<string> => {
    const { target } = resolveNominalTarget(requestedModel);
    const decision = classifyNominalBucket(target, () => false);
    if ("bucket" in decision) return decision.bucket;
    return providerBucketOf(target);
  };

  /** The ONE bucket an ingress request keys every failover decision on: undefined
   * when its role has no cascade (today's behaviour for every unconfigured
   * role). No Context is taken — the machine-arm bucket (#693) is not
   * consulted, the ported resolution takes no machine argument. */
  const requestBucketOf = async (requestedModel: string): Promise<string | undefined> => {
    const role = roleFromModelName(requestedModel);
    if (!role || !getFailoverRule(role)) return undefined;
    return await nominalBucketOfModel(requestedModel);
  };

  /**
   * Serve through the budget-failover cascade: nominal attempt first, then each
   * configured step, bounded (`steps.length + 1`). Each attempt resolves the
   * CURRENT failover state, so a role already armed serves its step on attempt
   * 0. Qualifying quota refusals (isQuotaExhaustion — deliberately narrow, 401
   * and 404 never arm) advance the walk and write fleet state; non-quota
   * failures surface on the nominal and the last step, and fail forward with a
   * marked step in between. #274: a role-step's marks reach the OWNING side.
   * #409: a walled LAST step surfaces as a 429 rate_limit_error the client
   * already retries, never the provider's own 403/402. Called by both ingress
   * routes; applyFailoverNotices wraps the result at the route (content on
   * /v1/messages, response header on /v1/chat/completions — #229).
   */
  const handleWithCascade = async (
    c: Context,
    body: any,
    requestedModel: string,
    nominalBucket?: string
  ): Promise<Response> => {
    const role = roleFromModelName(requestedModel);
    const rule = role ? getFailoverRule(role) : undefined;
    const bucket = nominalBucket ?? (rule ? await nominalBucketOfModel(requestedModel) : undefined);
    const maxAttempts = rule ? rule.steps.length + 1 : 1; // nominal + each step
    const armGraceMs = getArmGraceMs();
    const sessionKey = extractSessionKey(body); // #91 point 4: per-session dwell
    const machineHeader = c.req.header("x-claudish-machine") ?? null;
    let graceRetried = false; // #91: one wait-and-retry on the nominal per request
    // #609: a delegated concrete that failed in THIS request is followed by the
    // NEXT concrete of the target's path, on the SAME delegating step, before
    // the walk moves on or surfaces — a `role:` step stands for the target's
    // whole chain, not for the single concrete the resolution happened to pick.
    // One-shot override, consumed by the next iteration; it rides OUTSIDE the
    // caller's attempt budget (`attempt--`) and is bounded by the target path's
    // candidate count, excluding every concrete this request already paid.
    type DelegationOverride = { stepIndex: number; concrete: string; owner: DelegationOwner };
    let delegationOverride: DelegationOverride | null = null;
    let delegationWalks = 0;
    // Concretes this request already paid, across steps (the #609 exclusion
    // set). The index-keyed, #331-aware twin on main also feeds a revisit
    // guard this base does not have — here the set has exactly one reader.
    const paidConcretes = new Set<string>();
    let response: Response | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // #609: an override attempt serves the walk's concrete verbatim and reads
      // no failover state — the walk chose the concrete, a re-resolution would
      // hand the dead one back. Typed read: the only writer is the closure
      // below, which control-flow narrowing cannot see.
      const override = delegationOverride as DelegationOverride | null;
      delegationOverride = null;
      const resolved =
        override && rule
          ? { step: rule.steps[override.stepIndex], stepIndex: override.stepIndex }
          : role
            ? resolveFailoverTargetForSession(role, sessionKey, bucket)
            : { step: null as FailoverStep | null, stepIndex: -1 };
      const { stepIndex } = resolved;
      // #274: when this attempt serves a role-step's DELEGATION, the bookkeeping
      // must reach the OWNING side (target's bucket for its nominal, target's
      // step otherwise) — derived from the RESOLUTION itself.
      const delegation = override
        ? { concrete: override.concrete, owner: override.owner }
        : role && resolved.step?.roleRef
          ? resolveDelegationOwner(role, resolved.step)
          : null;
      // #609: arm the next delegated concrete for THIS step, when the target's
      // path still has one this request has not paid. True = the caller drains
      // and `continue`s; false = today's advance / surface.
      const walkDelegatedTarget = (): boolean => {
        if (!role || !delegation || !resolved.step?.roleRef || stepIndex < 0) return false;
        if (delegationWalks >= delegationCandidateBound(resolved.step)) return false;
        paidConcretes.add(delegation.concrete);
        const next = resolveDelegationExcluding(resolved.step, paidConcretes);
        if (!next) return false;
        delegationWalks++;
        delegationOverride = { stepIndex, concrete: next.concrete, owner: next.owner };
        log(
          `[Failover] DELEGATION-WALK ${role}[${stepIndex}] — ${delegation.concrete} failed in this request; ` +
            `trying ${next.concrete} (${next.owner.role} ${next.owner.nominal ? "nominal" : `step ${next.owner.stepIndex}`})`,
          true // forceConsole — operational event, countable marker
        );
        return true;
      };
      // The step's target is already concrete — serve it verbatim (the v14
      // getHandlerForRequest is single-arg; the swap happens HERE, at the loop,
      // not inside resolution). The nominal goes through the request-side
      // mapping exactly as before the wiring.
      const serveModel =
        override?.concrete ??
        (stepIndex >= 0 && resolved.step?.target ? resolved.step.target : requestedModel);
      const handler = withAdvisor(
        withRequestHooks(await getHandlerForRequest(serveModel)),
        advisorPresence
      );
      // Capture pipeline contract (fork extension): one [Request] line per
      // request, AFTER handler resolution — the handler that actually serves
      // attempt 0, so an armed role logs the step's lane, not the nominal's.
      if (attempt === 0) {
        logRequest(body, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap);
      }
      // #317: FRESH attempt token per paid upstream attempt — the usage sink
      // keys its max-ledger on it (two paid attempts of one request must land
      // in two slots). No-op when both bars are off.
      openSessionBudgetAttempt(c.req.raw, machineHeader, sessionKey, process.env);
      response = await handler.handle(c, body);
      if (response.ok) {
        if (role) {
          // #431 CR B1: name the step that actually served, for the notices.
          recordServedStepForNotices(c, role, resolved.step ?? undefined, stepIndex);
          if (stepIndex === -1)
            onNominalSuccess(role, bucket); // nominal healthy → fresh episode + maybe recovery
          else resetStepSuccess(role, stepIndex);
          // #274: the concrete model succeeded — clear the OWNING side too, in
          // the owner's vocabulary, never the delegating role's own bucket.
          if (delegation) {
            if (delegation.owner.nominal) {
              onNominalSuccess(
                delegation.owner.role,
                concreteStepBucketOfSync(delegation.concrete)
              );
            } else {
              resetStepSuccess(delegation.owner.role, delegation.owner.stepIndex);
            }
          }
        }
        return response;
      }
      if (!role) return response; // no role → no cascade possible
      let errBody = "";
      try {
        errBody = await response.clone().text();
      } catch {
        // unreadable body — status alone still decides for 402
      }
      const reason = `HTTP ${response.status} from ${requestedModel}`;
      if (!isQuotaExhaustion(response.status, errBody)) {
        // Wiring faults never advance: a mistyped model id in a step would
        // become permanently invisible, every request stepping over it.
        if (isWiringError(response.status, errBody)) {
          log(
            `[Failover] STEP-WIRING ${role} step=${stepIndex} — HTTP ${response.status} looks like a misconfigured step; surfacing instead of advancing`,
            true // forceConsole — operational event, countable marker
          );
          return response;
        }
        // Fail-forward: a non-quota failure on an INTERMEDIATE step still has a
        // working successor beneath it. The nominal and the last step surface —
        // the user's own model failing must reach the user. Marked, not merely
        // skipped (first backoff rung is 10 min; unmarked, every subsequent
        // request re-pays the round-trip to a step that may be down for hours).
        // The nonQuota flag (#276) forfeits a dwell pin instead of re-pinning
        // deeper. #331: the mark carries the CONCRETE this attempt served.
        const isIntermediateStep =
          stepIndex >= 0 && rule != null && stepIndex < rule.steps.length - 1;
        if (!isIntermediateStep) {
          // #609: a delegating LAST step whose concrete failed non-quota walks
          // the target's remaining path before surfacing. No mark is written —
          // that is the last step's contract (nothing beneath it to protect);
          // the exclusion set is the request's only memory of the failure. A
          // wiring fault already surfaced above, so a mistyped id stays visible.
          if (walkDelegatedTarget()) {
            try {
              await response.body?.cancel();
            } catch {
              // already gone — nothing to drain
            }
            attempt--; // outside the caller's budget, bounded by the candidate count
            continue;
          }
          return response;
        }
        const why = `HTTP ${response.status} (non-quota) from step ${stepIndex}`;
        log(`[Failover] STEP-ADVANCE ${role} — ${why}; trying next step`, true);
        const attemptConcrete = delegation?.concrete ?? resolved.step?.target;
        markStepFailed(role, stepIndex, why, parseResetAtFromBody(errBody), {
          nonQuota: true,
          concrete: attemptConcrete,
        });
        if (delegation && !delegation.owner.nominal) {
          markStepFailed(
            delegation.owner.role,
            delegation.owner.stepIndex,
            why,
            parseResetAtFromBody(errBody),
            {
              nonQuota: true,
              concrete: delegation.concrete,
            }
          );
        }
        continue;
      }
      if (stepIndex === -1) {
        // Nominal walled (#91 gate: burst discrimination + grace before arming).
        // "armed" also covers the concurrent-request race where another request
        // armed the role between this one's resolution and its refusal: the
        // retry below re-resolves and serves from the cascade.
        const verdict = onNominalRefusal(
          role,
          reason,
          response.headers.get("retry-after"),
          errBody,
          bucket
        );
        if (verdict.outcome === "burst") {
          // A short retry-after names a burst: surface it, the client ladder
          // absorbs it, the role never exiles for a 10-min TTL off a blip.
          return response;
        }
        if (verdict.outcome === "grace") {
          if (armGraceMs > 0 && !graceRetried) {
            graceRetried = true;
            await new Promise((r) => setTimeout(r, armGraceMs));
            attempt--; // replay the nominal attempt, not a cascade step
            continue;
          }
          return response;
        }
        // "armed" — fall through: the next iteration resolves the cascade.
      } else {
        // #274 delegated bookkeeping: exactly one increment per failure on each
        // side, and the owning side records the wall in ITS OWN vocabulary.
        markStepFailed(role, stepIndex, reason, parseResetAtFromBody(errBody), {
          concrete: delegation?.concrete ?? resolved.step?.target,
        });
        if (delegation) {
          if (delegation.owner.nominal) {
            onNominalRefusal(
              delegation.owner.role,
              reason,
              response.headers.get("retry-after"),
              errBody,
              concreteStepBucketOfSync(delegation.concrete)
            );
          } else {
            markStepFailed(
              delegation.owner.role,
              delegation.owner.stepIndex,
              reason,
              parseResetAtFromBody(errBody),
              {
                concrete: delegation.concrete,
              }
            );
          }
        }
        // #609: a delegated wall walks the target's remaining path in-request —
        // the marks above are written exactly as before; the walk only decides
        // what THIS request tries next. Exhausted → today's advance / surface.
        if (walkDelegatedTarget()) {
          try {
            await response.body?.cancel();
          } catch {
            // already gone — nothing to drain
          }
          attempt--; // outside the caller's budget, bounded by the candidate count
          continue;
        }
        if (rule && stepIndex === rule.steps.length - 1) {
          // #409: a walled LAST step never surfaces the provider's own 403/402
          // (Claude Code renders a 403 as an auth failure and offers a login
          // prompt; a 402 "Insufficient Balance" reads as a wiring error). Both
          // ARE budget walls — say so in the vocabulary the client already
          // retries: 429 rate_limit_error, retry-after bounded by the proxy's
          // next re-probe. Native lane excluded: its meter is the client's own
          // credential, which already speaks 429.
          if (!(bucket ?? "").startsWith(`${NATIVE_BUCKET}/`)) {
            const lastConcrete = delegation?.concrete ?? resolved.step?.target ?? requestedModel;
            let upstreamMsg = errBody.slice(0, 200);
            try {
              const parsed = JSON.parse(errBody);
              const m = parsed?.error?.message ?? parsed?.message;
              if (typeof m === "string" && m.length > 0) upstreamMsg = m.slice(0, 200);
            } catch {
              // not JSON — the raw slice above already is the message
            }
            const headers = new Headers({ "Content-Type": "application/json" });
            const horizon = earliestWalledReprobeAt(role, bucket);
            let capped = false;
            if (horizon) {
              const seconds = Math.max(1, Math.ceil((horizon.getTime() - Date.now()) / 1000));
              capped = seconds > ARM_TTL_MAX_MS / 1000;
              headers.set(
                "retry-after",
                String(Math.min(Math.ceil(ARM_TTL_MAX_MS / 1000), seconds))
              );
            }
            log(
              `[Failover] WALL-SURFACE ${role} — HTTP ${response.status} from ${lastConcrete} rewritten to 429 rate_limit_error` +
                (horizon
                  ? ` (retry-after ${headers.get("retry-after")}s${capped ? ", capped at wall-TTL max" : ""})`
                  : " (no re-probe horizon — retry-after omitted)"),
              true // forceConsole — operational event, countable marker
            );
            try {
              await response.body?.cancel();
            } catch {
              // already gone — nothing to drain
            }
            return new Response(
              JSON.stringify({
                type: "error",
                error: {
                  type: "rate_limit_error",
                  message: `[Failover] ${role}: every step walled — last: ${lastConcrete} ${response.status}: ${upstreamMsg}`,
                },
              }),
              { status: 429, headers }
            );
          }
          return response; // last step also walled (native lane: surface as-is)
        }
      }
    }
    return response as Response;
  };

  // Terminal-safety backstop. Hono's DEFAULT error handler is literally
  // `console.error(err)` + a text/plain "Internal Server Error" (see
  // hono/dist/hono-base.js). During an interactive session claudish's stderr IS
  // Claude Code's TTY (claude-runner spawns with stdio: "inherit"), so that one
  // console.error prints Bun's multi-line error dump — `error: …` / `path: …` /
  // `errno: …` / `code: …` — directly into the frame Claude Code is painting,
  // shredding the status line. Overriding onError means no unhandled route
  // rejection can ever reach a console again: it goes to the log file, and the
  // client gets a single-line Anthropic envelope it can render inline.
  app.onError((err, c) => {
    logStderr(`[Proxy] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.message ?? err}`);
    log(`[Proxy] Unhandled error stack: ${err?.stack ?? "(no stack)"}`);
    // Marked so a probe of one pinned hop can tell a throw from an upstream 500
    // (`UNHANDLED_ERROR_HEADER`); the status and envelope are unchanged.
    return c.json(
      wrapAnthropicError(500, redactForClient(`Proxy error: ${err?.message ?? String(err)}`)),
      500,
      { [UNHANDLED_ERROR_HEADER]: "1" }
    );
  });

  app.get("/", (c) =>
    c.json({
      status: "ok",
      message: "Claudish Proxy",
      config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap },
    })
  );
  // Liveness, not mere existence (#641 G2, fork extension). A constant-time
  // JSON handler touches nothing in the request pipeline, so it answers 200
  // from a process serving nobody — exactly how the 2026-09-02 outage (hub
  // silent 03:20:45Z → 05:47Z) stayed invisible to every sidecar prober for
  // 2h27 while they kept relaying into it.
  //
  // Streams in flight and nothing moving → 503, the signal the probers
  // already act on (2 failures, 10s apart → AUTONOMOUS). `status` stays first
  // and the body keeps `activeStreams`, so drain scripts and watchdogs are
  // unaffected.
  //
  // #156/#157 family: a relay publishes `role` + `upstream` (origin only) so
  // a hub recreated in the wrong role is visible in one call, and
  // `instanceId` — a random per-process nonce — lets a relay detect that the
  // upstream's /health answered with OUR OWN id (`selfLoop`, detected in
  // relay.ts's heartbeat; the 2026-09-19 ARR-loop shape, answered "ok" 4h40
  // while flapping 193 times).
  app.get("/health", (c) => {
    const thresholdMs = stallThresholdMs();
    const stalled = streamTracker.isStalled(thresholdMs);
    const { role, upstream } = relayHealthFields(options.relay);
    return c.json(
      {
        status: stalled ? "stalled" : "ok",
        activeStreams: streamTracker.getActiveStreams(),
        pendingRequests: streamTracker.getPendingRequests(),
        msSinceProgress: streamTracker.getMsSinceProgress(),
        stallThresholdMs: thresholdMs,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        role,
        upstream,
        instanceId: getInstanceId(),
        ...(options.relay ? { selfLoop: options.relay.selfLoop } : {}),
      },
      stalled ? 503 : 200
    );
  });

  // Model discovery for Claude Desktop "third-party inference" mode.
  // The app builds its model picker ONLY from a live GET /v1/models, and
  // silently drops any id it doesn't recognize — so `serve` advertises the
  // Claude-recognized SLOT ids here (supplied via options.servedSlotIds),
  // NOT the real model ids those slots route to. Defaults to an empty list
  // for non-serve callers (the picker is irrelevant to them).
  const servedSlotIds = options.servedSlotIds ?? [];
  /**
   * Model ids advertised to a NON-serve caller.
   *
   * Computed once, at server construction, deliberately. The obvious shape is
   * to build this per request so a config edit shows up live, but this route
   * feeds a picker that gets refreshed on a whim, and every per-request option
   * is worse than it looks: `loadConfig()` is a disk read, and credential-
   * filtering the list means resolving each rule's provider chain, which can
   * reach 1Password — where a burst of concurrent handshakes trips a
   * 15-second machine-wide suppression that then fails unrelated requests.
   * A picker refresh must not be able to do that.
   *
   * NOT credential-filtered, and that is a decision rather than an omission.
   * Filtering has two failure modes and they are not symmetric. Advertising a
   * model with no key costs the user one clear credential error, which claudish
   * already renders inline complete with the 1Password notice. Hiding a model
   * whose key lives somewhere a SYNC check cannot see — an `op://` reference,
   * resolvable at request time — makes a working model unpickable with no
   * error at all and nothing to diagnose. The second is worse, so the list is
   * everything routable by configuration.
   */
  const discoverableModelIds = ((): string[] => {
    const seen = new Set<string>();
    try {
      const cfg = loadConfig();
      for (const name of Object.keys(cfg.routing ?? {})) {
        // `*` is the catch-all routing wildcard, not a model anyone can ask for.
        if (name === "*") continue;
        seen.add(name);
      }
      for (const ep of Object.values(cfg.customEndpoints ?? {})) {
        for (const m of (ep as { models?: string[] }).models ?? []) seen.add(m);
      }
    } catch (err) {
      // Same posture as every other optional read in this file: a broken config
      // degrades the picker, it does not take the proxy down.
      log(`[Proxy] /v1/models discovery skipped: ${err instanceof Error ? err.message : err}`);
    }
    return [...seen];
  })();

  app.get("/v1/models", (c) => {
    // Slot mode wins whenever `serve` supplied ids: Claude Desktop only
    // recognizes the slot ids, and this branch must stay byte-identical to what
    // it has always returned.
    const ids = servedSlotIds.length > 0 ? servedSlotIds : discoverableModelIds;
    return c.json({
      object: "list",
      has_more: false,
      data: ids.map((id) => ({
        id,
        object: "model",
        type: "model",
        created: 1716000000,
        owned_by: "claudish",
      })),
    });
  });

  /**
   * Probe-model discovery for self-hosted / user-deployed providers
   * (litellm, ollama, lmstudio, vllm, mlx, ollamacloud). The cloud
   * /probeModels catalog can't enumerate user deployments — only the
   * endpoint itself knows what's available. The TUI calls this when the
   * catalog has no entry for a provider.
   *
   * GET /v1/probe-discover?provider=<slug>
   * → 200 { provider, model } on success
   * → 200 { provider, model: null, reason } on discovery failure
   * → 404 if provider has no transport-level discoverer
   */
  app.get("/v1/probe-discover", async (c) => {
    const provider = c.req.query("provider");
    if (!provider) return c.json({ error: "missing provider query" }, 400);
    // Optional exclude list — TUI's probe loop passes models that already
    // failed so discovery returns the next candidate. Format: comma-separated.
    const excludeQuery = c.req.query("exclude") ?? "";
    const exclude = new Set(
      excludeQuery
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    // Use a sentinel model name — the handler factory needs one, but
    // discoverProbeModel doesn't consult the modelName field.
    const targetModel = `${provider}@<discover>`;
    // Try local providers first (ollama, lmstudio, vllm, mlx). They're
    // filtered out of the remote registry by design, so getRemoteProviderHandler
    // returns null for them and we'd otherwise report "transport does not
    // support discovery" even though LocalTransport DOES implement it.
    const handler =
      getLocalProviderHandler(targetModel) ?? (await getRemoteProviderHandler(targetModel));
    const transport = (handler as unknown as { provider?: ProviderTransport })?.provider;
    // A handler that exposes no transport (a catalog provider built as a
    // try-in-turn handler) still answers from the provider's own dynamic
    // models catalog when its definition declares one.
    const definition = getProviderByName(provider);
    const discover = transport?.discoverProbeModel
      ? (ex?: ReadonlySet<string>) => transport.discoverProbeModel!(ex)
      : definition?.modelDiscovery
        ? (ex?: ReadonlySet<string>) =>
            discoverProviderProbeModel(provider, definition.displayName, ex)
        : undefined;
    if (!discover) {
      return c.json({ provider, model: null, reason: "transport does not support discovery" }, 404);
    }
    try {
      const outcome = await discover(exclude);
      return c.json({
        provider,
        model: outcome.model,
        reason: outcome.model ? null : (outcome.reason ?? "no model available"),
      });
    } catch (e: unknown) {
      return c.json(
        {
          provider,
          model: null,
          reason: redactForClient(e instanceof Error ? e.message : String(e)),
        },
        500
      );
    }
  });

  // Token counting
  app.post("/v1/messages/count_tokens", async (c) => {
    try {
      const body = await c.req.json();
      if (typeof body?.model !== "string" || body.model.length === 0) {
        return c.json(wrapAnthropicError(400, "missing required field: model"), 400);
      }
      const handler = await getHandlerForRequest(body.model);

      // If native, we just forward. OpenRouter needs estimation.
      if (handler instanceof NativeHandler) {
        const headers: any = { "Content-Type": "application/json" };
        if (anthropicApiKey) headers["x-api-key"] = anthropicApiKey;

        const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        return c.json(await res.json());
      }
      // OpenRouter handler logic (estimation)
      const txt = JSON.stringify(body);
      return c.json({ input_tokens: Math.ceil(txt.length / 4) });
    } catch (e) {
      if (isTerminalRoutingFailure(e)) {
        return c.json(
          wrapAnthropicError(400, redactForClient(e.message), "invalid_request_error"),
          400
        );
      }
      return c.json(wrapAnthropicError(500, redactForClient(String(e))), 500);
    }
  });

  app.post("/v1/messages", async (c) => {
    // Set when the resolved handler itself threw (not the body parse, not routing):
    // that 500 is marked `UNHANDLED_ERROR_HEADER`, like `app.onError`'s.
    let handlerThrew = false;
    try {
      const body = await c.req.json();
      // Request-metadata trace (debug log only — the [RequestMeta] prefix is
      // NOT structural-log-worthy, so it never reaches the always-on redacted
      // log). Captures the three fields claudish otherwise never reads, to
      // diff ultracode vs plain-xhigh sessions for a wire-level marker.
      log(
        `[RequestMeta] model=${body.model} output_config=${JSON.stringify(body.output_config) ?? "(none)"} metadata=${JSON.stringify(body.metadata) ?? "(none)"} anthropic-beta=${c.req.header("anthropic-beta") ?? "(none)"}`
      );

      // Ground-truth capture (no-op unless CLAUDISH_CLASSIFIER_DEBUG). Runs
      // before detection so a drifted marker can still be discovered.
      maybeCaptureClassifierRequest(c, body);

      // Sidecar relay (#641 G2, fork extension). In NOMINAL mode (upstream
      // configured + alive) forward the raw request to the central hub and
      // return its piped response. This branch sits BEFORE the classifier
      // passthrough, handler resolution and any request logging, so nominal
      // forwards are served entirely by the hub — which also means the
      // sidecar never double-handles them. A pre-stream forward failure
      // returns null → fall through to the normal local path for this one
      // request (and feeds the prober's hysteresis toward AUTONOMOUS).
      //
      // #279 — checked BEFORE forwarding: a request whose hop list carries
      // our own instanceId is one of our forwards coming back (boot window
      // before the heartbeat latched selfLoop, or an A→B→A cycle heartbeat
      // identity cannot see). Serving locally is the only reaction — never a
      // refusal.
      const relay = options.relay;
      if (relay?.upstream && requestLoopedBack(c)) {
        log(
          `[Relay] request returned via ${HOPS_HEADER} — own id in hop list (boot window or relay cycle) — serving LOCALLY`,
          true
        );
      } else if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, body, relay);
        if (forwarded) return forwarded;
      }

      // Classifier passthrough (opt-in, default off): Claude Code's auto-mode
      // permission classifier is identified by CONTENT (a marker in its system
      // prompt), not model name. When enabled, reroute it to a native Claude
      // model on api.anthropic.com via nativeHandler (which forwards the inbound
      // Claude Max OAuth and the system array — incl. the x-anthropic-billing-header
      // block — verbatim), bypassing role-based routing. This lets the main loop
      // run on another provider (e.g. Codex) while the safety classifier still
      // runs on a real Claude model. Skipped in monitor mode (everything is
      // already native there). See classifier-passthrough.ts.
      if (!monitorMode && options.classifier?.enabled && isAutoModeClassifierRequest(body)) {
        log(
          `[Classifier] auto-mode permission classifier → native Anthropic (model ${body.model} → ${options.classifier.model})`
        );
        // Rewrite onto the native Claude model + strip 400-prone fields (see
        // classifier-passthrough.ts). Log first — it reads the original body.model.
        rewriteClassifierForNative(body, options.classifier.model);
        // Wrapped like every other request so the advisor work NativeHandler
        // used to do here still happens; not counted by the absent-tool
        // monitor, which watches the main loop.
        return await withAdvisor(nativeHandler).handle(c, body);
      }

      // #317 option B — per-session output-token ceiling. Admission runs BEFORE
      // any handler resolution: a refused request pays no upstream and writes no
      // failover state (not even the dwell pin the resolution below writes).
      // Inert without CLAUDISH_SESSION_BUDGET_* (null admission, zero work), and
      // never reached on a relayed request — the relay branch returned above, so
      // a sidecar never counts what the hub serves.
      const sessionKey = extractSessionKey(body);
      const machineHeader = c.req.header("x-claudish-machine") ?? null;
      {
        const admission = admitSessionBudget(machineHeader, sessionKey, process.env);
        if (admission?.refused) return sessionBudgetRefusalAnthropic(admission);
      }

      // #83 grain 2: capability vocabulary — lift the session's declaration from
      // trailing assistant history, once per session (the same #91 p4 dwell seam
      // the budget keys on), gated CLAUDISH_CAPABILITY_VOCAB (default off).
      if (sessionKey && isCapabilityVocabEnabled(process.env)) {
        const declared = liftCapabilityDeclaration(sessionKey, body);
        if (declared) {
          log(
            `[Capability] session=${sessionKey.slice(0, 8)} declared ${JSON.stringify(declared)}`
          );
        }
      }

      // Budget-failover cascade (#641 G8, first wiring): the nominal attempt
      // through the SAME resolution as before, then each configured step. The
      // [Request] log line and the per-attempt budget token moved INSIDE the
      // loop — one log per request naming attempt 0's lane (an armed role logs
      // the step's lane, not the nominal's), and a FRESH token per paid
      // attempt (#317). Inert with no CLAUDISH_FAILOVER_* env.
      const requestRole = roleFromModelName(body.model);
      const requestBucket = await requestBucketOf(body.model);
      // Route. The `await`s are load-bearing: handing a promise back BEFORE it
      // settles lets a rejection escape this try/catch entirely and land in
      // Hono's error handler instead. That is how connect failures bypassed
      // every message we build here.
      try {
        const response = await handleWithCascade(c, body, body.model, requestBucket);
        // Inject onset/recovery notices: in-content on this ingress (the
        // Claude Code agent loop), response header on /v1/chat/completions
        // (#229). The wrap never throws — a thrown error would turn a working
        // condensation into a failed one.
        const noticed = await applyFailoverNotices(
          response,
          requestRole,
          sessionKey,
          body.stream === true,
          noticePolicyForIngress(c.req.path),
          requestBucket,
          servedStepForNotices(c, requestRole) // #431 CR B1: name the step that served
        );
        return await applyCapabilityQueryAtCondensation(noticed, sessionKey, body.stream === true);
      } catch (handlerError) {
        handlerThrew = true;
        throw handlerError;
      }
    } catch (e) {
      log(`[Proxy] Error: ${e}`);
      // Routing failures are terminal — surface as a non-retryable 400 so the
      // client shows the real reason (e.g. missing key) instead of looping on
      // "API error · Retrying". Other errors stay 500.
      if (isTerminalRoutingFailure(e)) {
        return c.json(
          wrapAnthropicError(400, redactForClient(e.message), "invalid_request_error"),
          400
        );
      }
      // A handler that threw is a hop that threw: inside a routing chain
      // FallbackHandler advances past it, so a probe of one pinned hop must be
      // able to tell it from an upstream 500 (`UNHANDLED_ERROR_HEADER`).
      return c.json(
        wrapAnthropicError(500, redactForClient(String(e))),
        500,
        handlerThrew ? { [UNHANDLED_ERROR_HEADER]: "1" } : undefined
      );
    }
  });

  // OpenAI-compatible ingress (#641 G7, fork extension). An OpenAI client
  // (sk-agent, any AsyncOpenAI consumer) POSTs here; we translate the body to
  // Anthropic shape, run the SAME pipeline as /v1/messages, and translate the
  // response back to OpenAI wire shape. Anthropic remains the native ingress;
  // this is a translated ingress into the same pipeline. Carried from main's
  // proxy-server.ts route, adapted to the seams that exist on this branch —
  // the deltas are marked #641-G7-GAP inline:
  //   - no drain-freeze gate (the freeze infra is not ported yet);
  //   - since G8 the route serves through handleWithCascade like /v1/messages,
  //     so this ingress inherits the budget-failover substitution and the
  //     applyFailoverNotices call below is live (the narrower-than-main gap
  //     list lives with the cascade wiring block);
  //   - no stripBillingHeaderFromBody / keylessNativeRequest
  //     (the billing-strip family is not ported).
  app.post("/v1/chat/completions", async (c) => {
    try {
      // Same client-error terminal 400 as /v1/messages (#548 on main), in this
      // route's OpenAI error envelope: readRequestBody() throws a SyntaxError
      // on empty / non-JSON input that the catch below would otherwise map to
      // a retryable 500 (which relays count toward hub hysteresis). It also
      // inflates a gzipped relay body — a sidecar forward arrives with
      // content-encoding: gzip, which c.req.json() would not decode.
      let openaiBody: any;
      try {
        openaiBody = await readRequestBody(c);
      } catch (parseErr) {
        return c.json(
          {
            error: {
              message: `Invalid request body: ${(parseErr as Error)?.message ?? parseErr}`,
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
          400
        );
      }
      if (openaiBody === null || typeof openaiBody !== "object" || Array.isArray(openaiBody)) {
        return c.json(
          {
            error: {
              message: "Invalid request body: expected a JSON object",
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
          400
        );
      }

      // Relay (sidecar NOMINAL): forward the RAW OpenAI body to the hub's
      // /v1/chat/completions — the hub translates. forwardToUpstream is
      // path-aware, so the forward reaches the route the client hit, not
      // /v1/messages. #279: same hop-list gate as /v1/messages — a loop can
      // enter on either ingress.
      // #641-G7-GAP: no admission-freeze gate here — main places
      // drainFreezeGate() before the relay branch; the drain/freeze infra is
      // not ported yet.
      const relay = options.relay;
      if (relay?.upstream && requestLoopedBack(c)) {
        log(
          `[Relay] request returned via ${HOPS_HEADER} — own id in hop list (boot window or relay cycle) — serving LOCALLY`,
          true
        );
      } else if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, openaiBody, relay);
        if (forwarded) return forwarded;
      }

      if (typeof openaiBody?.model !== "string" || openaiBody.model.length === 0) {
        return c.json(
          {
            error: {
              message: "missing required field: model",
              type: "invalid_request_error",
              param: "model",
              code: null,
            },
          },
          400
        );
      }

      const anthropicBody = convertOpenAIRequestToAnthropic(openaiBody);
      const wantsStream = openaiBody.stream === true;

      // #317 option B — same admission as /v1/messages, on the OpenAI wire
      // shape this ingress speaks (sk-agent / AsyncOpenAI consumers get a
      // programmatic consumer's error envelope, with the same retry-after).
      // Inert without CLAUDISH_SESSION_BUDGET_*.
      const openaiSessionKey = extractSessionKey(anthropicBody);
      const machineHeader = c.req.header("x-claudish-machine") ?? null;
      {
        const admission = admitSessionBudget(machineHeader, openaiSessionKey, process.env);
        if (admission?.refused) {
          return c.json(
            {
              error: {
                message: admission.message,
                type: "rate_limit_error",
                code: null,
              },
            },
            429,
            { "retry-after": String(admission.retryAfterSec) }
          );
        }
      }

      // Serve through the v14 pipeline + the budget-failover cascade (same
      // loop as /v1/messages since G8; the [Request] log line and the attempt
      // token live inside the loop). Inert with no CLAUDISH_FAILOVER_* env.
      const openaiRole = roleFromModelName(anthropicBody.model);
      const openaiBucket = await requestBucketOf(anthropicBody.model);

      // Inject onset/recovery notices on the Anthropic-shape response BEFORE
      // translation to OpenAI wire shape. #229: this ingress's consumers are
      // programmatic (sk-agent, any AsyncOpenAI client) — the notice rides the
      // response header, NOT the content, so an empty model output stays
      // visibly empty instead of being masked by the notice-as-answer. The
      // wrap never throws.
      let response = await handleWithCascade(c, anthropicBody, anthropicBody.model, openaiBucket);
      response = await applyFailoverNotices(
        response,
        openaiRole,
        openaiSessionKey,
        wantsStream,
        noticePolicyForIngress(c.req.path),
        openaiBucket,
        servedStepForNotices(c, openaiRole) // #431 CR B1: name the step that served
      );

      // Translate the final Anthropic response to OpenAI shape.
      if (!response.ok) {
        // Error: convert the Anthropic error envelope to OpenAI's error shape
        // so an OpenAI SDK can surface it instead of choking on the foreign
        // body.
        let errJson: any;
        try {
          errJson = await response.json();
        } catch {
          errJson = { error: { type: "api_error", message: `upstream HTTP ${response.status}` } };
        }
        const anthropicErr = errJson?.error ?? errJson;
        const oaiErr = {
          error: {
            message: anthropicErr.message ?? `upstream HTTP ${response.status}`,
            type: anthropicErr.type ?? "api_error",
            code: anthropicErr.code ?? null,
          },
        };
        return c.json(oaiErr, response.status as any);
      }

      if (wantsStream) {
        // #229 review: both translations below rebuild their headers from
        // scratch, which is where the notice header set above used to die —
        // consumed (dedup + recovery-budget side effects) then never
        // delivered.
        return carryNoticeHeader(
          response,
          createOpenAIChatStreamFromAnthropic(response, anthropicBody.model)
        );
      }
      const message = await response.json();
      return carryNoticeHeader(
        response,
        c.json(anthropicMessageToChatCompletion(message, anthropicBody.model), {
          headers: { "Content-Type": "application/json" },
        })
      );
    } catch (e) {
      log(`[Proxy] /v1/chat/completions error: ${e}`);
      // Same routing-failure doctrine as /v1/messages, on the OpenAI wire
      // shape this ingress speaks — this route resolves through the same
      // getHandlerForRequest, so the missing-credential throw reaches it too.
      if (isTerminalRoutingFailure(e)) {
        return c.json(
          {
            error: {
              message: redactForClient(e.message),
              type: "invalid_request_error",
              code: null,
            },
          },
          400
        );
      }
      return c.json(
        { error: { message: redactForClient(String(e)), type: "api_error", code: null } },
        500
      );
    }
  });

  // Bun's NATIVE server — not @hono/node-server.
  //
  // claudish only ever runs under Bun (bin/claudish.cjs is a Node bootstrapper
  // that locates bun and re-execs; the CLI uses bun:ffi / Bun.spawn and cannot
  // run on Node), and Hono runs natively on Bun. Using the NODE adapter here was
  // a runtime mismatch that dragged in its Node-compat global polyfills:
  //   - at import:  an unconditional `global.fetch = …` that replaced Bun's
  //                 native fetch with a wrapper (different streaming/abort
  //                 semantics — every proxy outbound request went through it);
  //   - at serve(): `Object.defineProperty(global, "Response"/"Request", …)`,
  //                 a process-global swap to its own classes that broke any
  //                 Bun-native consumer sharing the process.
  // Bun.serve touches no globals, so the whole class of problem is gone rather
  // than patched up afterwards.
  const server = Bun.serve({
    fetch(req, srv) {
      // Capture pipeline (fork extension): remember the direct remote address.
      // It is recorded as the additive `remote` field ONLY — never as `src`,
      // never in the filename, whose vocabulary turn-autopsy's REQ_RE pins to
      // `direct` / the relay pair form (#722 read-back, measured 2026-10-29).
      // (Main's @hono/node-server wrapper read ctx.remoteAddress; Bun.serve
      // exposes the same fact as srv.requestIP — same WeakMap, native API.)
      if (!req.headers.get("x-forwarded-for") && !req.headers.get("x-real-ip")) {
        try {
          const ip = srv.requestIP(req);
          if (ip) hostnameConfig.remoteAddrMap.set(req, ip.address);
        } catch {
          // Address unavailable (unix socket, detached) — capture falls back
          // to "direct", which is what an unattributable source means.
        }
      }
      return app.fetch(req, srv);
    },
    port,
    // Fork extension (#641 G2): configurable bind — the hub and sidecar
    // containers must reach sibling machines ("0.0.0.0"), everything else
    // keeps the loopback default.
    hostname: options.hostname ?? "127.0.0.1",
    // Streamed provider responses can outlive the default idle timeout.
    idleTimeout: 255,
  });

  // Bun types `port` as optional (a unix-socket server has none); for a TCP
  // listen it is always set. `port` 0 means "pick a free one", so read it back.
  const resolvedPort = server.port ?? port;

  log(`[Proxy] Server started on port ${resolvedPort}`);

  // Warm pricing cache in background (non-blocking)
  if (!options.skipBackgroundWarmers) warmPricingCache().catch(() => {});

  // Warm recommended models from Firebase in background (non-blocking)
  if (!options.skipBackgroundWarmers) warmRecommendedModels().catch(() => {});

  // Warm the cloud models catalog in the background (non-blocking). Routing and
  // step 2b read wire ids from it. A request that finds neither a warm nor a
  // cached catalog waits in `ensureCatalogReady`, up to five seconds.
  if (!options.skipBackgroundWarmers)
    warmCatalog().catch(() => {
      // Non-fatal: a cached catalog still answers. With none at all, an explicit
      // spec passes through unchanged and a bare name gets the no-catalog no-route.
    });

  return {
    port: resolvedPort,
    url: `http://127.0.0.1:${resolvedPort}`,
    modelRequestCount: () => modelRequestCount,
    // #641 G2 (fork extension): what a drain script asks before picking its
    // moment — how many streams are still writing. Reads the same registry
    // /health publishes, so the two can never disagree.
    getActiveStreams: () => streamTracker.getActiveStreams(),
    ...(advisorPanel ? { advisorPanel } : {}),
    shutdown: async () => {
      // #631, ported to the Bun.serve stack (#641 G2). On the fork's
      // @hono/node-server the shutdown gate polled each connection's Node
      // handles (`req.complete && !res.writableEnded`): count CONSUMABLE
      // work — a response still being written — and ignore idle keep-alive
      // sockets, which otherwise hold the close callback forever. Bun's
      // `stop(true)` aborts instead of waiting, so the wait moves BEFORE it:
      // poll the stream registry (the same consumable-work registry /health
      // reads — a request counts while its response stream is open) until it
      // drains to zero, THEN stop. The wait is deliberately not bounded here:
      // the container runtime's stop timeout (`stop_grace_period`) is the
      // bound, and a shorter one in code would only re-create the abrupt kill
      // this exists to avoid; standalone-proxy's second signal is the human
      // way out.
      const settleStepMs = 250;
      while (streamTracker.getActiveStreams() > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleStepMs));
      }
      // `true` = close active connections too, so nothing keeps the port
      // alive after shutdown resolves (idle keep-alives included).
      await server.stop(true);
      // The advisor chains were handed over at startup; the proxy owns them.
      if (advisorRuntime) await shutdownAdvisorChains(advisorRuntime.chains.values());
      // "No episode may outlive the process that owns its timers" —
      // `closeAllEpisodes`'s own doc, which until now nothing but tests
      // invoked. `server.stop(true)` aborts the client signals, so waiters
      // unwind and most episodes self-close; the residual that matters is
      // `serve`, which is long-lived and can be shut down and REBUILT
      // in-process, and would otherwise carry a stale episode — and its stale
      // banner — across the rebuild.
      closeAllEpisodes();
    },
    invalidateHandlerCache: (providerSlug?: string) => {
      if (!providerSlug) {
        localProviderHandlers.clear();
        remoteProviderHandlers.clear();
        return;
      }
      // Handler cache keys are model specs like "lmstudio@<model>". Drop
      // any whose left-of-@ matches the slug, plus any using the slug as
      // a legacy prefix (e.g. "ollama/llama3"). Both forms route to the
      // same transport so both need invalidation.
      const matches = (k: string) =>
        k === providerSlug ||
        k.startsWith(`${providerSlug}@`) ||
        k.startsWith(`${providerSlug}/`) ||
        k.startsWith(`${providerSlug}:`);
      for (const k of [...localProviderHandlers.keys()]) {
        if (matches(k)) localProviderHandlers.delete(k);
      }
      for (const k of [...remoteProviderHandlers.keys()]) {
        if (matches(k)) remoteProviderHandlers.delete(k);
      }
    },
  };
}
