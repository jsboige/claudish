/**
 * #1128 — unit pins for the served-model side-channel (WeakMap keyed by
 * Response) and its two appliers.
 *
 * The route-level behavior (header on the wire, both ingresses, capture
 * byte-equality, walk, omission) lives in proxy-server-served-model-route.test.ts.
 * These pins cover the helpers' own contract: identity-preserving absence, the
 * #229-style rebuild that never reads the body, and the carry across a rebuild.
 */

import { describe, expect, test } from "bun:test";
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
