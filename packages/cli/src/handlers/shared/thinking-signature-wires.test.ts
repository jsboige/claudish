/**
 * What each COMPOSED wire SENDS when the history holds a Claudish-carried
 * thinking block — the writer side of #1208 (grain 2).
 *
 * Grain 1 (#1221) guards the NATIVE wire: `NativeHandler` strips a block whose
 * signature is namespaced `claudish-carried:v1:` before the payload leaves for
 * api.anthropic.com, because a non-empty foreign signature 400s there. That left
 * one question open for every OTHER wire: is the marker kept there? A `keep` is
 * only legitimate when the backend's answer to a request WITH the block has been
 * measured. None has — so the rule under test is the conservative one:
 *
 *   on every Anthropic-format wire that is not Codex, a carried block is
 *   REMOVED; on the OpenAI-format wire it is REWRITTEN (its text becomes
 *   `reasoning_content`, the signature is never read). No wire forwards the
 *   marker.
 *
 * Every assertion below is taken on the OUTGOING BODY the handler hands to
 * fetch — never on the client's request, which is where a pin would pass for
 * the wrong reason. The backend is a stub answering a short 200: this measures
 * what Claudish writes, not what any backend accepts (AC-W4), and spends no
 * token.
 *
 * Rows of the table measured on 2026-11-27 (issue #1208, writer AC):
 *   MiniMax direct (default)      removed
 *   MiniMax direct (`forced`)     removed — MiniMax's OWN block of the same turn kept
 *   Kimi direct                   removed
 *   Z.AI (Anthropic-compatible)   removed
 *   GLM on the OpenAI wire        rewritten
 *   DeepSeek (OpenAI wire)        rewritten
 *   Anthropic native              removed — pinned in thinking-signature.test.ts
 *   Codex (API Responses)         rewritten into a `reasoning` item — grain 3
 *   Relay passthrough             forwarded raw to the hub, which applies this table
 *
 * The relay row is read in the source (`fork/server/relay.ts`), not pinned here.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { ProviderTransport } from "../../providers/transport/types.js";
import { AnthropicAPIFormat } from "../../adapters/anthropic-api-format.js";
import { OpenAIAPIFormat } from "../../adapters/openai-api-format.js";
import { DialectManager } from "../../adapters/dialect-manager.js";
import type { BaseAPIFormat } from "../../adapters/base-api-format.js";
import { ComposedHandler } from "../composed-handler.js";
import { installStubFetch } from "../../test-support/stub-fetch.js";
import { CARRIED_SIGNATURE_PREFIX } from "./thinking-signature.js";

type Wire = "anthropic-sse" | "openai-sse";

/** A payload-shaped opaque blob, as the Codex lane will carry it (grain 3). */
const CARRIED = `${CARRIED_SIGNATURE_PREFIX}gAAAAABofQc9c3VwZXJTeWNyZXQtYmxvYg`;
/** The digest MiniMax signs its own thinking with (`7caa0d3c…` in the fixtures). */
const MINIMAX_OWN =
  "7caa0d3cc2a449ac1cc68507504693f566245c7b5db3558f6041585e15a848f8";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function anthropicTail(): string {
  return (
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: "probe",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }) +
    sse("message_stop", { type: "message_stop" })
  );
}

function openaiTail(): string {
  return (
    'data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
    'data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  );
}

function makeTransport(wire: Wire): ProviderTransport {
  return {
    name: "probe",
    displayName: `Probe ${wire}`,
    streamFormat: wire,
    overrideStreamFormat: () => wire as ProviderTransport["streamFormat"],
    getEndpoint: () => "http://upstream.test/v1/messages",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

/**
 * The history a Claude Code client echoes back after a turn that switched
 * provider: `user` · `assistant[ thinking(signature), text ]` · `user`.
 */
function makePayload(signatures: string[]): Record<string, unknown> {
  const content: Record<string, unknown>[] = signatures.map((signature, i) => ({
    type: "thinking",
    thinking: `reasoning ${i}`,
    signature,
  }));
  content.push({ type: "text", text: "answer" });
  return {
    model: "probe",
    max_tokens: 1024,
    stream: true,
    messages: [
      { role: "user", content: "say ok" },
      { role: "assistant", content },
      { role: "user", content: "say ok again" },
    ],
  };
}

interface Sent {
  /** the JSON body the handler handed to fetch */
  body: Record<string, unknown>;
  /** the caller's history object, AFTER the call */
  history: unknown;
}

/** Runs ONE request through a real ComposedHandler and returns what it wrote.
 *  `reuse` hands the SAME history object a previous call already went through. */
async function send(
  model: string,
  wire: Wire,
  signatures: string[],
  env: Record<string, string> = {},
  reuse?: Record<string, unknown>,
): Promise<Sent> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let body: Record<string, unknown> | null = null;
  const restore = installStubFetch(async (req) => {
    body = JSON.parse(await req.text()) as Record<string, unknown>;
    return new Response(wire === "anthropic-sse" ? anthropicTail() : openaiTail(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const adapter =
      wire === "anthropic-sse" ? new AnthropicAPIFormat(model) : new OpenAIAPIFormat(model);
    const handler = new ComposedHandler(makeTransport(wire), model, model, 8472, {
      adapter,
    } as never);
    const payload = reuse ?? makePayload(signatures);
    const app = new Hono();
    app.post("/v1/messages", (ctx) => handler.handle(ctx, payload as never));
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    await res.text();
    if (!body) throw new Error("the handler never called fetch: nothing was measured");
    return { body, history: payload.messages };
  } finally {
    restore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Block types of every assistant turn of the body, one string per turn. */
function assistantShapes(body: Record<string, unknown>): string[] {
  return (body.messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === "assistant")
    .map((m) =>
      Array.isArray(m.content) ? m.content.map((b: { type: string }) => b.type).join(",") : "?",
    );
}

describe("#1208 grain 2 — a carried thinking block on the composed wires", () => {
  describe("Anthropic-format wire: removed", () => {
    test("MiniMax direct, default policy: the carried block is removed", async () => {
      const { body } = await send("MiniMax-M3", "anthropic-sse", [CARRIED]);
      expect(JSON.stringify(body)).not.toContain("claudish-carried");
      expect(assistantShapes(body)).toEqual(["text"]);
    });

    test("MiniMax direct under `forced`: removed, and MiniMax's OWN block of the same turn is kept", async () => {
      const { body } = await send("MiniMax-M3", "anthropic-sse", [MINIMAX_OWN, CARRIED], {
        CLAUDISH_MINIMAX_THINKING: "forced",
      });
      expect(JSON.stringify(body)).not.toContain("claudish-carried");
      expect(assistantShapes(body)).toEqual(["thinking,text"]);
      const turn = (body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)
        .find((m) => m.role === "assistant");
      const thinking = turn?.content.find((b) => b.type === "thinking");
      // the survivor is the model's own reasoning, signature intact — never the carrier
      expect(thinking?.signature).toBe(MINIMAX_OWN);
      expect(thinking?.thinking).toBe("reasoning 0");
    });

    test("Kimi direct: removed (the wire carries no dialect exemption)", async () => {
      const { body } = await send("kimi-k2-0905-preview", "anthropic-sse", [CARRIED]);
      expect(JSON.stringify(body)).not.toContain("claudish-carried");
      expect(assistantShapes(body)).toEqual(["text"]);
    });

    test("Z.AI, Anthropic-compatible: removed", async () => {
      const { body } = await send("glm-5.3", "anthropic-sse", [CARRIED]);
      expect(JSON.stringify(body)).not.toContain("claudish-carried");
      expect(assistantShapes(body)).toEqual(["text"]);
    });
  });

  describe("OpenAI-format wire: rewritten, the signature never read", () => {
    test("GLM: the block's TEXT becomes reasoning_content, the marker is dropped", async () => {
      const { body } = await send("glm-4.6", "openai-sse", [CARRIED]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("claudish-carried");
      // no block shape survives on this wire, so no `signature` key is written at all
      expect(serialized).not.toContain('"signature"');
      const turn = (body.messages as Array<Record<string, unknown>>).find(
        (m) => m.role === "assistant",
      );
      expect(turn?.content).toBe("answer");
      // Measured fact, and the open point of the writer AC: what the writer puts in
      // `thinking` is what a third-party backend receives as its own past reasoning.
      expect(turn?.reasoning_content).toBe("reasoning 0");
    });

    test("DeepSeek (preserveThinkingInHistory = true): rewritten the same way", async () => {
      const { body } = await send("deepseek-chat", "openai-sse", [CARRIED]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("claudish-carried");
      expect(serialized).not.toContain('"signature"');
      const turn = (body.messages as Array<Record<string, unknown>>).find(
        (m) => m.role === "assistant",
      );
      expect(turn?.content).toBe("answer");
      expect(turn?.reasoning_content).toBe("reasoning 0");
    });
  });

  describe("AC-W1 — no dialect may start keeping the marker unmeasured", () => {
    // A row of the table changes the day a dialect answers
    // `preserveThinkingInHistory() = true` on an Anthropic-format wire: the strip
    // loop is skipped for the whole history and the marker leaves as-is. No
    // backend answer backs that, so the census below is what makes it visible.
    const dialects = (): BaseAPIFormat[] =>
      (new DialectManager("probe") as unknown as { adapters: BaseAPIFormat[] }).adapters;
    const carriedBlock = { type: "thinking", thinking: "reasoning 0", signature: CARRIED };

    test("exactly one registered dialect keeps history thinking, and it is DeepSeek", () => {
      const keepers = dialects()
        .filter((d) => d.preserveThinkingInHistory())
        .map((d) => d.getName());
      expect(keepers).toEqual(["DeepSeekModelDialect"]);
    });

    test("every registered dialect sees the SAME census (no dialect is left unvisited)", () => {
      // Guards the pin above against a vacuous pass: the census is the registry.
      const names = dialects().map((d) => d.getName());
      expect(new Set(names).size).toBe(names.length);
      for (const expected of [
        "GrokModelDialect",
        "GeminiAPIFormat",
        "CodexAPIFormat",
        "OpenAIAPIFormat",
        "QwenModelDialect",
        "MiniMaxModelDialect",
        "DeepSeekModelDialect",
        "GLMModelDialect",
        "XiaomiModelDialect",
      ]) {
        expect(names).toContain(expected);
      }
    });

    test("no registered dialect exempts a CARRIED block from the strip, under any policy", () => {
      for (const policy of [undefined, "forced", "effort", "default-effort"]) {
        const saved = process.env.CLAUDISH_MINIMAX_THINKING;
        try {
          if (policy === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
          else process.env.CLAUDISH_MINIMAX_THINKING = policy;
          const keepers = dialects()
            .filter((d) => d.preserveThinkingBlock(carriedBlock))
            .map((d) => `${d.getName()} (CLAUDISH_MINIMAX_THINKING=${policy})`);
          expect(keepers).toEqual([]);
        } finally {
          if (saved === undefined) delete process.env.CLAUDISH_MINIMAX_THINKING;
          else process.env.CLAUDISH_MINIMAX_THINKING = saved;
        }
      }
    });
  });

  describe("AC-W3 — an intermediate wire never rewrites the client's store", () => {
    // A cascade walk Codex → MiniMax → Codex replays the SAME history object
    // through each step. The store is the client's: a step may remove the carried
    // block from the body IT sends, and must leave the object the next step reads
    // intact. (The Codex legs themselves are grain 3; what is pinned here is that
    // the composed step in between is not the one that loses the material.)
    //
    // MEASURED 2026-11-27, and worth knowing before reading a mutation report: the
    // property is protected by TWO redundant sites — the deep clone at the composed
    // entry (`transformOpenAIToClaude`, transform.ts: `JSON.parse(JSON.stringify(…))`)
    // and the per-message copy of `AnthropicAPIFormat.stripUnsupportedContentTypes`.
    // Remove either one alone and this pin stays green, because the other still
    // holds; it goes red only when BOTH are removed (measured: 9 pass / 1 fail, this
    // test the only one). A single-site survivor here is redundancy at work, not a
    // pin that cannot fail.
    test("after a MiniMax turn and an OpenAI-wire turn, the SAME history object still carries the block", async () => {
      const store = makePayload([CARRIED]);
      const before = JSON.parse(JSON.stringify(store.messages));
      // one store, walked through the two intermediate wires in turn
      const mini = await send("MiniMax-M3", "anthropic-sse", [CARRIED], {}, store);
      const glm = await send("glm-4.6", "openai-sse", [CARRIED], {}, store);
      // removed on BOTH wires…
      expect(JSON.stringify(mini.body)).not.toContain("claudish-carried");
      expect(JSON.stringify(glm.body)).not.toContain("claudish-carried");
      // …and still present, untouched, in the store both were handed
      expect(store.messages).toEqual(before);
      expect(store.messages).toBe(mini.history);
      expect(store.messages).toBe(glm.history);
    });
  });
});
