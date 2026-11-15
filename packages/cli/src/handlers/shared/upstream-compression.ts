/**
 * #909 — gzip REQUEST bodies toward providers whose ingress decodes them.
 *
 * Scope guard: this only ever compresses what we SEND upstream (request
 * bodies). SSE responses are never gzipped — that is the never-hang rule
 * (`docs/reference/never-hang.md`).
 *
 * A provider carries the capability only after its ingress was probed
 * (probe matrix recorded on #909 before any profile flip). Unproven
 * providers never see a compressed body: absence of the transport field
 * means OFF, and the kill switch below disables everywhere.
 */
import { gzipSync } from "node:zlib";
import { logStderr } from "../../logger.js";

const DEFAULT_MIN_BYTES = 16384;

/**
 * "" means unset — the compose `${VAR:-}` interpolation trap (#310): every
 * read of a CLAUDISH_* env name must treat the empty string as absent or a
 * compose-deployed container silently loses the switch. (Dot access on
 * process.env on purpose: compose-env-coverage.test.ts scans for the
 * literal read shape, and a name hidden behind an indirection is a name
 * the gate cannot vouch for.)
 */
function normalizeEnv(raw: string | undefined): string | undefined {
  return raw && raw.trim() !== "" ? raw : undefined;
}

/**
 * Kill switch — `CLAUDISH_UPSTREAM_COMPRESS=0` disables compression on every
 * lane; unset (or any other value) leaves it on wherever the transport
 * declared the capability.
 */
export function upstreamCompressionEnabled(): boolean {
  return normalizeEnv(process.env.CLAUDISH_UPSTREAM_COMPRESS) !== "0";
}

/**
 * Size floor in bytes — bodies below it go out plain (compression would
 * cost more than it saves). Unset, empty or garbage falls back to the
 * default; never throws.
 */
export function upstreamCompressionMinBytes(): number {
  const raw = normalizeEnv(process.env.CLAUDISH_UPSTREAM_COMPRESS_MIN_BYTES);
  if (raw === undefined) return DEFAULT_MIN_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_BYTES;
}

export interface UpstreamBodyCompressionOpts {
  /**
   * Transport-declared capability (`ProviderTransport.requestCompression`).
   * `undefined` or anything other than "gzip" means the provider was never
   * probed — the body goes out plain.
   */
  capability: string | undefined;
  /** Outbound headers — `content-encoding: gzip` is set only when we actually compress. */
  headers: Record<string, string>;
  /** The serialized JSON body. */
  body: string;
  /** `provider model` label for the on-wire log line. */
  label: string;
}

/**
 * Returns the body to put on the wire: a gzipped Uint8Array when the
 * capability is declared, the switch is on and the body clears the floor;
 * the original string otherwise. Never throws — a gzip failure degrades to
 * the plain body (a compression hiccup must never stall the turn).
 *
 * The `Uint8Array<ArrayBuffer>` return is load-bearing under the v14 lib set
 * (DOM present): `BodyInit` rejects the default `Uint8Array<ArrayBufferLike>`
 * because it could be `SharedArrayBuffer`-backed. `gzipSync` allocates a
 * fresh buffer, so the narrower type is honest (same reasoning as
 * `devin/proto-codec.ts`'s `cat`).
 */
export function compressUpstreamRequestBody(
  opts: UpstreamBodyCompressionOpts
): string | Uint8Array<ArrayBuffer> {
  const { capability, headers, body, label } = opts;
  if (capability !== "gzip" || !upstreamCompressionEnabled()) return body;
  const originalBytes = Buffer.byteLength(body, "utf-8");
  if (originalBytes < upstreamCompressionMinBytes()) return body;
  try {
    const compressStartedAt = performance.now();
    const compressed = gzipSync(Buffer.from(body, "utf-8"));
    // Incompressible payload (base64 media, already-compressed blobs): gzip
    // can make the body LARGER. Sending the plain body costs less than
    // shipping gzip overhead — only compress when it actually wins.
    if (compressed.length >= originalBytes) return body;
    headers["content-encoding"] = "gzip";
    const ratio = ((compressed.length / originalBytes) * 100).toFixed(1);
    // #909 follow-up: the CPU cost next to the byte gain — hub measurements
    // (ai-01, #587 loop) put gzipSync at ~8 ms p50 for ~900 KB bodies; AC-4's
    // week-of-traffic report reads this column beside the saving.
    const ms = (performance.now() - compressStartedAt).toFixed(1);
    logStderr(
      `[UpstreamCompress] ${label} in=${originalBytes}B wire=${compressed.length}B (${ratio}%) ms=${ms}`
    );
    return compressed;
  } catch (e) {
    logStderr(`[UpstreamCompress] ${label} gzip failed, sending plain: ${String(e)}`);
    return body;
  }
}
