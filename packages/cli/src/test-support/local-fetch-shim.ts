/**
 * Normalize same-process Bun.serve mock responses across seats (#593).
 *
 * bun 1.4.0/linux short-circuits a fetch() aimed at a Bun.serve running in
 * the SAME process: the caller receives the handler's own `new Response(...)`
 * object — bun's internal `_Response` (visible via its `Symbol(cache)`
 * [status, body, headers] triple), NOT an instance of the global Response.
 * Its getters work, but the body methods throw: `.json()` rejects with
 * "Failed to parse JSON" and `.text()` with "Expected a Response object,
 * but received '_Response'". `Response.json()` (the static factory) does NOT
 * take the shortcut, which is why only the mocks answering with
 * `new Response(...)` went red on CI ubuntu (5x mcp-searxng-client + 1x
 * web-search-executor basic-auth, run 39618911322) while staying green on
 * bun 1.3.14 win32 — the failure is a property of the test environment,
 * never of the client under test.
 *
 * installLocalFetchShim() wraps globalThis.fetch and re-wraps any non-spec
 * Response into a fresh global one, layered so no code path ever depends on
 * the internal object's methods:
 *   1. the `Symbol(cache)` triple — [status, body-as-string, plain-headers]
 *      — rebuilds the Response without calling anything on the object;
 *   2. stream copy — `res.body` getter into `new Response(stream)`;
 *   3. a visible 599 fallback if the internal shape changed outright.
 *
 * The shim is inert wherever fetch already returns spec Responses (win32,
 * real networks): layer 0 is the `instanceof Response` pass-through.
 */

type Uninstall = () => void;

function rewrapInternalResponse(res: any): Response {
  // Layer 1 — the internal response cache triple. The dump from CI run
  // 39618911322 shows `[Symbol(cache)]: [200, "<body>", { <headers> }]`:
  // status number, body as a plain string, headers as a plain object.
  for (const sym of Object.getOwnPropertySymbols(res)) {
    try {
      const v = res[sym];
      if (Array.isArray(v) && typeof v[0] === "number" && v.length >= 2) {
        const [status, body, headers] = v;
        const init: ResponseInit = { status };
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          init.headers = headers as Record<string, string>;
        }
        return new Response(body == null ? null : String(body), init);
      }
    } catch {
      // try the next symbol / layer
    }
  }

  // Layer 2 — stream copy: getters only, no body methods on the object.
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
  return new Response(null, { status: 599, statusText: "local-fetch-shim: unrewrappable internal response" });
}

/**
 * Install the normalizing fetch wrapper. Returns the uninstall function.
 * Install once per test file (beforeAll), uninstall in afterAll.
 */
export function installLocalFetchShim(): Uninstall {
  const raw = globalThis.fetch;
  if (typeof raw !== "function") return () => {};

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await raw(input, init);
    if (res instanceof Response) return res; // layer 0 — every healthy seat
    return rewrapInternalResponse(res);
  };
  globalThis.fetch = wrapped as typeof fetch;

  return () => {
    globalThis.fetch = raw;
  };
}
