/**
 * #909 — gzip REQUEST bodies toward providers whose ingress decodes them.
 *
 * Two layers pinned here:
 *
 *   UNIT   — the helper's decision table: capability gate, kill switch,
 *            size floor (default, override, ""/garbage fallback), header
 *            side effect, gunzip round-trip.
 *   WIRE   — behavioral pins through the REAL call sites, driven by
 *            installStubFetch (never Bun.serve, #604): what reaches the
 *            upstream in handle() of ComposedHandler (transport-declared
 *            capability) and of NativeHandler (probed native lane). A body
 *            below the floor must arrive PLAIN with no content-encoding —
 *            a "gzip everything" regression would burn CPU on small turns
 *            and risk unprobed middleboxes.
 *
 * No credential, no network: the anthropic origin stays hardcoded, the
 * stub intercepts globalThis.fetch (pattern of native-handler-sse-capture).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ProviderTransport } from "../../providers/transport/types.js";
import { installStubFetch } from "../../test-support/stub-fetch.js";
import { ComposedHandler } from "../composed-handler.js";
import { NativeHandler } from "../native-handler.js";
import {
  compressUpstreamRequestBody,
  upstreamCompressionEnabled,
  upstreamCompressionMinBytes,
} from "./upstream-compression.js";

const ENV_NAMES = ["CLAUDISH_UPSTREAM_COMPRESS", "CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES"] as const;
const savedEnv: Record<string, string | undefined> = {};
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
});

afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
  for (const name of ENV_NAMES) {
    // Reflect.deleteProperty, NOT `= undefined`: on bun, assigning undefined
    // to a process.env key stores the STRING "undefined" (measured,
    // native-handler-sse-capture.test.ts).
    if (savedEnv[name] === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = savedEnv[name]!;
  }
});

/** A body comfortably above the default 16384-byte floor. */
function bigBody(bytes = 30000): string {
  return JSON.stringify({
    model: "fugu-ultra",
    max_tokens: 16,
    messages: [{ role: "user", content: "x".repeat(bytes) }],
  });
}

describe("#909 unit — compressUpstreamRequestBody decision table", () => {
  test("capability undefined → the plain string comes back and no header is set", () => {
    const headers: Record<string, string> = {};
    const body = bigBody();
    const out = compressUpstreamRequestBody({ capability: undefined, headers, body, label: "t" });
    expect(out).toBe(body);
    expect(headers["content-encoding"]).toBeUndefined();
  });

  test('a non-gzip capability value is not a capability → plain (only "gzip" is probed)', () => {
    const headers: Record<string, string> = {};
    const body = bigBody();
    const out = compressUpstreamRequestBody({ capability: "br", headers, body, label: "t" });
    expect(out).toBe(body);
    expect(headers["content-encoding"]).toBeUndefined();
  });

  test("kill switch CLAUDISH_UPSTREAM_COMPRESS=0 disables even with capability + big body", () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "0";
    const headers: Record<string, string> = {};
    const body = bigBody();
    const out = compressUpstreamRequestBody({ capability: "gzip", headers, body, label: "t" });
    expect(out).toBe(body);
    expect(headers["content-encoding"]).toBeUndefined();
  });

  test('kill switch "" (compose ${VAR:-} present-empty trap) still means ENABLED', () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "";
    const headers: Record<string, string> = {};
    const out = compressUpstreamRequestBody({
      capability: "gzip",
      headers,
      body: bigBody(),
      label: "t",
    });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(headers["content-encoding"]).toBe("gzip");
  });

  test("capable + above floor → gzipped, header set, gunzip round-trips to the original", () => {
    const headers: Record<string, string> = {};
    const body = bigBody();
    const out = compressUpstreamRequestBody({ capability: "gzip", headers, body, label: "t" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(out as Uint8Array).toString("utf-8")).toBe(body);
    // gzip on JSON text must actually shrink it — a no-gain compression
    // would mean the wire body is not what this feature is for.
    expect((out as Uint8Array).length).toBeLessThan(body.length);
  });

  test("capable but below floor → plain, no header (small turns pay no gzip tax)", () => {
    const headers: Record<string, string> = {};
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = compressUpstreamRequestBody({ capability: "gzip", headers, body, label: "t" });
    expect(out).toBe(body);
    expect(headers["content-encoding"]).toBeUndefined();
  });

  test("floor override lowers the threshold — a small repetitive body then compresses", () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "8";
    const headers: Record<string, string> = {};
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "ab".repeat(120) }],
    });
    const out = compressUpstreamRequestBody({ capability: "gzip", headers, body, label: "t" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(headers["content-encoding"]).toBe("gzip");
  });

  test("no-gain guard: a body whose gzip would be LARGER goes out plain (gzip overhead wins)", () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "8";
    const headers: Record<string, string> = {};
    // Short, varied, non-repetitive text: deflate has nothing to squeeze and
    // the ~20B gzip header+trailer exceeds any gain — the guard must keep
    // the plain body instead of shipping gzip overhead for nothing.
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "qwertyuiopasdfghjklzxcvbnm0123456789" }],
    });
    const out = compressUpstreamRequestBody({ capability: "gzip", headers, body, label: "t" });
    expect(out).toBe(body);
    expect(headers["content-encoding"]).toBeUndefined();
  });
});

describe("#909 unit — env readers", () => {
  test('upstreamCompressionEnabled: default true, "0" false, "" true, "1" true', () => {
    Reflect.deleteProperty(process.env, "CLAUDISH_UPSTREAM_COMPRESS");
    expect(upstreamCompressionEnabled()).toBe(true);
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "0";
    expect(upstreamCompressionEnabled()).toBe(false);
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "";
    expect(upstreamCompressionEnabled()).toBe(true);
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "1";
    expect(upstreamCompressionEnabled()).toBe(true);
  });

  test('upstreamCompressionMinBytes: default 16384; override honored; ""/garbage/negative fall back', () => {
    Reflect.deleteProperty(process.env, "CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES");
    expect(upstreamCompressionMinBytes()).toBe(16384);
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "4096";
    expect(upstreamCompressionMinBytes()).toBe(4096);
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "";
    expect(upstreamCompressionMinBytes()).toBe(16384);
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "garbage";
    expect(upstreamCompressionMinBytes()).toBe(16384);
    process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES = "-5";
    expect(upstreamCompressionMinBytes()).toBe(16384);
  });
});

/** Minimal Hono Context capturing c.json() (pattern of composed-handler-error.test.ts). */
function makeContext(): { c: Context; status: number } {
  let status = 0;
  const c = {
    req: { header: () => ({}) },
    header: () => {},
    json: (body: unknown, statusOrInit?: number | ResponseInit) => {
      status = typeof statusOrInit === "number" ? statusOrInit : 200;
      return new Response(JSON.stringify(body), { status });
    },
    body: (stream: ReadableStream, init?: ResponseInit) => new Response(stream, init),
  } as unknown as Context;
  return {
    c,
    get status() {
      return status;
    },
  };
}

function makeTransport(requestCompression?: "gzip"): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    requestCompression,
    getEndpoint: () => "http://localhost:19999/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

describe("#909 wire — ComposedHandler.handle sends what the transport declared", () => {
  test('requestCompression:"gzip" + big body → the UPSTREAM receives gzip + content-encoding', async () => {
    const seen: { encoding: string | null; bytes: Uint8Array }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({
        encoding: req.headers.get("content-encoding"),
        bytes: new Uint8Array(await req.arrayBuffer()),
      });
      // 401, no forceRefreshAuth on the transport: the handler surfaces the
      // error and never retries — exactly one upstream call, one wire body.
      return new Response(JSON.stringify({ error: { message: "no key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const handler = new ComposedHandler(
      makeTransport("gzip"),
      "fugu-ultra",
      "fugu-ultra",
      8464,
      {}
    );
    const { c } = makeContext();
    await handler.handle(c, JSON.parse(bigBody()));

    expect(seen.length).toBe(1);
    expect(seen[0].encoding).toBe("gzip");
    const roundTripped = JSON.parse(gunzipSync(seen[0].bytes).toString("utf-8"));
    expect(roundTripped.model).toBe("fugu-ultra");
  });

  test("no declared capability → the UPSTREAM receives the plain string, no content-encoding", async () => {
    const seen: { encoding: string | null; text: string }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({ encoding: req.headers.get("content-encoding"), text: await req.text() });
      return new Response(JSON.stringify({ error: { message: "no key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const handler = new ComposedHandler(
      makeTransport(undefined),
      "fugu-ultra",
      "fugu-ultra",
      8464,
      {}
    );
    const { c } = makeContext();
    await handler.handle(c, JSON.parse(bigBody()));

    expect(seen.length).toBe(1);
    expect(seen[0].encoding).toBeNull();
    expect(JSON.parse(seen[0].text).model).toBe("fugu-ultra");
  });

  test("kill switch 0 → big body still arrives PLAIN on the wire", async () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "0";
    const seen: { encoding: string | null }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({ encoding: req.headers.get("content-encoding") });
      return new Response(JSON.stringify({ error: { message: "no key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const handler = new ComposedHandler(
      makeTransport("gzip"),
      "fugu-ultra",
      "fugu-ultra",
      8464,
      {}
    );
    const { c } = makeContext();
    await handler.handle(c, JSON.parse(bigBody()));

    expect(seen[0].encoding).toBeNull();
  });
});

/** A minimal but COMPLETE Anthropic SSE turn (native lane passthrough). */
const NATIVE_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"claude-stub-opus","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("#909 wire — NativeHandler.handle gzips toward api.anthropic.com (probed lane)", () => {
  // The native lane writes response captures when it succeeds — without this
  // the tests pollute the default /captures dir (pattern + pitfalls of
  // native-handler-sse-capture.test.ts).
  let capDir: string;
  let prevCapture: string | undefined;

  beforeEach(() => {
    capDir = join(tmpdir(), `claudish-909-native-${process.pid}-${Date.now()}`);
    prevCapture = process.env.CLAUDISH_CAPTURE_DIR;
    process.env.CLAUDISH_CAPTURE_DIR = capDir;
  });

  afterEach(() => {
    if (prevCapture === undefined) Reflect.deleteProperty(process.env, "CLAUDISH_CAPTURE_DIR");
    else process.env.CLAUDISH_CAPTURE_DIR = prevCapture;
    try {
      rmSync(capDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * The native lane finalizes its response capture ASYNCHRONOUSLY after the
   * client consumed the stream — rmSync in afterEach must not race that
   * write (measured: ENOENT on the capture file). Wait (bounded) for the
   * file to appear, then settle. This is #722's waitForCapture pattern.
   */
  async function awaitCaptureSettled(dir: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.startsWith("resp-"));
      } catch {
        files = [];
      }
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  function buildApp(): Hono {
    const app = new Hono();
    const handler = new NativeHandler();
    app.post("/v1/messages", async (c) => handler.handle(c, await c.req.json()));
    return app;
  }

  async function post(app: Hono, content: string): Promise<Response> {
    return app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-stub-not-a-real-credential",
        "x-claudish-machine": "myia-po-2027",
      },
      body: JSON.stringify({
        model: "claude-stub-opus",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content }],
      }),
    });
  }

  test("big body → the UPSTREAM receives gzip + content-encoding at the anthropic origin", async () => {
    const seen: { url: string; encoding: string | null; bytes: Uint8Array }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({
        url: req.url,
        encoding: req.headers.get("content-encoding"),
        bytes: new Uint8Array(await req.arrayBuffer()),
      });
      return new Response(NATIVE_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await post(buildApp(), "x".repeat(30000));
    expect(res.status).toBe(200);

    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].encoding).toBe("gzip");
    const roundTripped = JSON.parse(gunzipSync(seen[0].bytes).toString("utf-8"));
    expect(roundTripped.model).toBe("claude-stub-opus");
    await res.text();
    await awaitCaptureSettled(capDir);
  });

  test("small body (below floor) → PLAIN at the same origin, no content-encoding", async () => {
    const seen: { encoding: string | null; text: string }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({ encoding: req.headers.get("content-encoding"), text: await req.text() });
      return new Response(NATIVE_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await post(buildApp(), "ping");
    expect(res.status).toBe(200);

    expect(seen[0].encoding).toBeNull();
    expect(JSON.parse(seen[0].text).model).toBe("claude-stub-opus");
    await res.text();
    await awaitCaptureSettled(capDir);
  });

  test("kill switch 0 → big body arrives PLAIN on the native lane too", async () => {
    process.env.CLAUDISH_UPSTREAM_COMPRESS = "0";
    const seen: { encoding: string | null }[] = [];
    restoreFetch = installStubFetch(async (req) => {
      seen.push({ encoding: req.headers.get("content-encoding") });
      return new Response(NATIVE_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await post(buildApp(), "x".repeat(30000));
    expect(res.status).toBe(200);
    expect(seen[0].encoding).toBeNull();
    await res.text();
    await awaitCaptureSettled(capDir);
  });
});
