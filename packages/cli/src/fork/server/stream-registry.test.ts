import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import {
  createStreamTracker,
  stallThresholdMs,
  DEFAULT_STALL_THRESHOLD_MS,
} from "./stream-registry";

const enc = new TextEncoder();

/** An SSE body that emits `chunks` then closes. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i++;
    },
  });
}

function appWithSse(bodyFactory: () => ReadableStream<Uint8Array>) {
  const tracker = createStreamTracker();
  const app = new Hono();
  app.use("*", tracker.middleware);
  app.get("/health", (c) => c.json({ activeStreams: tracker.getActiveStreams() }));
  app.get("/sse", () =>
    new Response(bodyFactory(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  );
  app.get("/json", (c) => c.json({ ok: true }));
  return { app, tracker };
}

describe("stream tracker", () => {
  test("passes an SSE body through byte-identical", async () => {
    const parts = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { app } = appWithSse(() => sseBody(parts));
    const res = await app.request("/sse");
    expect(await res.text()).toBe(parts.join(""));
  });

  test("counts a stream while it runs and releases it at close", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["a", "b"]));
    expect(tracker.getActiveStreams()).toBe(0);

    const res = await app.request("/sse");
    const reader = res.body!.getReader();
    await reader.read(); // first chunk pulled → stream is live
    expect(tracker.getActiveStreams()).toBe(1);

    // Drain to completion.
    while (!(await reader.read()).done) {
      /* keep reading */
    }
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("releases the count when the client cancels mid-stream", async () => {
    // The leak that matters: a client that walks away must not pin the counter
    // above zero forever, or the watchdog would drain until its cap on every
    // restart.
    const { app, tracker } = appWithSse(() => sseBody(["a", "b", "c", "d"]));
    const res = await app.request("/sse");
    const reader = res.body!.getReader();
    await reader.read();
    expect(tracker.getActiveStreams()).toBe(1);

    await reader.cancel();
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("releases the count when the upstream body throws mid-stream", async () => {
    // A hub death mid-relay. The wrapper must close cleanly, never error() —
    // otherwise the counting layer becomes a new way for a stream to break.
    let pulls = 0;
    const exploding = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(enc.encode("data: partial\n\n"));
          return;
        }
        throw new Error("socket closed unexpectedly");
      },
    });
    const { app, tracker } = appWithSse(() => exploding);

    const res = await app.request("/sse");
    const text = await res.text(); // must resolve, not reject
    expect(text).toBe("data: partial\n\n");
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("ignores non-SSE responses", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["x"]));
    const res = await app.request("/json");
    expect(await res.json()).toEqual({ ok: true });
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("counts concurrent streams independently", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["a", "b"]));
    const r1 = (await app.request("/sse")).body!.getReader();
    const r2 = (await app.request("/sse")).body!.getReader();
    await r1.read();
    await r2.read();
    expect(tracker.getActiveStreams()).toBe(2);

    await r1.cancel();
    expect(tracker.getActiveStreams()).toBe(1);
    await r2.cancel();
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("/health reports the live count", async () => {
    const { app } = appWithSse(() => sseBody(["a", "b"]));
    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();

    const health = await (await app.request("/health")).json();
    expect(health).toEqual({ activeStreams: 1 });

    await reader.cancel();
    const health2 = await (await app.request("/health")).json();
    expect(health2).toEqual({ activeStreams: 0 });
  });
});


/**
 * A body that emits `chunks` and then goes quiet WITHOUT closing — the shape of
 * a wedged pipeline, and the one the count alone cannot tell from a busy one.
 */
function goesQuiet(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
        return;
      }
      return new Promise<void>(() => {});
    },
  });
}

describe("stall threshold config", () => {
  const original = process.env.CLAUDISH_STALL_THRESHOLD_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDISH_STALL_THRESHOLD_MS;
    else process.env.CLAUDISH_STALL_THRESHOLD_MS = original;
  });

  test("defaults when unset or blank", () => {
    delete process.env.CLAUDISH_STALL_THRESHOLD_MS;
    expect(stallThresholdMs()).toBe(DEFAULT_STALL_THRESHOLD_MS);
    process.env.CLAUDISH_STALL_THRESHOLD_MS = "   ";
    expect(stallThresholdMs()).toBe(DEFAULT_STALL_THRESHOLD_MS);
  });

  test("reads an operator override", () => {
    process.env.CLAUDISH_STALL_THRESHOLD_MS = "45000";
    expect(stallThresholdMs()).toBe(45_000);
  });

  test("0 is honoured — it is the documented kill switch", () => {
    process.env.CLAUDISH_STALL_THRESHOLD_MS = "0";
    expect(stallThresholdMs()).toBe(0);
  });

  test("garbage falls back to the default, never to a flapping value", () => {
    // A typo must not silently disable the detector, nor invent a 1ms threshold
    // that would demote the whole fleet to AUTONOMOUS on every request.
    for (const bad of ["abc", "-1", "NaN"]) {
      process.env.CLAUDISH_STALL_THRESHOLD_MS = bad;
      expect(stallThresholdMs()).toBe(DEFAULT_STALL_THRESHOLD_MS);
    }
  });
});

describe("stream liveness (2026-09-02 outage)", () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  test("an idle proxy is never stalled, however long the silence", async () => {
    // The false positive that would cost the most: a quiet night demoting every
    // sidecar to AUTONOMOUS, where unarmed cascades meet provider walls.
    let clock = 1_000_000;
    Date.now = () => clock;
    const { tracker } = appWithSse(() => sseBody(["a"]));
    clock += 60 * 60 * 1000;
    expect(tracker.getActiveStreams()).toBe(0);
    expect(tracker.isStalled(180_000)).toBe(false);
  });

  test("work in flight with no byte for longer than the threshold is stalled", async () => {
    let clock = 1_000_000;
    Date.now = () => clock;
    const { app, tracker } = appWithSse(() => goesQuiet(["data: hello"]));

    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();
    expect(tracker.getActiveStreams()).toBe(1);
    expect(tracker.isStalled(180_000)).toBe(false);

    clock += 179_000; // still inside the budget — upstream TTFT reaches ~23s here
    expect(tracker.isStalled(180_000)).toBe(false);

    clock += 2_000; // 181s of silence with a stream open: wedged
    expect(tracker.isStalled(180_000)).toBe(true);
    expect(tracker.getMsSinceLastByte()).toBe(181_000);
  });

  test("a byte arriving from upstream clears the verdict", async () => {
    // The stamp marks arrival FROM upstream, not consumption by the client: the
    // wrapper pulls one chunk ahead, so a read dequeues what already landed and
    // only the pull it triggers refreshes the stamp. That is the signal wanted —
    // a wedged upstream stops producing — hence the tick before asserting.
    let clock = 1_000_000;
    Date.now = () => clock;
    const { app, tracker } = appWithSse(() => sseBody(["a", "b", "c"]));

    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();
    clock += 200_000;
    expect(tracker.isStalled(180_000)).toBe(true);

    await reader.read();
    await new Promise((r) => setTimeout(r, 0)); // let the next upstream pull land
    expect(tracker.isStalled(180_000)).toBe(false);
    expect(tracker.getMsSinceLastByte()).toBe(0);
  });

  test("a stream ending counts as progress", async () => {
    // Otherwise the last stream to finish leaves a stale stamp behind, and the
    // next one is judged on silence that predates it.
    let clock = 1_000_000;
    Date.now = () => clock;
    const { app, tracker } = appWithSse(() => goesQuiet(["x"]));

    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();
    clock += 500_000;
    await reader.cancel(); // the stream ends here, not 500s ago
    expect(tracker.getActiveStreams()).toBe(0);
    expect(tracker.getMsSinceLastByte()).toBe(0);
  });

  test("a client walking away does not leave a stalled verdict armed", async () => {
    let clock = 1_000_000;
    Date.now = () => clock;
    const { app, tracker } = appWithSse(() => goesQuiet(["x"]));

    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();
    await reader.cancel();
    clock += 600_000;
    expect(tracker.isStalled(180_000)).toBe(false);
  });

  test("a non-positive threshold disables the verdict entirely", async () => {
    let clock = 1_000_000;
    Date.now = () => clock;
    const { app, tracker } = appWithSse(() => goesQuiet(["x"]));

    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();
    clock += 10 * 60 * 1000;
    expect(tracker.isStalled(0)).toBe(false);
    expect(tracker.isStalled(-1)).toBe(false);
    expect(tracker.isStalled(180_000)).toBe(true);
  });
});
