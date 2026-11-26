import { describe, expect, test } from "bun:test";
import {
  UPSTREAM_ERROR_HEADER,
  UPSTREAM_ERROR_MARKER,
  carryUpstreamErrorMarker,
  isMarkedUpstreamError,
} from "./upstream-error-marker.js";

/**
 * #1213 — the wire contract of the upstream-error marker, pinned by itself.
 *
 * The hub writes the header (composed-handler.ts, the two sites that relay an
 * upstream status), the relay reads it (relay.ts) and two rebuilds carry it
 * (the OpenAI ingress, the relay's non-streaming branch). The route-level pins
 * (proxy-server-upstream-error-marker.test.ts) drive the hub side through the
 * real routes; the relay side is pinned in fork/server/relay.test.ts. This file
 * pins the one thing neither can: the NAME and VALUE on the wire, and the
 * predicate's truth table — every conjunct is load-bearing.
 */

function res(status: number, marker?: string): Response {
  return new Response("body", {
    status,
    headers: marker === undefined ? {} : { [UPSTREAM_ERROR_HEADER]: marker },
  });
}

describe("#1213 — the marker's name and value on the wire", () => {
  test("the header name and the marker value are fixed — the relay and the hub must agree byte for byte", () => {
    expect(UPSTREAM_ERROR_HEADER).toBe("x-claudish-upstream-error");
    expect(UPSTREAM_ERROR_MARKER).toBe("1");
    // The same registry as #318's marker: our own, claudish-prefixed.
    expect(UPSTREAM_ERROR_HEADER.startsWith("x-claudish-")).toBe(true);
  });
});

describe("#1213 — isMarkedUpstreamError: truth table", () => {
  test("a 5xx with the exact marker is the ONLY true case", () => {
    expect(isMarkedUpstreamError(res(500, "1"))).toBe(true);
    expect(isMarkedUpstreamError(res(502, "1"))).toBe(true);
    expect(isMarkedUpstreamError(res(503, "1"))).toBe(true);
    expect(isMarkedUpstreamError(res(504, "1"))).toBe(true);
    expect(isMarkedUpstreamError(res(599, "1"))).toBe(true);
  });

  test("no header → false, whatever the status (an old hub, or the hub's own 5xx)", () => {
    expect(isMarkedUpstreamError(res(500))).toBe(false);
    expect(isMarkedUpstreamError(res(502))).toBe(false);
    expect(isMarkedUpstreamError(res(503))).toBe(false);
  });

  test("a wrong value is inert — the predicate is an equality, not a presence check", () => {
    for (const value of ["true", "0", "yes", "2", "01", "one", "1;1"]) {
      expect(isMarkedUpstreamError(res(502, value))).toBe(false);
    }
  });

  test("a whitespace-padded value IS the marker — Headers strips HTTP optional whitespace, as the wire does", () => {
    // Not a second accepted spelling: `x-claudish-upstream-error: 1 ` and
    // ` 1` are the same header value by RFC 9110 §5.5 (OWS is not part of the
    // field value). Pinned so nobody "tightens" the predicate into trimming.
    expect(isMarkedUpstreamError(res(502, "1 "))).toBe(true);
    expect(isMarkedUpstreamError(res(502, " 1"))).toBe(true);
  });

  test("a 4xx carrying the header is NOT a marked upstream error — it keeps its ordinary 4xx path", () => {
    expect(isMarkedUpstreamError(res(400, "1"))).toBe(false);
    expect(isMarkedUpstreamError(res(429, "1"))).toBe(false);
  });

  test("a 2xx carrying the header is not one either", () => {
    expect(isMarkedUpstreamError(res(200, "1"))).toBe(false);
  });
});

describe("#1213 — carryUpstreamErrorMarker: the #229 carry pattern", () => {
  test("a value on `from` is copied onto `to`; status and body are `to`'s own", async () => {
    const from = new Response("hub body", {
      status: 502,
      headers: { [UPSTREAM_ERROR_HEADER]: "1" },
    });
    const to = new Response(JSON.stringify({ error: { message: "translated" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
    const out = carryUpstreamErrorMarker(from, to);

    expect(out).not.toBe(to); // a rebuild, not an in-place mutation
    expect(out.status).toBe(502);
    expect(out.headers.get(UPSTREAM_ERROR_HEADER)).toBe("1");
    expect(out.headers.get("content-type")).toBe("application/json"); // `to`'s headers survive
    expect(await out.text()).toBe(JSON.stringify({ error: { message: "translated" } }));
  });

  test("no value on `from` → `to` is returned UNTOUCHED (the same object), nothing invented", () => {
    const from = new Response("ok", { status: 502 });
    const to = new Response("{}", { status: 502 });
    expect(carryUpstreamErrorMarker(from, to)).toBe(to);
    expect(to.headers.get(UPSTREAM_ERROR_HEADER)).toBeNull();
  });

  test("never throws — a `from` without readable headers returns `to`", () => {
    const to = new Response("{}", { status: 502 });
    const bogus = { headers: null } as unknown as Response;
    expect(carryUpstreamErrorMarker(bogus, to)).toBe(to);
  });
});
