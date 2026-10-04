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

/** What MiniMax streams when it reasons: a thinking block, then the answer.
 *  `withSignature` adds the signature_delta M3 emits after its thinking —
 *  the part the client needs to legally echo the block back (#295). */
function upstreamWithThinking(withSignature = false): Response {
  const signature =
    (withSignature ? sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc123" } }) : "");
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
    signature +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "It's 12:00." } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 1 }) +
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
    sse("message_stop", { type: "message_stop" });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(thinking: unknown, withSignature = false): Promise<string> {
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
  (globalThis as any).fetch = async () => upstreamWithThinking(withSignature);
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

describe("forced policy passes thinking blocks through (#295 chain)", () => {
  const saved = process.env.CLAUDISH_MINIMAX_THINKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
    else process.env.CLAUDISH_MINIMAX_THINKING = saved;
  });

  // The chain, as bisected live in #295: M3 only (re)starts thinking on a
  // tool-continuation turn when the preceding assistant turn carries its
  // preserved thinking block (T4c). Under `forced` the proxy makes the model
  // think for a client that did not ask — so the response's thinking block
  // (and its signature, without which the client cannot legally echo it)
  // must REACH the client, or it can never hold, echo, and restart the chain.
  test("forced + client silent: the thinking block and signature reach the client", async () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const body = await run(undefined, true);
    expect(body).toContain("thinking_delta");
    expect(body).toContain("signature_delta");
    expect(body).toContain("sig-abc123");
    expect(body).toContain("It's 12:00.");
    expect(body).toContain("message_stop");
  });

  test("forced:n budget variant behaves the same", async () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced:8000";
    const body = await run(undefined);
    expect(body).toContain("thinking_delta");
    expect(body).toContain("message_stop");
  });

  // The filter's original purpose stands when the policy is NOT forced:
  // passthrough + silent client still strips the unrequested thinking
  // (the leak this filter exists for, unchanged by #295).
  test("passthrough policy + silent client: unrequested thinking still stripped", async () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const body = await run(undefined);
    expect(body).not.toContain("thinking_delta");
    expect(body).toContain("It's 12:00.");
    expect(body).toContain("message_stop");
  });
});

// #324 B1 — the SECOND filter of the #295 chain: the RETURN trip. #295 let a
// `forced` response carry its thinking block to the client; ComposedHandler's
// history strip (the preserveThinkingInHistory gate) then removed the block
// the client echoed back before it reached M3 — measured by the coordinator
// with a disposable probe: `FORWARDED assistant[1] block types: ["tool_use"]`.
// These tests run the two-turn route and inspect the UPSTREAM REQUEST BODY
// (what the stubbed fetch actually received), not the client-facing SSE.
//
// Signature shapes are the production ones: M3's implicit signature is the
// SHA-256 of the empty string (fixtures minimax-m3-anthropic-implicit-
// signature r10324/r10416); an Anthropic signature is a long opaque base64
// blob (the cascade-switch foreign block: an Opus session that fell to a
// MiniMax step carries those in its history).
const M3_SIG = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ANTHROPIC_BLOB =
  "Eo8BCpoKBgcKBWRvbGxhEgxPcmljZSB0b2tlbjKgAZf2hkh6gH0S2kJDZm9vYmFyYmF6cXV1eDNjdmJubWw4cHl0enIxOXF3dHFvcnN0dXYzeHl6MjBzdHJpbmdfZm9vYmFy";

function upstreamPlainText(): Response {
  const body =
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_mm2", type: "message", role: "assistant", model: MODEL, content: [],
        stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
    sse("message_stop", { type: "message_stop" });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Drive ONE payload through a fresh ComposedHandler with the M3-signature
 *  upstream (turn-1 shape) or a plain answer (turn-2 shape), capturing every
 *  upstream REQUEST body the stubbed fetch received. */
async function runCaptured(payload: any, upstream: () => Response): Promise<any[]> {
  const handler = new ComposedHandler(makeTransport(), MODEL, MODEL, 8472, {
    adapter: new AnthropicAPIFormat(MODEL),
  });
  const upstreamBodies: any[] = [];
  const app = new Hono();
  app.post("/v1/messages", async (c: any) => handler.handle(c, payload));
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: any }) => {
    upstreamBodies.push(JSON.parse(init?.body));
    return upstream();
  };
  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    await res.text();
  } finally {
    (globalThis as any).fetch = original;
  }
  return upstreamBodies;
}

/** All thinking blocks in the upstream request body, across assistant turns. */
function upstreamThinkingBlocks(upstreamBody: any): any[] {
  const blocks: any[] = [];
  for (const msg of upstreamBody?.messages ?? []) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) if (block.type === "thinking") blocks.push(block);
    }
  }
  return blocks;
}

describe("forced history round-trip: the echoed M3 block reaches the upstream (#324 B1)", () => {
  const saved = process.env.CLAUDISH_MINIMAX_THINKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
    else process.env.CLAUDISH_MINIMAX_THINKING = saved;
  });

  // The two-turn chain: turn 1 hands the block (and its signature) to the
  // client; turn 2 is what the client sends back once it holds the block —
  // assistant [thinking(M3 sig), tool_use] + the tool_result turn. The strip
  // used to remove the thinking block here, so M3 never saw its own block
  // and fell back to the mute T4a shape.
  test("turn 2 upstream body carries the echoed M3 thinking block, signature included", async () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const turn2: any = {
      model: MODEL,
      max_tokens: 32000,
      stream: true,
      messages: [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "the user asks the time; call the clock tool", signature: M3_SIG },
            { type: "tool_use", id: "toolu_1", name: "clock", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }] },
      ],
    };
    const bodies = await runCaptured(turn2, upstreamPlainText);
    expect(bodies.length).toBe(1);
    const thinking = upstreamThinkingBlocks(bodies[0]);
    expect(thinking.length).toBe(1);
    expect(thinking[0].signature).toBe(M3_SIG);
    expect(thinking[0].thinking).toBe("the user asks the time; call the clock tool");
    // The forced policy is active on this request too (end-to-end chain), and
    // the sibling blocks survive structurally.
    expect(bodies[0].thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
    const assistant = bodies[0].messages.find((m: any) => m.role === "assistant");
    expect(assistant.content.map((b: any) => b.type)).toEqual(["thinking", "tool_use"]);
  });

  // The strip's raison d'être: a FOREIGN thinking block (Anthropic blob
  // signature, the cascade-switch shape — Opus session fell to a MiniMax
  // step) is still removed, while M3's own block in the same history
  // survives. Signature shape is the discriminant, not blanket preservation.
  test("a foreign Anthropic-signed block in the same history is still stripped under forced", async () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const history: any = {
      model: MODEL,
      max_tokens: 32000,
      stream: true,
      messages: [
        { role: "user", content: "Draft a plan" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "opus reasoning that predates the switch", signature: ANTHROPIC_BLOB },
            { type: "text", text: "Plan v1" },
          ],
        },
        { role: "user", content: "Refine it with the clock" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "call the clock tool", signature: M3_SIG },
            { type: "tool_use", id: "toolu_2", name: "clock", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "12:00" }] },
      ],
    };
    const bodies = await runCaptured(history, upstreamPlainText);
    const thinking = upstreamThinkingBlocks(bodies[0]);
    expect(thinking.length).toBe(1);
    expect(thinking[0].signature).toBe(M3_SIG);
    expect(JSON.stringify(bodies[0])).not.toContain("opus reasoning that predates the switch");
    expect(JSON.stringify(bodies[0])).not.toContain(ANTHROPIC_BLOB);
  });

  // Unsigned blocks are M2.5's own shape (m25 turns 2-3 carry no signature)
  // and Anthropic never emits unsigned thinking — preserve them.
  test("an unsigned MiniMax block (m25 turn-2/3 shape) also survives the strip", async () => {
    process.env.CLAUDISH_MINIMAX_THINKING = "forced";
    const history: any = {
      model: MODEL,
      max_tokens: 32000,
      stream: true,
      messages: [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "unsigned m25 reasoning" },
            { type: "text", text: "It's 12:00." },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    };
    const bodies = await runCaptured(history, upstreamPlainText);
    const thinking = upstreamThinkingBlocks(bodies[0]);
    expect(thinking.length).toBe(1);
    expect(thinking[0].thinking).toBe("unsigned m25 reasoning");
  });

  // Unforced policies keep today's behavior exactly: everything stripped.
  test("passthrough policy: the echoed M3 block is still stripped (unchanged default)", async () => {
    delete process.env.CLAUDISH_MINIMAX_THINKING;
    const history: any = {
      model: MODEL,
      max_tokens: 32000,
      stream: true,
      messages: [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "the user asks the time; call the clock tool", signature: M3_SIG },
            { type: "tool_use", id: "toolu_1", name: "clock", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }] },
      ],
    };
    const bodies = await runCaptured(history, upstreamPlainText);
    expect(upstreamThinkingBlocks(bodies[0]).length).toBe(0);
  });
});
