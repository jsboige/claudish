/**
 * #565 — admission census over DECLARED windows (v14 port, port-map row 1).
 *
 * Incident 2026-10-20: a 1.2k-message `/compact` turn (~1.1M tokens) reached the
 * hub, the nominal answered a MiniMax 400 ("Input too large"), and the client
 * got provider jargon that sent a whole diagnosis thread down the wrong path.
 * No lane in the fleet has a window anywhere near that size, so the request was
 * doomed at admission — the proxy could have said so itself.
 *
 * Deliberately NOT a rescue: nothing downstream can take the request, the
 * correct outcome IS the refusal. The only question is whether it is announced
 * locally, with numbers, or surfaces as an opaque upstream 400.
 *
 * The answer is a RECOVERABLE turn (HTTP 200 + a factual text block + a real
 * `usage.input_tokens`), never a bare 400: the client's context gauge advances
 * with the measured size, so its own compaction fires on the next turn. A 400
 * here would reproduce the `/compact` retry loop — the client resends the
 * identical body forever (the #79 incident on main).
 *
 * SCOPE ON THIS BASE: only the #565 half of main's `context-overflow.ts` is
 * ported (row 1) — the census, its refusal text, the kill switch, and the
 * recovery-turn constructors the refusal answer needs. The #79 upstream-refusal
 * classifier (`classifyContextOverflow`) and the learned provider cap are a
 * LATER row (main's step-skip producers); `countMediaBlocks` already lives in
 * `media-cap.ts` here and stays separate until that row lands, per the port
 * map's row-7a note. Provenance: main #573 (a774f817) + #610 (8bb52c70).
 */

/**
 * #441/#442 — fixed token allocation charged for ONE image/document block
 * when estimating for a refusal. A 1 MB screenshot is ~1.5k tokens on a vision
 * lane and ~0 once described/stripped by the vision fallback — never the
 * ~750k its base64 characters score under the /4 convention.
 */
export const MEDIA_BLOCK_TOKENS = 1600;

/**
 * Prompt estimate for the admission census — DISTINCT from the /4 payload
 * convention used by `estimatePayloadTokens` (endpoint-token-budget.ts), where
 * over-counting base64 is safe: an inflated count only compacts earlier. For a
 * REFUSAL an inflated estimate is a FALSE refusal — measured on main (review
 * c.6114982206), a 1.03 MB screenshot plus "describe this screenshot" scored
 * ~750k tokens under /4 and would have refused a perfectly servable vision
 * turn against a 262 144 window. Each image/document `source.data` is
 * therefore replaced by a fixed MEDIA_BLOCK_TOKENS allocation instead of its
 * base64 length / 4.
 */
export function estimateClampTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  try {
    const { stripped, count } = stripMediaData(payload);
    return Math.ceil(JSON.stringify(stripped).length / 4) + count * MEDIA_BLOCK_TOKENS;
  } catch {
    return 0;
  }
}

/**
 * Shared media walk: replaces every `source.data` base64 payload with an empty
 * string (so the JSON length is the text-only size) and counts the blocks.
 * Kept private here — `media-cap.ts` carries its own #575 walk on this base
 * and the two unify at the row-7a landing, not before.
 */
function stripMediaData(payload: unknown): { stripped: unknown; count: number } {
  let count = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const obj = { ...(node as Record<string, unknown>) };
    const src = obj.source as Record<string, unknown> | undefined;
    const hasMediaData =
      src !== null &&
      typeof src === "object" &&
      typeof src.data === "string" &&
      src.data.length > 0;
    if (hasMediaData) {
      count++;
      obj.source = { ...src, data: "" };
    }
    for (const k of Object.keys(obj)) {
      if (k === "source" && hasMediaData) continue; // replaced above — do not re-walk
      obj[k] = strip(obj[k]);
    }
    return obj;
  };
  return { stripped: strip(payload), count };
}

/**
 * #441 — FLOOR of the safety margin a refusal must clear beyond the largest
 * declared window. The margin actually applied is proportional —
 * `max(this floor, est/64)` — because the /4 estimator drifts toward /3.5 on
 * code-dense prompts: a fixed margin covers none of that at 250k, a
 * proportional one tracks it (~1.6% of the prompt, ~3.9k at the RX95 window;
 * pre-review #442, ai-01 2026-10-11). Covers the two drifts the /4 estimator
 * cannot see: a tokenizer reading structured JSON yields MORE tokens than
 * chars/4 (every `{`/`"`/`:` is a token), and the wire prompt is the CONVERTED
 * payload (openai or anthropic), not the Claude-shaped request we estimate —
 * a few percent of shape delta at 250k. Over-estimating the prompt is safe (it
 * only stands the census down); UNDER-estimating refuses requests the engine
 * would have served — the opposite failure. 2048 ≈ 0.8% of the Swift window
 * (262 144).
 *
 * MEASURED CORRECTION (2026-10-25, #674 on main): the `est/64` term (1.56%)
 * does NOT track that tokenizer drift — over 1 111 served swift responses
 * paired req→resp, `real/est` is x1.068 at p50, x1.118 at p95, x1.196 at p99
 * (min 0.57, max 3.18). Deliberately left as-is rather than enlarged: the
 * ratio is content-dependent, so any factor big enough to cover the tail
 * over-reserves on the median and stands down on requests the census should
 * refuse. The band it cannot see is main's #674 exact-counting case (not
 * ported here).
 */
export const CONTEXT_LIMIT_SAFETY_MARGIN_TOKENS = 2048;

/** #441 — the margin actually applied for a given prompt estimate. */
export function contextLimitMarginTokens(est: number): number {
  return Math.max(CONTEXT_LIMIT_SAFETY_MARGIN_TOKENS, Math.ceil(est / 64));
}

/** One candidate window on the request's resolved path. */
export interface DeclaredWindow {
  /** Provider (custom-endpoint) name, e.g. `vllm-myia`. */
  name: string;
  limit: number;
}

export interface ContextAdmissionDecision {
  /** True when every candidate on the path declares a window, and every one is smaller than the request. */
  refuse: boolean;
  estTokens: number;
  /** The largest declared window seen; undefined when the path declares none. */
  largest?: DeclaredWindow;
}

/**
 * Decide whether a request can be refused at admission.
 *
 * `windows` carries ONLY declared bounds (an operator `contextLimit`);
 * `undeclaredCandidates` counts the candidates on the same path that declare
 * nothing. A path with ANY undeclared candidate falls open — the census never
 * guesses a window, and an undeclared candidate is never treated as `0`. The
 * refusal must clear the largest declared window by the same proportional
 * margin the #441 clamp reserves on main (`contextLimitMarginTokens`), so a
 * request merely NEAR a window is left to the upstream's own refusal instead
 * of being refused on estimator drift.
 */
export function decideContextAdmission(
  payload: unknown,
  windows: readonly DeclaredWindow[],
  undeclaredCandidates = 0
): ContextAdmissionDecision {
  const declared = windows.filter((w) => Number.isFinite(w.limit) && w.limit > 0);
  // One undeclared candidate is enough to stand down (hub 2026-10-22): the
  // haiku path `MiniMax (nothing) > vllm-myia (262 144) > role:sonnet > ds@…
  // (nothing)` refused every request over 262k — `/compact` included, so the
  // session could never condense its way out — while the nominal and the PAYG
  // terminator could have taken it. A candidate the census cannot see may be
  // the one that serves; only a path where EVERY candidate declares a window
  // too small is doomed. An entry with a non-finite or zero limit is an
  // undeclared candidate too, never a window of size 0.
  if (undeclaredCandidates > 0 || declared.length < windows.length) {
    return { refuse: false, estTokens: 0 };
  }
  // Nothing declared ⇒ no census at all (estTokens 0, not a measurement): the
  // estimate walks and re-serialises the whole body, and most requests on most
  // machines have no declared window to weigh. Pay for it only when it decides.
  if (declared.length === 0) return { refuse: false, estTokens: 0 };
  // `estimateClampTokens`, not the /4 payload convention: the clamp estimator
  // replaces each image/document base64 block with a fixed allocation, so a
  // 1 MB screenshot scores ~1.6k instead of the ~750k its base64 chars would.
  // For a REFUSAL an inflated estimate is a false refusal — the /4 convention
  // is safe only where over-counting merely compacts earlier.
  const estTokens = estimateClampTokens(payload);
  let largest = declared[0];
  for (const w of declared) if (w.limit > largest.limit) largest = w;
  const refuse = estTokens > largest.limit + contextLimitMarginTokens(estTokens);
  return { refuse, estTokens, largest };
}

/**
 * The refusal text. States what was measured and what to do — never posture,
 * never instruct the agent to undo its decisions (doctrine 2026-08-23).
 *
 * LOAD-BEARING: this wording must never match `isQuotaExhaustion` (no "quota",
 * "credit", "balance", "weekly", "usage limit", "plan limit", "exhaust",
 * "exceed your account") — a context refusal is not a wall and must not arm a
 * cascade. Pinned by test.
 */
export function contextAdmissionRefusalText(estTokens: number, largest: DeclaredWindow): string {
  return (
    `[claudish] Input of ~${estTokens} tokens exceeds every declared context window on this route ` +
    `(largest declared: ${largest.limit} — ${largest.name}). No DECLARED window on this route can ` +
    "take it; " +
    "the context gauge has been advanced accordingly. Condense the conversation before retrying."
  );
}

/** `CLAUDISH_CONTEXT_ADMISSION=0` restores today's behaviour: no census, no
 * local refusal. Only an explicit "0" disarms, per house convention. */
export function contextAdmissionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_CONTEXT_ADMISSION || "").trim() === "0";
}

// ── Recoverable-turn constructors ─────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Complete SSE turn: message_start → one text block → message_delta with the real
 * `usage.input_tokens` → message_stop. Every terminating path must emit
 * `message_stop` (never-hang invariant); `message_delta.usage` is the frame the
 * client's gauge actually reads.
 */
export function buildOverflowRecoveryStream(
  text: string,
  inputTokens: number,
  modelName: string
): Response {
  const id = `msg_overflow_${Date.now()}`;
  const outputTokens = Math.max(1, Math.ceil(text.length / 4));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        frame("message_start", {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })
      );
      controller.enqueue(
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );
      controller.enqueue(
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })
      );
      controller.enqueue(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        })
      );
      controller.enqueue(frame("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS } });
}

/** Single JSON message — the `stream: false` lane (notably `/compact`). */
export function buildOverflowRecoveryMessage(
  text: string,
  inputTokens: number,
  modelName: string
): Record<string, unknown> {
  return {
    id: `msg_overflow_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
  };
}
