/**
 * Frame coherence — the SSE `event:` line and the JSON `type` must agree.
 *
 * WHY (measured 2026-10-30, local reproduction, no paid probe):
 * the Anthropic client SDK (Python, 0.84.0 AND 0.87.0 — identical verdicts)
 * reads a streamed frame as a PAIR: the SSE event name decides how the frame
 * is routed, and the JSON `type` decides how the payload is validated. The
 * SDK fills a MISSING `type` from the event name (`_streaming.py`:
 * `if is_dict(data) and "type" not in data: data["type"] = sse.event`) — so a
 * frame with no `type` is harmless. A frame whose `type` DISAGREES with the
 * event name is not: the SDK validates the payload against the `type` and
 * dies. Measured on a valid stream with ONE mutated frame:
 *
 *   event: content_block_delta + {"type":"message_delta", …}
 *     → AttributeError: 'NoneType' object has no attribute 'output_tokens'
 *       (the SDK read a message_delta and found no `usage`) — the TURN DIES.
 *   event: content_block_delta + {"type":"thinking_delta", …}  (type hors union)
 *     → frame silently dropped → the answer arrives EMPTY (no error anywhere).
 *   data: {...} with NO `event:` line, or an unknown event name
 *     → frame silently dropped → the answer arrives EMPTY (no error anywhere).
 *
 * The empty-answer shapes are the worst ones: the client reports success and
 * the model never spoke. Every one of them is a frame the proxy RELAYED
 * UNCHANGED — the proxy is the last hop before the client, and it forwarded
 * an incoherent pair without a murmur.
 *
 * THE RULE (one line): the `event:` line is the frame's kind; the JSON `type`
 * is aligned to it. When the event name is absent or unknown, the JSON `type`
 * provides it. A frame that carries neither is relayed unchanged — we never
 * drop a frame we cannot interpret.
 *
 * `error` is deliberately NOT in the set: the parser drops a bare `event:
 * error` header on purpose (the payload goes through finalizeWithError), and
 * synthesizing one here would change an upstream error frame into a client
 * status error.
 *
 * A frame that is ALREADY coherent is relayed byte-for-byte — the repair only
 * touches frames the client would otherwise mis-read.
 */

export const ANTHROPIC_STREAM_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
]);

export interface FrameReconciliation {
  /** The `event:` line to emit (null = emit none). */
  eventLine: string | null;
  /** The `data:` line to emit. */
  dataLine: string;
  changed: boolean;
  /** Machine-readable repair kind — logged, never payload. */
  reason:
    | "type-mismatch"
    | "type-absent"
    | "event-line-absent"
    | "event-name-unknown"
    | null;
  /** The two names involved (structural, never content). */
  eventName: string | null;
  jsonType: string | null;
}

/** "event: content_block_delta" → "content_block_delta". */
export function parseEventName(eventLine: string): string | null {
  const idx = eventLine.indexOf(":");
  if (idx < 0) return null;
  const name = eventLine.slice(idx + 1).trim();
  return name.length > 0 ? name : null;
}

/**
 * Reconcile one frame's `event:` line with its JSON `type`.
 *
 * Never throws: an unparseable payload is relayed unchanged.
 */
export function reconcileFrame(
  eventLine: string | null,
  dataLine: string
): FrameReconciliation {
  const unchanged = (
    reason: FrameReconciliation["reason"] = null
  ): FrameReconciliation => ({
    eventLine,
    dataLine,
    changed: false,
    reason,
    eventName: eventLine ? parseEventName(eventLine) : null,
    jsonType: null,
  });

  if (!dataLine.startsWith("data: ")) return unchanged();

  let payload: any;
  try {
    payload = JSON.parse(dataLine.slice(6));
  } catch {
    return unchanged();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return unchanged();
  }

  const eventName = eventLine ? parseEventName(eventLine) : null;
  const jsonType =
    typeof payload.type === "string" ? payload.type : null;

  // The event name is authoritative when it names a real Anthropic frame.
  if (eventName && ANTHROPIC_STREAM_EVENTS.has(eventName)) {
    if (jsonType === eventName) {
      return { eventLine, dataLine, changed: false, reason: null, eventName, jsonType };
    }
    payload.type = eventName;
    return {
      eventLine,
      dataLine: "data: " + JSON.stringify(payload),
      changed: true,
      reason: jsonType ? "type-mismatch" : "type-absent",
      eventName,
      jsonType,
    };
  }

  // No usable event name — the JSON type is the only source of the kind.
  if (jsonType && ANTHROPIC_STREAM_EVENTS.has(jsonType)) {
    return {
      eventLine: `event: ${jsonType}`,
      dataLine,
      changed: true,
      reason: eventName ? "event-name-unknown" : "event-line-absent",
      eventName,
      jsonType,
    };
  }

  // Neither side names a real Anthropic frame: relayed unchanged. We never
  // drop a frame we cannot interpret.
  return {
    eventLine,
    dataLine,
    changed: false,
    reason: null,
    eventName,
    jsonType,
  };
}
