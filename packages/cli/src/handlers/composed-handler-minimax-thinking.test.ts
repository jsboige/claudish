/**
 * #237 review — the MiniMax thinking filter, driven through ComposedHandler.
 *
 * ComposedHandler hands the anthropic-sse parser the MODEL dialect (whose
 * shouldFilterThinking() is true for MiniMax) plus `clientRequestedThinking`,
 * and the parser strips only what the client did not ask for. The parser-level
 * tests in format-translation.test.ts pass that flag directly, so they cannot
 * see how the handler COMPUTES it: an `=== "enabled"` predicate there made an
 * `adaptive` client lose the thinking blocks MiniMax produced for it (MiniMax
 * honors adaptive — live probe 2026-09-23). Non-vacuity: reverting the handler
 * line to `claudeRequest?.thinking?.type === "enabled"` turns the adaptive
 * test red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { ComposedHandler } from "./composed-handler.js";

const MODEL = "MiniMax-M3";

function makeTransport(): ProviderTransport {
  return {
    name: "test-minimax",
    displayName: "Test MiniMax",
    streamFormat: "anthropic-sse",
    overrideStreamFormat: () => "anthropic-sse" as any,
    getEndpoint: () => "http://upstream.test/anthropic/v1/messages",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** What MiniMax streams when it reasons: a thinking block, then the answer. */
function upstreamWithThinking(): Response {
  const body =
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_mm", type: "message", role: "assistant", model: MODEL, content: [],
        stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning here" } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "It's 12:00." } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 1 }) +
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
    sse("message_stop", { type: "message_stop" });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(thinking: unknown): Promise<string> {
  const handler = new ComposedHandler(makeTransport(), MODEL, MODEL, 8472, {
    adapter: new AnthropicAPIFormat(MODEL),
  });
  const payload: any = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "What time is it?" }],
  };
  if (thinking !== undefined) payload.thinking = thinking;
  const app = new Hono();
  app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => upstreamWithThinking();
  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    return await res.text();
  } finally {
    (globalThis as any).fetch = original;
  }
}

describe("MiniMax thinking filter through ComposedHandler (#237 review)", () => {
  const saved = process.env.CLAUDISH_MINIMAX_THINKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
    else process.env.CLAUDISH_MINIMAX_THINKING = saved;
  });

  test("adaptive client receives the thinking blocks it asked for", async () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const body = await run({ type: "adaptive" });
    expect(body).toContain("thinking_delta");
    expect(body).toContain("It's 12:00.");
  });

  test("enabled client receives its thinking blocks", async () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const body = await run({ type: "enabled", budget_tokens: 1024 });
    expect(body).toContain("thinking_delta");
    expect(body).toContain("It's 12:00.");
  });

  test("disabled client gets the answer without the unrequested thinking", async () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const body = await run({ type: "disabled" });
    expect(body).not.toContain("thinking_delta");
    expect(body).toContain("It's 12:00.");
    expect(body).toContain("message_stop");
  });
});
