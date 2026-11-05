/**
 * #431 on `replatform/v14` — the WIRE CONTRACT, pinned at module level.
 *
 * The base's producers: the loop's own `context` classification and, since the
 * #684 port (row 7b), the `busy` emitter in `ComposedHandler` — both pinned
 * end-to-end by the route suite (`proxy-server-role-failover-route.test.ts`,
 * arms S1-S7). What only THIS file can pin is the module's own surface: the
 * reader, and the concurrency-refusal classifier both the handler emitter and
 * the transport 429 ladders consume.
 *
 * The two traps this file exists for are the module's own comments: a reason
 * accepted by the union but missing from the reader's list (silent no-op), and
 * a header whose detail section is parsed into the reason.
 */

import { describe, expect, test } from "bun:test";
import {
  CONCURRENCY_REFUSAL_SKIP_DETAIL,
  STEP_SKIP_HEADER,
  classifyConcurrencyRefusal,
  encodeStepSkipHeader,
  readStepSkip,
  stepSkipDisabled,
} from "./step-skip.js";

const withHeader = (value: string) =>
  new Response(null, { status: 400, headers: { [STEP_SKIP_HEADER]: value } });

describe("#431 wire contract", () => {
  test("every reason in the union round-trips, with and without detail", () => {
    for (const reason of ["context", "busy", "media", "unroutable"] as const) {
      expect(readStepSkip(withHeader(encodeStepSkipHeader(reason)))).toEqual({ reason });
      expect(readStepSkip(withHeader(encodeStepSkipHeader(reason, "cap=1000")))).toEqual({
        reason,
        detail: "cap=1000",
      });
    }
  });

  test("the header name is the one the loop reads — spelled once, here", () => {
    expect(STEP_SKIP_HEADER).toBe("x-claudish-step-skip");
  });

  test("an absent header reads as null — the overwhelming majority of responses", () => {
    expect(readStepSkip(new Response(null, { status: 200 }))).toBeNull();
  });

  test("an UNKNOWN reason reads as null: the loop never acts on a value it cannot read", () => {
    // The failure mode the single reason list exists to prevent — a future
    // producer inventing a reason must extend the union AND the reader.
    expect(readStepSkip(withHeader("throttled; cap=1000"))).toBeNull();
  });

  test("a malformed detail is dropped, never folded into the reason", () => {
    expect(readStepSkip(withHeader("busy ; "))).toEqual({ reason: "busy", detail: undefined });
  });

  test("the kill switch is an explicit `0` and nothing else", () => {
    expect(stepSkipDisabled({})).toBe(false);
    expect(stepSkipDisabled({ CLAUDISH_FAILOVER_STEP_SKIP: "" })).toBe(false);
    expect(stepSkipDisabled({ CLAUDISH_FAILOVER_STEP_SKIP: "1" })).toBe(false);
    expect(stepSkipDisabled({ CLAUDISH_FAILOVER_STEP_SKIP: "0" })).toBe(true);
    expect(stepSkipDisabled({ CLAUDISH_FAILOVER_STEP_SKIP: " 0 " })).toBe(true);
  });
});

describe("#679/#684 — the concurrency-refusal classifier (row 7b)", () => {
  // z.ai's measured shape: HTTP 429, the CODE is the contract (two wordings,
  // string and numeric). Every pin here is a discriminator against a real
  // neighbour signal, not a synthetic negative.
  const body = (code: unknown, message: string) =>
    JSON.stringify({ error: { code, message, type: "rate_limit_error" } });

  test("429 + code 1302 classifies, in both measured spellings", () => {
    expect(
      classifyConcurrencyRefusal(429, body("1302", "Request concurrency limit exceeded"))
    ).toBe(true);
    expect(classifyConcurrencyRefusal(429, body(1302, "concurrency limit reached"))).toBe(true);
  });

  test("the 1308 USAGE wall never matches — a real quota signal, not a busy slot", () => {
    // The discriminator that justifies the classifier's existence: same
    // provider, same status, one code apart, opposite handling (1308 marks
    // the step; 1302 skips it).
    expect(
      classifyConcurrencyRefusal(
        429,
        body("1308", "Usage limit reached, resets at 2026-11-05T00:00:00Z")
      )
    ).toBe(false);
    expect(classifyConcurrencyRefusal(429, body(1308, "usage limit"))).toBe(false);
  });

  test("a 429 without the code — ordinary rate limit or Anthropic account cap — is not a refusal", () => {
    expect(classifyConcurrencyRefusal(429, body(undefined, "Rate limit exceeded"))).toBe(false);
    expect(
      classifyConcurrencyRefusal(
        429,
        JSON.stringify({
          error: {
            type: "rate_limit_error",
            message: "Number of requests has exceeded your per-account rate limit",
          },
        })
      )
    ).toBe(false);
  });

  test("the status gate: a 1302-shaped body under any other status is not a refusal", () => {
    expect(classifyConcurrencyRefusal(200, body("1302", "concurrency"))).toBe(false);
    expect(classifyConcurrencyRefusal(503, body(1302, "concurrency"))).toBe(false);
  });

  test("unparseable and empty bodies read as no", () => {
    expect(classifyConcurrencyRefusal(429, "<html>throttled</html>")).toBe(false);
    expect(classifyConcurrencyRefusal(429, "")).toBe(false);
  });

  test("the skip detail is stable — the loop's marker greps it", () => {
    expect(CONCURRENCY_REFUSAL_SKIP_DETAIL).toBe("code=1302");
  });

  test("the emitter's header round-trips through the reader the loop uses", () => {
    expect(
      readStepSkip(withHeader(encodeStepSkipHeader("busy", CONCURRENCY_REFUSAL_SKIP_DETAIL)))
    ).toEqual({ reason: "busy", detail: "code=1302" });
  });
});
