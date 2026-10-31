/**
 * #641 G7 — route-level pin for the OpenAI-compatible ingress on this branch.
 *
 * Carried from main's `proxy-server-openai-notice.test.ts` harness (config
 * sandbox + intercepted upstream leg + real loopback client leg), restricted
 * to what is testable while the budget-failover cascade is a ported MODULE
 * but not yet wired into any route:
 *
 *   - the full translated round-trip (OpenAI body → Anthropic pipeline →
 *     OpenAI response), streaming and non-streaming, through a REAL custom
 *     endpoint handler — proving the route resolves, logs, serves and
 *     translates on the v14 seams;
 *   - the terminal client-error 400s (#548 malformed body, missing model) in
 *     the OpenAI error envelope;
 *   - the routing-failure doctrine (RoutingError → 400 invalid_request_error,
 *     the same terminal doctrine as /v1/messages) on the OpenAI envelope.
 *
 * NOT portable yet (declared in the PR body): main's two notice-header pins
 * arm the cascade (`resetFailoverForTests({CLAUDISH_FAILOVER_*})` + a role
 * substitution) — on this branch the cascade never runs, so there is no
 * substitution to announce. The `carryNoticeHeader` copy sites stay in the
 * route, inert, and those pins land with the cascade-wiring grain. What IS
 * pinned here is the inert half of the same contract: no notice header, and
 * the content exactly the model's own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetFailoverForTests } from "./fork/failover.js";
import { NOTICE_HEADER } from "./handlers/shared/failover-stream-notice.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct range from the other v14 route tests (19200 / 19700 / 19910 /
// 1997x / 1998x); these are main's own notice-test ports, free on this branch.
const PROXY_PORT = 19851;
const UPSTREAM_PORT = 19951;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as the other route tests: a provisioned machine
// must behave like a bare CI runner. CLAUDISH_PROXY_KEY would 401 every
// request before the route runs; provider keys would change resolution;
// CLAUDISH_CAPTURE_DIR (#175 class) would redirect capture writes mid-test.
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
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** The served model: a custom endpoint answered by the intercepted fetch. */
const EP_MODEL = "notice-ep@fake-flash";

function fakeUpstreamSSE(): Response {
  // The proxy always drives the upstream in streaming mode (every adapter's
  // buildPayload hardcodes stream:true), so the fake only needs the SSE shape.
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-flash",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse = `${chunk({ role: "assistant", content: "" })}${chunk({
    content: "Hello from the substitute.",
  })}${chunk({}, "stop")}data: [DONE]\n\n`;
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

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "notice-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/v1`,
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
  // Intercept only the proxy→endpoint leg; the client→proxy leg (the leg under
  // test) keeps the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(UPSTREAM_BASE)) return fakeUpstreamSSE();
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

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
  resetFailoverForTests(); // nothing armed — the cascade is unwired on v14 anyway
}

async function askOpenAI(body: unknown, raw = false): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

// ---- the pins -----------------------------------------------------------------

describe("#641 G7 — OpenAI ingress on the v14 seams", () => {
  test("non-streaming: translated chat.completion reaches the client, no notice header (inert stays inert)", async () => {
    await spin();
    const res = await askOpenAI({
      model: EP_MODEL,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(NOTICE_HEADER)).toBeNull();
    const body: any = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello from the substitute.");
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  }, 30_000);

  test("streaming: translated chunk stream reaches the client with [DONE], no notice header", async () => {
    await spin();
    const res = await askOpenAI({
      model: EP_MODEL,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(NOTICE_HEADER)).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // First chunk carries the role delta, the payload chunk carries the text,
    // the terminal chunk the finish_reason, then [DONE] — and nothing else.
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain("Hello from the substitute.");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // The content is EXACTLY the model's own — no fork marker rides it.
    expect(text).not.toContain("[claudish]");
  }, 30_000);

  test("#548: malformed JSON body → terminal 400 in the OpenAI error envelope, not a retryable 500", async () => {
    await spin();
    const res = await askOpenAI("{not json", true);

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Invalid request body");
  }, 30_000);

  test("missing model → terminal 400 naming the param", async () => {
    await spin();
    const res = await askOpenAI({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("model");
  }, 30_000);

  test("unroutable explicit model → RoutingError doctrine: 400 invalid_request_error on the OpenAI envelope", async () => {
    await spin();
    const res = await askOpenAI({
      model: "no-such-ep@no-such-endpoint/no-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  }, 30_000);
});
