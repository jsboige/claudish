/**
 * Pins for the catalog network guard (armed by the test preload BEFORE any
 * test file — the state under test is therefore the run's own fetch chain).
 *
 * The upstream-cause reproduction (#1133 follow-up, measured 2026-11-21):
 * with the guard REMOVED from the preload, the second test's warmCache() does
 * a REAL network fetch (~6.4 s measured) and leaves 1 056 entries — `glm-5 @
 * 204800` included — in the process-global memory catalog, which is exactly
 * the leak that reddened main's Group 1 cold-start case at 844710aec. The
 * mutation proof therefore needs network; offline it stays green vacuously
 * (documented — CI, where the original red lived, has network).
 */
import { describe, expect, test } from "bun:test";
import {
  OpenRouterCatalogResolver,
  firebaseCatalogUrl,
  getMemCatalogEntries,
  resetOpenRouterCatalogForTests,
} from "../providers/catalog-resolvers/openrouter.js";
import { CATALOG_GUARD_MESSAGE, catalogGuardBlockedCount } from "./catalog-network-guard.js";

const REAL_CATALOG_URL =
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

describe("catalog network guard (#1133 upstream — the real-catalog leak class)", () => {
  test("a fetch to the REAL catalog endpoint is refused in-process, counted", async () => {
    const before = catalogGuardBlockedCount();
    let err: unknown = null;
    try {
      await fetch(REAL_CATALOG_URL);
    } catch (e) {
      err = e;
    }
    // The refusal is the guard's own marker — not a transport error, not a
    // status: the request never left the process.
    expect(String(err)).toContain(CATALOG_GUARD_MESSAGE);
    expect(catalogGuardBlockedCount()).toBe(before + 1);
    // The same endpoint the resolver would dial by default.
    expect(firebaseCatalogUrl()).toBe(REAL_CATALOG_URL);
  }, 10_000);

  // Review blocking 1 (#1135): a URL object has .href, never .url — the first
  // extraction missed it and the request passed through to the real fetch.
  test("a fetch called with a URL OBJECT is refused too (no input shape slips past)", async () => {
    const before = catalogGuardBlockedCount();
    let err: unknown = null;
    try {
      await fetch(new URL(REAL_CATALOG_URL));
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain(CATALOG_GUARD_MESSAGE);
    expect(catalogGuardBlockedCount()).toBe(before + 1);
  }, 10_000);

  test("a resolver warm under the guard leaves the memory catalog COLD — the cross-file leak is dead", async () => {
    resetOpenRouterCatalogForTests();
    const before = catalogGuardBlockedCount();
    const resolver = new OpenRouterCatalogResolver();
    await resolver.warmCache(); // the same call createProxyServer fires in background
    // refreshCatalog never throws; on the guard's refusal the memory catalog
    // stays exactly what it was — cold — instead of 1 056 live entries.
    expect(getMemCatalogEntries()).toBeNull();
    expect(catalogGuardBlockedCount()).toBe(before + 1);
    resetOpenRouterCatalogForTests();
  }, 10_000);

  test("a LOCAL catalog override passes through (documented integration-test pattern)", async () => {
    const before = catalogGuardBlockedCount();
    let err: unknown = null;
    try {
      // Loopback, nothing listening: the failure must be the SOCKET's, not
      // the guard's — proving the wrapper delegated instead of matching.
      await fetch("http://127.0.0.1:9/queryModels");
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toContain(CATALOG_GUARD_MESSAGE);
    expect(catalogGuardBlockedCount()).toBe(before);
  }, 10_000);
});
