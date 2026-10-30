/**
 * Frame coherence — the SSE `event:` line and the JSON `type` must agree.
 *
 * THE DEFECT (measured 2026-10-30, local reproduction, no paid probe):
 * the Anthropic client SDK (Python 0.84.0 AND 0.87.0 — identical verdicts)
 * reads a streamed frame as a PAIR. The SDK fills a MISSING `type` from the
 * event name, so a frame with no `type` is harmless; a frame whose `type`
 * DISAGREES with the event name is not:
 *
 *   event: content_block_delta + {"type":"message_delta", …}
 *     → AttributeError: 'NoneType' object has no attribute 'output_tokens'
 *       — the SDK read a message_delta and found no `usage`. THE TURN DIES.
 *   event: content_block_delta + {"type":"thinking_delta", …}   (hors union)
 *     → frame silently dropped → the answer arrives EMPTY, no error anywhere.
 *   data: {…} with no `event:` line, or an unknown event name
 *     → frame silently dropped → the answer arrives EMPTY, no error anywhere.
 *
 * The proxy RELAYED every one of those frames unchanged: it is the last hop
 * before the client, and it forwarded an incoherent pair without a murmur.
 *
 * THE REPAIR: the `event:` line is the frame's kind; the JSON `type` is
 * aligned to it. When the event name is absent or unknown, the JSON `type`
 * provides it. A frame carrying neither is relayed unchanged — we never drop
 * a frame we cannot interpret. A frame that is ALREADY coherent is relayed
 * byte-for-byte.
 *
 * Run: bun test packages/cli/src/handlers/shared/stream-parsers/anthropic-sse-frame-coherence.test.ts
 */

import { describe, expect, it } from "bun:test";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";
import {
  ANTHROPIC_STREAM_EVENTS,
  parseEventName,
  reconcileFrame,
} from "./frame-coherence.js";

function mockContext() {
  return {
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  } as any;
}

const sseResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const stripPingFrames = (wire: string): string =>
  wire.replaceAll('event: ping\ndata: {"type":"ping"}\n\n', "");

const run = async (frames: string[]): Promise<string> => {
  const res = await createAnthropicPassthroughStream(
    mockContext(),
    sseResponse(frames),
    { modelName: "test-model" }
  );
  return stripPingFrames(await res.text());
};

const frame = (event: string | null, data: unknown) =>
  (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } },
  });

const blockStart = () =>
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

const blockStop = () => frame("content_block_stop", { type: "content_block_stop", index: 0 });

const messageDelta = () =>
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  });

const messageStop = () => frame("message_stop", { type: "message_stop" });

/** A complete, valid Anthropic stream whose delta frame is the one mutated. */
const streamWith = (deltaFrame: string): string[] => [
  messageStart(),
  blockStart(),
  deltaFrame,
  blockStop(),
  messageDelta(),
  messageStop(),
];

/** Parse a wire into { event, data } frames. */
const parseWire = (wire: string): Array<{ event: string | null; data: any }> =>
  wire
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      let data: any = null;
      if (dataLine) {
        try {
          data = JSON.parse(dataLine.slice(5).trim());
        } catch {
          data = null;
        }
      }
      return { event: eventLine ? parseEventName(eventLine) : null, data };
    });

describe("frame-coherence — helper", () => {
  it("parses an event name", () => {
    expect(parseEventName("event: content_block_delta")).toBe("content_block_delta");
    expect(parseEventName("event:message_stop")).toBe("message_stop");
    expect(parseEventName("event:")).toBeNull();
  });

  it("leaves a coherent frame byte-for-byte", () => {
    const data = 'data: {"type":"content_block_delta","index":0}';
    const out = reconcileFrame("event: content_block_delta", data);
    expect(out.changed).toBe(false);
    expect(out.dataLine).toBe(data);
    expect(out.eventLine).toBe("event: content_block_delta");
  });

  it("aligns a mismatched type to the event name", () => {
    const out = reconcileFrame(
      "event: content_block_delta",
      'data: {"type":"message_delta","index":0}'
    );
    expect(out.changed).toBe(true);
    expect(out.reason).toBe("type-mismatch");
    expect(JSON.parse(out.dataLine.slice(6)).type).toBe("content_block_delta");
  });

  it("fills an absent type from the event name", () => {
    const out = reconcileFrame(
      "event: content_block_delta",
      'data: {"index":0,"delta":{"type":"text_delta"}}'
    );
    expect(out.changed).toBe(true);
    expect(out.reason).toBe("type-absent");
    expect(JSON.parse(out.dataLine.slice(6)).type).toBe("content_block_delta");
  });

  it("synthesizes the event line from the JSON type", () => {
    const out = reconcileFrame(null, 'data: {"type":"content_block_delta","index":0}');
    expect(out.changed).toBe(true);
    expect(out.reason).toBe("event-line-absent");
    expect(out.eventLine).toBe("event: content_block_delta");
  });

  it("replaces an unknown event name with the JSON type", () => {
    const out = reconcileFrame(
      "event: content_block_chunk",
      'data: {"type":"content_block_delta","index":0}'
    );
    expect(out.changed).toBe(true);
    expect(out.reason).toBe("event-name-unknown");
    expect(out.eventLine).toBe("event: content_block_delta");
  });

  it("never drops a frame it cannot interpret", () => {
    const data = 'data: {"foo":1}';
    const out = reconcileFrame("event: something_else", data);
    expect(out.changed).toBe(false);
    expect(out.dataLine).toBe(data);
    expect(out.eventLine).toBe("event: something_else");
  });

  it("never throws on an unparseable payload", () => {
    const out = reconcileFrame("event: content_block_delta", "data: {not json");
    expect(out.changed).toBe(false);
    expect(out.dataLine).toBe("data: {not json");
  });

  it("does not treat `error` as a synthesizable frame kind", () => {
    const out = reconcileFrame(null, 'data: {"type":"error","error":{"type":"x"}}');
    expect(out.changed).toBe(false);
    expect(out.eventLine).toBeNull();
  });
});

describe("frame-coherence — the client-visible wire", () => {
  it("relays a coherent frame byte-for-byte", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    expect(wire).toContain(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bonjour"}}\n'
    );
  });

  it("repairs a mismatched type (the shape that kills the SDK client)", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_delta", {
          type: "message_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    const frames = parseWire(wire);
    const delta = frames.find((f) => f.event === "content_block_delta" && f.data?.delta);
    expect(delta).toBeDefined();
    expect(delta!.data.type).toBe("content_block_delta");
  });

  it("repairs a type outside the Anthropic union", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_delta", {
          type: "thinking_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    const frames = parseWire(wire);
    const delta = frames.find((f) => f.data?.delta);
    expect(delta).toBeDefined();
    expect(delta!.data.type).toBe("content_block_delta");
    expect(delta!.event).toBe("content_block_delta");
  });

  it("synthesizes the missing event line (the shape that empties the answer)", async () => {
    const wire = await run(
      streamWith(
        frame(null, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    const frames = parseWire(wire);
    const delta = frames.find((f) => f.data?.delta);
    expect(delta).toBeDefined();
    expect(delta!.event).toBe("content_block_delta");
  });

  it("replaces an unknown event name (the shape that empties the answer)", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_chunk", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    const frames = parseWire(wire);
    const delta = frames.find((f) => f.data?.delta);
    expect(delta).toBeDefined();
    expect(delta!.event).toBe("content_block_delta");
    expect(wire).not.toContain("content_block_chunk");
  });

  it("fills an absent type from the event line", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    const frames = parseWire(wire);
    const delta = frames.find((f) => f.data?.delta);
    expect(delta!.data.type).toBe("content_block_delta");
  });

  it("INVARIANT — no frame leaves the proxy with a type/event disagreement", async () => {
    const wires = await Promise.all([
      run(streamWith(frame("content_block_delta", { type: "message_delta", index: 0, delta: { type: "text_delta", text: "x" } }))),
      run(streamWith(frame("content_block_delta", { type: "thinking_delta", index: 0, delta: { type: "text_delta", text: "x" } }))),
      run(streamWith(frame(null, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))),
      run(streamWith(frame("content_block_chunk", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))),
      run(streamWith(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }))),
    ]);
    for (const wire of wires) {
      for (const f of parseWire(wire)) {
        if (!f.data || typeof f.data !== "object") continue;
        const type = typeof f.data.type === "string" ? f.data.type : null;
        if (!type || !ANTHROPIC_STREAM_EVENTS.has(type)) continue;
        expect(f.event).toBe(type);
      }
    }
  });

  it("still terminates the stream with message_stop", async () => {
    const wire = await run(
      streamWith(
        frame("content_block_delta", {
          type: "message_delta",
          index: 0,
          delta: { type: "text_delta", text: "bonjour" },
        })
      )
    );
    expect(wire).toContain('data: {"type":"message_stop"}');
  });
});
