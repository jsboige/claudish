/**
 * #1128 — route-level pins that the served-model header reaches the CLIENT,
 * with the exact string the capture records for the same request.
 *
 * Mirrors the proxy-server-openai-notice.test.ts harness (#229): the REAL
 * route in-process (createProxyServer on a loopback port), the proxy→endpoint
 * leg intercepted (fake upstream), the client→proxy leg on the real network —
 * the leg under test. The upstream fake serves two custom endpoints: a 402
 * wall (walk step 0) and a healthy SSE endpoint (the concrete under test).
 *
 * Pins, by AC:
 * - AC1+AC2: header present on /v1/messages AND /v1/chat/completions,
 *   streaming and JSON, value byte-equal to the capture's `model=` line on
 *   the same request — the bare id (`fake-flash`), NOT the provider-prefixed
 *   route target (`sm-ep@fake-flash`).
 * - AC1+AC2 on the NATIVE lane (review N1-N3): intercepted api.anthropic.com,
 *   Anthropic-shaped dummy credential, a `claude-opus-5` request whose #218 pin
 *   maps opus→`claude-opus-5-5` — so the header must name the POST-PIN id (≠
 *   requested) and be byte-equal to the native capture's `model=` line
 *   (`parser=native`, the same `target` string createResponseCapture records).
 * - AC4: under an armed cascade the value is the FINAL step's concrete (the
 *   402 first step never reaches the client); an unroutable request (terminal
 *   400) carries NO header — omitted, never guessed.
 * - AC5: every value asserted by exact equality with a routing-table id —
 *   nothing credential-shaped can satisfy these assertions.
 * - AC6: unchanged SSE bytes end-to-end (content + [DONE] / message_stop).
 *   The native pins assert the same on the passthrough lane (byte tap).
 *
 * Mutation proof: delete the markServedModel call sites, the route
 * withServedModelHeader wraps, the carry calls, or the native setServedModel
 * marks — each red below (the C1 transport-fallback omission guard is pinned
 * in served-model-header.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { SERVED_MODEL_HEADER } from "./handlers/shared/served-model-header.js";
import { resetFailoverForTests } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct range from proxy-server-routing-error.test.ts (19700+) and
// proxy-server-openai-notice.test.ts (19851/19951).
const PROXY_PORT = 19861;
const WALL_BASE = `http://127.0.0.1:19961`; // never dialed: fetch intercepted
const SERVE_BASE = `http://127.0.0.1:19962`; // never dialed: fetch intercepted

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-openai-notice.test.ts: a
// provisioned machine must behave like a bare CI runner. CLAUDISH_CAPTURE_DIR
// is deleted here and set per-test (the AC2 pin needs it ON).
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  // #1142 pins — the endpoint budget knob for the serving endpoint (`sm-ep`
  // normalizes to SM_EP); a host setting must not leak a lease into the
  // other pins, and the pins' own knob must not leak back to the host.
  "CLAUDISH_ENDPOINT_TOKEN_BUDGET_SM_EP",
  // #218 pin knobs — a host setting must not disable or re-point the pin the
  // native pins below measure (kill switch off / auto-adoption).
  "CLAUDISH_NATIVE_MODEL_PIN", "CLAUDISH_NATIVE_PIN_AUTO",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** The healthy endpoint's model — the bare id the parsers/capture record. */
const CONCRETE = "fake-flash";
const STEP_WALL = "sm-a@fake-a";
const STEP_SERVE = `sm-ep@${CONCRETE}`;

// ---- native lane (review N1-N3) ------------------------------------------------
// The #218 pin the native pins exercise: request `claude-opus-5`, modelMap maps
// the opus role onto `claude-opus-5-5` — a claude-* target, so the lane stays
// native AND resolveNativeModelPin rewrites payload.model (deterministic case
// of native-pin-auto.test.ts:198; map target ≠ requested, no auto-adoption).
const NATIVE_REQUESTED = "claude-opus-5";
const NATIVE_PINNED = "claude-opus-5-5";
// A literal non-secret dummy (native-handler-sse-capture.test.ts): it only has
// to satisfy the Anthropic-shape predicate so the #296 refusal does not fire.
const NATIVE_DUMMY_KEY = "sk-ant-stub-not-a-real-credential";

/** Which shape the api.anthropic.com stub answers for the next native request
 * (the interceptor cannot see the client's stream flag once the body may be
 * compressed — #909 — so the test sets the mode explicitly). */
let nativeStubMode: "sse" | "json" = "sse";
let nativeCalls = 0;

/** A complete Anthropic SSE turn — the bytes the passthrough relays verbatim. */
function nativeUpstreamSSE(): string {
  return (
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_native_stub","type":"message","role":"assistant","model":' +
    JSON.stringify(NATIVE_PINNED) +
    ',"content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Native passthrough says hi."}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  );
}

function nativeUpstreamJSON(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_native_stub",
      type: "message",
      role: "assistant",
      model: NATIVE_PINNED,
      content: [{ type: "text", text: "Native JSON says hi." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    }
  );
}

function fakeUpstreamSSE(): Response {
  // The proxy always drives the upstream in streaming mode, so the fake only
  // needs the OpenAI SSE shape (custom endpoint, format openai).
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: CONCRETE,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "Hello from the concrete." }) +
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

function fakeUpstreamQuotaWall(): Response {
  return new Response(
    JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted" } }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "sm-a": { kind: "simple", url: `${WALL_BASE}/v1`, format: "openai", apiKey: "test-key" },
        "sm-ep": { kind: "simple", url: `${SERVE_BASE}/v1`, format: "openai", apiKey: "test-key" },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  nativeStubMode = "sse";
  nativeCalls = 0;
  // Intercept only the proxy→endpoint leg; the client→proxy leg (the leg under
  // test) keeps the real fetch.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    // The native lane's origin is hardcoded (native-handler.ts) — the only way
    // in is the fetch stub, same as native-handler-sse-capture.test.ts.
    if (url.startsWith("https://api.anthropic.com")) {
      nativeCalls++;
      if (nativeStubMode === "json") return nativeUpstreamJSON();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(nativeUpstreamSSE()));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "anthropic-version": "2023-06-01" },
      });
    }
    if (url.startsWith(WALL_BASE)) return fakeUpstreamQuotaWall();
    if (url.startsWith(SERVE_BASE)) return fakeUpstreamSSE();
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

async function spin(failoverEnv?: Record<string, string>, modelMap?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    modelMap,
    { quiet: true }
  );
  resetFailoverForTests(failoverEnv);
}

async function askMessages(model: string, stream: boolean, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "connection": "close", ...extraHeaders },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 100,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

async function askOpenAI(model: string, stream: boolean): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "connection": "close" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Read the capture's `model=` value for the response side of a request. */
function captureModels(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("resp-"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .flatMap((content) =>
      // Header line shape: `# parser=openai-sse model=<id> reqN=… pid=…` — the
      // model is a single token; reqN/pid are trailing metadata, not the value.
      [...content.matchAll(/^# parser=\S+ model=(\S+)/gm)].map((m) => m[1])
    );
}

// ---- the pins -----------------------------------------------------------------

describe("#1128 — x-claudish-served-model on the wire", () => {
  test("/v1/messages streaming: header = the bare concrete, SSE bytes unchanged", async () => {
    await spin();
    const res = await askMessages(STEP_SERVE, true);

    expect(res.status).toBe(200);
    // AC2: the bare id the parser was constructed with (and the capture
    // records) — NOT the provider-prefixed route target.
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);

    const text = await res.text();
    expect(text).toContain("Hello from the concrete.");
    expect(text).toContain("message_stop");
  }, 30_000);

  test("/v1/messages non-streaming: header = the bare concrete, single JSON message", async () => {
    await spin();
    const res = await askMessages(STEP_SERVE, false);

    expect(res.status).toBe(200);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
    const body: any = await res.json();
    expect(body.content?.[0]?.text).toBe("Hello from the concrete.");
  }, 30_000);

  test("AC2: header is byte-equal to the capture's model= line on the SAME request", async () => {
    const capDir = mkdtempSync(join(tmpdir(), "claudish-sm-"));
    process.env.CLAUDISH_CAPTURE_DIR = capDir;
    try {
      await spin();
      const res = await askMessages(STEP_SERVE, false);
      expect(res.status).toBe(200);
      const header = res.headers.get(SERVED_MODEL_HEADER);
      const body: any = await res.json(); // consumes the collected message → capture finalized
      expect(body.content?.[0]?.text).toBe("Hello from the concrete.");

      expect(header).toBeTruthy();
      const models = captureModels(capDir);
      expect(models.length).toBeGreaterThan(0);
      // Every response capture for this request names the same string the
      // header carries — byte-equal, no normalization.
      for (const m of models) expect(m).toBe(header!);
      expect(models).toContain(CONCRETE);
    } finally {
      delete process.env.CLAUDISH_CAPTURE_DIR;
      try { rmSync(capDir, { recursive: true, force: true }); } catch {}
    }
  }, 30_000);

  test("/v1/chat/completions streaming: the header survives the translation rebuild", async () => {
    await spin();
    const res = await askOpenAI(STEP_SERVE, true);

    expect(res.status).toBe(200);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
    const text = await res.text();
    expect(text).toContain("Hello from the concrete.");
    expect(text).toContain("[DONE]");
  }, 30_000);

  test("/v1/chat/completions non-streaming: the header survives the translation rebuild", async () => {
    await spin();
    const res = await askOpenAI(STEP_SERVE, false);

    expect(res.status).toBe(200);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from the concrete.");
  }, 30_000);

  test("AC4 — armed cascade: the value is the FINAL step's concrete, not the walled first step", async () => {
    await spin({
      CLAUDISH_FAILOVER_SONNET: `${STEP_WALL}>${STEP_SERVE}`,
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    const res = await askMessages("claude-sonnet-5", false);

    expect(res.status).toBe(200);
    // The 402 first step never reaches the client; the concrete that produced
    // the response is step 1's — and only that.
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
    const body: any = await res.json();
    // Block 0 is the onset notice (inContent on /v1/messages); the model's own
    // answer rides the later blocks — assert it is there, notice and all.
    expect(JSON.stringify(body.content)).toContain("Hello from the concrete.");
  }, 30_000);

  test("#1142 — budget-leased NOMINAL attempt: the header survives withBudgetRelease", async () => {
    // The #654 lease makes handleWithCascade wrap the handler's Response
    // (withBudgetRelease rebuilds it — fresh object identity) at the
    // nominal-attempt site BEFORE the route applies the side-channel lookup.
    // Before #1142 the WeakMap entry died with the inner object and this
    // header was omitted on every budget-leased endpoint.
    process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_SM_EP = "1000000";
    try {
      await spin();
      const res = await askMessages(STEP_SERVE, true);

      expect(res.status).toBe(200);
      expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
      const text = await res.text();
      expect(text).toContain("message_stop");
    } finally {
      delete process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_SM_EP;
    }
  }, 30_000);

  test("#1142 — budget-leased WALK step: the header survives withBudgetRelease", async () => {
    // Same seam, walk site: the cascade's serving step takes the lease and
    // the walk's return path wraps at the same withBudgetRelease call — the
    // concrete of the step that ACTUALLY served must still reach the client.
    process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_SM_EP = "1000000";
    try {
      await spin({
        CLAUDISH_FAILOVER_SONNET: `${STEP_WALL}>${STEP_SERVE}`,
        CLAUDISH_FAILOVER_ACTIVE: "sonnet",
      });
      const res = await askMessages("claude-sonnet-5", false);

      expect(res.status).toBe(200);
      expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(CONCRETE);
      const body: any = await res.json();
      expect(JSON.stringify(body.content)).toContain("Hello from the concrete.");
    } finally {
      delete process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_SM_EP;
    }
  }, 30_000);

  test("AC4 — #296 native refusal: NO header (omitted, never guessed)", async () => {
    await spin();
    // A bare unknown name lands on the native lane, which refuses for lack of
    // an Anthropic credential (#296 shape A) — a real no-model-served outcome.
    const res = await askMessages("no-such-model-anywhere", false);

    expect(res.status).toBe(403);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBeNull();
  }, 30_000);
});

describe("#1128 — native lane: the POST-PIN concrete (review N1-N3)", () => {
  // The #218 pin needs the role map IN the server (a createProxyServer arg,
  // never config.json): request `claude-opus-5`, modelMap opus→`claude-opus-5-5`.
  const NATIVE_SPIN = () => spin(undefined, { opus: NATIVE_PINNED });

  test("streaming: header = the post-pin id (≠ the requested one), passthrough bytes intact", async () => {
    await NATIVE_SPIN();
    const res = await askMessages(NATIVE_REQUESTED, true, { "x-api-key": NATIVE_DUMMY_KEY });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // One upstream call, at the hardcoded origin — and the header names the
    // version that ANSWERED (post-#218-pin), not the one asked for.
    expect(nativeCalls).toBe(1);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(NATIVE_PINNED);
    expect(NATIVE_PINNED).not.toBe(NATIVE_REQUESTED); // the pin is real, not vacuous

    const text = await res.text();
    expect(text).toContain("Native passthrough says hi.");
    expect(text).toContain("message_stop");
  }, 30_000);

  test("non-streaming: header = the post-pin id on the JSON shape too", async () => {
    nativeStubMode = "json";
    await NATIVE_SPIN();
    const res = await askMessages(NATIVE_REQUESTED, false, { "x-api-key": NATIVE_DUMMY_KEY });

    expect(res.status).toBe(200);
    expect(res.headers.get(SERVED_MODEL_HEADER)).toBe(NATIVE_PINNED);
    const body: any = await res.json();
    expect(body.content?.[0]?.text).toBe("Native JSON says hi.");
  }, 30_000);

  test("AC2 native: header byte-equal to the native capture's model= line on the SAME request", async () => {
    const capDir = mkdtempSync(join(tmpdir(), "claudish-sm-native-"));
    process.env.CLAUDISH_CAPTURE_DIR = capDir;
    try {
      await NATIVE_SPIN();
      const res = await askMessages(NATIVE_REQUESTED, true, { "x-api-key": NATIVE_DUMMY_KEY });
      expect(res.status).toBe(200);
      const header = res.headers.get(SERVED_MODEL_HEADER);
      const text = await res.text(); // drain the passthrough → the capture finalizes
      expect(text).toContain("message_stop");

      expect(header).toBe(NATIVE_PINNED);
      // The capture finalizes asynchronously once the pump drains; poll for it
      // (bounded), same contract as native-handler-sse-capture.test.ts.
      const deadline = Date.now() + 3000;
      let files: string[] = [];
      while (Date.now() < deadline) {
        try {
          files = readdirSync(capDir).filter((f) => f.startsWith("resp-"));
        } catch {
          files = [];
        }
        if (files.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(files.length).toBeGreaterThan(0);
      // Every native capture names the same string the header carries — and it
      // is the capture's OWN label (`-native-<model>.sse`) that proves it is
      // the pinned id, the same `target` createResponseCapture records.
      const models = captureModels(capDir);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) expect(m).toBe(header!);
      expect(files[0]).toContain(`-native-${NATIVE_PINNED}.sse`);
    } finally {
      delete process.env.CLAUDISH_CAPTURE_DIR;
      try { rmSync(capDir, { recursive: true, force: true }); } catch {}
    }
  }, 30_000);
});
