/**
 * Normalize same-process Bun.serve mock responses across seats (#593).
 *
 * MEASURED on the ubuntu-24.04 runner (bun 1.4.0, run 39798841822): a fetch()
 * aimed at a Bun.serve running in the SAME process can return bun's internal
 * `_Response` — the handler's own `new Response(...)` object. That object
 * PASSES `instanceof Response` (the pin's instanceof assertion was green while
 * `res.json()` rejected "Expected a Response object, but received '_Response'")
 * and carries an own `Symbol(cache)` holding `[status, body-as-string,
 * plain-headers]`. Its getters work; its body methods throw.
 *
 * NOT reproducible everywhere: bun 1.4.0 on WSL2 linux returns clean spec
 * Responses for the same code (no own symbols, `json()` OK — checked as a
 * plain script and under `bun test`, on `localhost` and `127.0.0.1`). The
 * trigger is runner-specific and unidentified, so detection here is by SHAPE,
 * never by platform or `instanceof` — the first version of this shim gated on
 * `instanceof Response`, which made it a no-op on exactly the seat it targeted.
 *
 * A spec Response has NO own symbols (measured win32 + WSL), so the own
 * `Symbol(cache)` triple is an unambiguous internal marker:
 *   1. own symbol (name containing "cache") holding `[status, body, headers]`
 *      — rebuild a global Response from those values, calling NOTHING on the
 *      internal object;
 *   2. getter copy — `res.body` / `res.headers` / `res.status` getters into a
 *      new Response (for an internal object whose cache is not an own symbol);
 *   3. a visible 599 fallback if the shape changed outright.
 *
 * Inert wherever fetch already returns spec Responses (win32, WSL, real
 * networks): no own cache symbol → layer-0 pass-through, byte-identical.
 */

type Uninstall = () => void;

/**
 * The internal marker: an OWN symbol whose name contains "cache" and whose
 * value is `[status:number, body, headers?]`. `Symbol(getResponseCache)` (a
 * function on the same object) is skipped by the Array.isArray check.
 * Returns null for every spec Response — they carry no own symbols.
 */
export function internalResponseCacheOf(res: unknown): unknown[] | null {
  if (typeof res !== "object" || res === null) return null;
  let symbols: symbol[];
  try {
    symbols = Object.getOwnPropertySymbols(res);
  } catch {
    return null;
  }
  for (const sym of symbols) {
    if (!String(sym).includes("cache")) continue;
    try {
      const v = (res as any)[sym];
      if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number") {
        return v;
      }
    } catch {
      // unreadable symbol — not the marker
    }
  }
  return null;
}

function rebuildFromCache(cache: unknown[]): Response {
  const [status, body, headers] = cache;
  const init: ResponseInit = { status };
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    init.headers = headers as Record<string, string>;
  }
  return new Response(body == null ? null : String(body), init);
}

export function rewrapInternalResponse(res: any): Response {
  // Layer 1 — the own-cache triple (the runner's actual shape).
  const cache = internalResponseCacheOf(res);
  if (cache) return rebuildFromCache(cache);

  // Layer 2 — getter copy: no body methods called on the internal object.
  try {
    const headers: Record<string, string> = {};
    const h = res.headers;
    if (h && typeof h.forEach === "function") {
      h.forEach((value: string, key: string) => {
        headers[key] = value;
      });
    }
    return new Response(res.body ?? null, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch {
    // layer 3
  }

  // Layers 1-2 read getters only, so reaching here means the internal
  // object's shape changed outright — surface it as a visible 599 rather
  // than letting a class-identity error leak into the client under test.
  return new Response(null, {
    status: 599,
    statusText: "local-fetch-shim: unrewrappable internal response",
  });
}

/**
 * Install the normalizing fetch wrapper. Returns the uninstall function.
 * Install once per test file (beforeAll/imports), uninstall in afterAll.
 */
export function installLocalFetchShim(): Uninstall {
  const raw = globalThis.fetch;
  if (typeof raw !== "function") return () => {};

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await raw(input, init);
    // Internal marker FIRST: the runner's _Response passes `instanceof`, so
    // the identity check alone cannot be the gate (that was the first shim's
    // defect — measured, run 39798841822).
    if (internalResponseCacheOf(res)) return rewrapInternalResponse(res);
    if (res instanceof Response) return res; // spec Response — untouched
    return rewrapInternalResponse(res); // foreign object: getters, else 599
  };
  globalThis.fetch = wrapped as typeof fetch;

  return () => {
    globalThis.fetch = raw;
  };
}
