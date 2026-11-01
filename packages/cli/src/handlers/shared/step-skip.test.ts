/**
 * #431 on `replatform/v14` — the WIRE CONTRACT, pinned at module level.
 *
 * Why the route suite cannot pin this arm: on main the header is emitted by
 * `ComposedHandler` on its own final Response; this base has no such producer
 * yet (no `media-cap`, no concurrency-refusal marker — see the module header),
 * and an upstream-supplied header never reaches the loop (measured: the
 * handler re-wraps a non-ok body into an Anthropic envelope and the response
 * it returns carries none of the upstream's custom headers). So the reader is
 * pinned here, and the loop's use of it is pinned by the `context` arm in
 * `proxy-server-role-failover-route.test.ts`.
 *
 * The two traps this file exists for are the module's own comments: a reason
 * accepted by the union but missing from the reader's list (silent no-op), and
 * a header whose detail section is parsed into the reason.
 */

import { describe, expect, test } from "bun:test";
import {
  STEP_SKIP_HEADER,
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
