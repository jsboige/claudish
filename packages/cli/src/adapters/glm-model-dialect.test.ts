/**
 * GLMModelDialect — #435 ingress-interaction pins.
 *
 * The OpenAI ingress now maps the client's `enable_thinking` /
 * `chat_template_kwargs.enable_thinking` / `reasoning_effort` onto the house
 * `thinking` object (openai-request-to-anthropic.ts). These pins hold the GLM
 * end of that contract on the OpenAI wire (the `gc@` Coding Plan lane the
 * issue was reported on): what the dialect does with each mapped shape.
 *
 * Probe of record (2026-08-20, gc@ glm-5.3, "Reponds exactement: ok"):
 *   no field            → 37 out tokens / 131 reasoning chars (GLM thinks by default)
 *   {type:"disabled"}   →  3 out tokens / 0 reasoning
 * The default policy is `passthrough` — no field set unless someone asked.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { GLMModelDialect } from "./glm-model-dialect.js";

const ORIGINAL = process.env.CLAUDISH_GLM_THINKING;
const ORIGINAL_EFFORT = process.env.CLAUDISH_GLM54_EFFORT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDISH_GLM_THINKING;
  else process.env.CLAUDISH_GLM_THINKING = ORIGINAL;
  if (ORIGINAL_EFFORT === undefined) delete process.env.CLAUDISH_GLM54_EFFORT;
  else process.env.CLAUDISH_GLM54_EFFORT = ORIGINAL_EFFORT;
});

function dialect() {
  return new GLMModelDialect("glm-5.3");
}

const OPENAI = { wireFormat: "openai-sse" as const };

describe("GLM 5.4 effort experiment", () => {
  it("forces the documented high tier for medium on the OpenAI wire", () => {
    process.env.CLAUDISH_GLM54_EFFORT = "medium";
    delete process.env.CLAUDISH_GLM_THINKING;
    const payload: any = { reasoning_effort: "max" };
    new GLMModelDialect("glm-5.4").prepareRequest(payload, { thinking: { type: "adaptive" } }, OPENAI);
    expect(payload.reasoning_effort).toBe("high");
    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("leaves defaults, other models and the Anthropic wire unchanged", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    delete process.env.CLAUDISH_GLM54_EFFORT;
    const normal: any = {};
    new GLMModelDialect("glm-5.4").prepareRequest(normal, {}, OPENAI);
    expect(normal.reasoning_effort).toBeUndefined();
    process.env.CLAUDISH_GLM54_EFFORT = "medium";
    const other: any = {};
    dialect().prepareRequest(other, {}, OPENAI);
    expect(other.reasoning_effort).toBeUndefined();
    const anthropic: any = {};
    new GLMModelDialect("glm-5.4").prepareRequest(anthropic, {}, { wireFormat: "anthropic-sse" });
    expect(anthropic.reasoning_effort).toBeUndefined();
  });

  it("preserves a client's explicit disabled thinking", () => {
    process.env.CLAUDISH_GLM54_EFFORT = "medium";
    delete process.env.CLAUDISH_GLM_THINKING;
    const payload: any = { reasoning_effort: "max" };
    new GLMModelDialect("glm-5.4").prepareRequest(payload, { thinking: { type: "disabled" } }, OPENAI);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("does not override the explicit disabled policy", () => {
    process.env.CLAUDISH_GLM54_EFFORT = "medium";
    process.env.CLAUDISH_GLM_THINKING = "disabled";
    const payload: any = { reasoning_effort: "max" };
    new GLMModelDialect("glm-5.4").prepareRequest(payload, {}, OPENAI);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});

describe("GLMModelDialect — #435 ingress-mapped thinking (OpenAI wire)", () => {
  it("ingress {type:'disabled'} → wire {type:'disabled'} — the 37→3 probe shape", () => {
    delete process.env.CLAUDISH_GLM_THINKING; // passthrough default
    const payload: any = {};
    dialect().prepareRequest(payload, { thinking: { type: "disabled" } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("ingress enabled block → binary {type:'enabled'} (budget dropped — GLM has no budget knob)", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const payload: any = {};
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 8000 } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("no thinking controls sent → no field on the wire (GLM thinks by default — documented passthrough)", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const payload: any = {};
    dialect().prepareRequest(payload, {}, OPENAI);
    expect(payload.thinking).toBeUndefined();
  });

  it("CLAUDISH_GLM_THINKING=disabled overrides even an ingress enabled ask", () => {
    process.env.CLAUDISH_GLM_THINKING = "disabled";
    const payload: any = {};
    dialect().prepareRequest(payload, { thinking: { type: "enabled", budget_tokens: 32000 } }, OPENAI);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });
});
