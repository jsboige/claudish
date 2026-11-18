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
import { withFirstUsefulEventWatchdog } from "../first-event-watchdog.js";

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

describe("#1098 ping-only stream gets the well-formed synthetic turn", () => {
  // #1030's measurement: a 200 upstream whose only output was ping frames,
  // confined by the first-event watchdog. The pings WERE forwarded (a ping is
  // a data line, so `forwardedAnyData` armed at the #286 chokepoint), no
  // message_start ever came, nothing was marked failed — and the #286 gate
  // skipped the synthetic trio, leaving the orphan message_delta+message_stop
  // pair that Claude Code reports as "empty or malformed response (HTTP 200)".
  // #1098 splits "forwarded" from "forwarded CONTENT": `forwardedNonPingData`
  // mirrors the watchdog's own `hasUsefulDataLine` (a ping payload is not
  // useful), and the trio fires for a ping-only stream too.
  // CR: the CONFINED label is gated on the watchdog's own expiry signal
  // (x-claudish-first-event-expired header), NOT on "watchdog armed + pings
  // forwarded" — a finite pings-only close satisfies the latter with zero
  // watchdog involvement and used to wear the confined wording (a lie).
  // NOTE the space: the house keep-alive emits {"type":"ping"} (no space);
  // this fixture's JSON.stringify form (with space) proves the UPSTREAM pings
  // were forwarded, not the parser's own.
  const pingsOnly = [
    "event: ping",
    'data: {"type": "ping"}',
    "",
    "event: ping",
    'data: {"type": "ping"}',
    "",
  ].join("\n");

  function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    if (value === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = value;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
      else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = prev;
    });
  }

  test("normal close, watchdog armed (default): trio fires with the GENERIC label — no expiry happened", async () => {
    await withEnv(undefined, async () => {
      const response = createAnthropicPassthroughStream(mockContext(), sseResponse(pingsOnly), {
        modelName: "glm-5.3",
      }) as Response;
      const output = await drain(response);

      // The upstream pings were forwarded (byte-for-byte, space intact).
      expect(output).toContain('{"type": "ping"}');
      // THE bug: message_start used to be absent here.
      expect(output).toContain("event: message_start");
      expect(output).toContain("The model returned an empty response");
      // CR pin: a finite immediate close must NEVER wear the confined
      // wording, however armed the watchdog is — nothing expired.
      expect(output).not.toContain("Upstream confined");
      expect(output).toContain("event: message_stop");
    });
  });

  test("watchdog OFF (=0): trio still fires, generic label", async () => {
    await withEnv("0", async () => {
      const response = createAnthropicPassthroughStream(mockContext(), sseResponse(pingsOnly), {
        modelName: "glm-5.3",
      }) as Response;
      const output = await drain(response);

      expect(output).toContain("event: message_start");
      expect(output).toContain("The model returned an empty response");
      expect(output).not.toContain("Upstream confined");
      expect(output).toContain("event: message_stop");
    });
  });

  test("filtered path (filterThinking): same trio on a normal close, generic label", async () => {
    await withEnv(undefined, async () => {
      const adapter = { shouldFilterThinking: () => true } as any;
      const response = createAnthropicPassthroughStream(mockContext(), sseResponse(pingsOnly), {
        modelName: "glm-5.3",
        adapter,
      }) as Response;
      const output = await drain(response);

      expect(output).toContain('{"type": "ping"}');
      expect(output).toContain("event: message_start");
      expect(output).toContain("The model returned an empty response");
      expect(output).not.toContain("Upstream confined");
      expect(output).toContain("event: message_stop");
    });
  });

  test("INTEGRATION through the real watchdog (200ms): expiry closes the held stream → exactly one start/stop, parseable frames, confined label", async () => {
    await withEnv("200", async () => {
      // A pings-only source that HOLDS open: the only way it ends is the
      // watchdog's own expiry at 200ms. If the watchdog never fires this
      // drain hangs and the test times out — the signal path is proven by
      // the label below, not by the environment variable.
      const encoder = new TextEncoder();
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(pingsOnly));
          // never closes on its own
        },
      });
      const upstream = new Response(held, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const wrapped = withFirstUsefulEventWatchdog(upstream, "test-pings-held");
      const response = createAnthropicPassthroughStream(mockContext(), wrapped, {
        modelName: "glm-5.3",
      }) as Response;
      const output = await drain(response);

      // Cardinalities: EXACTLY one message_start and one message_stop.
      const starts = output.match(/event: message_start\n/g) ?? [];
      const stops = output.match(/event: message_stop\n/g) ?? [];
      expect(starts.length, "exactly one message_start").toBe(1);
      expect(stops.length, "exactly one message_stop").toBe(1);

      // Every data line is parseable JSON (the client's own reader would die
      // on an unparseable frame — the trio must be well-formed end to end).
      for (const line of output.split("\n")) {
        if (line.startsWith("data: ")) {
          expect(() => JSON.parse(line.slice(6)), `parseable: ${line.slice(0, 60)}`).not.toThrow();
        }
      }

      // The expiry signal (not the env, not the pings) carries the label.
      expect(output).toContain(
        "[Upstream confined — no first useful event within 200ms: stream closed, please retry]"
      );
      expect(output).toContain('{"type": "ping"}');
    });
  });
});
