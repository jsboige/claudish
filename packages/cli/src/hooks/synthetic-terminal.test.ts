/**
 * Unit pins for the seam's synthetic terminal helper (#641 landing, family
 * B): the sniffer's byte-level terminal state and the tail's wire shape.
 * The end-to-end site pins live in src/seam-neverhang-pins.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { encodeUtf8 } from "./sse-codec.js";
import { TerminalSniffer, encodeSyntheticErrorTail } from "./synthetic-terminal.js";

const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m" },
  });
const blockStart = (index: number) =>
  frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
const blockStop = (index: number) =>
  frame("content_block_stop", { type: "content_block_stop", index });
const messageStop = () => frame("message_stop", { type: "message_stop" });

function decode(frames: Uint8Array[]): string {
  return frames.map((f) => new TextDecoder().decode(f)).join("");
}

describe("#641 — TerminalSniffer byte state", () => {
  test("tracks start, block index and stop across whole chunks", () => {
    const sniffer = new TerminalSniffer();
    sniffer.feed(encodeUtf8(messageStart()));
    expect(sniffer.sawStart).toBe(true);
    expect(sniffer.sawStop).toBe(false);
    sniffer.feed(encodeUtf8(blockStart(0) + blockStop(0)));
    expect(sniffer.openIndex).toBe(0);
    expect(sniffer.blockOpen).toBe(false);
    sniffer.feed(encodeUtf8(blockStart(3)));
    expect(sniffer.openIndex).toBe(3);
    expect(sniffer.blockOpen).toBe(true);
    sniffer.feed(encodeUtf8(messageStop()));
    expect(sniffer.sawStop).toBe(true);
    expect(sniffer.blockOpen).toBe(false);
  });

  test("a marker straddling two chunks is still caught", () => {
    const sniffer = new TerminalSniffer();
    const whole = messageStart();
    // Split INSIDE the marker: the first chunk ends mid-pattern.
    const cut = whole.indexOf('"type":"message_start"') + 8;
    sniffer.feed(encodeUtf8(whole.slice(0, cut)));
    expect(sniffer.sawStart).toBe(false);
    sniffer.feed(encodeUtf8(whole.slice(cut)));
    expect(sniffer.sawStart).toBe(true);
  });

  test("text quoting SSE frames never sets terminal state", () => {
    // Inside a JSON string value every quote is escaped, so the raw literal
    // `"type":"message_stop"` cannot occur in content. If that argument ever
    // breaks, the tail would go missing after ordinary model prose.
    const sniffer = new TerminalSniffer();
    const quoting = frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: 'the wire has {"type":"message_stop"} escaped as \\"type\\":\\"message_stop\\" in prose',
      },
    });
    sniffer.feed(encodeUtf8(messageStart() + quoting));
    expect(sniffer.sawStart).toBe(true);
    expect(sniffer.sawStop).toBe(false);
  });
});

describe("#641 — encodeSyntheticErrorTail wire shape", () => {
  test("no message_start: a full synthetic message carrying the label", () => {
    const sniffer = new TerminalSniffer();
    const out = decode(encodeSyntheticErrorTail(sniffer, "socket reset by peer"));
    expect(out).toContain("event: message_start");
    expect(out).toContain("[Upstream stream error: socket reset by peer]");
    expect(out).toContain("event: message_stop");
    // JSON.stringify-built frames parse back (S4-a): the label's text is
    // inside a parsable payload, not hand-concatenated.
    const payload = out.split("\n\n").find((f) => f.includes("text_delta")) as string;
    expect(() => JSON.parse(payload.split("data: ")[1] as string)).not.toThrow();
  });

  test("#1014 — the synthetic message_start seeds both cache counters (#179 b)", () => {
    const sniffer = new TerminalSniffer();
    const out = decode(encodeSyntheticErrorTail(sniffer, "boom before start"));
    const startFrame = out.split("\n\n").find((f) => f.includes("event: message_start")) as string;
    const { message } = JSON.parse(startFrame.split("data: ")[1] as string) as {
      message: { usage: Record<string, number> };
    };
    // The client sums the three input counters raw; an absent seed key
    // survives the delta merge as undefined and the sum turns NaN.
    expect(message.usage.cache_read_input_tokens).toBe(0);
    expect(message.usage.cache_creation_input_tokens).toBe(0);
    // The seam sits below the parser: no prior count exists, so the seed
    // carries the genuinely-unknown fallback, not a 0-that-looks-empty.
    expect(message.usage.input_tokens).toBe(100);
  });

  test("start seen, block open: closed at its real index, notice at index+1", () => {
    const sniffer = new TerminalSniffer();
    sniffer.feed(encodeUtf8(messageStart() + blockStart(1)));
    const out = decode(encodeSyntheticErrorTail(sniffer, "boom"));
    expect(out).not.toContain("event: message_start");
    expect(out).toContain('{"type":"content_block_stop","index":1}');
    expect(out).toContain('"index":2,"content_block":{"type":"text"');
    expect(out).toContain("[Upstream stream error: boom]");
    expect(out).toContain("event: message_stop");
  });

  test("after the real message_stop: empty tail, never a second terminal pair", () => {
    const sniffer = new TerminalSniffer();
    sniffer.feed(encodeUtf8(messageStart() + blockStart(0) + blockStop(0) + messageStop()));
    expect(encodeSyntheticErrorTail(sniffer, "late rejection")).toEqual([]);
  });
});
