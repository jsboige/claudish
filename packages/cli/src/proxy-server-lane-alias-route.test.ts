/**
 * #1055 g3 — pin the STABLE-ALIAS lane at the ROUTE level, end to end (AC1).
 *
 * g1 pinned the capture half one layer down (request-logger.test.ts: the
 * `lane` envelope field, always written) and g2 pinned the refusal half
 * (proxy-server-lane-budget-route.test.ts). What no pin proved yet is the
 * COUPLING the issue's AC1 names: a harness calls a STABLE ALIAS
 * (`nb-minimax`, a bare name with no provider prefix), the proxy resolves it
 * through the user routing override (#3401 — without it a bare alias is
 * classified native-anthropic and 401s against api.anthropic.com), the
 * resolved concrete leaves the box, AND the request lands in the lane
 * attribution feed with the CLIENT'S spelling in the body and the SERVED
 * spelling in the resp header — the two halves of "model_used + lane in the
 * table" from the same request.
 *
 * This file drives the REAL /v1/messages route on a loopback port with a
 * prefix-intercepted fake endpoint and a temp CLAUDISH_CAPTURE_DIR, then reads
 * what actually left the box AND what the capture middleware persisted:
 *
 *   POST /v1/messages model="nb-minimax" x-claudish-lane: nb-coder
 *     → upstream body.model === "MiniMax-M3.1-Flash"   (alias resolved)
 *     → req capture envelope .lane === "nb-coder"       (attribution feed)
 *     → req capture body.model === "nb-minimax"         (client spelling)
 *     → resp capture HDR model === "MiniMax-M3.1-Flash" (model_used for the
 *                                                        consumption table)
 *
 * Mutation proof:
 *   - drop `matchUserRoutingOverride(...)` from the 2c guard in
 *     proxy-server.ts → test 1 goes red (the request 401s against the native
 *     lane; the alias never routes).
 *   - drop the `lane` payload field in request-logger.ts → the capture
 *     assertions go red (envelope has no lane key).
 *   - make the resp HDR carry the requested alias instead of the served id →
 *     the model_used assertion goes red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// Distinct from every port already claimed by sibling suites (14981 is
// client-attribution's; checked against port-allocation.test.ts's scan).
const PROXY_PORT = 14991;
const NB_BASE = "http://127.0.0.1:14992"; // openai-wire custom endpoint
// #1055 g3 CR (AC1 model_used item): a SECOND custom endpoint on the
// Anthropic wire, because `mmc@` takes the `anthropic-sse` parser in
// production (MiniMax direct) while the fixture above streams OpenAI chunks.
// URL prefixes only — the legs are stubbed through globalThis.fetch, nothing
// binds these ports.
const ANTH_BASE = "http://127.0.0.1:14993";
const ANTH_ALIAS = "nb-anthropic";
// Deliberately NOT the routing target: on the Anthropic wire the upstream's
// own `message_start.model` passes through verbatim (anthropic-sse emits the
// data line unchanged), so a distinct spelling is what makes the
// pass-through visible instead of assumed.
const ANTH_UPSTREAM_SPELLING = "MiniMax-M3.1-Flash-20260101";

/** The stable harness alias — a BARE name, no provider prefix (that is the
 * #3401 trap: the bare-name heuristic would call it native-anthropic). */
const ALIAS = "nb-minimax";
/** The concrete the routing rule resolves the alias to. */
const RESOLVED = "MiniMax-M3.1-Flash";

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-client-attribution.test.ts, but
// CLAUDISH_CAPTURE_DIR is MANAGED here (set to a temp dir per test) — a
// machine-level capture dir must not leak real captures into the assertions.
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
  "CLAUDISH_CLIENT_ATTRIBUTION",
  "CLAUDISH_RELAY_UPSTREAM",
  "CLAUDISH_LANE_BUDGETS",
  "CLAUDISH_LANE_STOP_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

let captureDir: string | null = null;

interface Hit {
  url: string;
  bodyModel: string;
}
const nbHits: Hit[] = [];

function fakeNbEndpointResponse(): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`
        )
      );
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: { content: "SERVED-NB" } }] })}\n\n`
        )
      );
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
        )
      );
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * The Anthropic-wire fixture: a real `message_start` whose `model` is the
 * provider's own spelling, then one text block and the terminal pair. Served
 * as SSE when the request streams, as a complete `message` JSON otherwise.
 */
function fakeAnthropicEndpoint(stream: boolean): Response {
  const message = {
    id: "msg-nb-anth",
    type: "message",
    role: "assistant",
    model: ANTH_UPSTREAM_SPELLING,
    content: [{ type: "text", text: "SERVED-ANTH" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  };
  if (!stream) {
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const enc = new TextEncoder();
  const ev = (type: string, data: any) =>
    enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const streamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        ev("message_start", {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 7, output_tokens: 1 },
          },
        })
      );
      controller.enqueue(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );
      controller.enqueue(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "SERVED-ANTH" },
        })
      );
      controller.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        })
      );
      controller.enqueue(ev("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
  return new Response(streamBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
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
        "nb-ep": {
          kind: "simple",
          url: `${NB_BASE}/v1`,
          format: "openai",
          apiKey: "test-key",
        },
        // The Anthropic wire — the parser `mmc@` actually runs in production.
        "nb-anth-ep": {
          kind: "simple",
          url: `${ANTH_BASE}/v1`,
          format: "anthropic",
          apiKey: "test-key",
        },
      },
      // THE stable alias (#1055): one routing entry, exact key — this is what
      // `matchUserRoutingOverride` consults to beat the native heuristic (2c).
      routing: {
        [ALIAS]: [`nb-ep@${RESOLVED}`],
        [ANTH_ALIAS]: [`nb-anth-ep@${RESOLVED}`],
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  captureDir = mkdtempSync(join(tmpdir(), "nb-alias-captures-"));
  savedEnv.CLAUDISH_CAPTURE_DIR = process.env.CLAUDISH_CAPTURE_DIR;
  process.env.CLAUDISH_CAPTURE_DIR = captureDir;
  nbHits.length = 0;
  // Intercept only the proxy→endpoint leg; the client→proxy leg keeps real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(ANTH_BASE)) {
      let stream = true;
      try {
        stream = JSON.parse(String(init?.body ?? "{}")).stream !== false;
      } catch {}
      return fakeAnthropicEndpoint(stream);
    }
    if (url.startsWith(NB_BASE)) {
      let bodyModel = "";
      try {
        bodyModel = JSON.parse(String(init?.body ?? "{}")).model ?? "";
      } catch {}
      nbHits.push({ url, bodyModel });
      return fakeNbEndpointResponse();
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
  if (savedEnv.CLAUDISH_CAPTURE_DIR === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
  else process.env.CLAUDISH_CAPTURE_DIR = savedEnv.CLAUDISH_CAPTURE_DIR;
  if (captureDir) {
    try {
      rmSync(captureDir, { recursive: true, force: true });
    } catch {}
    captureDir = null;
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

/** HUB mode — no relay upstream, the local pipeline serves. */
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

async function postAlias(lane: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    connection: "close",
  };
  if (lane !== null) headers["x-claudish-lane"] = lane;
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: ALIAS,
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Any ingress, any wire — the AC1 model_used pins drive all four shapes. */
async function post(
  path: "/v1/messages" | "/v1/chat/completions",
  model: string,
  stream: boolean,
  lane: string | null
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    connection: "close",
  };
  if (lane !== null) headers["x-claudish-lane"] = lane;
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Every JSON payload of an SSE body, `[DONE]` and unparseable lines dropped. */
function sseData(text: string): any[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== "[DONE]")
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readCaptures(): { reqs: any[]; resps: string[] } {
  const files = readdirSync(captureDir!);
  const reqs = files
    .filter((f) => /^req-/.test(f))
    .map((f) => JSON.parse(readFileSync(join(captureDir!, f), "utf-8")));
  const resps = files
    .filter((f) => /^resp-/.test(f))
    .map((f) => readFileSync(join(captureDir!, f), "utf-8"));
  return { reqs, resps };
}

describe("#1055 g3 — stable alias + lane attribution, one request (AC1)", () => {
  test("alias call: resolved model leaves the box, lane + client spelling land in the capture, served id in the resp header", async () => {
    await spinHub();
    const res = await postAlias("nb-coder");
    const text = await res.text();

    // Served: the alias routed to the custom endpoint (not 401 native).
    expect(res.status).toBe(200);
    expect(text).toContain("SERVED-NB");
    // model_used: the RESOLVED concrete is what left the box — an unresolved
    // alias on the upstream wire would be the #3401 regression.
    expect(nbHits.length).toBe(1);
    expect(nbHits[0].bodyModel).toBe(RESOLVED);

    // Capture: the attribution feed sees the lane (g1 envelope) and keeps the
    // CLIENT's spelling in the body (pre-remap by design — the consumption
    // table's per-model split reads the SERVED id from the resp header).
    const { reqs, resps } = readCaptures();
    expect(reqs.length).toBe(1);
    expect(reqs[0].lane).toBe("nb-coder");
    expect(reqs[0].body?.model).toBe(ALIAS);
    // The resp header line is the consumption table's model source.
    expect(resps.length).toBe(1);
    expect(resps[0]).toMatch(/#\s*parser=\S+\s+model=/);
    expect(resps[0]).toContain(`model=${RESOLVED}`);
  }, 30_000);

  test("same alias without a lane header: serves, capture lane is EMPTY (never absent)", async () => {
    await spinHub();
    const res = await postAlias(null);
    await res.text();

    expect(res.status).toBe(200);
    expect(nbHits.length).toBe(1);
    const { reqs } = readCaptures();
    expect(reqs.length).toBe(1);
    // "" = no lane on this request; an ABSENT key would mean a pre-#1055
    // capture (g1's three-way rule) — both must stay distinguishable.
    expect(reqs[0].lane).toBe("");
  }, 30_000);
});

/**
 * #1055 AC1, the `model_used` item the coordinator added at 14/11 ~23:30Z.
 *
 * The pin above settles what the CAPTURE says. What the HARNESS receives is a
 * different value, and it is the one the harness will report as `model_used`:
 * an alias that leaks through unchanged would make every row of the pilot's
 * measurement table say `nb-minimax` instead of the model that served.
 *
 * Both ingresses are pinned because sk-agent speaks `/v1/chat/completions`
 * (ms#1760) while the rest of the fleet speaks `/v1/messages`.
 */
describe("#1055 AC1 — the client-visible response `model` is the SERVED id", () => {
  test("/v1/messages (streaming): message_start.model is the resolved concrete, never the alias", async () => {
    await spinHub();
    const res = await post("/v1/messages", ALIAS, true, "nb-coder");
    const text = await res.text();

    expect(res.status).toBe(200);
    const start = sseData(text).find((e) => e?.type === "message_start");
    expect(start).toBeDefined();
    // openai-sse synthesizes message_start with `model: target` (#437) — the
    // resolved concrete, the value a harness reads back as model_used.
    expect(start.message.model).toBe(RESOLVED);
    expect(start.message.model).not.toBe(ALIAS);
  }, 30_000);

  test("/v1/chat/completions (streaming, the sk-agent ingress): every chunk.model is the resolved concrete", async () => {
    await spinHub();
    const res = await post("/v1/chat/completions", ALIAS, true, "nb-coder");
    const text = await res.text();

    expect(res.status).toBe(200);
    const chunks = sseData(text).filter((e) => e?.object === "chat.completion.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    // anthropic-to-openai copies message_start.model into each chunk (#212).
    // Mutation (the one this pin exists for): keep `fallbackModel` instead —
    // fallbackModel is the CLIENT's spelling (the alias), so this goes red.
    for (const chunk of chunks) {
      expect(chunk.model).toBe(RESOLVED);
    }
  }, 30_000);

  test("/v1/messages on the ANTHROPIC wire (the mmc@ production parser): the upstream's own spelling passes through, reported", async () => {
    await spinHub();
    const res = await post("/v1/messages", ANTH_ALIAS, true, "nb-coder");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("SERVED-ANTH");
    const start = sseData(text).find((e) => e?.type === "message_start");
    expect(start).toBeDefined();
    // MEASURED, not assumed: anthropic-sse emits the upstream data line
    // unchanged, so the harness reads the PROVIDER's spelling — not the
    // routing target, and not the alias. This is the spelling the pilot's
    // measurement table will carry for an `mmc@` request: `MiniMax-M3.1-Flash`
    // in production (the provider echoes the id it served); the fixture uses a
    // distinguishable one so the pass-through is falsifiable.
    expect(start.message.model).toBe(ANTH_UPSTREAM_SPELLING);
    expect(start.message.model).not.toBe(ANTH_ALIAS);
  }, 30_000);

  test("/v1/chat/completions (stream:false) on the ANTHROPIC wire: the JSON model is the served spelling", async () => {
    await spinHub();
    const res = await post("/v1/chat/completions", ANTH_ALIAS, false, "nb-coder");
    const body: any = await res.json();

    expect(res.status).toBe(200);
    // anthropicMessageToChatCompletion: `message.model ?? fallbackModel` — the
    // served spelling wins over the alias whenever the upstream states one.
    expect(body.model).toBe(ANTH_UPSTREAM_SPELLING);
    expect(body.model).not.toBe(ANTH_ALIAS);
    expect(body.choices?.[0]?.message?.content).toBe("SERVED-ANTH");
  }, 30_000);
});
