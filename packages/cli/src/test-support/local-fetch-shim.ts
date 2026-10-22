/**
 * Normalize same-process Bun.serve mock responses across seats (#593).
 *
 * MEASURED, three CI runs deep:
 *
 * 1. On the ubuntu-24.04 runner (bun 1.4.0), a fetch() aimed at a Bun.serve
 *    in the SAME process returns the handler's own Response object. That
 *    object PASSES `instanceof Response` (identity assert green) and its
 *    getters work — but its body methods THROW: `.json()` fails with
 *    "Expected a Response object, but received '_Response'" /
 *    "Failed to parse JSON". First shim gated the rewrap on
 *    `!(res instanceof Response)` → no-op on exactly that seat (run
 *    39798841822).
 * 2. On the SAME runner, EVERY constructed Response carries an own
 *    `Symbol(cache)` holding `[status, body, headers]` — `new Response("x")`
 *    built in test code included (run 39841666124: the uniqueness assert
 *    received the triple). The cache marker is universal there and cannot
 *    discriminate "internal". On win32/WSL seats no Response carries any own
 *    symbol at all. Second shim gated on the marker → still a no-op there.
 * 3. What the transit breaks is the BODY METHODS, not construction: freshly
 *    constructed Responses never sent through fetch work fine on the same
 *    runner (the broad suite is green on constructed Responses everywhere
 *    else).
 *
 * So the shim REWRAPS UNCONDITIONALLY: every result of a local fetch becomes
 * a FRESH Response that never transited the serve path —
 *   1. own `Symbol(cache)` triple `[status, body, headers]` (the runner's
 *      native shape) rebuilds without calling anything on the object;
 *   2. getter copy — `res.body` / `res.headers` / `res.status` into a new
 *      Response (healthy seats, where layer 1 finds no cache);
 *   3. a visible 599 fallback if the shape changed outright.
 *
 * The rebuilt object is content-equivalent (status, body, headers verbatim),
 * so healthy seats (win32, WSL, real networks) behave identically — they just
 * pay one extra Response construction per local fetch in these test files.
 */

type Uninstall = () => void;

/**
 * Read the own `Symbol(cache)` triple `[status, body, headers?]` if present.
 * NOT a discriminator: on the ubuntu runner every Response carries it
 * (measured, run 39841666124); on win32/WSL none does.
 * `Symbol(getResponseCache)` (function-valued) is skipped by the
 * Array.isArray check.
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
      // unreadable symbol — not the cache
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
  return new Response(body == null ? null : (body as BodyInit), init);
}

export function rewrapInternalResponse(res: any): Response {
  // Layer 1 — the own-cache triple (the runner's native shape).
  const cache = internalResponseCacheOf(res);
  if (cache) return rebuildFromCache(cache);

  // Layer 2 — getter copy: no body methods called on the transited object.
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

  // Layers 1-2 read getters only, so reaching here means the transited
  // object's shape changed outright — surface it as a visible 599 rather
  // than letting a class-identity error leak into the client under test.
  return new Response(null, {
    status: 599,
    statusText: "local-fetch-shim: unrewrappable response",
  });
}

/**
 * Install the normalizing fetch wrapper. Returns the uninstall function.
 * Install once per test file (imports/beforeAll), uninstall in afterAll.
 */
export function installLocalFetchShim(): Uninstall {
  const raw = globalThis.fetch;
  if (typeof raw !== "function") return () => {};

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await raw(input, init);
    // Unconditional: the transit through in-process fetch is what breaks the
    // body methods on the runner, and no marker discriminates there (every
    // constructed Response carries Symbol(cache) on that seat). A fresh
    // Response that never transited works everywhere.
    return rewrapInternalResponse(res);
  };
  globalThis.fetch = wrapped as typeof fetch;

  return () => {
    globalThis.fetch = raw;
  };
}
