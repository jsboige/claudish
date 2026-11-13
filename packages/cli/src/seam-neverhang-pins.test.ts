/**
 * #641 landing pins — the seam terminates, never breaks the client's pipe.
 *
 * Family B (client-facing seams): an upstream read failure appends a
 * synthetic labeled terminal and closes — the agent loop always sees a
 * terminated message. A rejection landing AFTER the real `message_stop`
 * adds NO second terminal pair (S4-a rule). The two lease wrappers
 * (#663 r1 shape) release and close.
 *
 * Family A (the two stream-head sniffers, the surviving allowlist in
 * prod-no-controller-error.test.ts): their replayed rejection is CONVERTED
 * by the real consumer chain into a labeled error terminal — these pins go
 * through that chain, not around it.
 */

import { describe, expect, test } from "bun:test";
import { releaseWhenBodyEnds } from "./handlers/shared/call-context.js";
import { sniffDevinStreamHead } from "./handlers/shared/devin-stream-head-sniffer.js";
import { sniffResponsesStreamHead } from "./handlers/shared/stream-head-sniffer.js";
import { createDevinConnectStream } from "./handlers/shared/stream-parsers/devin-connect.js";
import { createResponsesStreamHandler } from "./handlers/shared/stream-parsers/openai-responses-sse.js";
import { notifyOnDownstreamCancel } from "./handlers/shared/stream-parsers/upstream-cancel.js";
import { ResponseRecorder } from "./hooks/raw.js";
import type { SeamHooks } from "./hooks/seam-hooks.js";
import { observeTap } from "./hooks/seam-tap.js";
import { closedTransform } from "./hooks/seam-transform.js";
import { encodeUtf8 } from "./hooks/sse-codec.js";

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
const textDelta = (index: number, text: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
const blockStop = (index: number) =>
  frame("content_block_stop", { type: "content_block_stop", index });
const messageStop = () => frame("message_stop", { type: "message_stop" });

const FAIL = "upstream socket died mid-turn";

/** Yields `head`, then rejects: the shape every pin here seeds. */
function headThenReject(head: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        if (head) controller.enqueue(encodeUtf8(head));
        return;
      }
      throw new Error(FAIL);
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** The inert hooks surface the seam needs at runtime (typed by class, so cast). */
const inertHooks = {
  hasEndHooks: false,
  intercepts: () => false,
  observes: () => false,
  interceptToolCall: () => Promise.resolve(null),
  observeToolCall: () => Promise.resolve(),
  observeRewrite: () => Promise.resolve(),
  end: () => Promise.resolve(),
  recordRewrite: () => {},
  noteRewriteInvalid: () => {},
  sink: { end: () => {} },
} as unknown as SeamHooks;

function countStops(text: string): number {
  return (text.match(/event: message_stop/g) ?? []).length;
}

describe("#641 family B — the tap terminates, never errors the client pipe", () => {
  test("seam-tap: a rejection before message_start ends as a synthetic labeled terminal, closed", async () => {
    const tapped = observeTap(headThenReject(""), inertHooks);
    const text = await readText(tapped);
    expect(text).toContain("event: message_start");
    expect(text).toContain(`[Upstream stream error: ${FAIL}]`);
    expect(text).toContain("event: message_stop");
  });

  test("seam-tap: a rejection after message_stop adds no second terminal pair", async () => {
    const whole =
      messageStart() + blockStart(0) + textDelta(0, "partial") + blockStop(0) + messageStop();
    const tapped = observeTap(headThenReject(whole), inertHooks);
    const text = await readText(tapped);
    expect(text).toContain("event: message_stop");
    expect(countStops(text)).toBe(1);
    expect(text).not.toContain("[Upstream stream error");
  });
});

describe("#641 family B — the closed transform terminates, never errors the client pipe", () => {
  test("seam-transform: a raised pending error ends as a synthetic labeled terminal, closed", async () => {
    const head = messageStart() + blockStart(0) + textDelta(0, "partial");
    const out = closedTransform(headThenReject(head), { mode: "buffer", hooks: inertHooks });
    const text = await readText(out);
    // The flushed held region reached the client (message_start is a loose
    // event), the error is labeled, and exactly one terminal pair exists.
    expect(text).toContain("event: message_start");
    expect(text).toContain(`[Upstream stream error: ${FAIL}]`);
    expect(countStops(text)).toBe(1);
  });
});

describe("#641 family B — the recorder's replays terminate, never error the reader", () => {
  test("a failed SSE recording ends as a synthetic labeled terminal, closed", async () => {
    const head = messageStart() + blockStart(0);
    const recorder = new ResponseRecorder(headThenReject(head), undefined, true);
    const replay = recorder.replay();
    const text = await readText(replay.stream);
    expect(text).toContain("event: message_start");
    expect(text).toContain(`[Upstream stream error: ${FAIL}]`);
    expect(countStops(text)).toBe(1);
  });

  test("a failed JSON recording closes without injecting SSE frames", async () => {
    const recorder = new ResponseRecorder(headThenReject('{"partial": '), undefined, false);
    const replay = recorder.replay();
    const text = await readText(replay.stream);
    expect(text).toContain('{"partial": ');
    expect(text).not.toContain("event:");
    expect(text).not.toContain("[Upstream stream error");
  });

  test("a failure after the recorded message_stop adds no second terminal pair", async () => {
    const whole = messageStart() + blockStart(0) + blockStop(0) + messageStop();
    const recorder = new ResponseRecorder(headThenReject(whole), undefined, true);
    const replay = recorder.replay();
    const text = await readText(replay.stream);
    expect(countStops(text)).toBe(1);
    expect(text).not.toContain("[Upstream stream error");
  });
});

describe("#641 family B — the lease wrappers release and close (#663 r1)", () => {
  test("releaseWhenBodyEnds: a rejection releases the lease and closes, never errors", async () => {
    let released = 0;
    const wrapped = releaseWhenBodyEnds(sseResponse(headThenReject("")), () => {
      released++;
    });
    const text = await wrapped.text();
    expect(text).toBe("");
    expect(released).toBe(1);
  });

  test("notifyOnDownstreamCancel: a rejection closes, never errors, no cancel flag", async () => {
    let cancelled = 0;
    const wrapped = notifyOnDownstreamCancel(sseResponse(headThenReject("")), () => {
      cancelled++;
    });
    const text = await wrapped.text();
    expect(text).toBe("");
    expect(cancelled).toBe(0);
  });
});

describe("#641 family A — a sniffer's replayed rejection is converted by the real chain", () => {
  test("responses sniffer: a replayed rejection ends as a labeled error terminal through the Responses chain", async () => {
    const preamble = 'data: {"type":"response.created"}\n\n';
    const verdict = await sniffResponsesStreamHead(sseResponse(headThenReject(preamble)), {
      budgetMs: 500,
    });
    expect(verdict.kind).toBe("clean");
    // biome-ignore lint/suspicious/noExplicitAny: same mock context as openai-responses-sse.test.ts
    const ctx = {
      json(): never {
        throw new Error("unexpected");
      },
    } as any;
    const handled = createResponsesStreamHandler(
      ctx,
      (verdict as { response: Response }).response,
      {
        modelName: "gpt-test",
      }
    );
    const text = await handled.text();
    expect(text).toContain("Stream error");
    expect(text).toContain(FAIL);
  });

  test("devin sniffer: a replayed rejection ends as a labeled error frame through the Devin chain", async () => {
    const verdict = await sniffDevinStreamHead(sseResponse(headThenReject("")), { budgetMs: 500 });
    expect(verdict.kind).toBe("clean");
    const handled = createDevinConnectStream(
      undefined as never,
      (verdict as { response: Response }).response,
      {
        modelName: "devin-test",
      }
    );
    const text = await handled.text();
    expect(text).toContain("event: error");
    expect(text).toContain(FAIL);
  });
});
