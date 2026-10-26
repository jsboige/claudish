import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSseMessage, sseResponseToJson } from "./collect-sse-message.js";
import { createAnthropicPassthroughStream } from "./stream-parsers/anthropic-sse.js";
import { createResponsesStreamHandler } from "./stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "./stream-parsers/openai-sse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../../test-fixtures/sse-responses");

/**
 * Read an SSE fixture file and return as a Response with streaming body.
 * This simulates the HTTP response from a provider API.
 */
function fixtureToResponse(fixturePath: string): Response {
  const content = readFileSync(fixturePath, "utf-8");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send all SSE lines as a single chunk (simulates buffered response)
      controller.enqueue(encoder.encode(content));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Create a minimal mock Hono context for stream parsers. */
function createMockContext(): any {
  let capturedBody: ReadableStream | null = null;
  let capturedInit: any = null;

  return {
    body(stream: ReadableStream, init?: any) {
      capturedBody = stream;
      capturedInit = init;
      return new Response(stream, init);
    },
    getCapturedResponse() {
      return capturedBody ? new Response(capturedBody, capturedInit) : null;
    },
  };
}

function textResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function framesResponse(frames: unknown[], spaceAfterColon = true): Response {
  const prefix = spaceAfterColon ? "data: " : "data:";
  return textResponse(frames.map((frame) => `${prefix}${JSON.stringify(frame)}\n\n`).join(""));
}

function blockTypes(message: Awaited<ReturnType<typeof collectSseMessage>>): unknown[] {
  return message.content.map((block) => block.type);
}

const textTurnFrames = [
  {
    type: "message_start",
    message: {
      id: "msg_prefix",
      model: "prefix-model",
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
];

describe("collectSseMessage real fixture replay", () => {
  test("collects Anthropic passthrough thinking, text, and tool_use blocks", async () => {
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "minimax-m25-turn1-thinking-text-tool.sse")
    );
    const parsed = createAnthropicPassthroughStream(createMockContext(), fixture, {
      modelName: "minimax-m2.5",
    });

    const message = await collectSseMessage(parsed, "minimax-m2.5");

    expect(message.content).toHaveLength(3);
    expect(blockTypes(message)).toEqual(["thinking", "text", "tool_use"]);
    expect(message.stop_reason).toBe("tool_use");
    const tool = message.content[2];
    expect(typeof tool.input).toBe("object");
    expect(tool.input).not.toBeNull();
    expect(Array.isArray(tool.input)).toBe(false);
    expect(tool.input).toHaveProperty("pattern");
  });

  test("collects OpenAI SSE text and tool_use blocks", async () => {
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-openai-tool-call.sse"));
    const { DefaultAPIFormat } = await import("../../adapters/base-api-format.js");
    const parsed = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      new DefaultAPIFormat("test-model"),
      "test-model",
      null
    );

    const message = await collectSseMessage(parsed, "test-model");

    expect(message.content).toHaveLength(2);
    expect(blockTypes(message)).toEqual(["text", "tool_use"]);
    expect(message.stop_reason).toBe("tool_use");
  });

  test("collects OpenAI Responses SSE text and parallel tool_use blocks", async () => {
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gpt-5.6-sol-responses-turn1.sse"));
    const parsed = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });

    const message = await collectSseMessage(parsed, "gpt-5.6-sol");

    expect(message.content).toHaveLength(4);
    expect(blockTypes(message)).toEqual(["text", "tool_use", "tool_use", "tool_use"]);
    expect(message.stop_reason).toBe("tool_use");
  });
});

describe("collectSseMessage data-line prefix tolerance", () => {
  test("collects data lines with a space after the colon", async () => {
    const message = await collectSseMessage(framesResponse(textTurnFrames, true), "fallback");

    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("collects data lines without a space after the colon identically", async () => {
    const spaced = await collectSseMessage(framesResponse(textTurnFrames, true), "fallback");
    const unspaced = await collectSseMessage(framesResponse(textTurnFrames, false), "fallback");

    expect(unspaced).toEqual(spaced);
    expect(unspaced.content).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("collectSseMessage tool arguments", () => {
  test("reassembles fragmented input_json_delta into a parsed object", async () => {
    const message = await collectSseMessage(
      framesResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "Grep", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"pattern":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"*.ts"' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "}" },
        },
      ]),
      "test-model"
    );

    expect(message.content).toEqual([
      { type: "tool_use", id: "tool_1", name: "Grep", input: { pattern: "*.ts" } },
    ]);
  });

  test("keeps a tool_use block with empty input when its JSON is unparseable", async () => {
    const message = await collectSseMessage(
      framesResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_2", name: "Read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":' },
        },
      ]),
      "test-model"
    );

    expect(message.content).toEqual([{ type: "tool_use", id: "tool_2", name: "Read", input: {} }]);
    expect(message.stop_reason).toBe("tool_use");
  });
});

test("collectSseMessage retains a delta for an unregistered block index", async () => {
  const message = await collectSseMessage(
    framesResponse([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "survived truncation" },
      },
    ]),
    "test-model"
  );

  expect(message.content).toEqual([{ type: "text", text: "survived truncation" }]);
});

describe("collectSseMessage stop_reason derivation", () => {
  test("derives tool_use for a tool-only turn with no message_delta", async () => {
    const message = await collectSseMessage(
      framesResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_3", name: "Bash", input: {} },
        },
      ]),
      "test-model"
    );

    expect(message.stop_reason).toBe("tool_use");
    expect(message.stop_reason).not.toBe("tool_reason");
  });

  test("derives end_turn for a text-only turn with no message_delta", async () => {
    const message = await collectSseMessage(
      framesResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
      ]),
      "test-model"
    );

    expect(message.stop_reason).toBe("end_turn");
    expect(message.stop_reason).not.toBeNull();
  });
});

describe("collectSseMessage usage", () => {
  test("picks up message_start usage", async () => {
    const message = await collectSseMessage(
      framesResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 21, output_tokens: 2 } },
        },
      ]),
      "test-model"
    );

    expect(message.usage).toEqual({ input_tokens: 21, output_tokens: 2 });
  });

  test("lets later message_delta usage override message_start usage", async () => {
    const message = await collectSseMessage(
      framesResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 1 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 34, output_tokens: 8 },
        },
      ]),
      "test-model"
    );

    expect(message.usage).toEqual({ input_tokens: 34, output_tokens: 8 });
  });
});

test("collectSseMessage resolves with partial content when the stream stalls", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            `data: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}`,
            `data: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "partial" },
            })}`,
            "",
          ].join("\n\n")
        )
      );
      // Deliberately never close or enqueue another chunk.
    },
  });

  const message = await collectSseMessage(new Response(stream), "test-model", {
    stallTimeoutMs: 50,
  });

  expect(message.content).toEqual([{ type: "text", text: "partial" }]);
  expect(message.stop_reason).toBe("end_turn");
}, 500);

describe("collectSseMessage degenerate input", () => {
  test("resolves a well-formed message for a Response with no body", async () => {
    await expect(collectSseMessage(new Response(null), "fallback-model")).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      model: "fallback-model",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  test("resolves an immediately closed empty stream as an empty end_turn", async () => {
    const message = await collectSseMessage(textResponse(""), "test-model");

    expect(message.content).toEqual([]);
    expect(message.stop_reason).toBe("end_turn");
  });

  test("ignores malformed and non-JSON data lines", async () => {
    const message = await collectSseMessage(
      textResponse('event: message\ndata: not-json\n\ndata: {"type":\n\n'),
      "test-model"
    );

    expect(message.content).toEqual([]);
    expect(message.stop_reason).toBe("end_turn");
  });

  test("ignores DONE markers and blank data lines", async () => {
    const message = await collectSseMessage(
      textResponse("data:\n\ndata: \n\ndata: [DONE]\n\n"),
      "test-model"
    );

    expect(message.content).toEqual([]);
    expect(message.stop_reason).toBe("end_turn");
  });
});

describe("collectSseMessage never-throws contract (#658)", () => {
  test("never throws when the stream REJECTS mid-read — partial content survives", async () => {
    // The never-hang promise lives in the OUTER catch: a socket that dies
    // while the body is being read must not propagate to a `stream: false`
    // caller (notably /compact), which would see an API error instead of a
    // well-formed message. The other tests in this file never reject the
    // reader — this one does. Measured on the trunk: a
    // `catch (err) { throw err; }` mutant passes every other test here, so
    // without this case the guarantee is unpinned.
    // The partial chunk is DELIVERED first and the error raised in `pull`
    // (when the queue is empty): `controller.error()` inside `start` would
    // discard the queued chunk instead, which pins nothing about preservation.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}\n\n'
          )
        );
      },
      pull(controller) {
        controller.error(new Error("upstream socket died mid-read"));
      },
    });
    const res = new Response(body, { status: 200 });

    const msg = await collectSseMessage(res, "m"); // must RESOLVE, not reject

    expect(msg.type).toBe("message");
    expect(msg.content).toEqual([{ type: "text", text: "partial answer" }]);
    expect(msg.stop_reason).toBe("end_turn");
  });
});

test("sseResponseToJson returns the same collected message as JSON", async () => {
  const direct = await collectSseMessage(framesResponse(textTurnFrames), "fallback");
  const response = await sseResponseToJson(framesResponse(textTurnFrames), "fallback");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(JSON.parse(await response.text())).toEqual(direct);
});
