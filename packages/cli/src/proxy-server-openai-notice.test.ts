/**
 * #229 review (ai-01, 2026-09-23): a route-level pin that the failover-notice
 * header reaches the CLIENT on the OpenAI ingress — not just
 * applyFailoverNotices' own output.
 *
 * The review measured the defect on 7d03a10: the notice is consumed (per-session
 * dedup + recovery-budget side effects fire) and then dropped, because BOTH
 * post-notice translations rebuild their headers from scratch —
 * createOpenAIChatStreamFromAnthropic from a 3-key literal (anthropic-to-openai.ts),
 * c.json() from nothing. The unit tests passed anyway: they assert one layer
 * above where the header dies.
 *
 * This file drives the REAL route in-process (createProxyServer on a loopback
 * port), the failover cascade ARMED on a fake custom endpoint, and asserts on
 * the HTTP response the client fetch actually receives — header present AND
 * decoded content clean. Mutation proof: remove the carryNoticeHeader copy at
 * either route call site and these tests go red.
 *
 * Upstream fake: the proxy's outbound fetch to the custom endpoint is
 * intercepted (the relay.test.ts harness pattern) rather than served by an
 * in-process Bun.serve — an in-process Bun.serve on this exact path exhibits a
 * pre-existing Bun 1.3.14 interaction (unhandled "Expected a Response object",
 * stream arrives empty to the parser) that is orthogonal to #229 and reproduces
 * identically on main with these changes stashed. The client→proxy leg stays on
 * the real network, which is the leg under test.
 *
 * Session key: an OpenAI client carries no Anthropic metadata.user_id, but the
 * ingress converter maps the standard OpenAI `user` field onto it
 * (openai-request-to-anthropic.ts). The streaming test sends `user` so the
 * one-per-session stream notice fires; without it, consumeStreamNotice skips
 * (dedup impossible → skip rather than spam) and only the non-streaming notice,
 * which needs no session key, would reach the client.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  NOTICE_HEADER,
  noticeFromHeaderValue,
} from "./handlers/shared/failover-stream-notice.js";
import { resetFailoverForTests } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct range from proxy-server-routing-error.test.ts (19700+) in case bun
// ever runs the files concurrently.
const PROXY_PORT = 19851;
const UPSTREAM_PORT = 19951;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-routing-error.test.ts: a provisioned
// machine must behave like a bare CI runner. CLAUDISH_PROXY_KEY would 401 every
// request before the route runs; provider keys would change resolution;
// CLAUDISH_CAPTURE_DIR (#175 class) would redirect capture writes mid-test.
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

/** The failover step: a custom endpoint served by the intercepted fetch. */
const STEP_MODEL = "notice-ep@fake-flash";

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
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "Hello from the substitute." }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
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

/** Spin the proxy, then arm the cascade on the fake provider. */
async function spinArmed(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
  resetFailoverForTests({
    CLAUDISH_FAILOVER_SONNET: STEP_MODEL,
    CLAUDISH_FAILOVER_ACTIVE: "sonnet",
  });
}

async function askOpenAI(stream: boolean, user?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      stream,
      ...(user ? { user } : {}),
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

// ---- the pin -------------------------------------------------------------------

describe("#229 — the notice header survives to the CLIENT on the OpenAI ingress", () => {
  test("streaming: translated chunk stream reaches the client WITH the header, content stays clean", async () => {
    await spinArmed();
    const res = await askOpenAI(true, "sess-route-stream-1");

    expect(res.status).toBe(200);
    const header = res.headers.get(NOTICE_HEADER);
    expect(header).toBeTruthy();
    expect(noticeFromHeaderValue(header!)).toContain("[claudish]");

    const text = await res.text();
    // The content is EXACTLY the model's own — the notice never rides it (#229).
    expect(text).not.toContain("[claudish]");
    expect(text).toContain("Hello from the substitute.");
    expect(text).toContain("[DONE]");
  }, 30_000);

  test("non-streaming: translated JSON reaches the client WITH the header, content stays clean", async () => {
    await spinArmed();
    const res = await askOpenAI(false);

    expect(res.status).toBe(200);
    const header = res.headers.get(NOTICE_HEADER);
    expect(header).toBeTruthy();
    expect(noticeFromHeaderValue(header!)).toContain("[claudish]");

    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from the substitute.");
    expect(JSON.stringify(body)).not.toContain("[claudish]");
  }, 30_000);

  test("no failover armed: no header, byte-clean response (the inert path stays inert)", async () => {
    activeProxy = await createProxyServer(
      PROXY_PORT,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      { quiet: true }
    );
    resetFailoverForTests(); // nothing armed

    // Ask directly on the step model (custom endpoint), not the role name: with
    // the cascade inert there is no role swap and roleFromModelName resolves
    // null — no notice, no header, and the same translations run on the body.
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: STEP_MODEL,
        stream: false,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(NOTICE_HEADER)).toBeNull();
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from the substitute.");
  }, 30_000);
});
