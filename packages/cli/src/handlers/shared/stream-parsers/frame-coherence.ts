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
 * THE RULE (one line): the `event:` line and the JSON `type` must describe the
 * SAME frame, and the PAYLOAD decides which one is right when they disagree —
 * because the client validates the payload against the JSON `type` and routes
 * the frame by the event name. So:
 *
 *   - `type` absent            → take the event name (what the SDK itself does);
 *   - the two agree            → touch nothing (byte-for-byte relay);
 *   - they disagree            → keep whichever one the PAYLOAD satisfies, and
 *                                align the other to it. If the payload satisfies
 *                                neither, the frame is left alone (unrepairable —
 *                                the upstream body is broken, not the pair);
 *   - no usable event name     → the JSON `type` provides it (the SDK silently
 *                                DROPS a frame whose event name it does not
 *                                know, so the name has to exist).
 *
 * A frame that carries neither is relayed unchanged — we never drop a frame we
 * cannot interpret.
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
    | "event-name-mismatch"
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

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Does the payload satisfy the schema of this frame kind?
 *
 * The client validates the payload against the JSON `type`; when the two
 * disagree, the payload is the tie-breaker — it is the only witness of what
 * the frame really is. The predicates are deliberately conservative and
 * mutually exclusive, so a payload identifies AT MOST ONE kind.
 */
export function payloadSatisfies(kind: string, p: any): boolean {
  if (!isObject(p)) return false;
  switch (kind) {
    case "message_start":
      return isObject(p.message);
    case "message_delta":
      // A message_delta carries `usage`; a content_block_delta does not.
      return isObject(p.delta) && isObject(p.usage);
    case "message_stop":
      return (
        !isObject(p.delta) &&
        !isObject(p.content_block) &&
        !isObject(p.message) &&
        typeof p.index !== "number"
      );
    case "content_block_start":
      return isObject(p.content_block);
    case "content_block_delta":
      return isObject(p.delta) && !isObject(p.usage);
    case "content_block_stop":
      return (
        !isObject(p.delta) &&
        !isObject(p.content_block) &&
        !isObject(p.message) &&
        typeof p.index === "number"
      );
    case "ping":
      return true;
    default:
      return false;
  }
}

/** The kinds a payload can identify (ping carries no body of its own). */
const PAYLOAD_KINDS = [
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
] as const;

/**
 * The ONE kind the payload identifies, or null when it identifies none (or
 * several — an ambiguous body is not a witness).
 */
export function soleKindSatisfiedBy(p: any): string | null {
  const hits = PAYLOAD_KINDS.filter((k) => payloadSatisfies(k, p));
  return hits.length === 1 ? hits[0] : null;
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

  const eventUsable = eventName !== null && ANTHROPIC_STREAM_EVENTS.has(eventName);
  const typeUsable = jsonType !== null && ANTHROPIC_STREAM_EVENTS.has(jsonType);

  // No usable event name — the JSON type is the only source of the kind. The
  // SDK silently DROPS a frame whose event name it does not know, so the name
  // has to exist; without it the answer arrives empty.
  if (!eventUsable) {
    if (typeUsable) {
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

  // A usable event name.
  if (!typeUsable) {
    // The JSON type is missing or outside the union: the event name is the
    // only witness of the frame's kind. A known type is still better than an
    // unknown one for the client's validation.
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

  if (jsonType === eventName) {
    return { eventLine, dataLine, changed: false, reason: null, eventName, jsonType };
  }

  // They disagree and both are real Anthropic kinds: the PAYLOAD decides —
  // it is the only witness of what the frame really is.
  const payloadKind = soleKindSatisfiedBy(payload);
  if (payloadKind && payloadKind !== eventName && payloadKind !== jsonType) {
    // The body says a THIRD kind: both names are wrong. The payload wins,
    // and the pair is aligned on it — the client's validation then passes
    // instead of killing the turn.
    payload.type = payloadKind;
    return {
      eventLine: `event: ${payloadKind}`,
      dataLine: "data: " + JSON.stringify(payload),
      changed: true,
      reason: "type-mismatch",
      eventName,
      jsonType,
    };
  }
  if (payloadKind === eventName) {
    payload.type = eventName;
    return {
      eventLine,
      dataLine: "data: " + JSON.stringify(payload),
      changed: true,
      reason: "type-mismatch",
      eventName,
      jsonType,
    };
  }
  if (payloadKind === jsonType) {
    // The body matches the JSON type: the event NAME is the wrong one, and it
    // has to be fixed — the SDK drops a frame whose event name it does not
    // know.
    return {
      eventLine: `event: ${jsonType}`,
      dataLine,
      changed: true,
      reason: "event-name-mismatch",
      eventName,
      jsonType,
    };
  }

  // The payload identifies no kind (a broken body): the event line is the
  // frame's declaration, so the JSON type is aligned to it — the pair agrees,
  // and the failure stays where it belongs (the upstream body).
  payload.type = eventName;
  return {
    eventLine,
    dataLine: "data: " + JSON.stringify(payload),
    changed: true,
    reason: "type-mismatch",
    eventName,
    jsonType,
  };
}
