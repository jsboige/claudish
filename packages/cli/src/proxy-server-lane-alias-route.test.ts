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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// Distinct from every port already claimed by sibling suites (14981 is
// client-attribution's; checked against port-allocation.test.ts's scan).
const PROXY_PORT = 14991;
const NB_BASE = "http://127.0.0.1:14992"; // openai-wire custom endpoint

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
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CLIENT_ATTRIBUTION",
  "CLAUDISH_RELAY_UPSTREAM", "CLAUDISH_LANE_BUDGETS", "CLAUDISH_LANE_STOP_DIR",
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
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: { content: "SERVED-NB" } }] })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-nb", object: "chat.completion.chunk", created: 1, model: RESOLVED, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
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
      },
      // THE stable alias (#1055): one routing entry, exact key — this is what
      // `matchUserRoutingOverride` consults to beat the native heuristic (2c).
      routing: {
        [ALIAS]: [`nb-ep@${RESOLVED}`],
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  captureDir = mkdtempSync(join(tmpdir(), "nb-alias-captures-"));
  savedEnv["CLAUDISH_CAPTURE_DIR"] = process.env.CLAUDISH_CAPTURE_DIR;
  process.env.CLAUDISH_CAPTURE_DIR = captureDir;
  nbHits.length = 0;
  // Intercept only the proxy→endpoint leg; the client→proxy leg keeps real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
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
  if (savedEnv["CLAUDISH_CAPTURE_DIR"] === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
  else process.env.CLAUDISH_CAPTURE_DIR = savedEnv["CLAUDISH_CAPTURE_DIR"];
  if (captureDir) {
    try { rmSync(captureDir, { recursive: true, force: true }); } catch {}
    captureDir = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try { rmSync(REAL_CONFIG_PATH); } catch {}
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
  const headers: Record<string, string> = { "content-type": "application/json", "connection": "close" };
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
