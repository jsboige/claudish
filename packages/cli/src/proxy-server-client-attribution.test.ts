/**
 * #682 — pin the CLIENT-ATTRIBUTION header at the ROUTE level, on BOTH
 * ingresses.
 *
 * #686/#687 shipped the mechanism (compose `x-claudish-client: <machine>:
 * <workspace>` from the inbound `x-claudish-machine` / `x-claudish-workspace`
 * headers, inject it toward an endpoint that opted in with
 * `clientAttribution: true`), and #823 extended the opt-in to the anthropic
 * wire. Every existing pin sits one layer BELOW the routes:
 * `composed-handler.test.ts` drives `handleWithCascade` with a fabricated
 * context, `client-attribution.test.ts` pins the composition function, and
 * `custom-endpoints-loader.test.ts` pins that the transport carries the flag.
 *
 * Nothing proved the two INGRESSES wire those pieces together — a route that
 * rebuilt its context (or re-read headers after translation) would keep the
 * whole suite green while attributing nothing. This file drives the REAL
 * routes on a loopback port with prefix-intercepted fake endpoints:
 *
 *   POST /v1/messages          → anthropic-wire custom endpoint (`attr-anth`)
 *   POST /v1/chat/completions  → openai-wire custom endpoint (`attr-oai`)
 *
 * and reads the outbound header set that actually left the box.
 *
 * The other two ACs of #682 are pinned where the control belongs, not here:
 * AC2 (the native lane leaks no `x-claudish-*` toward Anthropic) lives in
 * `native-passthrough-strip.test.ts` (#282), and AC3 (a relay preserves the
 * header sidecar → hub) in `fork/server/relay.test.ts` (#686).
 *
 * Mutation proof: drop `applyClientAttribution` from the header-build site in
 * composed-handler.ts → all four tests below go red (the header is absent
 * from the captured set). Restore, green. Making the composition ingress-
 * specific (e.g. only on /v1/messages) turns exactly one pair red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// Distinct from every port already claimed by sibling suites (19851+ range).
const PROXY_PORT = 14981;
const ANTH_BASE = "http://127.0.0.1:14982"; // anthropic-wire custom endpoint
const OAI_BASE = "http://127.0.0.1:14983"; // openai-wire custom endpoint

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-hop-gate.test.ts: a provisioned
// machine must behave like a bare CI runner. CLAUDISH_CLIENT_ATTRIBUTION is
// cleared so a machine-level `=0` (kill switch) cannot silently disarm the
// very thing under test.
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
  "CLAUDISH_CLIENT_ATTRIBUTION",
  "CLAUDISH_RELAY_UPSTREAM",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

interface Hit {
  url: string;
  headers: Record<string, string>;
}
const anthHits: Hit[] = [];
const oaiHits: Hit[] = [];

function headersOf(init: any): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return out;
  if (typeof raw.forEach === "function" && typeof raw.get === "function") {
    raw.forEach((v: string, k: string) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = String(v);
  return out;
}

function sseFromEventLines(lines: string[]): Response {
  const sse = lines.join("\n") + "\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The fake anthropic-wire endpoint — Anthropic SSE, marker in the text. */
function fakeAnthropicEndpointResponse(): Response {
  return sseFromEventLines([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_anth", type: "message", role: "assistant", model: "fake", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, message: {}, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SERVED-ANTH" } } as any)}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } } as any)}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ]);
}

/** The fake openai-wire endpoint — OpenAI SSE chunks, marker in the text. */
function fakeOpenAIEndpointResponse(): Response {
  return sseFromEventLines([
    `data: ${JSON.stringify({ id: "chatcmpl-oai", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl-oai", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { content: "SERVED-OAI" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl-oai", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ]);
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "attr-anth": {
          kind: "simple",
          url: ANTH_BASE,
          format: "anthropic",
          apiKey: "test-key",
          clientAttribution: true,
        },
        "attr-oai": {
          kind: "simple",
          url: `${OAI_BASE}/v1`,
          format: "openai",
          apiKey: "test-key",
          clientAttribution: true,
        },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  anthHits.length = 0;
  oaiHits.length = 0;
  // Intercept only the proxy→endpoint legs; the client→proxy leg (the leg
  // under test) keeps the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(ANTH_BASE)) {
      anthHits.push({ url, headers: headersOf(init) });
      return fakeAnthropicEndpointResponse();
    }
    if (url.startsWith(OAI_BASE)) {
      oaiHits.push({ url, headers: headersOf(init) });
      return fakeOpenAIEndpointResponse();
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
});

/** HUB mode — no relay upstream, so both requests go through the local pipeline. */
async function spinHub(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
}

async function postMessages(headers: Record<string, string>): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "attr-anth@fake-model",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

async function postChatCompletions(headers: Record<string, string>): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "attr-oai@fake-model",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

const ATTRIB = {
  "x-claudish-machine": "myia-po-2027",
  "x-claudish-workspace": "claudish",
};

describe("#682 — x-claudish-client leaves on BOTH ingresses, route level", () => {
  test("/v1/messages → anthropic-wire endpoint: composed value + machine verbatim on the wire", async () => {
    await spinHub();
    const res = await postMessages(ATTRIB);
    await res.text();

    expect(res.status).toBe(200);
    expect(anthHits.length).toBe(1);
    expect(anthHits[0].headers["x-claudish-client"]).toBe("myia-po-2027:claudish");
    expect(anthHits[0].headers["x-claudish-machine"]).toBe("myia-po-2027");
    expect(anthHits[0].headers["content-type"]).toBe("application/json");
    expect(oaiHits.length).toBe(0);
  }, 30_000);

  test("/v1/chat/completions → openai-wire endpoint: same header, translated ingress", async () => {
    await spinHub();
    const res = await postChatCompletions(ATTRIB);
    await res.text();

    expect(res.status).toBe(200);
    expect(oaiHits.length).toBe(1);
    expect(oaiHits[0].headers["x-claudish-client"]).toBe("myia-po-2027:claudish");
    expect(oaiHits[0].headers["x-claudish-machine"]).toBe("myia-po-2027");
    expect(anthHits.length).toBe(0);
  }, 30_000);

  test("/v1/messages without attribution headers: `unknown:unknown` — never absent", async () => {
    await spinHub();
    const res = await postMessages({});
    await res.text();

    expect(res.status).toBe(200);
    expect(anthHits.length).toBe(1);
    expect(anthHits[0].headers["x-claudish-client"]).toBe("unknown:unknown");
    // never fabricated when the source header is absent
    expect(anthHits[0].headers["x-claudish-machine"]).toBeUndefined();
  }, 30_000);

  test("/v1/chat/completions without attribution headers: `unknown:unknown` too", async () => {
    await spinHub();
    const res = await postChatCompletions({});
    await res.text();

    expect(res.status).toBe(200);
    expect(oaiHits.length).toBe(1);
    expect(oaiHits[0].headers["x-claudish-client"]).toBe("unknown:unknown");
    expect(oaiHits[0].headers["x-claudish-machine"]).toBeUndefined();
  }, 30_000);
});
