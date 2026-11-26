/**
 * #1209 part 2/2 — a `stream:false` client that hangs up must not keep being
 * paid for.
 *
 * MEASURED (issue #1209, sidecar po-2028, 26/11 04:20→05:05Z): ten `nb_coder`
 * calls each paid a 360 s forward header-timeout and were then served locally;
 * six of them finished their generation 12–359 s AFTER the client's own budget
 * had expired (`[resp] … closed=true`, 50–70 K chars each) — ≈90 K completion
 * tokens plus six 100–150 K prompts paid for and discarded.
 *
 * THE RULE THIS FILE PINS: for a non-streaming request the upstream fetch
 * carries the request's own abort signal, so the upstream is cancelled at the
 * moment the server sees the socket close — and nothing downstream re-issues
 * for a client that is gone (no retry, no 5xx a cascade would walk, no failure
 * blamed on the provider). `@hono/node-server` is what fires that signal: its
 * `outgoing` "close" handler aborts the request's AbortController with
 * "Client connection prematurely closed." whenever the response was not fully
 * written (node-server 1.19.6, dist/listener.js L542-548 — read, not assumed).
 *
 * The scoping is a decision, so it has its own pin: streaming requests are NOT
 * bound to the client signal (the relay passthrough and the never-hang contract
 * own that path; #1209 scopes this fix to the sync path).
 *
 * Harness shape copied from the sibling route suites: the real proxy in-process
 * via `createProxyServer()` (port 0 → ephemeral, returned as `proxy.port`, so
 * no port claims to coordinate), a raw `net.Socket` as the client, and
 * `installStubFetch` for the upstream — never `Bun.serve` (#593: a Bun.serve
 * created after any node:http server in the same `bun test` process is
 * unreachable).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import {
  ComposedHandler,
  combineAbortSignals,
  setPatientBackoffTimingsForTests,
  syncClientAbortSignal,
} from "./handlers/composed-handler.js";
import {
  preStreamPolicyRetry,
  setPolicyRetryBackoffForTests,
} from "./handlers/shared/stream-parsers/policy-refusal.js";
import { setDiagOutput } from "./logger.js";
import { resetOpenRouterCatalogForTests } from "./providers/catalog-resolvers/openrouter.js";
import type { ProviderTransport } from "./providers/transport/types.js";
import { createProxyServer } from "./proxy-server.js";
import { hangUntilAborted, installStubFetch } from "./test-support/stub-fetch.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Every env name that could route this request somewhere other than the stub:
// provider credentials, the proxy's own auth keys, the relay branch and the
// fail-closed native guard. Restored in afterEach.
const SANDBOXED_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "LITELLM_API_KEY",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_RELAY_UPSTREAM",
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let proxy: ProxyServer | null = null;
let restoreFetch: (() => void) | null = null;
let capDir = "";

const nativeFetch = globalThis.fetch;
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url);

function sandbox(): void {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of SANDBOXED_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.OPENAI_API_KEY = "sk-test-client-gone";
  capDir = join(tmpdir(), `claudish-client-gone-${process.pid}-${Date.now()}`);
  process.env.CLAUDISH_CAPTURE_DIR = capDir;
}

function restore(): void {
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOXED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(capDir, { recursive: true, force: true });
  } catch {}
}

beforeEach(() => {
  sandbox();
  resetOpenRouterCatalogForTests();
});

afterEach(async () => {
  if (proxy) {
    await proxy.shutdown();
    proxy = null;
  }
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  // Module-global test hooks: never let one test's timings leak into the next.
  setPatientBackoffTimingsForTests(null);
  setPolicyRetryBackoffForTests(null);
  restore();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms — ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A promise the test resolves by hand, at a chosen moment of the handler's run. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One raw HTTP/1.1 POST over a real socket — the only way to close a client. */
async function openPost(port: number, body: Record<string, unknown>): Promise<net.Socket> {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  const payload = JSON.stringify(body);
  const head = [
    "POST /v1/messages HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
  sock.write(`${head}${payload}`);
  return sock;
}

/** Wait for a CONDITION, never a fixed sleep, before starting the next phase. */
async function waitFor(ok: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout after ${ms} ms — ${what}`);
    await sleep(10);
  }
}

// ---- the seams (scoping is a decision, so it is pinned by name) --------------

describe("#1209 (2/2) — the client-gone seam", () => {
  test("syncClientAbortSignal: bound for stream:false, undefined for stream:true", () => {
    const ac = new AbortController();
    const c = { req: { raw: { signal: ac.signal } } } as unknown as Context;
    expect(syncClientAbortSignal(c, { stream: false })).toBe(ac.signal);
    expect(syncClientAbortSignal(c, {})).toBe(ac.signal);
    expect(syncClientAbortSignal(c, undefined)).toBe(ac.signal);
    expect(syncClientAbortSignal(c, { stream: true })).toBeUndefined();
    // No request to read a signal from (non-HTTP callers): nothing to bind.
    expect(syncClientAbortSignal({} as unknown as Context, { stream: false })).toBeUndefined();
  });

  test("combineAbortSignals: a lone signal is returned as is; either input aborts the pair", () => {
    const a = new AbortController();
    const b = new AbortController();
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
    expect(combineAbortSignals(a.signal, undefined)).toBe(a.signal);
    expect(combineAbortSignals(undefined, b.signal)).toBe(b.signal);
    const both = combineAbortSignals(a.signal, b.signal)!;
    expect(both.aborted).toBe(false);
    b.abort("client gone");
    expect(both.aborted).toBe(true);
    expect(both.reason).toBe("client gone");
  });

  test("combineAbortSignals: an input aborted BEFORE the call is not silently dropped", () => {
    const a = new AbortController();
    const b = new AbortController();
    a.abort("already gone");
    // An already-aborted input would never fire its "abort" listener again —
    // the pair must resolve to it directly, not to a signal that never aborts.
    const combined = combineAbortSignals(a.signal, b.signal)!;
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("already gone");
  });

  test("preStreamPolicyRetry: shouldStop is consulted BEFORE the attempt is counted", async () => {
    setPolicyRetryBackoffForTests([1, 1]);
    // Witness first (a zero is only a verdict next to a positive): with no stop
    // condition the same call DOES issue its retry.
    let witnessCalls = 0;
    const witness = await preStreamPolicyRetry(
      () => {
        witnessCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      { lane: "openai", model: "test-model" }
    );
    expect(witnessCalls).toBe(1);
    expect(witness.response?.status).toBe(200);

    // A departure must issue nothing AND leave the `action=retry` ledger (#41/
    // #60) untouched — counting the attempt before the check would make six
    // departed clients look like a policy-refusal storm.
    let calls = 0;
    const stopped = await preStreamPolicyRetry(
      () => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status: 400 }));
      },
      { lane: "openai", model: "test-model", shouldStop: () => true }
    );
    expect(calls).toBe(0);
    expect(stopped.attempts).toBe(0);
    expect(stopped.response).toBeNull();
  });
});

// ---- the handler's terminal answer -------------------------------------------
//
// Each test below is one place the client can leave. The upstream fetch must be
// cancelled at that moment, and nothing downstream may re-issue for a client
// that is gone — the re-issue sites (overload backoff, in-stream rate-limit
// backoff, policy-refusal retry) would otherwise each pay the body again, or
// end in a 5xx a cascade would walk onto a paid step.

/** One OpenAI chat-completion SSE frame. */
function oaiChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** The measured "closed" shape: the peer dropped the connection before any byte. */
function econnreset(): Promise<Response> {
  return Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }));
}

/** A complete, ordinary answer — what a live client is owed at the end of a ladder. */
function okSse(): Response {
  const body = `${oaiChunk({ role: "assistant" })}${oaiChunk({ content: "ok" }, "stop")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Z.AI's burst limit as it really arrives: HTTP 200, then an SSE error. */
const RATE_LIMIT_SSE = `event: error\ndata: ${JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", code: "1302", message: "Rate limit reached for requests" },
})}\n\n`;
const rateLimitSse = () =>
  new Response(RATE_LIMIT_SSE, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** The refusal class of #155: a plain 4xx carrying `invalid_prompt`. */
const POLICY_REFUSAL_BODY = JSON.stringify({
  error: {
    code: "invalid_prompt",
    message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
  },
});

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** The three facts every client-gone answer shares. */
function expectClientGone(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get("x-claudish-client-gone")).toBe("1");
  // Omitted on purpose (#1128): an answer nobody received served no one.
  expect(res.headers.get("x-claudish-served-model")).toBeNull();
}

describe("#1209 (2/2) — the terminal answer to a client that left", () => {
  const encoder = new TextEncoder();
  const UPSTREAM = "http://upstream.test/v1/chat/completions";
  type MessageBody = { type: string; content: unknown[]; stop_reason: string };

  /** Runs one handled request over a Hono app; the fetch is the caller's. */
  async function drive(
    fetchImpl: (req: Request) => Response | Promise<Response>,
    opts: {
      signal?: AbortSignal;
      requestInit?: Record<string, unknown>;
      streamFormat?: "openai-sse" | "anthropic-sse";
      stream?: boolean;
      forceRefreshAuth?: () => void | Promise<void>;
    } = {}
  ): Promise<Response> {
    const restore = installStubFetch((req) => {
      // A pin counts its OWN upstream only (#1076): CI runs the whole suite in
      // one process, and work left behind by an earlier file may still fetch.
      if (!req.url.startsWith(UPSTREAM)) {
        return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      }
      return fetchImpl(req);
    });
    try {
      // Transport shape copied from policy-refusal-prestream.test.ts: a bare
      // `streamFormat` field does not select the anthropic lane (#102) — the
      // override does.
      const transport = {
        name: "test-provider",
        displayName: "Test",
        streamFormat: "openai-sse",
        ...(opts.streamFormat ? { overrideStreamFormat: () => opts.streamFormat } : {}),
        ...(opts.forceRefreshAuth ? { forceRefreshAuth: opts.forceRefreshAuth } : {}),
        getEndpoint: () => UPSTREAM,
        getHeaders: () => ({}),
        ...(opts.requestInit ? { getRequestInit: () => opts.requestInit } : {}),
      } as unknown as ProviderTransport;
      const payload = {
        model: "test-model",
        max_tokens: 64,
        stream: opts.stream ?? false,
        messages: [{ role: "user", content: "hello" }],
      };
      const handler = new ComposedHandler(transport, "test-model", "test-model", 8462, {});
      const app = new Hono();
      app.post("/v1/messages", (c: Context) => handler.handle(c, payload));
      return await app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } finally {
      restore();
    }
  }

  test("a client that aborts before headers gets a well-formed 200, marked, never a 500", async () => {
    const ac = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const reached = deferred();
    const pending = drive(
      (req) => {
        upstreamSignal = req.signal;
        reached.resolve();
        // "thinking, no headers yet" — the measured shape of the incident.
        return hangUntilAborted(req);
      },
      { signal: ac.signal }
    );
    await withTimeout(reached.promise, 5000, "the handler never reached the upstream");
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal!.aborted).toBe(false);
    ac.abort("client gone");

    const res = await withTimeout(pending, 5000, "the handler never answered the aborted call");
    expect(upstreamSignal!.aborted).toBe(true); // the upstream fetch WAS cancelled
    expectClientGone(res);
    const body = (await res.json()) as MessageBody;
    expect(body.type).toBe("message");
    expect(body.content).toEqual([]);
    expect(body.stop_reason).toBe("end_turn");
  }, 20000);

  test("a client that leaves during the CONNECT-RETRY ladder gets no retry and is not charged", async () => {
    // The "closed" class (ECONNRESET before any byte) is retried after a rung —
    // 400 ms, then 1200 ms (connectRetryDelaysMs). A client that hangs up inside
    // the first rung must not be answered with the original 400
    // connection_error: that reply charges the failure to the PROVIDER (durable
    // connection-error line, telemetry, a failed stat) for a client that will
    // never read it, and a cascade would walk onto it.
    const ac = new AbortController();
    let calls = 0;
    // The ladder's own marker is part of the contract: a "retry 1/2" line for
    // an attempt issued to nobody reads, in an operator's log, as the provider
    // dropping the connection twice.
    const stderrLines: string[] = [];
    setDiagOutput({
      write: (line: string) => void stderrLines.push(line),
    } as unknown as Parameters<typeof setDiagOutput>[0]);
    try {
      const pending = drive(
        () => {
          calls += 1;
          return econnreset();
        },
        { signal: ac.signal }
      );
      await waitFor(() => calls >= 1, 5000, "the handler never reached the upstream");
      await sleep(100); // inside the first rung (400 ms)
      ac.abort("client gone");

      const res = await withTimeout(
        pending,
        2000,
        "the handler kept retrying for a client that is gone"
      );
      expect(calls).toBe(1); // the next rung's refetch was never issued
      expectClientGone(res);
      expect(stderrLines.filter((line) => line.includes("[ConnectRetry]"))).toEqual([]);
    } finally {
      setDiagOutput(null);
    }
  }, 20000);

  test("WITNESS: a client that stays gets the ladder's retry and its marker (the capture above sees them)", async () => {
    // The zero asserted above is only a verdict next to a positive: same stub,
    // same capture, the client simply does not leave — the ladder issues its
    // retry and says so. Also the regression guard of the ladder itself: the
    // client-gone parameter changed nothing for a live client.
    let calls = 0;
    const stderrLines: string[] = [];
    setDiagOutput({
      write: (line: string) => void stderrLines.push(line),
    } as unknown as Parameters<typeof setDiagOutput>[0]);
    try {
      const res = await withTimeout(
        drive(() => {
          calls += 1;
          return calls === 1 ? econnreset() : Promise.resolve(okSse());
        }),
        5000,
        "the ladder never answered a live client"
      );
      expect(calls).toBe(2); // the initial attempt + the ladder's retry
      expect(res.headers.get("x-claudish-client-gone")).toBeNull(); // a normal answer
      const body = (await res.json()) as MessageBody;
      expect(JSON.stringify(body.content)).toContain("ok");
      const markers = stderrLines.filter((line) => line.includes("[ConnectRetry]"));
      expect(markers.length).toBe(1);
      expect(markers[0]).toContain("retry 1/2");
    } finally {
      setDiagOutput(null);
    }
  }, 20000);

  test("the gate is the SIGNAL, not the error class — a re-labelled abort is still client-gone", async () => {
    // OpenAIProviderTransport turns every AbortError into OpenAITimeoutError
    // (openai.ts L281-284). An error-name gate would miss exactly the incident
    // this fixes, so the stub reproduces that re-labelling.
    const ac = new AbortController();
    let calls = 0;
    const pending = drive(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          calls += 1;
          req.signal.addEventListener(
            "abort",
            () => {
              const err = new Error("Request to OpenAI API timed out.");
              err.name = "OpenAITimeoutError";
              reject(err);
            },
            { once: true }
          );
        }),
      { signal: ac.signal }
    );
    await waitFor(() => calls >= 1, 5000, "the handler never reached the upstream");
    ac.abort("client gone");

    const res = await withTimeout(pending, 5000, "the handler never answered the aborted call");
    expectClientGone(res);
  }, 20000);

  test("a transport's own signal is preserved, not replaced", async () => {
    // LocalProviderTransport hands a 10-minute AbortSignal.timeout(): dropping
    // it would trade a client-abort fix for an unbounded upstream.
    const providerAbort = new AbortController();
    let observed: AbortSignal | undefined;
    const reached = deferred();
    const pending = drive(
      (req) => {
        observed = req.signal;
        reached.resolve();
        // A plain 4xx: no patience, no retry — the handler answers at once.
        return new Response("{}", { status: 404 });
      },
      { requestInit: { signal: providerAbort.signal } }
    );
    await withTimeout(reached.promise, 5000, "the handler never reached the upstream");
    expect(observed).toBeDefined();
    expect(observed).not.toBe(providerAbort.signal); // combined…
    expect(observed!.aborted).toBe(false);
    providerAbort.abort("transport timeout");
    expect(observed!.aborted).toBe(true); // …and still carrying the transport's
    await withTimeout(pending, 5000, "the handler never answered");
  }, 20000);

  test("a client that leaves MID-GENERATION cancels the upstream and gets no partial turn", async () => {
    // Headers arrived long ago and the meter is running: this is where the
    // incident's ≈90 K completion tokens were spent (generations finishing
    // 12–359 s after the client's budget had expired).
    const ac = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const pending = drive(
      (req) => {
        upstreamSignal = req.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(oaiChunk({ role: "assistant" }) + oaiChunk({ content: "partial" }))
            );
            // What a real fetch does to a body when its signal fires.
            req.signal.addEventListener("abort", () => controller.error(abortError()), {
              once: true,
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      { signal: ac.signal }
    );
    await waitFor(() => upstreamSignal !== undefined, 5000, "the upstream never started answering");
    await sleep(50); // the parser has consumed the first tokens
    expect(upstreamSignal!.aborted).toBe(false);
    ac.abort("client gone");

    const res = await withTimeout(pending, 5000, "the handler never answered the aborted call");
    expect(upstreamSignal!.aborted).toBe(true); // the generation was cut, not left to finish
    expectClientGone(res);
    const body = (await res.json()) as MessageBody;
    expect(body.content).toEqual([]); // not the parser's "[Upstream stream error …]" turn
  }, 20000);

  test("a client that leaves during the OVERLOAD BACKOFF gets no retry and no 529", async () => {
    setPatientBackoffTimingsForTests({ maxRetries: 6, baseDelayMs: 300 });
    const ac = new AbortController();
    let calls = 0;
    const pending = drive(
      () => {
        calls += 1;
        // A real transient overload — the patience it buys is legitimate.
        return new Response("overloaded", { status: 503 });
      },
      { signal: ac.signal }
    );
    await waitFor(() => calls >= 1, 5000, "the handler never reached the upstream");
    await sleep(100); // inside the first backoff wait (300–360 ms)
    ac.abort("client gone");

    const res = await withTimeout(
      pending,
      2000,
      "the handler kept backing off for a client that is gone"
    );
    expect(calls).toBe(1); // the announced "patient retry 1/6" was never issued
    expectClientGone(res);
  }, 20000);

  test("a client that leaves during the IN-STREAM RATE-LIMIT backoff gets no retry and no 529", async () => {
    setPatientBackoffTimingsForTests({ maxRetries: 6, baseDelayMs: 300 });
    const ac = new AbortController();
    let calls = 0;
    const pending = drive(
      () => {
        calls += 1;
        return rateLimitSse();
      },
      { signal: ac.signal, streamFormat: "anthropic-sse" }
    );
    await waitFor(() => calls >= 1, 5000, "the handler never reached the upstream");
    await sleep(100); // inside the first temporizing wait (300–1300 ms)
    ac.abort("client gone");

    const res = await withTimeout(
      pending,
      3000,
      "the handler kept temporizing for a client that is gone"
    );
    expect(calls).toBe(1);
    expectClientGone(res);
  }, 20000);

  test("a client that leaves during the in-stream rate-limit RETRY FETCH is not a sustained overload", async () => {
    setPatientBackoffTimingsForTests({ maxRetries: 6, baseDelayMs: 50 });
    const ac = new AbortController();
    let calls = 0;
    const pending = drive(
      (req) => {
        calls += 1;
        return calls === 1 ? rateLimitSse() : hangUntilAborted(req);
      },
      { signal: ac.signal, streamFormat: "anthropic-sse" }
    );
    await waitFor(() => calls >= 2, 5000, "the retry fetch never started");
    ac.abort("client gone");

    const res = await withTimeout(pending, 3000, "the handler never answered the aborted call");
    expect(calls).toBe(2);
    expectClientGone(res); // not the 529 "overload persisted", which a cascade would walk
  }, 20000);

  test("a client that leaves during the POLICY-REFUSAL RETRY gets no retry and no labeled refusal", async () => {
    setPolicyRetryBackoffForTests([400, 400]);
    const ac = new AbortController();
    let calls = 0;
    const pending = drive(
      () => {
        calls += 1;
        return new Response(POLICY_REFUSAL_BODY, {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
      { signal: ac.signal }
    );
    await waitFor(() => calls >= 1, 5000, "the handler never reached the upstream");
    await sleep(100); // inside the first retry backoff (400 ms)
    ac.abort("client gone");

    const res = await withTimeout(
      pending,
      3000,
      "the handler kept retrying for a client that is gone"
    );
    expect(calls).toBe(1); // no identical-body re-issue
    expectClientGone(res);
    expect(await res.text()).not.toContain("policy refusal");
  }, 20000);

  test("a client that leaves during the 401 re-auth retry is not an authentication failure", async () => {
    const ac = new AbortController();
    let calls = 0;
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    const pending = drive(
      () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
      {
        signal: ac.signal,
        // A token refresh takes seconds in production: hold it open.
        forceRefreshAuth: () => {
          refreshStarted.resolve();
          return releaseRefresh.promise;
        },
      }
    );
    await withTimeout(refreshStarted.promise, 5000, "the auth refresh never started");
    ac.abort("client gone"); // the client's budget expires while the token refreshes
    releaseRefresh.resolve();

    const res = await withTimeout(pending, 3000, "the handler never answered the aborted call");
    expectClientGone(res); // neither the 401 envelope nor a reported auth failure
  }, 20000);

  test("NEGATIVE: a streaming client's signal is NOT the upstream's — relay and never-hang own that path", async () => {
    const ac = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let finishBody!: () => void;
    const pending = drive(
      (req) => {
        upstreamSignal = req.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(oaiChunk({ role: "assistant" })));
            finishBody = () => {
              try {
                controller.enqueue(encoder.encode(`${oaiChunk({}, "stop")}data: [DONE]\n\n`));
                controller.close();
              } catch {
                // already closed
              }
            };
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      { signal: ac.signal, stream: true }
    );
    const res = await withTimeout(pending, 5000, "the streaming response never opened");
    expect(res.headers.get("x-claudish-client-gone")).toBeNull();
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal).not.toBe(ac.signal); // never the client's own

    ac.abort("client gone");
    await sleep(100);
    expect(upstreamSignal!.aborted).toBe(false); // this fix leaves that path alone

    finishBody();
    await res.text().catch(() => {}); // drain: the pump finalizes and clears its ping
  }, 20000);
});

// ---- the route: a real socket closes while the upstream is thinking ----------

describe("#1209 (2/2) — a stream:false client that hangs up", () => {
  test("cancels the upstream fetch, issues no retry, and leaves the proxy healthy", async () => {
    const arrivals: Request[] = [];
    let aborts = 0;
    const reached = deferred();

    restoreFetch = installStubFetch((req) => {
      if (isLoopback(req.url)) return nativeFetch(req);
      // Catalog / pricing / recommendation warm-ups run at boot: they are
      // egress but they are not this request. Answer them, never count them —
      // this pin counts its OWN upstream only (#1076).
      if (!/\/v1\/chat\/completions$/.test(req.url)) {
        return new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      arrivals.push(req);
      req.signal.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true }
      );
      reached.resolve();
      // "thinking, no headers yet" — the measured shape of the incident.
      return hangUntilAborted(req);
    });

    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    const port = proxy.port;

    const sock = await openPost(port, {
      model: "openai@gpt-4o",
      max_tokens: 16,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });

    await withTimeout(reached.promise, 5000, "the proxy never reached the upstream");
    expect(arrivals.length).toBe(1);
    expect(arrivals[0].signal.aborted).toBe(false);

    // The client's own budget expires: it closes its socket. The server sees
    // `outgoing` close with the response unwritten and aborts the request.
    sock.destroy();

    await waitFor(
      () => aborts >= 1,
      5000,
      "the upstream fetch was never cancelled after the client closed its socket"
    );

    // Settle window: the connect-retry ladder (and every other re-issue) must
    // NOT run for a client that is gone — re-paying the body is the waste.
    await sleep(400);
    expect(arrivals.length).toBe(1);
    expect(aborts).toBe(1);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 20000);
});
