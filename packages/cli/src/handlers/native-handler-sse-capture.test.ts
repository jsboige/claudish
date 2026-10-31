/**
 * #722 read-back — grain v17-1: behavioral pin of the NATIVE lane's
 * response-side capture (byte tap / done / cancel).
 *
 * WHY THIS FILE EXISTS. The #722 read-back could not measure the native lane's
 * RESPONSE side: `NativeHandler` hardcodes its origin to
 * `https://api.anthropic.com` (native-handler.ts:62), so there is no
 * credential-free way to point it at a local endpoint, and a real probe would
 * cost money. The request side was measured (PR #757/#758); the response side
 * was declared NON MESUREE, which is what kept #722 out of merge.
 *
 * The gate ai-01 opened for that hole (QUEUE v17, grain 1): a BEHAVIORAL test
 * of the native lane in the success-SSE case, driven by a fetch stub — no real
 * credential, no paid probe, and NO production change for the bench. The
 * upstream origin stays where it is; the stub intercepts `globalThis.fetch`, so
 * nothing leaves the process.
 *
 * Uses `installStubFetch` (test-support/stub-fetch.ts), never `Bun.serve`:
 * once a node:http server has lived in the bun test process, every later
 * `Bun.serve` is unreachable (#604, mechanism in docs/reference/test-strict.md).
 *
 * WHAT IS PINNED — three points, all MEASURED on 2026-10-29 (po-2024):
 *
 *   1. BYTE TAP — the bytes the client receives are the bytes the capture file
 *      holds; the native lane is a passthrough, it does not rewrite the
 *      upstream frames.
 *   2. DONE    — at upstream close the capture is finalized: a
 *      `resp-<pid>-r<NNNN>-<ts>-native-<model>.sse` file exists, carrying the
 *      `parser=native` header the .sse readers anchor on.
 *   3. CANCEL  — a CLIENT cancel mid-stream DOES reach the upstream: the
 *      native lane cancels the upstream reader (measured: the upstream body
 *      stream is cancelled), the pump settles before the cancel promise
 *      resolves, and the capture is finalized `closed:false` /
 *      `reason:"client-cancel"` — a clean end, not an error.
 *
 * Points 1 and 2 close the read-back hole the gate named. Point 3 was originally
 * pinned as what the lane did on 2026-10-29 (po-2024): the cancel did NOT reach
 * the upstream, the abandoned turn was billed in full, and the capture ended
 * `reason=error` ("Controller is already closed"). That measurement became
 * issue #780, and this bench is now the regression pin of the FIX: the
 * `reason=error` / "Controller is already closed" pair must never come back.
 * Mutation discipline: removing the `cancel()` callback in `native-handler.ts`
 * turns the cancel case of this file red.
 *
 * ⚠ SCOPE — this file lands on MAIN, and it describes MAIN's native lane.
 * The v14 port is a DIFFERENT tree with a different passthrough: #722's own
 * body (wire #7) states that v14's `native-handler.ts` has a real cancel path
 * ("cap.done cancel-aware — v14's passthrough has a real cancel path, main's
 * doesn't"). That is RAPPORTÉ (from #722's body), NOT measured here — this
 * bench ran on main. The cancel facts below must therefore be read as "main's
 * native lane", and the v14 bench has to re-measure the same three points
 * before the read-back table can carry them.
 *
 * The credential used here is a literal non-secret dummy (`sk-ant-…-stub`):
 * it only has to satisfy the Anthropic-shape predicate so the #296 refusal
 * does not fire. No real key, no key fragment, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { installStubFetch } from "../test-support/stub-fetch.js";
import { NativeHandler } from "./native-handler.js";

/** A minimal but COMPLETE Anthropic SSE turn (message_start … message_stop). */
const CHUNK_1 =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"claude-stub-opus","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bonjour"}}\n\n';
const CHUNK_2 = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const CHUNK_3 = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const STUB_API_KEY = "sk-ant-stub-not-a-real-credential";

interface Stub {
  /** Every outbound call the proxy made toward the upstream. */
  calls: { url: string; headerNames: string[] }[];
  /** True once the upstream body stream was cancelled by the proxy. */
  upstreamCancelled: () => boolean;
  /** Releases the held upstream stream (cancel test). */
  release: () => void;
  /** Undo the fetch stub. */
  restore: () => void;
}

/**
 * A stub upstream that answers a native request with `text/event-stream`.
 * `hold` keeps the stream open after the first chunk, so a client cancel has
 * something to cancel.
 */
function stubNativeSSE(opts: { hold?: boolean } = {}): Stub {
  const calls: { url: string; headerNames: string[] }[] = [];
  let cancelled = false;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const restore = installStubFetch(async (req) => {
    calls.push({ url: req.url, headerNames: [...req.headers.keys()] });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(CHUNK_1));
        if (opts.hold) await gate;
        // #780: a real upstream whose connection the proxy dropped stops
        // producing — it does not write into a cancelled stream. The guard
        // keeps the stub faithful once `cancel()` is propagated.
        if (cancelled) return;
        controller.enqueue(enc.encode(CHUNK_2));
        controller.enqueue(enc.encode(CHUNK_3));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "anthropic-version": "2023-06-01",
      },
    });
  });

  return {
    calls,
    upstreamCancelled: () => cancelled,
    release: () => releaseGate(),
    restore,
  };
}

function buildApp(): Hono {
  const app = new Hono();
  const handler = new NativeHandler();
  app.post("/v1/messages", async (c) => handler.handle(c, await c.req.json()));
  return app;
}

function post(app: Hono): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": STUB_API_KEY,
      "x-claudish-machine": "myia-po-2024",
    },
    body: JSON.stringify({
      model: "claude-stub-opus",
      stream: true,
      max_tokens: 64,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
}

async function waitForCapture(dir: string, timeoutMs = 3000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The capture directory is created LAZILY by the capture itself (at done()
    // time), so a missing directory means "no capture yet", not a failure.
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("resp-") && f.endsWith(".sse"));
    } catch {
      files = [];
    }
    if (files.length > 0) return join(dir, files[0]);
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe("native lane response capture (#722 read-back, grain v17-1)", () => {
  let capDir: string;
  let prevEnv: string | undefined;
  let stub: Stub | null = null;

  beforeEach(() => {
    capDir = join(tmpdir(), `claudish-native-capture-${process.pid}-${Date.now()}`);
    prevEnv = process.env.CLAUDISH_CAPTURE_DIR;
    process.env.CLAUDISH_CAPTURE_DIR = capDir;
  });

  afterEach(() => {
    if (stub) stub.restore();
    stub = null;
    // `Reflect.deleteProperty`, NOT `delete process.env.X` (biome's
    // lint/performance/noDelete) and NOT `= undefined`: measured on bun
    // 1.3.14, assigning undefined to a process.env key stores the STRING
    // "undefined" — the capture would then write to a directory literally
    // named "undefined" in the working directory.
    if (prevEnv === undefined) Reflect.deleteProperty(process.env, "CLAUDISH_CAPTURE_DIR");
    else process.env.CLAUDISH_CAPTURE_DIR = prevEnv;
    try {
      rmSync(capDir, { recursive: true, force: true });
    } catch {}
  });

  it("byte tap + done: the client bytes are the captured bytes, and the capture is finalized", async () => {
    stub = stubNativeSSE();

    const res = await post(buildApp());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // The upstream was called once, at the hardcoded Anthropic origin: the
    // native lane has no URL override, which is WHY this hole existed.
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe("https://api.anthropic.com/v1/messages");

    const clientText = await res.text();
    expect(clientText).toContain('"type":"message_start"');
    expect(clientText).toContain('"type":"message_stop"');

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const captured = readFileSync(file!, "utf-8");

    // The header the .sse readers anchor on (#662).
    expect(captured).toContain("# parser=native");
    expect(captured).toContain("# instance=");
    // The capture is named with the native lane's own label — a reader can
    // tell a native capture from a parsed-provider one.
    expect(file!).toMatch(/resp-\d+-r\d{4}-.+-native-claude-stub-opus\.sse$/);

    // The tapped bytes are the upstream bytes, verbatim.
    expect(captured).toContain('"type":"message_start"');
    expect(captured).toContain('"type":"message_stop"');
    // …and they are the SAME bytes the client received (passthrough, no rewrite).
    expect(captured.slice(captured.indexOf("# ====="))).toContain(clientText.trim());
  });

  it("cancel: a client cancel ends the upstream work, and the capture ends clean", async () => {
    stub = stubNativeSSE({ hold: true });

    const res = await post(buildApp());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('"type":"message_start"');

    await reader.cancel("client went away");
    // Let the pump notice what it notices, then release the held upstream
    // (which must now find its stream already cancelled and produce nothing).
    await new Promise((r) => setTimeout(r, 150));
    stub.release();

    // #780: the client cancel IS propagated upstream — the provider connection
    // is dropped instead of billing the abandoned turn to completion.
    expect(stub.upstreamCancelled()).toBe(true);

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const captured = readFileSync(file!, "utf-8");

    // #780: the capture is finalized as a CLEAN client-cancel — not as an
    // error at the first enqueue into the closed client stream.
    expect(captured).toContain('"reason":"client-cancel"');
    expect(captured).toContain('"closed":false');
    expect(captured).not.toContain("Controller is already closed");

    // The capture holds the bytes that reached the client before the cancel,
    // and NOT the upstream tail that was never read.
    expect(captured).toContain('"type":"content_block_delta"');
    expect(captured).not.toContain('"type":"content_block_stop"');
    expect(captured).not.toContain('"type":"message_stop"');
  });
});
