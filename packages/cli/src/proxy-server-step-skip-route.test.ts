/**
 * #431 route pins — a cascade step that cannot take THIS request skips
 * forward: context overflow (vLLM "maximum context length" 400, or the
 * learned-cap short-circuit) and a saturated endpoint limiter (bounded busy
 * wait) advance to the next step with NO failure mark and NO dwell pin on the
 * skipped step. The recovery turn stays the client's answer on the last step
 * and on the non-cascade path, exactly as before.
 *
 * The two vllm-lane asks (ai-01 #4154 relay, 23:27Z): on a 400 "maximum
 * context length", route THAT request onward — never a local retry of the
 * skipped step (pinned as exactly-one-upstream-call), and compaction is the
 * covered shape (CC compacts at 0.95 × its window = 266k/313.5k > Swift's
 * 262 144, and /compact is the stream:false caller — pinned as a JSON answer
 * that is the successor's, never the recovery notice "as its summary").
 *
 * Mutation proofs (one per guard — remove the guard, exactly its pins go red):
 *  - m1: delete the loop's skip-advance block ⇒ K1/K2/K3/K8/K11 red (the
 *    recovery turn / the busy wait becomes the client's answer).
 *  - m2: drop the skippedSteps threading into the resolutions ⇒ K1 red — the
 *    walk re-pays the skipped step (short-circuit) on every remaining attempt
 *    and surfaces the recovery turn while a healthy successor existed.
 *  - m3: remove the maxOutputTokens clamp ⇒ K7 red (32000 on the wire).
 *  - m4: remove the busy bound (ConcurrencyLimiter.run's budget) ⇒ K8 red
 *    (r2 waits for the holder and answers from s0, not s1).
 *  - m5: remove the kill-switch gate ⇒ K11 red (skip fires with
 *    CLAUDISH_FAILOVER_STEP_SKIP=0 where today's behavior is required).
 *
 * Same harness contract as proxy-server-wall-surface-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  resetFailoverForTests,
  setRoleNominalResolver,
  getSessionDwellPinForTests,
} from "./fork/failover.js";
import { resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19895/19995, 19905/20005).
const PROXY_PORT = 20115;
const UPSTREAM_PORT = 20215;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-wall-surface-route.test.ts, plus
// the #431 knobs (stripped per test so a previous test's setting cannot leak).
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_FAILOVER_STEP_SKIP", "CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** Captured upstream request bodies by endpoint tag (nm/s0/s1/b0/b1/cap/capa). */
let upstreamBodies: Record<string, any[]> = {};
/** All countable markers — [Failover], [StepBusy] and [ContextGuard] (both
 * console.log and stderr are hooked: `log(..., true)` reaches console.log
 * while logStderr reaches stderr). */
let markerLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** The vLLM refusal, verbatim family (Swift v0.31): counts prompt + max_tokens
 * against --max-model-len and never trims. */
function vllmContextOverflow400(): Response {
  return new Response(
    JSON.stringify({
      object: "error",
      message:
        "This model's maximum context length is 262144 tokens. However, you requested 294816 tokens (294816 in the prompt and 0 in the completion), which exceeds the maximum context length.",
      type: "BadRequestError",
      param: null,
      code: 400,
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

/** Minimal healthy openai-wire SSE answer carrying `text`. */
function okSse(text: string, model: string): Response {
  const chunk = (delta: any, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":${JSON.stringify(model)}, "choices":[{"index":0,"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Mistral-style quota 402 — arms/holds the role the way the other route
 * tests do (status alone, no reset). */
function quotaWall402(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The incident env: a 2-step sonnet cascade; K4 (last step) uses the 1-step
 * variant. AUTO arm from the start — attempt 0 IS step 0, no nominal detour. */
function cascadeEnv(steps: string): Record<string, string> {
  return {
    CLAUDISH_FAILOVER_SONNET: steps,
    CLAUDISH_FAILOVER_AUTO: "1",
    CLAUDISH_FAILOVER_ARM_AFTER: "1",
  };
}
const TWO_STEP = "s0-ep@fake-s0>s1-ep@fake-s1";

/** The sonnet nominal, as the proxy's own resolver would inject it. */
const SONNET_NOMINAL = "nom-ep@fake-nom";

/** Per-test upstream behaviors, keyed by endpoint tag. Default: everything
 * healthy. */
let upstreamAnswer: Record<string, () => Response | Promise<Response>> = {};

function resetCascade(env?: Record<string, string>): void {
  resetFailoverForTests(env ?? cascadeEnv(TWO_STEP));
  const nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL };
  setRoleNominalResolver((r) => nominals[r]);
}

async function postMessage(
  opts: {
    model?: string;
    session?: string;
    content?: string;
    stream?: boolean;
    maxTokens?: number;
  } = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: opts.maxTokens ?? 64,
      stream: opts.stream ?? false,
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
      messages: [{ role: "user", content: opts.content ?? "say hi" }],
    }),
  });
}

/** Read the assistant text out of a non-streaming (collected) response. */
async function responseText(r: Response): Promise<string> {
  const body: any = await r.json();
  return (body?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("");
}

beforeEach(() => {
  calls = {};
  upstreamBodies = {};
  markerLog = [];
  upstreamAnswer = {};
  resetOverflowCapsForTests();
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ep = (name: string, extra: Record<string, unknown> = {}) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
    ...extra,
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
        // K7: the AC2 clamp endpoints — one openai, one anthropic wire.
        "cap-ep": ep("cap", { maxOutputTokens: 8192 }),
        "cap-anthropic-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/capa/v1`,
          format: "anthropic",
          apiKey: "test-key",
          maxOutputTokens: 8192,
        },
        // K8/K9/K11b: the busy endpoints — s0-shaped but with their own names
        // so their limiters are built with maxConcurrency from the first use.
        "b0-ep": ep("b0", { maxConcurrency: 1 }),
        "b1-ep": ep("b1"),
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "account usage limit" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      );
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const tag = url
      .slice(UPSTREAM_BASE.length + 1)
      .split("/")[0]
      .slice(0, 4); // nm / s0 / s1 / b0 / b1 / cap / capa
    calls[tag] = (calls[tag] ?? 0) + 1;
    if (init?.body) {
      try {
        (upstreamBodies[tag] ??= []).push(JSON.parse(init.body));
      } catch {
        // not JSON — ignore
      }
    }
    const answer = upstreamAnswer[tag];
    if (answer) return answer();
    return okSse(`ok-from-${tag}`, `fake-${tag}`);
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]") || line.includes("[StepBusy]") || line.includes("[ContextGuard]")) {
        markerLog.push(line);
      }
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]") || line.includes("[StepBusy]") || line.includes("[ContextGuard]")) {
        markerLog.push(line);
      }
    }
    realConsoleLog(...args);
  }) as any;
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
  console.log = realConsoleLog;
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

async function spin(map?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    map ?? { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#431 — a cascade step that cannot take the request skips forward", () => {
  test("K1: vLLM context-overflow 400 on a non-last step → successor serves, no re-attempt, no failure mark, dwell yields", async () => {
    await spin();
    resetCascade();
    // The nominal must WALL for the cascade to engage (AUTO arms on a
    // qualifying refusal, it is not always-armed) — same contract as the
    // wall-surface harness.
    upstreamAnswer.nm = () => quotaWall402();
    // First a healthy s0 turn (pins the session at step 0), then the overflow.
    let s0Calls = 0;
    upstreamAnswer.s0 = () => (s0Calls++ === 0 ? okSse("ok-from-s0", "fake-s0") : vllmContextOverflow400());

    // 1. Healthy request from sess-one — served by s0, session pinned at 0.
    const r0 = await postMessage({ session: "sess-one" });
    expect(r0.status).toBe(200);
    expect(await responseText(r0)).toContain("ok-from-s0");
    expect(getSessionDwellPinForTests("sonnet", "sess-one")?.stepIndex).toBe(0);

    // 2. THE PIN: the oversized request is answered by the SUCCESSOR, never
    //    the recovery notice, never a second s0 round-trip.
    const big = "x".repeat(400_000); // est ≈ 100k+ tokens — over any 262k cap when doubled? est = len/4 ≈ 100k; the refusal is the upstream's word, not ours.
    const r1 = await postMessage({ session: "sess-one", content: `read: ${big}` });
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("ok-from-s1"); // (the armed failover notice rides block 0)
    // Exactly ONE overflow round-trip to s0 (the vllm ask: no local retry, no
    // re-attempt of the skipped step for the same request).
    expect(calls.s0).toBe(2); // healthy turn + the refused one
    expect(calls.s1).toBe(1);
    expect(calls.nm).toBe(1); // armed once, then the bucket wall holds
    // AC4: the countable marker, forceConsole, with the estimate and the cap.
    const skipLine = markerLog.find((l) => l.includes("[Failover] SKIP sonnet[0]"));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain("reason=context");
    expect(skipLine).toContain("est=");
    expect(skipLine).toContain("cap=262144");
    // AC1: no dwell pin on the SKIPPED step — the pin yielded at the skip and
    // re-pinned at the successor that now serves this session.
    const pin = getSessionDwellPinForTests("sonnet", "sess-one");
    expect(pin === null || pin.stepIndex !== 0).toBe(true);
    expect(
      markerLog.some((l) => l.includes("DWELL sonnet") && l.includes("skipped for this request"))
    ).toBe(true);

    // 3. No failure mark: a FRESH session's next request resolves step 0
    //    again (a markStepFailed would TTL-freeze it for 10 min). The learned
    //    cap must be reset first — the cap, not a mark, is what legitimately
    //    short-circuits an identical-size request.
    resetOverflowCapsForTests();
    upstreamAnswer.s0 = () => okSse("ok-from-s0-again", "fake-s0");
    const r2 = await postMessage({ session: "sess-two" });
    expect(await responseText(r2)).toContain("ok-from-s0-again");
    expect(calls.s0).toBe(3);
  }, 30_000);

  test("K2 (compaction, stream:false): the JSON answer is the successor's, never the recovery notice as the summary", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    // /compact is the stream:false caller; CC's compact threshold (0.95 ×
    // 280k window) is above Swift's 262 144, so the compact request IS the
    // oversized one by construction.
    const r1 = await postMessage({ session: "sess-comp", stream: false, content: "summarize " + "y".repeat(400_000) });
    expect(r1.status).toBe(200);
    const text = await responseText(r1);
    expect(text).toContain("ok-from-s1");
    // The recovery notice must not ride as the summary — the successor's own
    // words are the answer, and the marker proves the skip fired.
    expect(text).not.toContain("exceeded the serving model's maximum prompt size");
    expect(markerLog.some((l) => l.includes("[Failover] SKIP sonnet[0] reason=context"))).toBe(true);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
  }, 30_000);

  test("K3: the learned-cap short-circuit skips forward with ZERO upstream round-trips", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    // First oversized request: pays one round-trip, learns the cap, skips.
    const r1 = await postMessage({ session: "sess-sc", content: "z".repeat(400_000) });
    expect(await responseText(r1)).toContain("ok-from-s1"); // notice rides block 0

    expect(calls.s0).toBe(1);

    // Second oversized request: same (provider, model) — the learned cap
    // short-circuits BEFORE any fetch, and the skip still advances.
    // A FRESH session: r1's dwell pin points at s1 and would bypass s0
    // entirely — the short-circuit is only consulted when step 0 is resolved.
    const r2 = await postMessage({ session: "sess-sc-2", content: "w".repeat(400_000) });
    expect(await responseText(r2)).toContain("ok-from-s1");
    expect(calls.s0).toBe(1); // unchanged — zero new round-trips
    expect(
      markerLog.some((l) => l.includes("[ContextGuard] short-circuit"))
    ).toBe(true);
    expect(markerLog.filter((l) => l.includes("[Failover] SKIP sonnet[0] reason=context")).length).toBe(2);
  }, 30_000);

  test("K4: overflow on the LAST step keeps the recovery turn (today's behavior), single round-trip", async () => {
    await spin();
    resetCascade(cascadeEnv("s0-ep@fake-s0")); // single-step cascade
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    const r1 = await postMessage({ session: "sess-last" });
    // The recovery turn IS the answer on the last step: HTTP 200, factual
    // notice, usage advanced so the client's gauge crosses its threshold.
    expect(r1.status).toBe(200);
    const body: any = await r1.json(); // read ONCE — a clone after the body is consumed is empty
    const text = (body?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    expect(text).toContain("exceeded the serving model's maximum prompt size");
    expect(body?.usage?.input_tokens).toBeGreaterThan(0);
    // No retry loop: exactly one round-trip, no SKIP marker (nothing to skip TO).
    expect(calls.s0).toBe(1);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);

  test("K5: non-cascade path unchanged — the nominal's overflow is the recovery turn", async () => {
    await spin();
    resetCascade(); // cascade configured, but the request names a concrete model
    upstreamAnswer.nm = () => vllmContextOverflow400();

    const r1 = await postMessage({ model: "nom-ep@fake-nom", session: "sess-direct" });
    expect(r1.status).toBe(200);
    const text = await responseText(r1);
    expect(text).toContain("exceeded the serving model's maximum prompt size");
    expect(calls.nm).toBe(1);
    expect(calls.s0 ?? 0).toBe(0);
    expect(calls.s1 ?? 0).toBe(0);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);

  test("K7 (AC2): maxOutputTokens clamps max_tokens on the wire — openai and anthropic formats", async () => {
    await spin();
    resetFailoverForTests({}); // no cascade — the direct endpoint is the point
    setRoleNominalResolver(() => undefined);

    // OpenAI wire: 32000 → 8192 before it leaves.
    const r1 = await postMessage({ model: "cap-ep@fake-cap", maxTokens: 32000 });
    expect(r1.status).toBe(200);
    expect(upstreamBodies.cap?.length).toBe(1);
    expect(upstreamBodies.cap[0].max_tokens).toBe(8192);
    // Never clamps UP: a smaller ask passes verbatim.
    await postMessage({ model: "cap-ep@fake-cap", maxTokens: 100 }); // body inspected, answer unused
    expect(upstreamBodies.cap[1].max_tokens).toBe(100);

    // Anthropic wire: same clamp from the same field.
    upstreamAnswer.capa = () => vllmContextOverflow400();
    const r3 = await postMessage({ model: "cap-anthropic-ep@fake-capa", maxTokens: 32000 });
    expect(r3.status).toBe(200); // recovery turn — the clamp is the pin, not the answer
    expect(upstreamBodies.capa?.length).toBe(1);
    expect(upstreamBodies.capa[0].max_tokens).toBe(8192);
    // And an endpoint WITHOUT the field keeps the verbatim passthrough.
    await postMessage({ model: "s0-ep@fake-s0", maxTokens: 32000 }); // body inspected, answer unused
    expect(upstreamBodies.s0[0].max_tokens).toBe(32000);
  }, 30_000);

  test("K8 (AC3): saturated limiter on a non-last step → bounded wait, skip to the successor, no failure mark", async () => {
    await spin();
    resetCascade(cascadeEnv("b0-ep@fake-b0>b1-ep@fake-b1"));
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    upstreamAnswer.nm = () => quotaWall402();
    // Call #0 holds b0's single slot until released; later calls answer ok —
    // a per-call holder would leave EVERY later fetch pending forever.
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-from-b0", "fake-b0"));

    const r1p = postMessage({ session: "sess-hold", content: "hold the slot" });
    // Let r1 reach b0 and take the slot (nm → armed → step 0 dispatch).
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);

    const t0 = Date.now();
    const r2 = await postMessage({ session: "sess-two-busy" });
    const waited = Date.now() - t0;
    // THE PIN: r2 is served by the SUCCESSOR after a bounded wait — not held
    // for the holder's whole lease, not answered from b0.
    expect(await responseText(r2)).toContain("ok-from-b1");
    expect(waited).toBeLessThan(1000); // ~the 100 ms bound, never the 1.2 s lease
    expect(calls.b1).toBe(1);
    expect(
      markerLog.some((l) => l.includes("[Failover] SKIP sonnet[0] reason=busy") && l.includes("wait=100ms"))
    ).toBe(true);
    expect(markerLog.some((l) => l.includes("[StepBusy]"))).toBe(true);
    // No failure mark: a fresh session's request resolves b0 again once the
    // slot is free (a mark would TTL-freeze it for 10 min).
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    await r1p;
    const r3 = await postMessage({ session: "sess-three-busy" });
    expect(await responseText(r3)).toContain("ok-from-b0");
    expect(calls.b0).toBe(2);
  }, 30_000);

  test("K9 (AC3): the nominal path keeps its unbounded FIFO — a saturated nominal waits, no busy 529", async () => {
    await spin();
    resetFailoverForTests({}); // NO cascade — the endpoint is the nominal target
    setRoleNominalResolver(() => undefined);
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-from-b0", "fake-b0"));

    const r1p = postMessage({ model: "b0-ep@fake-b0", content: "hold" });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);

    // With the bound wrongly applied here, this would 529 at ~100 ms. It must
    // WAIT for the slot and serve — that is today's nominal behavior.
    let r2done = false;
    const r2p = postMessage({ model: "b0-ep@fake-b0", content: "waiter" }).then((r) => {
      r2done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(r2done).toBe(false); // still queued — no silent timeout
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    const r2 = await r2p;
    expect(r2.status).toBe(200);
    expect(await responseText(r2)).toContain("ok-from-b0");
    expect(markerLog.some((l) => l.includes("[StepBusy]"))).toBe(false);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
    await r1p;
  }, 30_000);

  test("K11: kill switch CLAUDISH_FAILOVER_STEP_SKIP=0 restores today's behavior — context and busy", async () => {
    await spin();
    resetCascade();
    process.env.CLAUDISH_FAILOVER_STEP_SKIP = "0";
    upstreamAnswer.nm = () => quotaWall402();

    // Context: the overflow recovery turn IS the client's answer again.
    upstreamAnswer.s0 = () => vllmContextOverflow400();
    const r1 = await postMessage({ session: "sess-ks", content: "k".repeat(400_000) });
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("exceeded the serving model's maximum prompt size");
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);

    // Busy: the marking is suppressed too — a step attempt keeps its
    // unbounded FIFO instead of a busy 529.
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    resetCascade(cascadeEnv("b0-ep@fake-b0>b1-ep@fake-b1"));
    resetOverflowCapsForTests();
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-late-b0", "fake-b0"));
    const rh = postMessage({ session: "sess-ks-hold", content: "hold" });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);
    let r2done = false;
    const r2p = postMessage({ session: "sess-ks-busy" }).then((r) => {
      r2done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(r2done).toBe(false); // still queued — the switch suppressed the bound
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    const r2 = await r2p;
    expect(await responseText(r2)).toContain("ok-late-b0"); // waited for the slot — no skip
    expect(markerLog.some((l) => l.includes("reason=busy"))).toBe(false);
    await rh;
  }, 30_000);
});
