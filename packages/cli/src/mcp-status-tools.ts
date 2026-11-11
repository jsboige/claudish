/**
 * Read-only MCP status/capability surface (#985).
 *
 * Pure formatting + secret-scrubbing helpers, separated from `mcp-server.ts`
 * so the shape (and the "no secret leaves this surface" guarantee) is unit-testable
 * without booting the stdio MCP server. The server supplies the live facts
 * (model map, armed failovers, reset clocks, catalog entry); this module only
 * renders them and refuses to let a secret-shaped value through.
 *
 * Sources of truth (callers):
 *  - model map: `getModelMapping(profile)` (profile-config.ts) — the same object
 *    proxy-server.ts uses to route.
 *  - armed steps / configured/auto: `getActiveFailovers()` + `getFailoverRule(role)`
 *    + `isFailoverActive(role)` (fork/failover.ts).
 *  - reset clocks: `earliestWalledReprobeAt(role)` (fork/failover.ts).
 *  - capabilities: the recommended-model catalog entry (`getRecommendedModels`),
 *    cross-checked with `getDeclaredContextLimit`/`getDerivedContextLimit`
 *    (providers/runtime-providers.ts) for the REAL window vs the claimed one.
 *
 * #993 review: the live-facts gathering for `claudish_status` moved here too
 * (`claudishStatusHandler`) so the "a read never resets what it reads"
 * invariant is unit-testable without booting the stdio MCP server.
 */

import {
  FAILOVER_ROLES,
  earliestWalledReprobeAt,
  ensureFailoverRulesLoaded,
  getActiveFailovers,
  getFailoverRule,
  isAutoArmEnabled,
} from "./fork/failover.js";
import { getModelMapping, loadConfig } from "./profile-config.js";

// A value is never rendered verbatim if it looks like a credential. The read
// surface is additive (status + capabilities); it has no legitimate reason to
// carry an API key, a bearer token, or a proxy key. We scrub by SHAPE, not by
// matching against a known key list, so a future/rotated secret cannot slip.
const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/i, // sk-… (Anthropic, OpenAI, OpenRouter, z.ai)
  /\bsk-ant-[A-Za-z0-9_-]{4,}\b/i,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/i,
  /\bkey-[A-Za-z0-9_-]{8,}\b/i,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{24,}\b/, // JWT
  /\b[0-9a-f]{20,}\.[0-9a-f]{10,}\b/i, // z.ai console key: long-hex id "." long-hex secret
];

// KEY-name shapes are matched by CONTAINMENT, not word boundaries: `_` is a word
// character, so `\bapi…` never fires inside `OPENAI_API_KEY` (#993 review). A key
// whose name merely CONTAINS a credential word carries no value out, whatever it.
const SECRET_KEY_NAME_SHAPES: RegExp[] = [
  /x-api-key|x-proxy-key|authorization|api[_-]?key|proxy[_-]?key|token|secret|credential/i,
];

/**
 * Scrub a single scalar. Numbers/booleans/null pass through; strings are
 * redacted wholesale if any secret shape matches (we never try to partially
 * mask a credential — a half-shown key is still a leak).
 */
export function scrubScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  for (const re of SECRET_SHAPES) {
    if (re.test(value)) return "[redacted]";
  }
  return value;
}

/**
 * Deep-scrub an arbitrary structure before it goes on the wire. Objects and
 * arrays are walked; any string value (or KEY) matching a secret shape is
 * redacted. Returns a new structure — the input is never mutated.
 */
export function scrubForWire<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubForWire(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A credential-named key never carries its value out, whatever the value.
      if (SECRET_KEY_NAME_SHAPES.some((re) => re.test(k))) {
        out[k] = "[redacted]";
      } else {
        out[k] = scrubForWire(v);
      }
    }
    return out as unknown as T;
  }
  return scrubScalar(value) as T;
}

// ─── claudish_status ──────────────────────────────────────────────────────────

export interface StatusRoleInput {
  role: string;
  /** Effective routing target this role maps to (the modelMap entry), if any. */
  nominal?: string;
  /** Configured cascade steps, in order, as routing targets. */
  configuredSteps: string[];
  /** Currently-serving failover step, when the role is diverted. */
  activeStep?: { target: string; stepIndex: number; bucket: string } | null;
  /**
   * Whether this process holds LIVE serving state. False when the in-process
   * proxy never started: the walls/diversions maps were never populated here,
   * so `diverted: false` would be a default, not an answer (#993 review).
   */
  servingKnown: boolean;
  /** Machine-readable reason when servingKnown is false. */
  servingUnknownReason?: string;
  /** Whether auto-arming (CLAUDISH_FAILOVER_AUTO) is on — the REAL flag. */
  auto: boolean;
  /** Next reprobe/reset instant, ISO, if a wall or reset is declared. */
  resetAt?: string | null;
}

export interface StatusInput {
  /** Whose state this is — the status reports a PROCESS, never "the hub". */
  scope: string;
  /** The effective profile name, if known. */
  profile?: string;
  roles: StatusRoleInput[];
}

export interface StatusRoleOutput {
  role: string;
  effective: string | null;
  /**
   * Null (with `servingNote`) when this process has no live serving state —
   * never a defaulted `diverted: false`.
   */
  serving:
    | { target: string; stepIndex: number; bucket: string; diverted: true }
    | { target: string | null; diverted: false }
    | null;
  /** Set exactly when serving is null — why there is no live state here. */
  servingNote: string | null;
  configured: string[];
  auto: boolean;
  resetAt: string | null;
}

export interface StatusOutput {
  surface: string;
  scope: string;
  profile: string | null;
  roles: StatusRoleOutput[];
}

/**
 * Render `claudish_status`: tier → effective provider mapping, armed steps,
 * configured/auto, reset clocks. Read-only — reports, never requisitions.
 */
export function renderStatus(input: StatusInput): StatusOutput {
  const roles = input.roles.map((r) => ({
    role: r.role,
    effective: r.nominal ?? null,
    serving: r.servingKnown
      ? r.activeStep
        ? {
            target: r.activeStep.target,
            stepIndex: r.activeStep.stepIndex,
            bucket: r.activeStep.bucket,
            diverted: true as const,
          }
        : { target: r.nominal ?? null, diverted: false as const }
      : null,
    servingNote: r.servingKnown ? null : (r.servingUnknownReason ?? "unknown"),
    configured: r.configuredSteps,
    auto: r.auto,
    resetAt: r.resetAt ?? null,
  }));
  return scrubForWire({
    surface: "claudish_status",
    scope: input.scope,
    profile: input.profile ?? null,
    roles,
  });
}

/**
 * Gather + render the `claudish_status` payload from THIS process's live state.
 *
 * #993 review contract, load-bearing:
 *  - NEVER calls `initFailover()` — that clears `walled`/`stepFailures`/`dwellPins`
 *    and would un-wall every bucket the in-process proxy (`getProxy()`,
 *    mcp-server.ts) had learned. Rules are parsed read-only through
 *    `ensureFailoverRulesLoaded()` when they were never loaded here; a read must
 *    never reset the thing it reads.
 *  - `scope` names whose state this is: the MCP server's own in-process proxy —
 *    NOT the hub's. When that proxy never started (`proxyStarted: false`),
 *    `serving` is null with a reason, never a defaulted `diverted: false`.
 *  - `auto` comes from the real auto-arm flag (`CLAUDISH_FAILOVER_AUTO`), not
 *    from step counts — a configured cascade is not an auto-arm.
 */
export function claudishStatusHandler(opts: { proxyStarted: boolean }): StatusOutput {
  ensureFailoverRulesLoaded();
  const cfg = loadConfig();
  const mapping = getModelMapping(cfg.defaultProfile);
  const active = getActiveFailovers();
  const roles: StatusRoleInput[] = FAILOVER_ROLES.map((role) => {
    const rule = getFailoverRule(role);
    const serving = active.find((a) => a.role === role);
    const resetAt = earliestWalledReprobeAt(role);
    return {
      role: role as string,
      nominal: mapping[role],
      configuredSteps: rule ? rule.steps.map((s) => s.target) : [],
      activeStep: serving
        ? { target: serving.step.target, stepIndex: serving.stepIndex, bucket: serving.bucket }
        : null,
      servingKnown: opts.proxyStarted,
      servingUnknownReason: opts.proxyStarted ? undefined : "proxy-not-started-in-this-process",
      auto: isAutoArmEnabled(),
      resetAt: resetAt ? resetAt.toISOString() : null,
    };
  });
  return renderStatus({ scope: "mcp-process-proxy", profile: cfg.defaultProfile, roles });
}

// ─── claudish_capabilities ───────────────────────────────────────────────────

export interface CapabilitiesInput {
  model: string;
  /** Provider/routing prefix actually serving the model (e.g. gc@, cx@, or@). */
  provider?: string;
  /** Catalog-declared flags. Absent catalog = "unknown", never a guess. */
  catalog?: {
    vision?: boolean;
    toolUse?: boolean;
    thinking?: boolean;
    context?: string | number;
  } | null;
  /** Operator-DECLARED window (a claim), if any. */
  declaredContextLimit?: number;
  /** Engine-MEASURED window (a fact), if any. */
  derivedContextLimit?: number;
}

export interface CapabilitiesOutput {
  surface: string;
  model: string;
  provider: string | null;
  vision: boolean | null;
  toolUse: boolean | null;
  thinking: boolean | null;
  contextWindow: string | number | null;
  contextWindowSource: "measured" | "declared" | "catalog" | "unknown";
}

/**
 * Render `claudish_capabilities`: vision yes/no, the real context window,
 * tool-use, thinking. The window prefers the MEASURED value over the DECLARED
 * one, and says which it is — a stale claim must never masquerade as a fact.
 */
export function renderCapabilities(input: CapabilitiesInput): CapabilitiesOutput {
  const window =
    input.derivedContextLimit ?? input.declaredContextLimit ?? input.catalog?.context ?? null;
  const windowSource = input.derivedContextLimit
    ? "measured"
    : input.declaredContextLimit
      ? "declared"
      : input.catalog?.context
        ? "catalog"
        : "unknown";
  return scrubForWire({
    surface: "claudish_capabilities",
    model: input.model,
    provider: input.provider ?? null,
    vision: input.catalog?.vision ?? null,
    toolUse: input.catalog?.toolUse ?? null,
    thinking: input.catalog?.thinking ?? null,
    contextWindow: window,
    contextWindowSource: windowSource,
  });
}
