/**
 * MiniMaxModelDialect — thinking-policy tests.
 *
 * The behavior these pin (measured 2026-09-23 on the hub's haiku lane,
 * mmc@MiniMax-M3): unlike Qwen/GLM/DeepSeek, MiniMax does NOT think by
 * default — it honors the client's `thinking` value exactly. Claude Code
 * sends `{"type":"disabled"}` for every haiku-role/subagent request, the
 * proxy forwarded it verbatim, and 388/388 captured responses carried zero
 * `thinking_delta`: the model never reasoned. `forced` rewrites the outbound
 * request so it does — the response-side filter (parser
 * clientRequestedThinking) keeps the blocks out of a client that did not
 * ask for them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";

const ORIGINAL = process.env.CLAUDISH_MINIMAX_THINKING;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
  else process.env.CLAUDISH_MINIMAX_THINKING = ORIGINAL;
});

function dialect() {
  return new MiniMaxModelDialect("MiniMax-M3");
}

const ANTHROPIC = { wireFormat: "anthropic-sse" as const };
const OPENAI = { wireFormat: "openai-sse" as const };

describe("MiniMaxModelDialect — thinking policy (anthropic wire)", () => {
  it("defaults to passthrough: the client's disabled stays disabled", () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("forced rewrites a client-disabled request to enabled with the default budget", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("forced rewrites an absent thinking field too", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000 };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("forced:<n> carries the configured budget", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced:8000";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("forced leaves a client that already asked for thinking untouched", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced:8000";
    const payload: any = {
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("forced skips when the budget would not fit under max_tokens", () => {
    // Mirrors the Qwen constraint: an endpoint rejecting
    // max_tokens <= budget_tokens must not see the forced value — the request
    // goes out with the client's value rather than failing.
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 8000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("disabled forces the off switch even when the client asked", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "disabled";
    const payload: any = {
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    };
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 4096 } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("MiniMaxModelDialect — policy scope guards", () => {
  it("forced is inert on the OpenAI wire (the `thinking` object is not that wire's switch)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("forced is inert without a wire context (unit-test call shape)", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } });
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("an unrecognized value falls back to passthrough", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "budget:4096";
    const payload: any = { max_tokens: 32000, thinking: { type: "disabled" } };
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, ANTHROPIC);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("MiniMaxModelDialect — temperature clamp still applies", () => {
  it("clamps 0 → 0.01 regardless of thinking policy", () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const payload: any = { max_tokens: 32000, temperature: 0 };
    dialect().prepareRequest(payload, {}, ANTHROPIC);
    expect(payload.temperature).toBe(0.01);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });
});
