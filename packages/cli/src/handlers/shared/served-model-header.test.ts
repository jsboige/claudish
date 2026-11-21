/**
 * #1128 — unit pins for the served-model side-channel (WeakMap keyed by
 * Response) and its two appliers.
 *
 * The route-level behavior (header on the wire, both ingresses, capture
 * byte-equality, walk, omission) lives in proxy-server-served-model-route.test.ts.
 * These pins cover the helpers' own contract: identity-preserving absence, the
 * #229-style rebuild that never reads the body, and the carry across a rebuild.
 *
 * The C1 describe pins the TRANSPORT-FALLBACK omission guard in
 * ComposedHandler.markServedModel (review C1): a provider whose
 * `getActiveModelName()` diverges from `bareModelName` (gemini-codeassist is
 * the only production implementer — a capacity fallback that changed the model
 * mid-flight) makes capture and truth disagree, so the header is omitted
 * rather than publish a value the corpus cannot corroborate (AC4).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ProviderTransport } from "../../providers/transport/types.js";
import { ComposedHandler } from "../composed-handler.js";
import {
  SERVED_MODEL_HEADER,
  carryServedModelHeader,
  setServedModel,
  withServedModelHeader,
} from "./served-model-header.js";

function jsonResponse(headers: Record<string, string> = {}): Response {
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("#1128 — withServedModelHeader", () => {
  test("unmarked response: returned UNCHANGED (same object, no header) — omission, never a guess", () => {
    const res = jsonResponse();
    const out = withServedModelHeader(res);
    expect(out).toBe(res);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBeNull();
  });

  test("marked response: header set to the exact recorded value; status and existing headers preserved", async () => {
    const res = jsonResponse({ "x-keep": "yes" });
    setServedModel(res, "glm-5.3");
    const out = withServedModelHeader(res);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBe("glm-5.3");
    expect(out.headers.get("x-keep")).toBe("yes");
    expect(out.status).toBe(200);
    // Body passes through untouched — readable exactly once, same bytes.
    expect(await out.text()).toBe('{"ok":true}');
  });

  test("streaming body: the rebuild does not consume the stream — content arrives intact", async () => {
    const sse = "data: {\"type\":\"message_start\"}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    const res = new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    setServedModel(res, "kimi-k2.5");
    const out = withServedModelHeader(res);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBe("kimi-k2.5");
    expect(await out.text()).toBe(sse);
  });
});

describe("#1128 — carryServedModelHeader", () => {
  test("value on `from` (the hub's real HTTP header on a NOMINAL sidecar) lands on the rebuilt `to`", () => {
    const from = jsonResponse({ [SERVED_MODEL_HEADER]: "hub-served-concrete" });
    const to = jsonResponse({ "Content-Type": "application/json" });
    const out = carryServedModelHeader(from, to);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBe("hub-served-concrete");
    expect(out.headers.get("Content-Type")).toBe("application/json");
  });

  test("no value on `from`: `to` returned as the SAME object, untouched", () => {
    const from = jsonResponse();
    const to = jsonResponse();
    expect(carryServedModelHeader(from, to)).toBe(to);
    expect(to.headers.get(SERVED_MODEL_HEADER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C1 (review) — the transport-fallback omission guard in markServedModel.
// Driven through a REAL ComposedHandler success turn (stubbed upstream SSE),
// because the guard reads `this.provider.getActiveModelName()` — the route
// harness's plain custom endpoints have no such method, and the production
// implementer (gemini-codeassist) needs OAuth this bench must not touch.
// ---------------------------------------------------------------------------
const MODEL = "fugu-ultra";
const realFetchUnit = globalThis.fetch;

function fallbackTransport(activeModel: string | undefined): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://upstream.test/v1/chat/completions",
    getHeaders: () => ({}),
    getActiveModelName: () => activeModel,
  } as unknown as ProviderTransport;
}

/** A healthy openai-sse upstream answer (same shape the route harness uses). */
function successSSE(): Response {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-unit",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: "" }) +
      chunk({ content: "unit ok" }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const PAYLOAD = {
  model: MODEL,
  max_tokens: 64,
  stream: true,
  messages: [{ role: "user", content: "hi" }],
};

async function driveSuccessTurn(activeModel: string | undefined): Promise<Response> {
  const handler = new ComposedHandler(fallbackTransport(activeModel), MODEL, MODEL, 8462, {});
  const app = new Hono();
  app.post("/v1/messages", async (c: any) => handler.handle(c, PAYLOAD));
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => successSSE();
  try {
    return await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(PAYLOAD),
      headers: { "content-type": "application/json" },
    });
  } finally {
    (globalThis as any).fetch = original;
  }
}

describe("#1128 — C1: transport-fallback divergence omits the header (AC4)", () => {
  let capDir: string;
  let prevCapture: string | undefined;

  beforeEach(() => {
    capDir = mkdtempSync(join(tmpdir(), `claudish-sm-c1-${process.pid}-`));
    prevCapture = process.env.CLAUDISH_CAPTURE_DIR;
    process.env.CLAUDISH_CAPTURE_DIR = capDir;
  });

  afterEach(() => {
    if (prevCapture === undefined) Reflect.deleteProperty(process.env, "CLAUDISH_CAPTURE_DIR");
    else process.env.CLAUDISH_CAPTURE_DIR = prevCapture;
    try { rmSync(capDir, { recursive: true, force: true }); } catch {}
    globalThis.fetch = realFetchUnit;
  });

  test("getActiveModelName() DIVERGES from bareModelName → NO header (omitted, never guessed)", async () => {
    const res = await driveSuccessTurn("gca-capacity-fallback");
    const out = withServedModelHeader(res); // the route's own applier
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBeNull();
    // The turn itself succeeded — the omission is the guard, not a dead pipeline.
    expect(out.status).toBe(200);
    const text = await out.text();
    expect(text).toContain("message_stop");
  });

  test("control: getActiveModelName() EQUAL to bareModelName → header present (guard does not over-fire)", async () => {
    const res = await driveSuccessTurn(MODEL);
    const out = withServedModelHeader(res);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBe(MODEL);
  });

  test("control: transport reporting NO fallback (undefined) → header present", async () => {
    const res = await driveSuccessTurn(undefined);
    const out = withServedModelHeader(res);
    expect(out.headers.get(SERVED_MODEL_HEADER)).toBe(MODEL);
  });
});
