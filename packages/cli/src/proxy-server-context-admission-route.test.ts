/**
 * #565 — admission census through the REAL routes (v14 port, port-map row 1).
 *
 * Here the haiku role is config-armed role-wide, nominal `nm-ep` (declared
 * 262 144), cascade s0 (262 144) > s1 (262 144): a path where EVERY candidate
 * declares a window, so a ~300k-token request is doomed on all of them and the
 * census must refuse it at admission — zero upstream fetches, the refusal
 * answered as a RECOVERABLE turn (200 + factual text + the measured
 * `usage.input_tokens`) so the client's compaction gauge advances instead of
 * resending the identical body (the #79 `/compact` loop on main).
 *
 * WHAT THIS PINS THAT THE UNIT SUITE CANNOT: the WIRING. `context-admission.test.ts`
 * proves the DECISION given windows; this file proves the loop actually COLLECTS
 * them (nominal via resolveNominalTarget, steps via getFailoverRule, `role:`
 * delegation via modelMap), consults the registry the loader filled, and answers
 * on BOTH ingresses — `/v1/messages` and `/v1/chat/completions` funnel through
 * the same handleWithCascade, so the translated ingress is covered by
 * construction AND run for real (review 21/10 on main, non-blocking 3).
 *
 * Harness: the G6/G8 pattern — the REAL proxy on an ephemeral port, custom
 * endpoints registered through the proxy's own entry point (no config file
 * written, so a crashed run cannot overwrite a machine's real config), only the
 * outbound legs answered by a stubbed fetch. `[ContextAdmission]` markers are
 * captured off console.log (the census logs with forceConsole — operational
 * countable event, the same wire the fleet greps).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFailoverForTests } from "./fork/failover.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { clearRuntimeRegistry } from "./providers/runtime-providers.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);
const realConsoleLog = console.log;

let calls: Record<string, number> = {};
let markerLog: string[] = [];

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
  "CLAUDISH_FAILOVER_AUTO",
  "CLAUDISH_FAILOVER_ARM_AFTER",
  "CLAUDISH_CONTEXT_ADMISSION",
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

const fakeEp = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "simple",
  url: `http://fake.invalid/${name}/v1`,
  format: "openai",
  apiKey: "test-key",
  ...extra,
});

/** Every candidate on the armed path declares 262 144, except `bare-ep`
 *  (declares nothing — the stand-down candidate) and `small-ep` (32 768). */
function registerFakeEndpoints(): void {
  const customEndpoints: Record<string, ReturnType<typeof fakeEp>> = {
    "nm-ep": fakeEp("nm", { contextLimit: 262144 }),
    "s0-ep": fakeEp("s0", { contextLimit: 262144 }),
    "s1-ep": fakeEp("s1", { contextLimit: 262144 }),
    "small-ep": fakeEp("sm", { contextLimit: 32768 }),
    "bare-ep": fakeEp("bare"),
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

/** haiku cascade s0 > s1, AUTO arm — the nominal serves attempt 0 and the
 *  cascade arms only after a qualifying refusal (main's K-series semantics:
 *  the census's zero-call claims are about the REFUSAL, not the arm). */
function cascadeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0>s1-ep@fake-s1",
    CLAUDISH_FAILOVER_AUTO: "1",
    CLAUDISH_FAILOVER_ARM_AFTER: "1",
    ...extra,
  };
}

async function postMessage(
  opts: { content?: string; stream?: boolean; path?: string; model?: string } = {}
): Promise<Response> {
  return realFetch(`${activeProxy!.url}${opts.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-haiku-4-5",
      max_tokens: 64,
      stream: opts.stream ?? false,
      messages: [{ role: "user", content: opts.content ?? "say hi" }],
    }),
  });
}

const messageText = (msg: any): string =>
  (msg?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, sm: 0, bare: 0 };
  markerLog = [];
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
    const which = url.slice("http://fake.invalid/".length).split("/")[0].slice(0, 4);
    calls[which] = (calls[which] ?? 0) + 1;
    return healthySSE();
  }) as typeof fetch;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (line.includes("[ContextAdmission]")) markerLog.push(line);
    }
    realConsoleLog(...args);
  }) as any;
});

afterEach(async () => {
  console.log = realConsoleLog;
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
  clearRuntimeRegistry();
});

/** Spin the real proxy, then arm the cascade for it (the module reads failover
 *  state per request, so re-initialising after startup is the honest shape). */
async function spin(
  modelMap: Record<string, string>,
  env: Record<string, string> = cascadeEnv()
): Promise<void> {
  activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, modelMap, {
    quiet: true,
  });
  resetFailoverForTests(env);
}

describe("#565 — admission census through the real /v1/messages route", () => {
  test("A1: oversized prompt on a fully-declared path → labeled recovery turn, ZERO upstream calls", async () => {
    await spin({ haiku: "nm-ep@fake-nom" });
    const r = await postMessage({ content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200);
    const msg = await r.json();
    const text = messageText(msg);
    expect(text).toContain("exceeds every declared context window");
    expect(text).toContain("262144"); // the numbers, not provider jargon
    // The recoverable turn: the gauge advances with the MEASURED size.
    expect(msg?.usage?.input_tokens).toBeGreaterThan(262_144);
    // The whole point: no round-trip on any candidate.
    expect(calls.nm).toBe(0);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(true);
  }, 30_000);

  test("A1b (stream:true): the same refusal is a well-formed SSE turn ending in message_stop", async () => {
    await spin({ haiku: "nm-ep@fake-nom" });
    const r = await postMessage({ content: "x".repeat(1_200_000), stream: true });
    expect(r.status).toBe(200);
    const raw = await r.text();
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("event: message_stop"); // never-hang invariant
    expect(raw).toContain("exceeds every declared context window");
    expect(calls.nm).toBe(0);
  }, 30_000);

  test("A1c (/v1/chat/completions): the translated ingress refuses at admission too — zero upstream calls, [DONE]-terminated", async () => {
    await spin({ haiku: "nm-ep@fake-nom" });
    // A concrete declared model with no role — the census weighs the nominal
    // alone on this path, which declares 262 144.
    const r = await realFetch(`${activeProxy!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nm-ep@fake-nom",
        stream: true,
        messages: [{ role: "user", content: "x".repeat(1_200_000) }], // est ≈ 300k
      }),
    });
    expect(r.status).toBe(200);
    const raw = await r.text();
    // A well-formed OpenAI SSE stream that TERMINATES — never a hung stream.
    expect(raw).toContain("data: ");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(raw).toContain("exceeds every declared context window");
    expect(calls.nm).toBe(0);
  }, 30_000);

  test("A2 (hub 22/10): an UNDECLARED candidate on the path stands the census down — it serves", async () => {
    // The shape that blocked a CoursIA-2 session at ~270k tokens: the nominal
    // declares nothing while the steps all declare — refusing on the declared
    // subset would veto a candidate the census cannot see, `/compact` with it.
    await spin({ haiku: "bare-ep@fake-bare" }, cascadeEnv());
    const r = await postMessage({ content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200);
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(calls.bare).toBe(1); // the undeclared nominal got its chance
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);

  test("A3: the LARGEST declared window decides — a servable prompt is not refused by a small step", async () => {
    // Path: nominal nm-ep (262 144) > small-ep (32 768) > s1-ep (262 144);
    // prompt est ≈ 100k — under the LARGEST, so the census stands down even
    // though small-ep alone is too small. The unit suite pins the arithmetic;
    // this pins that the wiring really collects EVERY step's window.
    await spin(
      { haiku: "nm-ep@fake-nom" },
      cascadeEnv({ CLAUDISH_FAILOVER_HAIKU: "small-ep@fake-sm>s1-ep@fake-s1" })
    );
    const r = await postMessage({ content: "x".repeat(400_000) }); // est ≈ 100k
    expect(r.status).toBe(200);
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
    expect(calls.nm).toBe(1); // AUTO arm: the nominal serves attempt 0
  }, 30_000);

  test("A5: an UNDECLARED STEP stands the census down too — the mirror of A2 at the step position", async () => {
    // A2 proved the nominal's absence of a declaration protects the path;
    // this proves the census really walks the STEPS: nominal nm-ep declares
    // 262 144 and step 0 (bare-ep) declares nothing — the ~300k request is
    // over the nominal's window but the path is not doomed, so it serves.
    // A port that collected only the nominal would refuse here.
    await spin(
      { haiku: "nm-ep@fake-nom" },
      cascadeEnv({ CLAUDISH_FAILOVER_HAIKU: "bare-ep@fake-bare>s1-ep@fake-s1" })
    );
    const r = await postMessage({ content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200);
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
    expect(calls.nm).toBe(1); // AUTO arm: the declared nominal serves attempt 0
  }, 30_000);

  test("A4: kill switch CLAUDISH_CONTEXT_ADMISSION=0 restores today's behaviour", async () => {
    // A1's fully-declared path, which the census would refuse. The kill switch
    // is read from process.env per request (re-read, like every CLAUDISH_*
    // knob), so the honest shape is the env var itself, not the failover env.
    await spin({ haiku: "nm-ep@fake-nom" });
    process.env.CLAUDISH_CONTEXT_ADMISSION = "0";
    const r = await postMessage({ content: "x".repeat(1_200_000) });
    expect(r.status).toBe(200);
    expect(calls.nm).toBe(1); // the nominal pays the round-trip the census would have saved
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);
});

async function responseText(r: Response): Promise<string> {
  const msg = await r.json();
  return messageText(msg);
}
