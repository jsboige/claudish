/**
 * #283 — pin the ROUTE-level hop gate (#279 follow-up) on BOTH ingresses.
 *
 * ai-01 measured the gap during the #281 review: the relay.test.ts additions
 * pin `requestLoopedBack()` the function and `forwardToUpstream`'s appendHop,
 * but NOT the route wiring in proxy-server.ts — with both `requestLoopedBack`
 * gates removed from the routes, the whole suite stays green. The gate is the
 * only thing that turns "own id in the hop list" into "serve locally instead
 * of forwarding", and nothing tested that diversion end-to-end.
 *
 * This file drives the REAL routes in-process (createProxyServer on a loopback
 * port) with a static NOMINAL relay state pointing at a fake hub, and a fake
 * custom endpoint for the local pipeline. Both fake upstreams are intercepted
 * by URL prefix (globalThis.fetch — the relay and the composed handler both
 * call bare `fetch`, which resolves through globalThis at call time); the
 * client→proxy leg stays on the real network, which is the leg under test.
 *
 * Discriminator: the fake hub answers "FROM-THE-HUB", the fake local endpoint
 * "SERVED-LOCALLY" — so WHO served a request is readable straight from the
 * client-visible body, and the call counters close the case.
 *
 * Mutation proof (run before review): remove the `requestLoopedBack` condition
 * from the /v1/messages branch → the /v1/messages pair goes red (the request
 * is forwarded, FROM-THE-HUB, upstream hit); same on /v1/chat/completions for
 * its pair. Restore, green. The control tests (foreign id in the hop list,
 * forwarded anyway) fail if the gate is made unconditional.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { createRelayState } from "./fork/server/relay.js";
import { getInstanceId } from "./instance-id.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct from proxy-server-routing-error.test.ts (19700+),
// proxy-server-openai-notice.test.ts (19851/19951) and
// native-passthrough-strip.test.ts (19871, PR #285) in case bun ever runs
// the files concurrently.
const PROXY_PORT = 19881;
const HUB_BASE = "http://127.0.0.1:19981"; // fake upstream hub (prefix-intercepted)
const ENDPOINT_BASE = "http://127.0.0.1:19982"; // fake local custom endpoint (prefix-intercepted)

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-openai-notice.test.ts: a
// provisioned machine must behave like a bare CI runner. CLAUDISH_PROXY_KEY
// would 401 every request before the route runs; provider keys would change
// resolution; CLAUDISH_CAPTURE_DIR (#175 class) would redirect capture writes.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** The local-pipeline model: a custom endpoint served by the intercepted fetch. */
const LOCAL_MODEL = "hop-ep@fake-flash";

const upstreamHits: string[] = [];
const endpointHits: string[] = [];

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

/**
 * The fake hub. Path-aware like the real one: /v1/messages answers Anthropic
 * SSE, /v1/chat/completions answers OpenAI SSE — both saying FROM-THE-HUB, so
 * the marker is legible in the client-visible body whichever ingress was hit.
 */
function fakeHubResponse(url: string): Response {
  if (url.includes("/v1/chat/completions")) {
    return sseFromEventLines([
      `data: ${JSON.stringify({ id: "chatcmpl-hub", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-hub", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { content: "FROM-THE-HUB" } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-hub", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ]);
  }
  // /v1/messages — Anthropic SSE (the relay passthrough pipes it verbatim).
  return sseFromEventLines([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_hub", type: "message", role: "assistant", model: "fake", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, message: {}, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FROM-THE-HUB" } } as any)}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } } as any)}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ]);
}

/** The fake local endpoint — OpenAI SSE (every adapter drives it that way). */
function fakeEndpointResponse(): Response {
  return sseFromEventLines([
    `data: ${JSON.stringify({ id: "chatcmpl-ep", object: "chat.completion.chunk", created: 1, model: "fake-flash", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl-ep", object: "chat.completion.chunk", created: 1, model: "fake-flash", choices: [{ index: 0, delta: { content: "SERVED-LOCALLY" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl-ep", object: "chat.completion.chunk", created: 1, model: "fake-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
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
        "hop-ep": {
          kind: "simple",
          url: `${ENDPOINT_BASE}/v1`,
          format: "openai",
          apiKey: "test-key",
        },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  upstreamHits.length = 0;
  endpointHits.length = 0;
  // Intercept only the proxy→upstream legs; the client→proxy leg (the leg
  // under test) keeps the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(HUB_BASE)) {
      upstreamHits.push(url);
      return fakeHubResponse(url);
    }
    if (url.startsWith(ENDPOINT_BASE)) {
      endpointHits.push(url);
      return fakeEndpointResponse();
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

/**
 * Spin the proxy as a NOMINAL relay. createRelayState boots alive:true and no
 * prober is started here, so the verdict stays static for the whole test —
 * exactly the boot window #279's hop gate exists to cover: heartbeat identity
 * has not latched anything yet, only the hop list can detect the loop.
 */
async function spinNominalRelay(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true, relay: createRelayState({ upstream: HUB_BASE }) }
  );
}

async function postMessages(hops?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(hops !== undefined ? { "x-claudish-hops": hops } : {}),
    },
    body: JSON.stringify({
      model: LOCAL_MODEL,
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

async function postChatCompletions(hops?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(hops !== undefined ? { "x-claudish-hops": hops } : {}),
    },
    body: JSON.stringify({
      model: LOCAL_MODEL,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

// ---- the pin -------------------------------------------------------------------

describe("#283 — the route-level hop gate diverts on both ingresses", () => {
  test("/v1/messages: own id in the hop list → served LOCALLY, the hub is never contacted", async () => {
    await spinNominalRelay();
    const res = await postMessages(getInstanceId());

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SERVED-LOCALLY");
    expect(text).not.toContain("FROM-THE-HUB");
    // THE pin: the diversion happened at the route, before any forward.
    expect(upstreamHits.length).toBe(0);
    expect(endpointHits.length).toBe(1);
  }, 30_000);

  test("/v1/messages: no hop header (plain NOMINAL traffic) → forwarded, response piped from the hub", async () => {
    await spinNominalRelay();
    const res = await postMessages();

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("FROM-THE-HUB");
    expect(text).not.toContain("SERVED-LOCALLY");
    expect(upstreamHits.length).toBe(1);
    expect(endpointHits.length).toBe(0);
  }, 30_000);

  test("/v1/chat/completions: own id in the hop list → served LOCALLY on the translated ingress too", async () => {
    await spinNominalRelay();
    const res = await postChatCompletions(getInstanceId());

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SERVED-LOCALLY");
    expect(text).not.toContain("FROM-THE-HUB");
    expect(upstreamHits.length).toBe(0);
    expect(endpointHits.length).toBe(1);
  }, 30_000);

  test("/v1/chat/completions: FOREIGN id in the hop list → still forwarded (the list is append-only evidence, only SELF diverts)", async () => {
    await spinNominalRelay();
    const res = await postChatCompletions("node-x");

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("FROM-THE-HUB");
    expect(text).not.toContain("SERVED-LOCALLY");
    // Exactness (upstreamHits === 1, single copy of the content) is #286's to
    // pin: as of filing, the OpenAI-wire forward re-forwards twice and pipes
    // every body — 3 hits, 3 copies + a synthetic anthropic tail — because
    // createAnthropicPassthroughStream's #170 predicate never arms on the
    // OpenAI wire. This control only pins the GATE's semantics here: a foreign
    // id does NOT divert (≥1 forward, hub-served); making the gate
    // unconditional would serve locally and drive this to 0.
    expect(upstreamHits.length).toBeGreaterThan(0);
    expect(endpointHits.length).toBe(0);
  }, 30_000);
});
