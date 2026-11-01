/**
 * #783 — a client's thinking OFF reaches the endpoint's own switch.
 *
 * The OpenAI ingress maps a vLLM-style ask (`chat_template_kwargs.enable_thinking`
 * or top-level `enable_thinking`) onto the house `thinking:{type:"disabled"}`
 * block (#435). Before this fix the OUTBOUND side had no writer for vLLM's
 * form: a model served by an endpoint with no dialect — measured case
 * `swift-1.5-27b` on vllm-myia, whose id matches no model family — dropped the
 * block silently, the engine applied its template default (thinking ON), and a
 * client that asked for no reasoning received 135 chars of it anyway (6
 * sk-agent agents on web2 blocked).
 *
 * The rule under pin is "the ask would otherwise be LOST", not "the client
 * asked": an adapter that already encoded the off-switch in the form ITS
 * endpoint reads keeps ownership, and a strict-schema backend
 * (`omitReasoningContent`) is never handed a new top-level field.
 *
 * Pins drive ComposedHandler end-to-end (Hono + stubbed fetch, same harness
 * shape as composed-handler-effort-mapping.test.ts) and assert on the OUTBOUND
 * wire body the transport actually sent.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { BaseAPIFormat } from "../adapters/base-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const MODEL = "swift-1.5-27b";

function makeTransport(wire: "openai-sse" | "anthropic-sse" = "openai-sse"): ProviderTransport {
  return {
    name: "test-vllm",
    displayName: "Test vLLM",
    streamFormat: wire,
    overrideStreamFormat: () => wire as any,
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

/** An adapter that encodes the off-switch itself, as Qwen/GLM dialects do. */
class EncodesItsOwnSwitch extends BaseAPIFormat {
  override prepareRequest(request: any): any {
    request.enable_thinking = false;
    return request;
  }
  processTextContent(textContent: string): any {
    return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
  }
  shouldHandle(): boolean {
    return true;
  }
  getName(): string {
    return "EncodesItsOwnSwitch";
  }
}

/**
 * The binary-`thinking` owner. NOT hypothetical: DeepSeek's dialect writes
 * `request.thinking = {type:"disabled"}` for a client off-switch
 * (deepseek-model-dialect.ts — the 2026-10-22 hub condensation incident) and
 * OpenRouter's format passes `claudeRequest.thinking` through verbatim. The
 * `payload.thinking !== undefined` disjunct is what keeps THIS seam off both —
 * delete it and every DeepSeek PAYG substitution (the cascade's last step)
 * grows a `chat_template_kwargs` it never read about.
 */
class EncodesBinaryThinking extends BaseAPIFormat {
  override prepareRequest(request: any): any {
    request.thinking = { type: "disabled" };
    return request;
  }
  processTextContent(textContent: string): any {
    return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
  }
  shouldHandle(): boolean {
    return true;
  }
  getName(): string {
    return "EncodesBinaryThinking";
  }
}

/** The operator-extra-payload owner: `chat_template_kwargs` set outside the code. */
class EncodesTemplateKwargs extends BaseAPIFormat {
  override prepareRequest(request: any): any {
    // `true` ON PURPOSE: the disjunct's job is to keep an operator-pinned
    // switch even when it CONTRADICTS the client. A `false` fixture makes the
    // pin idempotent — `{...prior, enable_thinking:false}` rewrites the same
    // content and the mutation survives its own deletion (measured).
    request.chat_template_kwargs = { enable_thinking: true };
    return request;
  }
  processTextContent(textContent: string): any {
    return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
  }
  shouldHandle(): boolean {
    return true;
  }
  getName(): string {
    return "EncodesTemplateKwargs";
  }
}

function openaiUpstream(): Response {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body = `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RunOpts {
  effortTarget?: "chat_template_kwargs.reasoning_effort";
  omitReasoningContent?: boolean;
  wire?: "openai-sse" | "anthropic-sse";
  adapter?: BaseAPIFormat;
}

async function run(clientPayload: any, opts?: RunOpts): Promise<any> {
  let wireBody: any;
  const handler = new ComposedHandler(makeTransport(opts?.wire), MODEL, MODEL, 8473, {
    ...(opts?.adapter ? { adapter: opts.adapter } : {}),
    ...(opts?.effortTarget ? { effortTarget: opts.effortTarget } : {}),
    ...(opts?.omitReasoningContent ? { omitReasoningContent: true } : {}),
  });
  const app = new Hono();
  app.post("/v1/messages", async (c: any) => handler.handle(c, clientPayload));
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (...args: any[]) => {
    const [a, b] = args;
    let raw: unknown;
    if (typeof Request !== "undefined" && a instanceof Request) raw = await a.clone().text();
    else raw = b?.body ?? a?.body;
    try {
      wireBody = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      wireBody = raw;
    }
    return openaiUpstream();
  };
  try {
    await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(clientPayload),
      headers: { "content-type": "application/json" },
    });
    return wireBody;
  } finally {
    (globalThis as any).fetch = original;
  }
}

const req = (thinking?: unknown, effort?: string): any => {
  const payload: any = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  };
  if (thinking !== undefined) payload.thinking = thinking;
  if (effort !== undefined) payload.output_config = { effort };
  return payload;
};

describe("ComposedHandler — #783 client thinking OFF on the openai wire", () => {
  test("AC1: a disabled block lands as chat_template_kwargs.enable_thinking=false", async () => {
    const wire = await run(req({ type: "disabled" }));
    expect(wire.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(wire.extra_body).toBeUndefined();
    expect(wire.thinking).toBeUndefined();
  });

  test("AC2: sibling chat_template_kwargs keys are preserved (effort target armed)", async () => {
    const wire = await run(req({ type: "disabled" }, "high"), {
      effortTarget: "chat_template_kwargs.reasoning_effort",
    });
    expect(wire.chat_template_kwargs).toEqual({
      reasoning_effort: "xhigh",
      enable_thinking: false,
    });
  });

  test("AC3: an adapter that already encoded the off-switch keeps ownership (no second spelling)", async () => {
    const wire = await run(req({ type: "disabled" }), { adapter: new EncodesItsOwnSwitch(MODEL) });
    expect(wire.enable_thinking).toBe(false);
    expect(wire.chat_template_kwargs).toBeUndefined();
  });

  test("AC3b: the binary-`thinking` owner (DeepSeek dialect, OpenRouter passthrough) is excluded", async () => {
    const wire = await run(req({ type: "disabled" }), {
      adapter: new EncodesBinaryThinking(MODEL),
    });
    expect(wire.thinking).toEqual({ type: "disabled" });
    expect(wire.chat_template_kwargs).toBeUndefined();
    expect(wire.enable_thinking).toBeUndefined();
  });

  test("AC3c: an operator-pinned chat_template_kwargs wins over the client's ask", async () => {
    const wire = await run(req({ type: "disabled" }), {
      adapter: new EncodesTemplateKwargs(MODEL),
    });
    // The operator armed `true` (the #667 "last writer" doctrine: what the
    // operator armed is not clobbered downstream); the client asked off. The
    // seam leaves the wire alone — no second spelling, no overwrite.
    expect(wire.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test("AC4: no ask, or an enabled ask, writes nothing", async () => {
    expect((await run(req())).chat_template_kwargs).toBeUndefined();
    expect(
      (await run(req({ type: "enabled", budget_tokens: 2048 }))).chat_template_kwargs
    ).toBeUndefined();
  });

  test("AC5: a strict-schema backend (omitReasoningContent) is never handed a new field", async () => {
    const wire = await run(req({ type: "disabled" }), { omitReasoningContent: true });
    expect(wire.chat_template_kwargs).toBeUndefined();
  });

  test("AC6: the anthropic wire is untouched — nothing is added beside the native block", async () => {
    const wire = await run(req({ type: "disabled" }), { wire: "anthropic-sse" });
    expect(wire.chat_template_kwargs).toBeUndefined();
    expect(wire.enable_thinking).toBeUndefined();
  });
});
