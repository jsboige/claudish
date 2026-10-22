/**
 * Tests for the MCP streamable-http client (mcp-searxng-client.ts).
 *
 * Uses a local Bun.serve mock that simulates the TBXark mcp-proxy +
 * mcp-searxng backend: JSON and SSE response formats, session handshake,
 * auth header check, error shapes, and timeouts.
 *
 * The hard contract under test: callMcpTool NEVER throws — every failure
 * mode resolves to { ok: false, error }.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  installLocalFetchShim,
  internalResponseCacheOf,
  rewrapInternalResponse,
} from "../../test-support/local-fetch-shim.js";
import {
  callMcpTool,
  mcpWebSearch,
  mcpUrlRead,
  isMcpSearxngAvailable,
  _resetMcpClientState,
} from "./mcp-searxng-client.js";

// #593: bun 1.4.0/linux hands an in-process fetch to this file's Bun.serve
// the handler's own `new Response(...)` object (internal _Response) whose
// .json()/.text() reject — a property of the test environment, not of the
// client. The shim normalizes every local fetch into a spec Response.
const uninstallFetchShim = installLocalFetchShim();

type MockBehavior =
  | "json-ok"
  | "sse-ok"
  | "session-required"
  | "http-500"
  | "tool-error"
  | "hang"
  | "rpc-error";

let behavior: MockBehavior = "json-ok";
let sawAuthHeader: string | null = null;
let initializeCount = 0;

function rpcResult(id: any, text: string, isError = false) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  });
}

const server = Bun.serve({
  port: 0,
  // Loopback only. Bun.serve defaults to 0.0.0.0, which on Windows makes the
  // firewall prompt for bun.exe on every `bun test` run — and a user who clicks
  // through it grants inbound on * for Private AND Public profiles, machine-wide,
  // for a binary that also runs the proxy holding the cluster key. The mock is
  // only ever reached from this process.
  hostname: "127.0.0.1",
  async fetch(req) {
    sawAuthHeader = req.headers.get("authorization");
    const body = (await req.json().catch(() => ({}))) as any;
    const { id, method } = body;

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      initializeCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock" } },
        }),
        { headers: { "Content-Type": "application/json", "mcp-session-id": "mock-session-123" } }
      );
    }

    // tools/call
    switch (behavior) {
      case "json-ok":
        return new Response(rpcResult(id, "mock search results"), {
          headers: { "Content-Type": "application/json" },
        });
      case "sse-ok": {
        const frame = `event: message\ndata: ${rpcResult(id, "mock sse results")}\n\n`;
        return new Response(frame, { headers: { "Content-Type": "text/event-stream" } });
      }
      case "session-required": {
        const sid = req.headers.get("mcp-session-id");
        if (sid !== "mock-session-123") {
          return new Response("Bad Request: no session", { status: 400 });
        }
        return new Response(rpcResult(id, "session-bound results"), {
          headers: { "Content-Type": "application/json" },
        });
      }
      case "http-500":
        return new Response("Internal Server Error", { status: 500 });
      case "tool-error":
        return new Response(rpcResult(id, "fetch failed: 403 Forbidden", true), {
          headers: { "Content-Type": "application/json" },
        });
      case "rpc-error":
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } }),
          { headers: { "Content-Type": "application/json" } }
        );
      case "hang":
        await new Promise((r) => setTimeout(r, 10_000));
        return new Response(rpcResult(id, "too late"), {
          headers: { "Content-Type": "application/json" },
        });
    }
  },
});

const MOCK_URL = `http://localhost:${server.port}/searxng/mcp`;

beforeEach(() => {
  _resetMcpClientState();
  process.env.SEARXNG_MCP_URL = MOCK_URL;
  process.env.MCP_AUTH = "test-token";
  behavior = "json-ok";
  sawAuthHeader = null;
  initializeCount = 0;
});

afterAll(() => {
  server.stop(true);
  uninstallFetchShim();
  delete process.env.SEARXNG_MCP_URL;
  delete process.env.MCP_AUTH;
});

describe("mcp-searxng-client", () => {
  test("not configured → ok:false without any network call", async () => {
    delete process.env.SEARXNG_MCP_URL;
    expect(isMcpSearxngAvailable()).toBe(false);
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not configured");
  });

  test("local fetch of a new Response mock is a spec Response (#593 pin)", async () => {
    // Mechanism pin for the #593 class: on bun 1.4.0/linux an in-process
    // fetch returns the handler's internal _Response (body methods throw
    // "Failed to parse JSON" / "Expected a Response object"). With the shim
    // installed the response MUST be instanceof the global Response and its
    // body MUST parse. This is the mutation detector for the shim: remove
    // the install above and this goes red on CI ubuntu (1.4.0/linux). On
    // seats whose fetch already returns spec Responses (win32 1.3.14/1.4.0)
    // it is green with or without the shim — the linux half rides CI.
    const res = await fetch(MOCK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: {} }),
    });
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(200);
    const msg: any = await res.json();
    expect(msg.id).toBe(999);
    expect(msg.result?.content?.[0]?.text).toBe("mock search results");
  });

  test("the shim rewraps the CI-observed internal _Response shape (#593 pin)", async () => {
    // Shape verbatim from run 39798841822: the internal object PASSES
    // `instanceof Response` while its body methods throw "Expected a Response
    // object, but received '_Response'", and it carries an own Symbol(cache) =
    // [status, body-string, headers-object]. The first shipped shim gated on
    // `instanceof` and let exactly this object through untouched — the
    // fetch-path pin above is what caught it on the runner.
    const internal: any = Object.create(Response.prototype);
    const cacheSym = Symbol("cache");
    // defineProperty throughout: Response.prototype's accessors are getter-only,
    // so plain assignment throws ("Attempted to assign to readonly property").
    Object.defineProperty(internal, cacheSym, {
      value: [
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 777,
          result: { content: [{ type: "text", text: "synthetic" }] },
        }),
        { "Content-Type": "application/json" },
      ],
    });
    Object.defineProperty(internal, "json", {
      value: () =>
        Promise.reject(new TypeError("Expected a Response object, but received '_Response'")),
    });
    Object.defineProperty(internal, "text", {
      value: () =>
        Promise.reject(new TypeError("Expected a Response object, but received '_Response'")),
    });

    // The trap the first shim fell into: identity passes, detection must not.
    expect(internal instanceof Response).toBe(true);
    expect(internalResponseCacheOf(internal)).toBeTruthy();

    const rebuilt = rewrapInternalResponse(internal);
    expect(rebuilt).not.toBe(internal);
    expect(rebuilt instanceof Response).toBe(true);
    expect(rebuilt.status).toBe(200);
    const msg: any = await rebuilt.json();
    expect(msg.id).toBe(777);
    expect(msg.result?.content?.[0]?.text).toBe("synthetic");

    // A spec Response carries no own symbols — the detector leaves it alone.
    expect(internalResponseCacheOf(new Response("x"))).toBeNull();
  });

  test("JSON response → ok:true with text, sends Bearer auth", async () => {
    const res = await mcpWebSearch("docker compose", 3000);
    expect(res).toEqual({ ok: true, text: "mock search results" });
    expect(sawAuthHeader).toBe("Bearer test-token");
  });

  test("SSE response format is parsed", async () => {
    behavior = "sse-ok";
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 3000);
    expect(res).toEqual({ ok: true, text: "mock sse results" });
  });

  test("session-required: HTTP 400 triggers initialize handshake then retry succeeds", async () => {
    behavior = "session-required";
    const res = await callMcpTool("web_url_read", { url: "https://example.com" }, 5000);
    expect(res).toEqual({ ok: true, text: "session-bound results" });
    expect(initializeCount).toBe(1);
  });

  test("HTTP 500 → ok:false, never throws", async () => {
    behavior = "http-500";
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 3000);
    expect(res.ok).toBe(false);
  });

  test("tool result with isError → ok:false carrying the error text", async () => {
    behavior = "tool-error";
    const res = await mcpUrlRead("https://blocked.example.com", 3000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("403");
  });

  test("JSON-RPC error object → ok:false with message", async () => {
    behavior = "rpc-error";
    const res = await callMcpTool("nonexistent_tool", {}, 3000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Unknown tool");
  });

  test("deadline: hung server → ok:false within budget, never throws", async () => {
    behavior = "hang";
    const started = Date.now();
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 500);
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
