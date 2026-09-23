/**
 * MiniMaxModelDialect — Layer 2 dialect for MiniMax models.
 *
 * Handles MiniMax-specific quirks:
 * - Context window: all models are 204,800 tokens
 * - Temperature: must be in (0.0, 1.0] — clamps 0 → 0.01, >1 → 1.0
 * - Thinking: native support via standard `thinking` param; operator policy
 *   via CLAUDISH_MINIMAX_THINKING (see prepareRequest)
 * - Vision: not supported — supportsVision() returns false so ComposedHandler strips images
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import type { PrepareRequestContext } from "./model-dialect.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

/** MiniMax API requires temperature in (0.0, 1.0]. Sourced from MiniMax's published API docs, not per-model. */
const TEMPERATURE_RANGE = { min: 0.01, max: 1.0 } as const;

const DEFAULT_FORCED_BUDGET = 16000;

type MiniMaxThinkingPolicy =
  | { kind: "passthrough" }
  | { kind: "disabled" }
  | { kind: "forced"; budget: number };

/**
 * Read CLAUDISH_MINIMAX_THINKING on every call rather than caching it (same
 * rationale as Qwen/GLM/DeepSeek): the fleet flips this during a budget
 * crunch, and a cached value would need a restart of the proxy that is, at
 * that exact moment, the thing keeping everyone working.
 */
function readThinkingPolicy(): MiniMaxThinkingPolicy {
  const raw = (process.env.CLAUDISH_MINIMAX_THINKING || "").trim().toLowerCase();
  if (!raw || raw === "passthrough" || raw === "client" || raw === "default")
    return { kind: "passthrough" };
  if (raw === "disabled" || raw === "off" || raw === "false") return { kind: "disabled" };
  let m = raw.match(/^forced:(\d+)$/);
  if (m) {
    const budget = Number.parseInt(m[1], 10);
    if (Number.isFinite(budget) && budget > 0) return { kind: "forced", budget };
  } else if (raw === "forced" || raw === "enabled" || raw === "on" || raw === "true") {
    return { kind: "forced", budget: DEFAULT_FORCED_BUDGET };
  }
  log(`[MiniMaxModelDialect] Unrecognized CLAUDISH_MINIMAX_THINKING='${raw}', using 'passthrough'`);
  return { kind: "passthrough" };
}

export class MiniMaxModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation — clamp temperature to MiniMax's accepted range,
   * apply the operator thinking policy.
   *
   * The valid temperature range is the TEMPERATURE_RANGE constant sourced from
   * MiniMax's published API docs. The standard `thinking` parameter is supported
   * natively by MiniMax's Anthropic-compatible endpoint.
   *
   * Unlike Qwen/GLM/DeepSeek (which think BY DEFAULT and need an off switch),
   * MiniMax honors the client's `thinking` value exactly — measured 2026-09-23
   * on mmc@MiniMax-M3: Claude Code sends `{"type":"disabled"}` for every
   * subagent/haiku-role request, the value is forwarded verbatim, and 388/388
   * captured responses contain zero `thinking_delta`. The other lanes look
   * like they think "at xhigh" because CC asks them to; on the haiku lane CC
   * explicitly opts out, so MiniMax never reasons. CLAUDISH_MINIMAX_THINKING
   * makes that a policy rather than a silent client-side accident:
   *
   *   passthrough (default) — send exactly what the client asked for
   *   disabled              — force `thinking: {"type":"disabled"}`
   *   forced[:<n>]          — force `{"type":"enabled","budget_tokens":<n>}`
   *                           (default n=16000) when the client did not itself
   *                           ask for thinking; a client-enabled request keeps
   *                           its own budget untouched
   *
   * Rewrites apply on the anthropic wire only (`ctx.wireFormat ===
   * "anthropic-sse"`): on OpenAI-shaped routings the `thinking` object is not
   * the switch this endpoint reads, so forcing it there is inert noise. As
   * with Qwen, a configured budget that would not fit under max_tokens is not
   * forced for that one request — failing the request would be worse than
   * skipping its reasoning.
   */
  override prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any {
    if (request.temperature !== undefined) {
      if (request.temperature < TEMPERATURE_RANGE.min) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.min} (MiniMax requires >= ${TEMPERATURE_RANGE.min})`
        );
        request.temperature = TEMPERATURE_RANGE.min;
      } else if (request.temperature > TEMPERATURE_RANGE.max) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.max} (MiniMax requires <= ${TEMPERATURE_RANGE.max})`
        );
        request.temperature = TEMPERATURE_RANGE.max;
      }
    }

    const policy = readThinkingPolicy();
    if (ctx?.wireFormat === "anthropic-sse" && policy.kind !== "passthrough") {
      const clientEnabled = originalRequest?.thinking?.type === "enabled";
      const maxTokensRaw = Number(request.max_tokens ?? 0);
      const maxTokensKnown = maxTokensRaw > 0;
      const budgetFits =
        policy.kind === "forced" && (!maxTokensKnown || maxTokensRaw > policy.budget + 1);

      if (policy.kind === "disabled") {
        request.thinking = { type: "disabled" };
        log("[MiniMaxModelDialect] thinking disabled (CLAUDISH_MINIMAX_THINKING=disabled)");
      } else if (clientEnabled) {
        log("[MiniMaxModelDialect] client already requested thinking — leaving its budget untouched");
      } else if (budgetFits) {
        request.thinking = { type: "enabled", budget_tokens: policy.budget };
        log(
          `[MiniMaxModelDialect] thinking forced (client=${originalRequest?.thinking?.type ?? "absent"}), budget ${policy.budget}`
        );
      } else {
        log(
          `[MiniMaxModelDialect] thinking not forced for this request (max_tokens ${maxTokensRaw} <= budget ${policy.budget})`
        );
      }
    }

    return request;
  }

  /**
   * Context window sourced from the model catalog.
   * Defaults to 204,800 (MiniMax standard context) if not in catalog.
   */
  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * MiniMax's Anthropic API does not support image or document content blocks.
   * Returning false causes ComposedHandler to strip/proxy image content.
   * Sourced from model catalog; defaults to false for unrecognized MiniMax models.
   */
  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }

  /**
   * MiniMax's Anthropic-compatible endpoint returns thinking blocks that leak
   * to the user when passed through unrequested. Filter them from the SSE
   * stream — the parser consults this only when the client did NOT itself
   * request thinking (anthropic-sse opts.clientRequestedThinking), so a
   * client that asks for thinking still receives its blocks.
   */
  override shouldFilterThinking(): boolean {
    return true;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "minimax");
  }

  getName(): string {
    return "MiniMaxModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use MiniMaxModelDialect */
export { MiniMaxModelDialect as MiniMaxAdapter };
