/**
 * web-search-executor — SEARXNG_URL credentials-in-userinfo tests.
 *
 * The incident these pin (2026-08-20, po-2026): Basic Auth deployed on the
 * public search.myia.io (IIS, Windows account) 401'd every credless WAN
 * client, and claudish had no way to send credentials at all. The standard
 * curl-style form `https://user:pass@host` now produces an Authorization
 * header — LAN deployments with a credless URL stay byte-identical.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  searxngConfig,
  executeWebSearch,
  searxngLatencyStats,
  _resetSearxngTelemetry,
} from "./web-search-executor.js";

const ORIGINAL_URL = process.env.SEARXNG_URL;
const ORIGINAL_MCP = process.env.SEARXNG_MCP_URL;
const ORIGINAL_ATTEMPT_TIMEOUT = process.env.SEARXNG_ATTEMPT_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = ORIGINAL_URL;
  if (ORIGINAL_MCP === undefined) delete process.env.SEARXNG_MCP_URL;
  else process.env.SEARXNG_MCP_URL = ORIGINAL_MCP;
  if (ORIGINAL_ATTEMPT_TIMEOUT === undefined) delete process.env.SEARXNG_ATTEMPT_TIMEOUT_MS;
  else process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ORIGINAL_ATTEMPT_TIMEOUT;
  _resetSearxngTelemetry();
});

describe("searxngConfig — userinfo parsing", () => {
  test("no userinfo → no auth header, trailing slash stripped", () => {
    process.env.SEARXNG_URL = "http://192.168.0.47:8181/";
    const c = searxngConfig();
    expect(c.base).toBe("http://192.168.0.47:8181");
    expect(c.authHeaders).toEqual({});
  });

  test("user:pass → Basic header, creds stripped from base", () => {
    process.env.SEARXNG_URL = "https://searxng-user:pw@search.myia.io";
    const c = searxngConfig();
    expect(c.base).toBe("https://search.myia.io");
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("searxng-user:pw").toString("base64")}`
    );
  });

  test("URL-encoded specials decoded before base64", () => {
    process.env.SEARXNG_URL = "https://u:p%40ss@search.myia.io";
    const c = searxngConfig();
    expect(c.base).toBe("https://search.myia.io");
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("u:p@ss").toString("base64")}`
    );
  });

  test("unset → default public URL, no auth", () => {
    delete process.env.SEARXNG_URL;
    const c = searxngConfig();
    expect(c.base).toBe("http://search.myia.io");
    expect(c.authHeaders).toEqual({});
  });

  test("username without password still authenticates (empty password part)", () => {
    process.env.SEARXNG_URL = "https://u@search.myia.io";
    const c = searxngConfig();
    expect(c.authHeaders.Authorization).toBe(
      `Basic ${Buffer.from("u:").toString("base64")}`
    );
  });
});

describe("executeWebSearch — Basic auth end-to-end (local mock)", () => {
  test("server demanding auth is satisfied by creds-in-URL", async () => {
    delete process.env.SEARXNG_MCP_URL;
    const expectAuth = `Basic ${Buffer.from("u:p").toString("base64")}`;
    let sawAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        sawAuth = req.headers.get("authorization") || "";
        if (sawAuth !== expectAuth) return new Response("denied", { status: 401 });
        return Response.json({
          results: [{ title: "Lean proof", url: "https://example.com", content: "snippet" }],
        });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://u:p@127.0.0.1:${server.port}`;
      const out = await executeWebSearch("lean", 3000);
      expect(sawAuth).toBe(expectAuth);
      expect(out).toContain("[Web search results");
      expect(out).toContain("**Lean proof**");
    } finally {
      server.stop(true);
    }
  });

  test("401 despite creds → graceful no-results text, never a throw", async () => {
    delete process.env.SEARXNG_MCP_URL;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Unauthorized", { status: 401 });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://u:p@127.0.0.1:${server.port}`;
      const out = await executeWebSearch("lean", 2000);
      expect(out).toMatch(/no results|unavailable/i);
    } finally {
      server.stop(true);
    }
  });
});

describe("executeWebSearch — retry, budget and latency telemetry (#3388)", () => {
  // Attempt timeout is shrunk via env so timeout paths run in ~150ms instead
  // of the dimensioned 5s (bun's default per-test timeout is 5s).
  const ATTEMPT_MS = "150";

  function slowThenFastServer(slowMs: number) {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        hits++;
        if (hits === 1) {
          await new Promise((r) => setTimeout(r, slowMs));
        }
        return Response.json({
          results: [{ title: "Retry proof", url: "https://example.com", content: "snippet" }],
        });
      },
    });
    return { server, hits: () => hits };
  }

  test("first attempt times out → exactly one retry recovers results", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    const { server, hits } = slowThenFastServer(400);
    try {
      process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`;
      const out = await executeWebSearch("retry", 3000);
      expect(hits()).toBe(2);
      expect(out).toContain("[Web search results");
      expect(out).toContain("**Retry proof**");
    } finally {
      server.stop(true);
    }
  });

  test("all attempts time out → graceful failure text, never a throw, exactly 2 requests", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        hits++;
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({ results: [] });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`;
      const out = await executeWebSearch("never-answers", 3000);
      expect(hits).toBe(2);
      expect(out).toMatch(/failed after 2 attempts within 3000ms budget/i);
    } finally {
      server.stop(true);
    }
  });

  test("exhausted budget → no second attempt started", async () => {
    delete process.env.SEARXNG_MCP_URL;
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        hits++;
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({ results: [] });
      },
    });
    try {
      process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`;
      // 350ms budget: attempt 1 aborts at ~150ms, remaining ~200ms < 250ms
      // retry floor → no second request.
      const out = await executeWebSearch("no-budget", 350);
      expect(hits).toBe(1);
      expect(out).toMatch(/failed/i);
    } finally {
      server.stop(true);
    }
  });

  test("latency telemetry records every attempt (incl. timeouts) with p50/p95", async () => {
    delete process.env.SEARXNG_MCP_URL;
    expect(searxngLatencyStats()).toBeNull();
    const { server } = slowThenFastServer(400);
    try {
      process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
      process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`;
      await executeWebSearch("telemetry", 3000);
      const stats = searxngLatencyStats();
      expect(stats).not.toBeNull();
      expect(stats!.n).toBe(2); // timed-out attempt + successful attempt
      expect(stats!.p50).toBeGreaterThanOrEqual(0);
      expect(stats!.p95).toBeGreaterThanOrEqual(stats!.p50);
      _resetSearxngTelemetry();
      expect(searxngLatencyStats()).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("MCP stays first in the chain when configured (retry loop is the HTTP fallback only)", async () => {
    process.env.SEARXNG_ATTEMPT_TIMEOUT_MS = ATTEMPT_MS;
    let httpHits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        httpHits++;
        return Response.json({
          results: [{ title: "Via HTTP fallback", url: "https://example.com", content: "snippet" }],
        });
      },
    });
    try {
      // A failing MCP endpoint (nothing listens on this port → connection
      // refused) must fall through to direct HTTP, which then succeeds.
      process.env.SEARXNG_MCP_URL = "http://127.0.0.1:1/mcp";
      process.env.SEARXNG_URL = `http://127.0.0.1:${server.port}`;
      const out = await executeWebSearch("mcp-fallback", 3000);
      expect(httpHits).toBeGreaterThanOrEqual(1);
      expect(out).toContain("[Web search results");
    } finally {
      server.stop(true);
    }
  });
});
