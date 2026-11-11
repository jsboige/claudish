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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfigFileOverride } from "./config-override.js";
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
  "CLAUDISH_FAILOVER_SONNET",
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
    // #651 (K30) — the boot derivation probe. Answered for every endpoint (the
    // stub cannot know which opted in); it counts under the SAME drv tag as the
    // endpoint's chat leg, so the K30 pin's `calls.drv === 1` means "exactly
    // one probe, zero chat round-trip" in one number — the mutation (boot call
    // removed) makes the pin fail on TWO counts: no probe AND a chat call.
    if (url.endsWith("/v1/models")) {
      const tag = url.slice("http://fake.invalid/".length).split("/")[0].slice(0, 4);
      calls[tag] = (calls[tag] ?? 0) + 1;
      return new Response(JSON.stringify({ data: [{ id: "fake-drv", max_model_len: 2000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
  // K30: the config override is per-test state too — a leaked one would feed the
  // next test a drv/nodrv file instead of the shape its own spin() registered.
  setConfigFileOverride(null);
});

/** Spin the real proxy, then arm the cascade for it (the module reads failover
 *  state per request, so re-initialising after startup is the honest shape). */
async function spin(
  modelMap: Record<string, string>,
  env: Record<string, string> = cascadeEnv()
): Promise<void> {
  // Cascades live in process.env: the proxy's own initFailover() reads them at
  // spin, so a SECOND role's rule (A6) is wired exactly like the fleet's.
  Object.assign(process.env, env);
  activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, modelMap, {
    quiet: true,
  });
  // The module reads failover state per request — re-initialising after
  // startup is the honest shape (and arms the same env for the serve).
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

  test("A6: a role:<r> step is weighed as r's WHOLE path — r's UNDECLARED nominal stands the census down", async () => {
    // CR ai-01 6680514571 — the 22/10 shape at the delegation position:
    // haiku's cascade delegates to sonnet (role:sonnet), sonnet's NOMINAL is
    // bare-ep (declares nothing — it may take the request) while every other
    // candidate declares 262 144. Request est ≈ 300k: over every DECLARED
    // window, but the path is not doomed, so it must SERVE. A port that weighs
    // only the delegated role's STEPS (deleting the modelMap collectWindow in
    // proxy-server.ts) refuses here — the mutation this pin exists to kill.
    await spin(
      { haiku: "nm-ep@fake-nom", sonnet: "bare-ep@fake-bare" },
      {
        ...cascadeEnv({ CLAUDISH_FAILOVER_HAIKU: "role:sonnet>s1-ep@fake-s1" }),
        CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0",
      }
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

// ---------------------------------------------------------------------------
// #651 (v14 port of main's K30) — a window derived from the endpoint's OWN
// /v1/models catalog acts at admission, and the probe runs exactly once at boot.
//
// Main's K30 lives in proxy-server-step-skip-route.test.ts (a file the landing
// plan lists as a 13-loud modify/delete) and pins the handler-level derived
// short-circuit plus its #431 skip header. v14 has NO such short-circuit yet
// (`getDerivedContextLimit` has no consumer — that is the learned-caps row):
// the derived value acts through the #565 CENSUS, which reads the DECLARED
// registry entry the derivation overwrote (proxy-server.ts collectWindow).
// Same measurement, different seam — this file is where that seam is pinned.
//
// AC (ai-01 c.6790783245): an opt-in endpoint + an undeclared witness, exactly
// one /v1/models probe after createProxyServer; mutation — the
// deriveContextLimits(config) call in createProxyServer removed → RED,
// restored → GREEN. The census refusal rides the derived number, so removing
// the derivation un-refuses the oversized body and flips the whole pin.
// ---------------------------------------------------------------------------

describe("#651 (K30 v14) — a derived window acts at admission; one boot probe per opt-in endpoint", () => {
  /** Boot the real proxy against an override config file (never the machine's
   *  ~/.claudish/config.json) carrying one opt-in endpoint and one witness that
   *  declares nothing. loadConfig() is a real read inside createProxyServer —
   *  the only seam that makes the probe count honest. */
  async function spinWithDerivedConfig(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "claudish-k30-config-"));
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: "1.0.0",
        defaultProfile: "default",
        profiles: {},
        customEndpoints: {
          "drv-ep": {
            kind: "simple",
            url: "http://fake.invalid/drv/v1",
            format: "openai",
            apiKey: "test-key",
            deriveContextLimit: true,
          },
          "nodrv-ep": {
            kind: "simple",
            url: "http://fake.invalid/ndr/v1",
            format: "openai",
            apiKey: "test-key",
          },
        },
      }),
      "utf-8"
    );
    setConfigFileOverride(file);
    // The stub's default branch counts the drv/ndr tags from the URL prefix,
    // exactly like nm/s0/s1 above — no extra plumbing for the chat legs.
    activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });
    // No cascade armed: a bare provider@model nominal IS its own census path.
    resetFailoverForTests({});
  }

  test("K30: one probe at boot; the derived window refuses the oversized body with zero chat round-trip; the witness serves", async () => {
    await spinWithDerivedConfig();

    // Exactly one endpoint opted in → exactly one /v1/models probe at startup.
    // Mutating the boot call away flips this to 0 — the ai-01 AC.
    expect(calls.drv).toBe(1);

    // est ≈ 10k tokens against the 2 000-token window the stub's catalog states
    // (answered by the local stub below): over the largest (only) declared
    // window by far more than the census margin → refuse at admission.
    const big = "x".repeat(40_000);
    const r = await postMessage({ model: "drv-ep@fake-drv", content: big });
    expect(r.status).toBe(200); // the recoverable turn, never a bare 400
    const text = await responseText(r);
    expect(text).toContain("exceeds every declared context window");
    expect(text).toContain("2000"); // the DERIVED number, not a config literal
    // The second probe count stays 1 — the refusal paid no new catalog call.
    expect(calls.drv).toBe(1);
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(true);

    // Witness: the same oversized body on the endpoint that declares nothing
    // falls open and reaches upstream — the derived window is a measurement on
    // one endpoint, never a policy on the route.
    const r2 = await postMessage({ model: "nodrv-ep@fake-ndr", content: big });
    expect(r2.status).toBe(200);
    expect(await responseText(r2)).not.toContain("exceeds every declared context window");
    expect(calls.ndr).toBeGreaterThanOrEqual(1);
    // The witness never opted in: still exactly ONE probe in the whole run.
    expect(calls.drv).toBe(1);
  }, 30_000);
});

async function responseText(r: Response): Promise<string> {
  const msg = await r.json();
  return messageText(msg);
}
