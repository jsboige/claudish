/**
 * Synthetic terminal tail for the seam's client-facing byte streams (#641
 * landing, family B).
 *
 * The seam wrappers (seam-tap, seam-transform, raw's replay and fallback, the
 * advisor tee) sit AFTER the parser: their consumer is Claude Code, and a
 * `controller.error()` there kills the client-visible response mid-flight —
 * a hang by another name (never-hang rule). On an upstream read failure they
 * must instead append a synthetic, labeled terminal and close, so the agent
 * loop always sees a terminated message. The one exception is a rejection
 * landing AFTER the real `message_stop` went through: a second terminal pair
 * would corrupt the turn (S4-a rule) — there the stream just closes.
 *
 * The wire shape mirrors main's `finalizeWithError` (anthropic-sse.ts): a
 * full `message_start` when none passed, otherwise an open block closed at
 * its real index, the labeled notice in a fresh text block at
 * `highestIndex + 1`, then `message_delta` + `message_stop`. Frames are
 * built with JSON.stringify, never hand-built literals (S4-a): one quote in
 * the error text would produce JSON the client cannot parse.
 *
 * `TerminalSniffer` tracks that state by byte-sniffing each chunk flowing
 * toward the client. The exact patterns `"type":"message_start"` /
 * `"type":"message_stop"` / `"type":"content_block_start"` (with its
 * `"index":N`) are safe against content: inside a JSON string value every
 * quote is escaped (`\"type\"`), so a text block quoting SSE frames never
 * matches the raw literal. A pattern straddling two chunks is caught by
 * carrying the previous chunk's tail bytes into the next search.
 */

import { redactForClient } from "../redact.js";
import { encodeUtf8 } from "./sse-codec.js";

/** The model id of a synthetic message built below the parser, where the
 * real requested id is not available. Informational only: Claude Code does
 * not route on it. */
const SYNTH_MODEL = "claudish-seam";

function marker(type: string): Uint8Array {
  return encodeUtf8(`"type":"${type}"`);
}

const START_MARKER = marker("message_start");
const STOP_MARKER = marker("message_stop");
const BLOCK_START_MARKER = marker("content_block_start");
const BLOCK_STOP_MARKER = marker("content_block_stop");
const INDEX_KEY = encodeUtf8('"index":');
/** Longest marker plus room for the `"index":123` suffix parsed after it. */
const CARRY_BYTES = 64;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** First occurrence of `needle` in `haystack` at or after `from`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Reads the `N` of `"index":N` at `from` (the position of the key). */
function indexAfter(haystack: Uint8Array, from: number): number | null {
  const at = indexOfBytes(haystack, INDEX_KEY, from);
  if (at < 0) return null;
  let i = at + INDEX_KEY.length;
  let value = 0;
  let digits = 0;
  while (i < haystack.length) {
    const ch = haystack[i];
    if (ch >= 0x30 && ch <= 0x39) {
      value = value * 10 + (ch - 0x30);
      digits++;
      i++;
      continue;
    }
    break;
  }
  return digits > 0 ? value : null;
}

/** Tracks which terminal frames already flowed toward the client. */
export class TerminalSniffer {
  private startSeen = false;
  private stopSeen = false;
  /** Highest `content_block_start` index passed, -1 when none did. */
  private highestIndex = -1;
  /** True when the highest block started but its `content_block_stop` did not pass. */
  private lastBlockOpen = false;
  private carry: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): void {
    const hay = concatBytes(this.carry, chunk);
    if (!this.startSeen && indexOfBytes(hay, START_MARKER) >= 0) this.startSeen = true;
    if (!this.stopSeen && indexOfBytes(hay, STOP_MARKER) >= 0) {
      this.stopSeen = true;
      // message_stop closes the message: no block is left open past it.
      this.lastBlockOpen = false;
    }
    if (!this.stopSeen) {
      let at = indexOfBytes(hay, BLOCK_START_MARKER);
      while (at >= 0) {
        const idx = indexAfter(hay, at);
        if (idx !== null && idx > this.highestIndex) {
          this.highestIndex = idx;
          this.lastBlockOpen = true;
        }
        at = indexOfBytes(hay, BLOCK_START_MARKER, at + 1);
      }
      if (this.lastBlockOpen && this.highestIndex >= 0) {
        let at = indexOfBytes(hay, BLOCK_STOP_MARKER);
        while (at >= 0) {
          const idx = indexAfter(hay, at);
          if (idx === this.highestIndex) this.lastBlockOpen = false;
          at = indexOfBytes(hay, BLOCK_STOP_MARKER, at + 1);
        }
      }
    }
    this.carry = hay.slice(Math.max(0, hay.length - CARRY_BYTES));
  }

  get sawStart(): boolean {
    return this.startSeen;
  }

  get sawStop(): boolean {
    return this.stopSeen;
  }

  get openIndex(): number {
    return this.highestIndex;
  }

  get blockOpen(): boolean {
    return this.lastBlockOpen;
  }
}

/** `Error: msg` noise stripped — the label carries the message, not the wrapper. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function frame(event: string, data: unknown): Uint8Array {
  return encodeUtf8(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The synthetic labeled terminal for a failed read, as SSE bytes to enqueue
 * before `close()`. Returns an empty list when the real `message_stop`
 * already passed (no second terminal pair, S4-a). Usage is 0/0: the seam
 * sits below the parser, nothing here was billed or measured.
 */
export function encodeSyntheticErrorTail(sniffer: TerminalSniffer, message: string): Uint8Array[] {
  if (sniffer.sawStop) return [];
  const notice = `[Upstream stream error: ${redactForClient(message)}]`;
  const frames: Uint8Array[] = [];
  if (!sniffer.sawStart) {
    frames.push(
      frame("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: SYNTH_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    );
  } else if (sniffer.blockOpen && sniffer.openIndex >= 0) {
    // Close whatever block the failure cut open, at its real index — a
    // synthetic start/delta/stop on a live index would collide client-side.
    frames.push(
      frame("content_block_stop", { type: "content_block_stop", index: sniffer.openIndex })
    );
  }
  const noticeIdx = sniffer.openIndex + 1;
  frames.push(
    frame("content_block_start", {
      type: "content_block_start",
      index: noticeIdx,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: noticeIdx,
      delta: { type: "text_delta", text: notice },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: noticeIdx }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    frame("message_stop", { type: "message_stop" })
  );
  return frames;
}
