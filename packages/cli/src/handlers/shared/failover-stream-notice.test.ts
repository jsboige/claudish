import { describe, expect, it } from "bun:test";
import { prependNoticeToAnthropicStream } from "./failover-stream-notice.js";

/**
 * Pin for the SSE event-boundary loop inside prependNoticeToAnthropicStream.
 *
 * The loop was restructured for lint/noAssignInExpressions (assignment moved
 * out of the while condition, same evaluation sequence) — this file pins the
 * behavior it must keep, which nothing else covers: prependNoticeToAnthropicStream
 * has no other test, and relay.test.ts imports only the header constants.
 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

describe("prependNoticeToAnthropicStream — SSE boundary loop", () => {
  it("reassembles events whose \\n\\n boundary straddles two chunks, shifts indexes, leads with the notice", async () => {
    const evMessageStart = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { role: "assistant" },
    })}`;
    // First content block: its opening event is split mid-payload across chunks,
    // so the \n\n that terminates it only arrives with the second chunk.
    const evBlockStart = `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}`;
    const evBlockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    })}`;

    const splitAt = 40; // inside evBlockStart's data line, before its terminator
    const head = `${evMessageStart}\n\n${evBlockStart.slice(0, splitAt)}`;
    const tail = `${evBlockStart.slice(splitAt)}\n\n${evBlockDelta}\n\n`;

    const out = await collect(
      prependNoticeToAnthropicStream(chunkedStream([head, tail]), "NOTICE-TEXT")
    );

    // STRICT parse: every \n\n-delimited segment must be a well-formed event
    // (starts with "event:"). A boundary loop that consumes too few or too many
    // separator bytes leaves stray "\n" prefixes that this catches and the
    // loose contains-checks do not.
    const segments = out.split("\n\n").filter((s) => s !== "");
    for (const seg of segments) {
      expect(seg.startsWith("event: ")).toBe(true);
    }
    // Exact ordered sequence: message_start passes through untouched, the
    // three notice frames land immediately BEFORE the first real content
    // block (not at the very head), and the real block/delta shift to index 1.
    expect(segments.map((s) => s.split("\ndata:")[0])).toEqual([
      "event: message_start",
      "event: content_block_start", // notice frame (index 0)
      "event: content_block_delta", // notice text
      "event: content_block_stop", // notice frame close
      "event: content_block_start", // real block, shifted to index 1
      "event: content_block_delta", // real delta, shifted to index 1
    ]);
    // The notice frames lead, ahead of the first real content block.
    expect(out).toContain('"text":"NOTICE-TEXT"');
    // The first real content_block event is shifted to index 1 (notice owns 0).
    expect(out).toContain('"type":"content_block_start","index":1');
    // The straddled event kept its payload intact across the chunk split.
    expect(out).toContain('"type":"text_delta","text":"hello"');
  });

  it("flushes a trailing partial event (no closing blank line) verbatim", async () => {
    const evBlockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    })}`;
    const partial = `event: content_block_stop\ndata: {"type":"content_block_st`;

    const out = await collect(
      prependNoticeToAnthropicStream(
        chunkedStream([`${evBlockDelta}\n\n${partial}`]),
        "NOTICE-TEXT"
      )
    );

    // Same strict segment parse on the whole events only.
    const segments = out.split("\n\n").filter((s) => s !== "");
    for (const seg of segments) {
      expect(seg.startsWith("event: ")).toBe(true);
    }
    // Whole event processed (shifted), partial byte-for-byte at the tail.
    expect(out).toContain('"type":"content_block_delta","index":1');
    expect(out.endsWith(partial)).toBe(true);
  });
});
