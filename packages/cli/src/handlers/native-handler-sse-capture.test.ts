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
 *   3. CANCEL  — a CLIENT cancel mid-stream does NOT reach the upstream: the
 *      native lane keeps the upstream turn running to its end (measured: the
 *      upstream body stream was never cancelled), and the capture is finalized
 *      as an ERROR at the first enqueue into the closed client stream
 *      ("Controller is already closed"), holding the upstream bytes up to that
 *      point and NOT the tail that arrived after the cancel.
 *
 * Points 1 and 2 close the read-back hole the gate named. Point 3 is NOT an
 * endorsement: it records what the lane does today, because the answer
 * ("the upstream keeps burning after the client left") is a fact ai-01 asked
 * for and could not measure without a paid probe. Two consequences are visible
 * in the pinned facts, and are reported, not fixed here:
 *   - a cancelled native turn is still billed upstream (no cancel propagation);
 *   - the capture of a cancelled turn ends in `reason=error`, so a reader sees
 *     a truncated capture rather than a clean end.
 * Fixing them means changing the native lane's production behaviour — ai-01's
 * call, not this PR's (QUEUE v17: "AC répond au trou sans changer production
 * pour le banc").
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
import { Hono } from "hono";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHandler } from "./native-handler.js";
import { installStubFetch } from "../test-support/stub-fetch.js";

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
    if (prevEnv === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
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

  it("cancel: a client cancel does not reach the upstream, and the capture ends in error", async () => {
    stub = stubNativeSSE({ hold: true });

    const res = await post(buildApp());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('"type":"message_start"');

    await reader.cancel("client went away");
    // Let the pump notice what it notices, then release the held upstream.
    await new Promise((r) => setTimeout(r, 150));
    stub.release();

    // MEASURED: the client cancel is NOT propagated upstream. The native lane
    // keeps the upstream turn running — it never cancels the upstream reader.
    expect(stub.upstreamCancelled()).toBe(false);

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const captured = readFileSync(file!, "utf-8");

    // MEASURED: the capture is finalized as an ERROR at the first enqueue into
    // the closed client stream — not as a clean end.
    expect(captured).toContain('"reason":"error"');
    expect(captured).toContain("Controller is already closed");

    // MEASURED: it holds the upstream bytes up to the cancel, and NOT the tail
    // that arrived after it — a cancelled turn's capture is TRUNCATED.
    expect(captured).toContain('"type":"content_block_stop"');
    expect(captured).not.toContain('"type":"message_stop"');
  });
});
