/**
 * #1014 — the synthetic `message_start` frames seed the cache counters.
 *
 * Rule (b) of #179 (`docs/reference/model-routing.md`): `message_start` must
 * seed BOTH cache counters at an explicit 0. Claude Code reconstructs the
 * context size as the raw sum `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`; an absent seed key stays `undefined` through the
 * delta merge and turns that sum into `NaN`. The #444 sweep seeded every real
 * parser via `messageStartUsage()`; these two SYNTHETIC paths on main were not
 * part of it:
 *
 *   1. `finalizeWithError` (!sawMessageStart) — the last-resort graceful
 *      surface for an in-stream error before any start passed.
 *   2. The #286 empty-response tail (!sawMessageStart && !forwardedAnyData) —
 *      a stream that delivered nothing still owes the client a start.
 *
 * The pin per site: the synthetic start carries the three input counters with
 * both cache keys at 0. Red by mutation: revert a site's seed to the old
 * keyless literal and the matching test fails (its cache keys read
 * `undefined`).
 *
 * The prior carry-through (inputTokens → the seed's input_tokens) is the
 * helper's own contract, pinned in message-start-usage's tests — here we only
 * assert it stays a positive number, which is the NaN-relevant half.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

function sseResponse(raw: string): Response {
  return new Response(raw, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drain(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function mockContext(): any {
  const headers = new Headers();
  const c: any = {
    header: (k: string, v: string) => headers.set(k, v),
    json: () => null,
    headers,
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

/** Extract the (single) message_start frame's usage object from SSE output. */
function messageStartUsageFrame(output: string): Record<string, unknown> {
  const match = output.match(/event: message_start\ndata: (.+)\n/);
  expect(match, "output contains a message_start frame").toBeTruthy();
  const frame = JSON.parse(match![1]) as {
    message: { usage: Record<string, unknown> };
  };
  return frame.message.usage;
}

describe("#1014 synthetic message_start seeds the cache counters (#179 rule b)", () => {
  test("finalizeWithError: an in-stream error before any start seeds both cache keys at 0", async () => {
    // A non-policy in-stream error (no retry configured): finalizeWithError
    // builds the synthetic start + notice + stop.
    const raw = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "boom before start" },
    })}\n\n`;
    const response = createAnthropicPassthroughStream(mockContext(), sseResponse(raw), {
      modelName: "glm-5.3",
    }) as Response;
    const output = await drain(response);

    const usage = messageStartUsageFrame(output);
    expect(usage.input_tokens, "input seed stays a positive number").toBeGreaterThan(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    // The graceful surface still terminates the turn.
    expect(output).toContain("event: message_stop");
    expect(output).toContain("Upstream provider error");
  });

  test("#286 empty tail: a stream that delivered nothing seeds both cache keys at 0", async () => {
    // Zero events, clean close: the empty-response tail owes the client a
    // start, and it goes through the same seed.
    const response = createAnthropicPassthroughStream(mockContext(), sseResponse(""), {
      modelName: "glm-5.3",
    }) as Response;
    const output = await drain(response);

    const usage = messageStartUsageFrame(output);
    expect(usage.input_tokens, "input seed stays a positive number").toBeGreaterThan(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(output).toContain("The model returned an empty response");
    expect(output).toContain("event: message_stop");
  });
});
