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
 * Kill switch: `CLAUDISH_CODEX_SESSION_AFFINITY=0` (also `false`/`off`), read
 * per request, restores the previous wire exactly (fresh UUID per request, no
 * `prompt_cache_key`). Unset or empty — compose injects "" — means ON.
 */

import { createHash, randomUUID } from "node:crypto";

/**
 * Fallback id for a request that carries no Claude Code session id (an older
 * client, a direct API consumer). Minted once per process: two processes are
 * two different populations and must not share it. On the hub every such
 * request shares this one id — the residual overlap, which costs routing
 * precision only, never correctness.
 */
const PROCESS_FALLBACK_ID = randomUUID();

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
        /* not JSON — the raw string is the client's own stable handle */
      }
      return uid;
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
 * validator accepts), or the per-process fallback when there is no session id.
 */
export function codexSessionId(claudeRequest: any): string {
  const sid = sessionIdOf(claudeRequest);
  if (!sid) return PROCESS_FALLBACK_ID;
  const h = createHash("sha256").update(`claudish-codex-affinity:${sid}`).digest("hex");
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
