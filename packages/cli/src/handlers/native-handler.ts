import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "../auth/credentials/op-source.js";
import { log, maskCredential } from "../logger.js";
import { getApiKey } from "../profile-config.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { createResponseCapture } from "./shared/response-capture.js";
import {
  fetchMultiModelAdvice,
  findPendingAdvisorToolResults,
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  recordAdvisorEventsFromChunk,
  rewriteAdvisorToolResults,
  stripAdvisorBeta,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";
import type { ModelHandler } from "./types.js";

/**
 * Resolve the advisor provider keys through the credential layer (env → config →
 * op://) rather than raw process.env reads, so the multi-model advisor path goes
 * through the single layer like every other signer.
 *
 * openrouter/openai resolve via the authority (their providers sign with a plain
 * API key). google is special: the "google" authority alias is the Gemini Code
 * Assist OAuth credential (an OAuth token, NOT the GEMINI_API_KEY the advisor's
 * direct Gemini call needs), so google resolves the raw GEMINI/GOOGLE_API_KEY
 * through env → config → op:// directly.
 */
async function resolveAdvisorKeys(): Promise<{
  openrouter?: string;
  google?: string;
  openai?: string;
}> {
  const keyFromAuthority = async (name: string): Promise<string | undefined> => {
    try {
      const auth = await credentials.getRequestAuth(name, { model: "" });
      const k = auth.headers.Authorization?.replace(/^Bearer\s+/i, "") || auth.headers["x-api-key"];
      return k || undefined;
    } catch {
      return undefined;
    }
  };
  const geminiKey = async (): Promise<string | undefined> => {
    const local =
      process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || getApiKey("GEMINI_API_KEY");
    if (local) return local;
    if (hasOpSources()) {
      const r = await resolveOpKeyForEnvVars(new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]), {
        onAuthFailure: "skip",
      });
      return r.GEMINI_API_KEY || r.GOOGLE_API_KEY || undefined;
    }
    return undefined;
  };
  const [openrouter, google, openai] = await Promise.all([
    keyFromAuthority("openrouter"),
    geminiKey(),
    keyFromAuthority("openai"),
  ]);
  return { openrouter, google, openai };
}

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    // -------------------------------------------------------------------
    // Advisor-swap experiment (opt-in via CLAUDISH_SWAP_ADVISOR=1).
    // No-op if the env var is unset. See native-handler-advisor.ts.
    //
    // Two-way mutation on each request:
    //   1. Outbound swap: advisor_20260301 server tool → regular tool named
    //      "advisor". Also strips advisor-tool-2026-03-01 beta flag.
    //   2. Inbound rewrite (Stage 2): any tool_result blocks targeting an
    //      advisor tool_use_id we've previously seen in a streamed response
    //      get their error payload replaced with stubbed advisor advice.
    // -------------------------------------------------------------------
    const advisorCfg = loadAdvisorSwapConfig(this.advisorModels, this.advisorCollector);
    let advisorSwapped: ReturnType<typeof swapAdvisorToolInBody> = null;
    let advisorRewrittenIds: string[] = [];
    if (advisorCfg.enabled) {
      // Stage 1: tool-definition swap (outbound).
      advisorSwapped = swapAdvisorToolInBody(payload);
      if (advisorSwapped) {
        log("[Native][advisor-swap] replaced advisor_20260301 with regular tool 'advisor'");
        logAdvisorEvent(advisorCfg, {
          kind: "swap_applied",
          model: target,
          originalTool: advisorSwapped.originalTool,
          regularTool: advisorSwapped.regularTool,
        });
      }

      // Stage 2: tool_result rewrite (inbound). Runs AFTER the Stage-1 swap
      // so it sees the possibly-mutated payload. In practice the two are
      // orthogonal — rewrite looks at messages[].content tool_result blocks,
      // swap looks at tools[].
      if (advisorCfg.models && advisorCfg.models.length > 0) {
        // Multi-model advisor: async pre-fetch from external models
        const pendingIds = findPendingAdvisorToolResults(payload);
        if (pendingIds.length > 0) {
          const adviceMap = new Map<string, string>();
          for (const id of pendingIds) {
            // Resolve advisor provider keys through the credential authority
            // (env → config → op://) — the single source of truth — instead of
            // raw process.env reads. anthropic comes from the inbound request.
            const advisorKeys = await resolveAdvisorKeys();
            const advice = await fetchMultiModelAdvice(
              id,
              payload.messages as any[],
              advisorCfg.models,
              advisorCfg.collector ?? null,
              {
                ...advisorKeys,
                anthropic: originalHeaders["x-api-key"],
              }
            );
            adviceMap.set(id, advice);
          }
          advisorRewrittenIds = rewriteAdvisorToolResults(
            payload,
            (id) => adviceMap.get(id) ?? stubAdvisorAdvice(id)
          );
          if (advisorRewrittenIds.length > 0) {
            log(
              `[Native][advisor] rewrote ${advisorRewrittenIds.length} tool_result(s) with multi-model advice from [${advisorCfg.models.join(", ")}]${advisorCfg.collector ? ` (collector: ${advisorCfg.collector})` : " (no collector)"}`
            );
            logAdvisorEvent(advisorCfg, {
              kind: "multi_model_rewrite",
              ids: advisorRewrittenIds,
              models: advisorCfg.models,
              collector: advisorCfg.collector,
              model: target,
            });
          }
        }
      } else {
        // Legacy: stub advice (env var mode)
        advisorRewrittenIds = rewriteAdvisorToolResults(payload, stubAdvisorAdvice);
        if (advisorRewrittenIds.length > 0) {
          log(
            `[Native][advisor-swap] rewrote ${advisorRewrittenIds.length} error tool_result(s) with stub advice: ${advisorRewrittenIds.join(", ")}`
          );
          logAdvisorEvent(advisorCfg, {
            kind: "tool_result_rewritten",
            ids: advisorRewrittenIds,
            model: target,
          });
        }
      }

      // Dump request body (trimmed) so we can inspect follow-ups that carry
      // tool_result blocks — critical evidence for Stage 2 debugging.
      if (advisorCfg.dumpBodies) {
        logAdvisorEvent(advisorCfg, {
          kind: "request_body",
          swapApplied: !!advisorSwapped,
          rewrittenIds: advisorRewrittenIds,
          model: target,
          body: trimForLog(payload),
        });
      }
    }

    log("\n=== [NATIVE] Claude Code → Anthropic API Request ===");
    log(
      `[Native] x-api-key: ${originalHeaders["x-api-key"] ? maskCredential(originalHeaders["x-api-key"]) : "(not set)"}`
    );
    log(
      `[Native] authorization: ${originalHeaders.authorization ? maskCredential(originalHeaders.authorization) : "(not set)"}`
    );
    log(`Request body (Model: ${target}):`);
    log("=== End Request ===\n");

    // Build headers - pass through auth headers exactly as received
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": originalHeaders["anthropic-version"] || "2023-06-01",
    };

    // Pass through auth headers as-is. If the incoming request carries NO auth
    // (e.g. the --probe client, which doesn't replicate Claude Code's injected
    // key) fall back to the api key this handler was constructed with, so the
    // native passthrough can still authenticate against api.anthropic.com.
    if (originalHeaders.authorization) {
      headers.authorization = originalHeaders.authorization;
    }
    if (originalHeaders["x-api-key"]) {
      headers["x-api-key"] = originalHeaders["x-api-key"];
    }
    if (!originalHeaders.authorization && !originalHeaders["x-api-key"]) {
      // No inbound auth → fall back to the construction-time key, else resolve
      // ANTHROPIC_API_KEY through the credential authority (env → config → op://),
      // so even the native fallback is sourced from the single layer.
      let fallbackKey = this.apiKey;
      if (!fallbackKey) {
        const auth = await credentials.getRequestAuth("native-anthropic", { model: target });
        fallbackKey = auth.headers["x-api-key"];
      }
      if (fallbackKey) {
        headers["x-api-key"] = fallbackKey;
      }
    }
    if (originalHeaders["anthropic-beta"]) {
      const incomingBeta = originalHeaders["anthropic-beta"];
      if (advisorSwapped) {
        // When we swap the advisor tool we must also strip the matching beta
        // flag; otherwise Anthropic rejects the request (beta enabled but no
        // matching server tool declared).
        const { stripped, changed } = stripAdvisorBeta(incomingBeta);
        if (changed) {
          log(
            `[Native][advisor-swap] stripped advisor-tool beta; before=${incomingBeta} after=${stripped ?? "(empty)"}`
          );
          logAdvisorEvent(advisorCfg, {
            kind: "beta_stripped",
            before: incomingBeta,
            after: stripped ?? "",
          });
        }
        if (stripped) headers["anthropic-beta"] = stripped;
      } else {
        headers["anthropic-beta"] = incomingBeta;
      }
    }

    // Execute fetch
    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const contentType = anthropicResponse.headers.get("content-type") || "";

      // Handle streaming
      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        const cap = createResponseCapture("native", target);
        return c.body(
          new ReadableStream({
            async start(controller) {
              const reader = anthropicResponse.body?.getReader();
              if (!reader) throw new Error("No reader");

              const decoder = new TextDecoder();
              let buffer = "";
              let eventLog = "";

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  cap.tap(value);
                  controller.enqueue(value);

                  // Basic logging
                  const chunkText = decoder.decode(value, { stream: true });
                  buffer += chunkText;
                  // Advisor tap: extract any advisor tool_use ids and record
                  // stream events to the log (no-op when disabled).
                  recordAdvisorEventsFromChunk(advisorCfg, chunkText);
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) if (line.trim()) eventLog += `${line}\n`;
                }
                if (eventLog) log(eventLog);
                cap.note("reader done");
                cap.done({ closed: true, reason: "done" });
                controller.close();
              } catch (e) {
                log(`[Native] Stream Error: ${e}`);
                cap.note(`stream error: ${String(e)}`);
                cap.done({ closed: true, reason: "error", err: String(e) });
                controller.close();
              }
            },
          }),
          {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "anthropic-version": "2023-06-01",
            },
          }
        );
      }

      // Handle JSON
      const data = await anthropicResponse.json();
      log("\n=== [NATIVE] Response ===");
      log(JSON.stringify(data, null, 2));

      // Advisor tap for the non-streaming branch (mostly for title-classifier
      // calls on Haiku which return JSON). Picks up any advisor tool_use ids
      // we might miss in SSE.
      if (advisorCfg.enabled) {
        try {
          recordAdvisorEventsFromChunk(advisorCfg, JSON.stringify(data));
        } catch {
          // ignore scan failures — logging-only
        }
      }

      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (anthropicResponse.headers.has("anthropic-version")) {
        responseHeaders["anthropic-version"] = anthropicResponse.headers.get("anthropic-version")!;
      }

      return c.json(data, { status: anthropicResponse.status as any, headers: responseHeaders });
    } catch (error) {
      log(`[Native] Fetch Error: ${error}`);
      return c.json(wrapAnthropicError(500, String(error)), 500);
    }
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}

/**
 * Produces a logging-friendly copy of a request payload. Trims long text
 * fields (system prompts can exceed 30KB) so the advisor-swap log stays
 * readable. Preserves block structure so you can still inspect the shape
 * of tool_use / tool_result / server_tool_use blocks.
 */
function trimForLog(payload: any): any {
  const TEXT_TRUNC = 400;
  const clone = structuredClone(payload);
  const trimStr = (s: string) =>
    typeof s === "string" && s.length > TEXT_TRUNC
      ? `${s.slice(0, TEXT_TRUNC)}… [+${s.length - TEXT_TRUNC} chars]`
      : s;
  const walk = (v: any): any => {
    if (typeof v === "string") return trimStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(clone);
}
