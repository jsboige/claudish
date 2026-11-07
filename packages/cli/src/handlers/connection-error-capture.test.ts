import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { setRelayModeSnapshot } from "./shared/relay-mode-snapshot.js";
import { __resetCaptureDirMemo } from "./shared/response-capture.js";

/**
 * #844 — a connection-class failure writes ONE durable line.
 *
 * `appendUpstreamError` records HTTP non-ok responses; a connect failure
 * (dns/refused/unreachable/closed) never gets one, so until #844 the
 * classification the caller already computed (`{kind, code}`) existed only on
 * stdout — erased by the next container recreate. Measured 03/11 on po-2027:
 * the 16:37:23Z "Cannot reach Z.AI" left zero durable entries while the
 * 1308 of the same afternoon sits in upstream-errors.log with its exact
 * request_id; after the fact the transport failure was undiagnosable,
 * because the user-facing `unreachable` wording is ALSO the catch-all for
 * unknown codes (connection-error.ts).
 *
 * Pins, in order of what they protect:
 *   - the entry lands in a SIBLING file (`connection-errors.log`) with the
 *     full classification — upstream-errors.log's NDJSON shape (status/body)
 *     is read by traffic tooling and must not grow a second variant;
 *   - no capture dir configured ⇒ strictly no file, and the 400
 *     connection_error contract to the client is unchanged;
 *   - a "closed" blip the #251 ladder RECOVERS from writes nothing — the
 *     record is for failures the client actually saw.
 */

const realFetch = globalThis.fetch;

let captureDir: string | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CLAUDISH_CAPTURE_DIR;
  delete process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS;
  delete process.env.CLAUDISH_CONNECT_RETRY_MAX;
  setRelayModeSnapshot(null);
  __resetCaptureDirMemo();
  if (captureDir) {
    rmSync(captureDir, { recursive: true, force: true });
    captureDir = null;
  }
});

function makeTransport(): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost:19999/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

function stubUpstreamThrow(error: unknown) {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function stubUpstreamSequence(behaviors: Array<() => Promise<Response>>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
    calls += 1;
    return behavior();
  }) as unknown as typeof fetch;
  return () => calls;
}

function makeContext(): { c: Context; captured: { body?: any; status?: number } } {
  const captured: { body?: any; status?: number } = {};
  const c = {
    req: { header: () => ({}) },
    header: () => {},
    json: (body: unknown, statusOrInit?: number | ResponseInit) => {
      captured.body = body;
      captured.status = typeof statusOrInit === "number" ? statusOrInit : 200;
      return new Response(JSON.stringify(body), {
        ...(typeof statusOrInit === "object" ? statusOrInit : {}),
        status: typeof statusOrInit === "number" ? statusOrInit : 200,
      });
    },
    body: (stream: ReadableStream, init?: ResponseInit) => new Response(stream, init),
  } as unknown as Context;
  return { c, captured };
}

const PAYLOAD = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function makeHandler(): ComposedHandler {
  return new ComposedHandler(makeTransport(), "fugu-ultra", "fugu-ultra", 8464, {});
}

/** One parsed entry per line of the durable log, or null when absent. */
function readEntries(dir: string): Array<Record<string, unknown>> | null {
  const file = join(dir, "connection-errors.log");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("connection-class failure → durable record (#844)", () => {
  test("an unreachable connect failure writes ONE line with the full classification", async () => {
    captureDir = mkdtempSync(join(tmpdir(), "conn-err-844-"));
    process.env.CLAUDISH_CAPTURE_DIR = captureDir;
    __resetCaptureDirMemo();
    stubUpstreamThrow(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ENETUNREACH 203.0.113.7:443"), {
          code: "ENETUNREACH",
        }),
      })
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // The client contract is unchanged: still the honest 400 connection_error.
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");

    const entries = readEntries(captureDir);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    const e = entries![0];
    // What stdout loses to the recreate, the line keeps — including the code
    // the wording cannot carry (unreachable is also the catch-all class).
    expect(e.model).toBe("fugu-ultra");
    expect(e.provider).toBe("Sakana Fugu");
    expect(e.kind).toBe("unreachable");
    expect(e.code).toBe("ENETUNREACH");
    expect(String(e.endpoint)).toContain("localhost:19999");
    expect(e.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Number(e.elapsed_ms))).toBe(false);
    expect(Number.isNaN(Date.parse(String(e.ts)))).toBe(false);
    // Sibling discipline: the HTTP-errors log stays untouched by this class.
    expect(existsSync(join(captureDir, "upstream-errors.log"))).toBe(false);
  });

  test("no CLAUDISH_CAPTURE_DIR ⇒ no file anywhere, 400 contract unchanged", async () => {
    // The temp dir of the previous test is torn down and the env deleted in
    // afterEach; with the env unset the append must be a strict no-op — the
    // failure still surfaces to the client exactly as before.
    delete process.env.CLAUDISH_CAPTURE_DIR;
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("localhost:19999");
  });

  test("a closed blip the #251 ladder RECOVERS writes nothing", async () => {
    captureDir = mkdtempSync(join(tmpdir(), "conn-err-844-recover-"));
    process.env.CLAUDISH_CAPTURE_DIR = captureDir;
    __resetCaptureDirMemo();
    process.env.CLAUDISH_CONNECT_RETRY_DELAYS_MS = "0,0";
    const calls = stubUpstreamSequence([
      () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
      () =>
        Promise.resolve(
          new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
            status: 200,
          })
        ),
    ]);
    const { c } = makeContext();
    const res = await makeHandler().handle(c, PAYLOAD);

    expect(calls()).toBe(2);
    expect(res.status).toBe(200);
    // Recovered ⇒ no failure the client saw ⇒ no durable record.
    expect(readEntries(captureDir)).toBeNull();
  });
});

describe("connection-error line carries the relay context (#877)", () => {
  // Cross-file hygiene: relay.test.ts lives in the same bun test process and
  // its state machines publish to the same module-level snapshot. Every test
  // here re-asserts its own starting mode rather than inheriting one.
  beforeEach(() => {
    setRelayModeSnapshot(null);
  });

  test("AUTONOMOUS seat → line says so, with the flip's trigger", async () => {
    captureDir = mkdtempSync(join(tmpdir(), "conn-err-877-auto-"));
    process.env.CLAUDISH_CAPTURE_DIR = captureDir;
    __resetCaptureDirMemo();
    setRelayModeSnapshot({ mode: "autonomous", downTrigger: "heartbeat" });
    stubUpstreamThrow(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ENETUNREACH 203.0.113.7:443"), {
          code: "ENETUNREACH",
        }),
      })
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    const entries = readEntries(captureDir);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    const e = entries![0];
    // The two fields a post-recreate forensics needs: the seat was serving
    // locally because the relay had flipped, and the flip was a heartbeat
    // timeout — not a provider outage.
    expect(e.relay_mode).toBe("autonomous");
    expect(e.relay_down_trigger).toBe("heartbeat");
    // The #844 classification is unchanged by the addition.
    expect(e.kind).toBe("unreachable");
    expect(e.code).toBe("ENETUNREACH");
  });

  test("NOMINAL relay seat → mode present, trigger empty", async () => {
    captureDir = mkdtempSync(join(tmpdir(), "conn-err-877-nominal-"));
    process.env.CLAUDISH_CAPTURE_DIR = captureDir;
    __resetCaptureDirMemo();
    setRelayModeSnapshot({ mode: "nominal", downTrigger: "" });
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    const e = readEntries(captureDir)![0];
    // A relay seat failing its provider while relaying is the OTHER half of
    // the distinction: hub reachable, provider not — the WAN is not the seat's.
    expect(e.relay_mode).toBe("nominal");
    expect(e.relay_down_trigger).toBe("");
  });

  test("no relay configured (hub) → both fields absent, not empty", async () => {
    captureDir = mkdtempSync(join(tmpdir(), "conn-err-877-hub-"));
    process.env.CLAUDISH_CAPTURE_DIR = captureDir;
    __resetCaptureDirMemo();
    setRelayModeSnapshot(null);
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    const e = readEntries(captureDir)![0];
    // Absence is the hub's honest answer: there is no relay state in this
    // process, so the line must not grow fields that would read as a verdict.
    expect("relay_mode" in e).toBe(false);
    expect("relay_down_trigger" in e).toBe(false);
  });
});
