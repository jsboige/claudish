/**
 * Codex session affinity — one stable, opaque id per Claude Code session, sent
 * to the ChatGPT Codex backend both as the `session-id` / `thread-id` headers
 * and as the Responses API `prompt_cache_key`.
 *
 * Why: the ChatGPT backend routes a request to a cache-affinity target from
 * its `session-id` header (openai/codex `codex-rs/core/src/client.rs`: "ChatGPT
 * derives cache affinity from the Responses session-id header"; the header
 * names are `session-id` and `thread-id`, `codex-rs/codex-api/src/requests/
 * headers.rs`), and the Responses API documents `prompt_cache_key` as the
 * routing hint for requests sharing a prefix. Before this module the fork sent
 * neither: no `prompt_cache_key`, and `x-session-id` / `x-conversation-id` set
 * to a FRESH UUID on every request (#66, 2026-08-27). Measured on the hub
 * captures of 2026-11-05, the gpt-6.1-sol lane read 26.6 % of its input from
 * the cache (416 responses), where the native Anthropic and DeepSeek lanes
 * read 98 % — and at the published Sol credit rates (50 input / 2.5 cached /
 * 250 output per 1M) uncached input was 96 % of what the lane spent.
 *
 * Granularity is the CONVERSATION (Claude Code's `metadata.user_id` →
 * `session_id`), as upstream MadAppGang #113 chose for `prompt_cache_key`:
 * stable for every turn, survives a proxy restart, never shared between two
 * sessions — so #66's concern (one backend drawer shared by every session on
 * the account, the old constant "claudish-session") stays structurally ruled
 * out. The id is a one-way digest shaped as a UUID (the shape Codex itself
 * sends), never the raw session id.
 *
 * Affinity comes ONLY from a real Claude Code `session_id` (the JSON-string
 * or object form of `metadata.user_id`). Everything else — no `user_id`, or a
 * RAW-STRING `user_id` (the OpenAI ingress maps its `user` field there,
 * `openai-request-to-anthropic.ts`: an end-user handle, not a conversation) —
 * keeps the pre-#886 wire: a fresh `x-` UUID per request, no `session-id`,
 * no key (review 6662979923). #66 point 3 said one shared drawer "remains
 * structurally wrong" even when only routing precision is at stake, so no
 * process-wide fallback id exists here — `codexSessionId` returns null and
 * the caller sends nothing.
 *
 * Sub-agents share their parent's `session_id` (the session-budget counter
 * measured one parent plus 230 sub-agent requests under a single sid), so a
 * parent and its sub-agents share one affinity id with different prefixes.
 * Affinity only routes, it never merges state — do not read a
 * lower-than-expected "after" cache ratio on such a session as a regression.
 *
 * Kill switch: `CLAUDISH_CODEX_SESSION_AFFINITY=0` (also `false`/`off`), read
 * per request, restores the previous wire exactly (fresh UUID per request, no
 * `prompt_cache_key`). Unset or empty — compose injects "" — means ON.
 */

import { createHash } from "node:crypto";

/** Kill switch, read per request. Unset / "" → ON; "0" / "false" / "off" → OFF. */
export function codexSessionAffinityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CLAUDISH_CODEX_SESSION_AFFINITY ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/**
 * Claude Code's session id from an Anthropic-format request, or null. Mirrors
 * `extractSessionKey` in `fork/failover.ts` (the identity the dwell, the
 * session budget and the stream notices already key on), kept local so a
 * transport does not import the failover module.
 */
function sessionIdOf(claudeRequest: any): string | null {
  try {
    const uid = claudeRequest?.metadata?.user_id;
    if (!uid) return null;
    if (typeof uid === "string") {
      try {
        const p = JSON.parse(uid);
        if (p?.session_id) return String(p.session_id);
      } catch {
        /* not JSON — a raw string is an end-user handle (the OpenAI ingress
         * maps its `user` field here), not a conversation id: no affinity */
      }
      return null;
    }
    if (typeof uid === "object" && (uid as any).session_id) return String((uid as any).session_id);
  } catch {
    /* never throw from an id derivation */
  }
  return null;
}

/**
 * The affinity id for this request: a deterministic UUID-shaped digest of the
 * session id (version nibble 4, RFC 4122 variant — the layout any UUID
 * validator accepts), or NULL when the request carries no real session id —
 * the caller then sends neither `session-id` nor key (pre-#886 wire).
 */
export function codexSessionId(claudeRequest: any): string | null {
  const sid = sessionIdOf(claudeRequest);
  if (!sid) return null;
  const h = createHash("sha256").update(`claudish-codex-affinity:${sid}`).digest("hex");
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
