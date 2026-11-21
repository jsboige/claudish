/**
 * Catalog network guard — armed by the test preload, BEFORE any test file.
 *
 * WHY (#1133 follow-up, upstream cause measured 2026-11-21 on po-2023):
 * every `createProxyServer()` fires `warmAllCatalogs(["openrouter"])` in the
 * background (proxy-server.ts), and 34 route-test files spin the proxy. The
 * ones that never install their own fetch stub send that warm to the REAL
 * models-index endpoint — measured: the fetch completes in ~6.4 s and leaves
 * 1 056 entries in the PROCESS-GLOBAL `_memCache` (module state,
 * `openrouter.ts`), `glm-5 @ 204800` included. `lookupModel()` falls back to
 * that memory catalog on a disk miss (#222 c), so whether
 * `model-catalog.test.ts` Group 1's cold-start case passes depends on whether
 * a foreign warm landed before it ran — pure order/timing luck. That is how a
 * docs-only merge (`844710aec`) flipped main's color with zero code change,
 * and why the same red rides every open PR's `test` check.
 *
 * #1133 isolated the symptom (Group 1 resets the memory catalog). This guard
 * kills the CLASS: under the test preload, a fetch to the real remote catalog
 * endpoint is refused before it leaves the process, so no test file — present
 * or future — can leak a live catalog into module state. The warm fails
 * silently (`refreshCatalog` never throws; every failure mode is a value),
 * `_memCache` stays cold, and resolution falls back to the same
 * disk/passthrough paths an offline seat exercises.
 *
 * Scope: the REAL models-index HOST, every path (review blocking 2, #1135):
 * the match is on the host, and that host serves more than the catalog —
 * `queryModels` + the recommended-models fetch (model-loader.ts) and
 * `errorReportIngest` (mcp-server.ts) ride the same host. No test should
 * reach that host on any path, so the refusal is host-wide on purpose.
 * What still passes:
 * - `CLAUDISH_CATALOG_URL` pointed at a LOCAL server — a documented,
 *   legitimate integration-test pattern (openrouter.ts header); loopback
 *   overrides pass through.
 * - Everything off that host (the other background warms at proxy spin write
 *   to the sandboxed home, not to module state a test reads).
 * - A test file that assigns its own `globalThis.fetch` stub REPLACES this
 *   wrapper entirely (last write wins) and serves its own fixtures — the
 *   hermetic suites (openrouter.test.ts) are unaffected by design.
 *
 * Input shapes (review blocking 1): fetch accepts a string, a `Request` (it
 * has `.url`), or a `URL` object — which has `.href`, NOT `.url`. All three
 * are extracted before matching, so no input shape can slip past the guard.
 */

/** The real models-index host — the only host this guard refuses. */
const REAL_CATALOG_HOST = "us-central1-claudish-6da10.cloudfunctions.net";

export const CATALOG_GUARD_MESSAGE =
  "claudish test guard: fetch to the real model catalog blocked — the suite runs with a cold catalog (test-support/catalog-network-guard.ts)";

let blockedCount = 0;

/** How many real-catalog fetches this run refused (0 on a healthy run). */
export function catalogGuardBlockedCount(): number {
  return blockedCount;
}

function isRealCatalogUrl(url: string): boolean {
  try {
    return new URL(url).host === REAL_CATALOG_HOST;
  } catch {
    return false;
  }
}

/**
 * Wrap `globalThis.fetch` so the real catalog endpoint is refused in-process.
 * Armed once by the preload; idempotent (arming twice keeps one wrapper).
 */
export function armCatalogNetworkGuard(): void {
  const real = (globalThis as any).fetch;
  if (!real || (real as any).__claudishCatalogGuard) return;
  const wrapped = async (input: any, init?: any) => {
    // string | Request (.url) | URL (.href — never .url, review blocking 1)
    const url =
      input instanceof URL ? input.href : typeof input === "string" ? input : String(input?.url ?? "");
    if (isRealCatalogUrl(url)) {
      blockedCount++;
      throw new TypeError(CATALOG_GUARD_MESSAGE);
    }
    return real(input, init);
  };
  (wrapped as any).__claudishCatalogGuard = true;
  (globalThis as any).fetch = wrapped;
}
