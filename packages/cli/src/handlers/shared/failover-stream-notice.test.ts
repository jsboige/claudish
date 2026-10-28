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

    // The notice frames lead, ahead of the first real content block.
    const noticeAt = out.indexOf('"text":"NOTICE-TEXT"');
    expect(noticeAt).toBeGreaterThan(-1);
    // The first real content_block event is shifted to index 1 (notice owns 0).
    expect(out).toContain('"type":"content_block_start","index":1');
    // The straddled event kept its payload intact across the chunk split.
    expect(out).toContain('"type":"text_delta","text":"hello"');
    // Every whole event is terminated; notice frames precede the first block.
    expect(out.indexOf("event: content_block_start")).toBeLessThan(
      out.indexOf('"type":"content_block_delta","index":1')
    );
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

    // Whole event processed (shifted), partial byte-for-byte at the tail.
    expect(out).toContain('"type":"content_block_delta","index":1');
    expect(out.endsWith(partial)).toBe(true);
  });
});
