/**
 * #1213 — route-level pins: a provider 5xx RELAYED by the hub reaches the
 * client MARKED (`x-claudish-upstream-error: 1`), and nothing else ever does.
 *
 * Mirrors the proxy-server-served-model-route.test.ts harness (#1128): the REAL
 * routes in-process (createProxyServer on a loopback port), the proxy→endpoint
 * leg intercepted (a fake custom endpoint), the client→proxy leg on the real
 * network — the leg under test. The fake stands for the measured incident: a
 * custom endpoint whose front page answers 502 while the engine behind it is
 * down (myia-po-2028, 2026-11-26 — 32 local replays and a 66.7 s AUTONOMOUS
 * flip on the relaying seat, for one dead model).
 *
 * Why the marker is the fix: a relaying sidecar read EVERY hub 5xx as the
 * hub's own death. The hub answers a provider 5xx with the provider's status,
 * so the relay replayed each one locally against the SAME dead provider. The
 * marker says "the hub spoke; the 5xx is the provider's" and the relay passes
 * it through (fork/server/relay.test.ts pins that side).
 *
 * Pins:
 * - marked: the relayed 5xx (500/502/504 — a provider 503 is converted to the
 *   hub's own 529 before any envelope) on /v1/messages AND /v1/chat/completions,
 *   streaming and JSON alike. The OpenAI ingress builds its error from
 *   scratch, so the marker dies there unless carried — that carry is pinned.
 * - unmarked: a provider 4xx, the hub's OWN answers (a malformed body, an
 *   unroutable model, the 529 conversion), and a healthy 200.
 * - never the provider's string: the provider's own `x-claudish-upstream-error`
 *   header is never copied — the marker is the hub's or absent.
 * - survives the hub's own rebuilds: a budget-leased endpoint
 *   (withBudgetRelease) and an armed cascade whose LAST step is the dead one.
 *
 * Not reachable here, by construction: the route's catch-path 500
 * (`[Proxy] ERROR 500`) is built by the route itself, never through the
 * ComposedHandler envelope — unmarked, and the relay keeps flipping on it
 * (relay.test.ts: "HTTP 500 from hub → null + counts as failure").
 *
 * Mutation proof: drop either hub marker set, the OpenAI-ingress carry, or a
 * `status >= 500` conjunct — each red below.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetFailoverForTests } from "./fork/failover.js";
import { setPatientBackoffTimingsForTests } from "./handlers/composed-handler.js";
import {
  UPSTREAM_ERROR_HEADER,
  UPSTREAM_ERROR_MARKER,
} from "./handlers/shared/upstream-error-marker.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// One allocation per file (test-support/port-allocation.test.ts).
const PROXY_PORT = 19987;
const DEAD_BASE = "http://127.0.0.1:39987"; // never dialed: fetch intercepted
const WALL_BASE = "http://127.0.0.1:39988"; // never dialed: fetch intercepted

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-served-model-route.test.ts: a
// provisioned machine must behave like a bare CI runner.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODING_API_KEY",
  "LITELLM_API_KEY",
  "POE_API_KEY",
  "DEEPSEEK_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_RELAY_UPSTREAM",
  // The endpoint budget knob for the dead endpoint (`ue-dead` normalizes to
  // UE_DEAD): the lease rebuild is one of the seams under test.
  "CLAUDISH_ENDPOINT_TOKEN_BUDGET_UE_DEAD",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

const CONCRETE = "ue-model";
const STEP_DEAD = `ue-dead@${CONCRETE}`;
const STEP_WALL = "ue-wall@fake-a";

/** The provider front's own page — the body the incident surfaced. */
const IIS_502_PAGE =
  "<!DOCTYPE html><html><head><title>502 - Web server received an invalid response while acting as a gateway or proxy server.</title></head><body><h1>502</h1></body></html>";

/** What the dead endpoint answers for the next request. */
let deadStatus = 502;
let deadBody: string = IIS_502_PAGE;
let deadHeaders: Record<string, string> = { "content-type": "text/html" };
let deadCalls = 0;

/** A complete healthy OpenAI SSE turn, for the unmarked-200 control. */
function deadEndpointHealthy(): Response {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: CONCRETE,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse = `${chunk({ role: "assistant", content: "" }) + chunk({ content: "Hello from the concrete." }) + chunk({}, "stop")}data: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** JSON error body in the OpenAI error shape, with a 4xx/5xx status. */
function jsonError(
  status: number,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ error: { type: "upstream_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "ue-dead": { kind: "simple", url: `${DEAD_BASE}/v1`, format: "openai", apiKey: "test-key" },
        "ue-wall": { kind: "simple", url: `${WALL_BASE}/v1`, format: "openai", apiKey: "test-key" },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  deadStatus = 502;
  deadBody = IIS_502_PAGE;
  deadHeaders = { "content-type": "text/html" };
  deadCalls = 0;
  // Intercept only the proxy→endpoint leg; the client→proxy leg (the leg under
  // test) keeps the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(DEAD_BASE)) {
      deadCalls++;
      return new Response(deadBody, { status: deadStatus, headers: deadHeaders });
    }
    if (url.startsWith(WALL_BASE)) {
      return jsonError(402, "quota exhausted");
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetFailoverForTests();
});

async function spin(failoverEnv?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      quiet: true,
    }
  );
  resetFailoverForTests(failoverEnv);
}

async function askMessages(model: string, stream: boolean, rawBody?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body:
      rawBody ??
      JSON.stringify({
        model,
        stream,
        max_tokens: 100,
        messages: [{ role: "user", content: "say hi" }],
      }),
  });
}

async function askOpenAI(model: string, stream: boolean, rawBody?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body:
      rawBody ?? JSON.stringify({ model, stream, messages: [{ role: "user", content: "say hi" }] }),
  });
}

/** Point the dead endpoint at a JSON error of the given status. */
function deadAnswersJson(status: number, headers: Record<string, string> = {}): void {
  deadStatus = status;
  deadBody = JSON.stringify({
    error: { type: "upstream_error", message: `provider answered ${status}` },
  });
  deadHeaders = { "content-type": "application/json", ...headers };
}

// What the routes answer on their error branch — Anthropic-shaped on
// /v1/messages, OpenAI-shaped on /v1/chat/completions. Typed, not `any`: in this
// bun-types, `res.json()` is `unknown`.
type ErrorBody = { type?: string; error: { type?: string; message?: string } };

// ---- marked: the relayed provider 5xx ------------------------------------------

describe("#1213 — a relayed provider 5xx reaches the client MARKED, on both ingresses", () => {
  test("/v1/messages JSON: the provider's 502 page → 502 + marker, Anthropic-shaped", async () => {
    await spin();
    const res = await askMessages(STEP_DEAD, false);

    expect(res.status).toBe(502); // the provider's status — unchanged by #1213
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    expect(deadCalls).toBe(1); // one upstream call: the hub does not replay either
    const body = (await res.json()) as ErrorBody;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("502");
  }, 30_000);

  test("/v1/messages streaming: the client asked for a stream, the error still arrives 502 + marker", async () => {
    await spin();
    const res = await askMessages(STEP_DEAD, true);

    expect(res.status).toBe(502);
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    expect(res.headers.get("content-type")).toContain("application/json"); // an error envelope, never a 200 SSE
    const body = (await res.json()) as ErrorBody;
    expect(body.type).toBe("error");
  }, 30_000);

  test("/v1/messages: 500 and 504 are marked like the 502", async () => {
    await spin();
    for (const status of [500, 504]) {
      deadAnswersJson(status);
      const res = await askMessages(STEP_DEAD, false);
      expect(res.status).toBe(status);
      expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
      await res.text();
    }
  }, 30_000);

  test("/v1/chat/completions JSON: the marker survives the OpenAI error translation", async () => {
    await spin();
    const res = await askOpenAI(STEP_DEAD, false);

    expect(res.status).toBe(502);
    // The translation rebuilds the error from scratch (`c.json(oaiErr, …)`) —
    // without the carry this header is the one the rebuild drops.
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain("502"); // OpenAI error shape
    expect(body.type).toBeUndefined(); // …not the Anthropic one
  }, 30_000);

  test("/v1/chat/completions streaming: 502 + marker too (the error branch precedes the stream branch)", async () => {
    await spin();
    const res = await askOpenAI(STEP_DEAD, true);

    expect(res.status).toBe(502);
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.message).toContain("502");
  }, 30_000);
});

// ---- unmarked: everything the hub answers on its own account -------------------

describe("#1213 — a response that is not a relayed provider 5xx is never marked", () => {
  test("/v1/messages: a provider 400 and 401 are relayed UNMARKED", async () => {
    await spin();
    for (const status of [400, 401]) {
      deadAnswersJson(status);
      const res = await askMessages(STEP_DEAD, false);
      expect(res.status).toBe(status);
      expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
      await res.text();
    }
  }, 30_000);

  test("/v1/chat/completions: a provider 400 is relayed UNMARKED — the carry copies nothing when the hub set nothing", async () => {
    await spin();
    deadAnswersJson(400);
    const res = await askOpenAI(STEP_DEAD, false);

    expect(res.status).toBe(400);
    expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
    await res.text();
  }, 30_000);

  test("the hub's OWN 400 (a malformed body, answered before any handler) carries no marker", async () => {
    await spin();
    for (const ask of [askMessages, askOpenAI]) {
      const res = await ask(STEP_DEAD, false, "{not json");
      expect(res.status).toBe(400);
      expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
      await res.text();
    }
    expect(deadCalls).toBe(0); // never reached the provider
  }, 30_000);

  test("the hub's OWN routing refusal (an unroutable model) carries no marker", async () => {
    await spin();
    const res = await askMessages("no-such-model-anywhere", false);

    expect(res.status).toBe(403); // #296 shape A — the native lane's refusal
    expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
    await res.text();
  }, 30_000);

  test("a provider 503 is the hub's own 529 — unmarked, and still the status a relay already passes through", async () => {
    // Production patience is ~5 min; keep the loop's shape only, and restore.
    setPatientBackoffTimingsForTests({ maxRetries: 1, baseDelayMs: 1 });
    try {
      await spin();
      deadAnswersJson(503);
      const res = await askMessages(STEP_DEAD, false);

      expect(res.status).toBe(529);
      expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
      await res.text();
    } finally {
      setPatientBackoffTimingsForTests(null);
    }
  }, 30_000);

  test("a healthy 200 whose provider carries the header: the client's 200 is NOT marked", async () => {
    await spin();
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? "");
      if (url.startsWith(DEAD_BASE)) {
        deadCalls++;
        return new Response(deadEndpointHealthy().body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            [UPSTREAM_ERROR_HEADER]: UPSTREAM_ERROR_MARKER,
          },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await askMessages(STEP_DEAD, true);

    expect(res.status).toBe(200);
    expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
    expect(await res.text()).toContain("message_stop");
  }, 30_000);
});

// ---- the marker is the hub's own, never the provider's string ------------------

describe("#1213 — never the provider's string", () => {
  test("a provider 502 carrying a FOREIGN marker value → the client sees the hub's exact `1`", async () => {
    await spin();
    deadAnswersJson(502, { [UPSTREAM_ERROR_HEADER]: "forged" });
    const res = await askMessages(STEP_DEAD, false);

    expect(res.status).toBe(502);
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    await res.text();
  }, 30_000);

  test("a provider 403 CLAIMING the marker → 403, unmarked", async () => {
    await spin();
    deadAnswersJson(403, { [UPSTREAM_ERROR_HEADER]: UPSTREAM_ERROR_MARKER });
    const res = await askMessages(STEP_DEAD, false);

    expect(res.status).toBe(403);
    expect(res.headers.has(UPSTREAM_ERROR_HEADER)).toBe(false);
    await res.text();
  }, 30_000);
});

// ---- survives the hub's own rebuilds -------------------------------------------

describe("#1213 — the marker survives the hub's own rebuilds", () => {
  test("a budget-leased endpoint: the marker survives withBudgetRelease", async () => {
    // The #654 lease rebuilds the handler's Response (fresh object, headers
    // copied) BEFORE the route returns it — the same seam #1142 fixed for the
    // served-model header.
    process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_UE_DEAD = "1000000";
    await spin();
    const res = await askMessages(STEP_DEAD, false);

    expect(res.status).toBe(502);
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    await res.text();
  }, 30_000);

  test("an armed cascade whose LAST step is the dead endpoint: the final answer is that step's 502, marked", async () => {
    await spin({
      CLAUDISH_FAILOVER_SONNET: `${STEP_WALL}>${STEP_DEAD}`,
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    const res = await askMessages("claude-sonnet-5", false);

    expect(res.status).toBe(502); // the LAST step's status — the first step's 402 never reaches the client
    expect(res.headers.get(UPSTREAM_ERROR_HEADER)).toBe(UPSTREAM_ERROR_MARKER);
    expect(deadCalls).toBe(1);
    await res.text();
  }, 30_000);
});
