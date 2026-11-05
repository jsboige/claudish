/**
 * #693 — per-machine step exclusion through the REAL routes (v14 port).
 *
 * `CLAUDISH_FAILOVER_STEP_EXCLUDE=<step>:<machine>` subtracts a cascade step
 * for ONE machine's requests while the cascade stays global. Here the haiku
 * role is config-armed for everyone (the walled-nominal shape), step 0 (`s0`)
 * is excluded for `m-ai01`, so that machine's walk starts at step 1 (`s1`)
 * while every other machine and a machine-blind request keep step 0. The
 * mandate case: ai-01's structural prompts must never land on the local
 * engine when the nominal walls.
 *
 * WHAT THIS PINS THAT THE UNIT SUITE CANNOT: the WIRING. The unit suite proves
 * the module walks correctly given a machine; this file proves the loop
 * actually HANDS it the machine off `x-claudish-machine`. A port that landed
 * the module and forgot the argument leaves `failover-step-exclude.test.ts`
 * fully green and turns X1 here red — that is the whole point of the file.
 *
 * ADAPTATION vs main's X3: main's third pin drives `count_tokens`, which on
 * that base resolves through the cascade and therefore writes a dwell pin. On
 * THIS base `count_tokens` calls `getHandlerForRequest` alone and never
 * resolves a role (`proxy-server.ts`: "No cascade on this route"), so there is
 * no machine to thread and no pin to inspect there. X3 pins the same CLAIM
 * where this base can express it — the pin the SERVING route writes is at the
 * machine's own walk, not the global one — and says so rather than asserting a
 * site that does not exist.
 *
 * Harness: the G6/G8 pattern — the REAL proxy on an ephemeral port, custom
 * endpoints registered through the proxy's own entry point (no config file
 * written, so a crashed run cannot overwrite a machine's real config), only the
 * outbound legs answered by a stubbed fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSessionDwellPinForTests, resetFailoverForTests } from "./fork/failover.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

let calls: Record<string, number> = {};

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
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_FAILOVER_HAIKU",
  "CLAUDISH_FAILOVER_HAIKU_LABEL",
  "CLAUDISH_FAILOVER_HAIKU_DIRECTION",
  "CLAUDISH_FAILOVER_HAIKU_NOTE",
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_FAILOVER_STEP_EXCLUDE",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

function healthySSE(): Response {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-c",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "Hello from the cascade." }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const fakeEp = (name: string) => ({
  kind: "simple",
  url: `http://fake.invalid/${name}/v1`,
  format: "openai",
  apiKey: "test-key",
});

function registerFakeEndpoints(): void {
  const customEndpoints: Record<string, ReturnType<typeof fakeEp>> = {
    "nm-ep": fakeEp("nm"),
    "s0-ep": fakeEp("s0"),
    "s1-ep": fakeEp("s1"),
  };
  ensureEndpointsRegistered({
    config: {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints,
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

/** haiku nominal `nm-ep`; cascade s0 (excluded for m-ai01) > s1; armed role-wide. */
const EXCLUDE_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_HAIKU_LABEL: "Local engine>Role tail",
  CLAUDISH_FAILOVER_HAIKU_DIRECTION: "degraded>improved",
  CLAUDISH_FAILOVER_HAIKU_NOTE: "Step 0 is the engine ai-01 must not draw on.>",
  CLAUDISH_FAILOVER_ACTIVE: "haiku",
  CLAUDISH_FAILOVER_STEP_EXCLUDE: "s0-ep@fake-s0:m-ai01",
} as Record<string, string>;

async function postMessage(
  machine?: string,
  opts: { session?: string; path?: string } = {}
): Promise<Response> {
  return realFetch(`${activeProxy!.url}${opts.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(machine ? { "X-Claudish-Machine": machine } : {}),
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
    }),
  });
}

const messageText = (msg: any): string =>
  (msg?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0 };
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? "");
    if (!url.startsWith("http://fake.invalid/")) {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    calls[which] = (calls[which] ?? 0) + 1;
    return healthySSE();
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetFailoverForTests();
});

/** Spin the real proxy, then arm the cascade for it (the module reads failover
 *  state per request, so re-initialising after startup is the honest shape). */
async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    0,
    undefined,
    undefined,
    false,
    undefined,
    { haiku: "nm-ep@fake-nom" },
    { quiet: true }
  );
  resetFailoverForTests(EXCLUDE_ENV);
}

describe("#693 — per-machine step exclusion through the real /v1/messages route", () => {
  test("X1: the excluded machine's haiku walk starts at step 1 — s0 is never paid", async () => {
    await spin();
    const r = await postMessage("m-ai01");
    expect(r.status).toBe(200);
    expect(calls.s1).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.nm).toBe(0); // role-wide arm: the nominal is bypassed for all
    const text = messageText(await r.json());
    // The notice names the step actually served — the identity proof that the
    // request did NOT silently land on s0.
    expect(text).toContain("Role tail");
    expect(text).toContain("s1-ep@fake-s1");
  }, 30_000);

  test("X2: every other machine keeps step 0, and a header-less request too", async () => {
    await spin();
    const other = await postMessage("m-po2023");
    expect(other.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);

    const bare = await postMessage();
    expect(bare.status).toBe(200);
    expect(calls.s0).toBe(2); // machine-blind resolution = the global walk
    expect(calls.s1).toBe(0);
    expect(calls.nm).toBe(0);
  }, 30_000);

  test("X3: the dwell pin the serving route writes is at the machine's own walk", async () => {
    await spin();
    // First request of the session, from the excluded machine: the pin lands on
    // step 1 — the walk the machine's requests actually take, not the global one.
    const first = await postMessage("m-ai01", { session: "sess-x3" });
    expect(first.status).toBe(200);
    expect(calls.s1).toBe(1);
    expect(calls.s0).toBe(0);
    expect(getSessionDwellPinForTests("haiku", "sess-x3")).toMatchObject({ stepIndex: 1 });

    // The pin holds on the next request of that session — s0 still unpaid.
    const second = await postMessage("m-ai01", { session: "sess-x3" });
    expect(second.status).toBe(200);
    expect(calls.s1).toBe(2);
    expect(calls.s0).toBe(0);

    // A machine-blind session pins at the GLOBAL walk — the exclusion is not a
    // fleet-wide hole, it is one machine's subtraction (control, same file run).
    const blind = await postMessage(undefined, { session: "sess-blind" });
    expect(blind.status).toBe(200);
    expect(getSessionDwellPinForTests("haiku", "sess-blind")).toMatchObject({ stepIndex: 0 });
    expect(calls.s0).toBe(1);
  }, 30_000);
});
