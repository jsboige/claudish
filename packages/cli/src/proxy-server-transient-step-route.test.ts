/**
 * #299 B (route-level) — ONE cascade step on a TRANSIENT nominal overload,
 * without arming, through the real `handleWithCascade` loop.
 *
 * Production driver (2026-10-02): a MiniMax provider surge answered ~30% of
 * haiku requests with 529 (code 2064). `isQuotaExhaustion` is deliberately
 * narrow and never matched a 529, so the cascade stood still — the raw 529
 * surfaced to the client while a healthy step (Kimi) sat one position away,
 * and every relay read the hub's 529 as a hub outage (#299 A, po-2024).
 *
 * The pins:
 *  - T1: nominal 529 → the request is SERVED by cascade step 0, the
 *    `[Failover] TRANSIENT` marker logs, and NOTHING arms (no `ARMED` line,
 *    bucket not walled, no dwell pin).
 *  - T1b: the very NEXT request re-pays the nominal (one-shot per request —
 *    a dwell pin or an arm would hold the step and keep calls.nm at 1).
 *  - T2: kill switch `CLAUDISH_FAILOVER_TRANSIENT_STEP_MAX=0` → the 529
 *    surfaces, no step is paid, no marker.
 *  - T3: the forced step ITSELF overloads → the 529 surfaces (one step per
 *    request, never a second forced deviation), each endpoint paid once.
 *
 * Mutation proof (one per guard, each comment names its guard):
 *  - predicate: drop `status === 529` from isTransientNominalFailure ⇒ T1
 *    red (529 surfaces, no step).
 *  - kill switch: bypass the `transientUsed < getTransientStepMax()` check ⇒
 *    T2 red (steps even at MAX=0).
 *  - no-arm: route the branch through onNominalRefusal/armFailover ⇒ T1b red
 *    (nominal never re-paid) and T1's no-ARMED pin red.
 *  - one-shot consume: delete the `forcedTransient = null` clear after the
 *    handler call ⇒ T3 red (the stale forced step is re-paid, calls.s0=2).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  classifyNominalBucket,
  isBucketWalled,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983).
const PROXY_PORT = 19885;
const UPSTREAM_PORT = 19985;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-role-failover-route.test.ts,
// plus the #299 B knob (the kill switch is read from process.env per call).
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_FAILOVER_TRANSIENT_STEP_MAX",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

/** Endpoints answering the surfaced overload shape (529, code 2064). */
let overloadEndpoints: Set<string> = new Set();

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

/** The MiniMax surge shape as the cascade loop receives it: 529 + code 2064. */
function overloaded(): Response {
  return new Response(
    JSON.stringify({
      base_resp: { status_code: 529, status_msg: "overloaded", code: 2064 },
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    }),
    { status: 529, headers: { "content-type": "application/json" } }
  );
}

/** haiku: nominal = nom-ep (custom endpoint), one-step cascade to s0. */
const TRANSIENT_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "2",
} as Record<string, string>;

const HAIKU_NOMINAL = "nom-ep@fake-nom";
const bucketOfNominal = () => {
  const nb = classifyNominalBucket(HAIKU_NOMINAL, () => false);
  if (!("bucket" in nb)) throw new Error("route test: custom-endpoint nominal must classify to a bucket");
  return nb.bucket;
};

function resetTransient(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...TRANSIENT_ENV, ...extra });
  setRoleNominalResolver((r) => (r === "haiku" ? HAIKU_NOMINAL : undefined));
}

async function postHaiku(): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0 };
  failoverLog = [];
  overloadEndpoints = new Set(["nm"]);
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ep = (name: string) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
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
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    if (overloadEndpoints.has(which)) return overloaded();
    return healthySSE();
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  // The loop's own markers (TRANSIENT, STEP-ADVANCE, …) go through
  // logger.log(msg, /* forceConsole */ true) → console.log (stdout), not
  // stderr — capture both channels or the marker pin is blind.
  const realConsoleLog = console.log;
  (console as any).log = ((...args: any[]) => {
    for (const a of args) {
      const text = typeof a === "string" ? a : String(a ?? "");
      for (const line of text.split("\n")) {
        if (line.includes("[Failover]")) failoverLog.push(line);
      }
    }
    return realConsoleLog(...args);
  }) as any;
  (globalThis as any).__restoreTransientConsoleLog = () => {
    (console as any).log = realConsoleLog;
  };
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
  (globalThis as any).__restoreTransientConsoleLog?.();
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
  // modelMap is a createProxyServer PARAMETER (not read from profiles inside):
  // the un-armed request reaches the custom nominal through it — the same way
  // production haiku traffic reaches mmc@MiniMax-M3.
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    { haiku: HAIKU_NOMINAL },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#299 B — one cascade step on a transient nominal overload, no arm", () => {
  test("T1: nominal 529 → served by step 0; TRANSIENT marker; nothing arms", async () => {
    await spin();
    resetTransient();

    const r1 = await postHaiku();
    expect(r1.status).toBe(200); // served by the cascade step, not the 529
    expect(calls.nm).toBe(1); // the nominal was paid once, saw the surge
    expect(calls.s0).toBe(1); // the one-shot deviation

    // The countable marker names the role, the status and the no-arm stance.
    const marker = failoverLog.find((l) => l.includes("[Failover] TRANSIENT haiku"));
    expect(marker).toBeDefined();
    expect(marker).toContain("529");
    expect(marker).toContain("no arm");

    // Nothing armed: no ARMED line, the nominal bucket is not walled.
    expect(failoverLog.find((l) => l.includes("ARMED"))).toBeUndefined();
    expect(isBucketWalled(bucketOfNominal())).toBe(false);

    // Mutation (no-arm guard): route the branch through onNominalRefusal ⇒
    // an ARMED line appears and the isBucketWalled pin goes red.
  }, 30_000);

  test("T1b: the NEXT request re-pays the nominal — one-shot, no dwell pin, no arm", async () => {
    await spin();
    resetTransient();

    const r1 = await postHaiku();
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);

    // Still surging — the next request must TRY THE NOMINAL FIRST again (a
    // dwell pin or an arm would serve s0 directly and keep calls.nm at 1).
    const r2 = await postHaiku();
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(2);
    expect(calls.s0).toBe(2);

    // And when the surge lifts, the very next request is a pure nominal hit.
    overloadEndpoints.delete("nm");
    const r3 = await postHaiku();
    expect(r3.status).toBe(200);
    expect(calls.nm).toBe(3);
    expect(calls.s0).toBe(2);
  }, 30_000);

  test("T2: kill switch CLAUDISH_FAILOVER_TRANSIENT_STEP_MAX=0 → the 529 surfaces, no step paid", async () => {
    await spin();
    resetTransient();
    process.env.CLAUDISH_FAILOVER_TRANSIENT_STEP_MAX = "0";

    const r1 = await postHaiku();
    expect(r1.status).toBe(529); // the overload surfaces as before the change
    expect(calls.s0).toBe(0); // the cascade was never walked
    expect(failoverLog.find((l) => l.includes("[Failover] TRANSIENT"))).toBeUndefined();

    // Mutation (kill-switch guard): bypass the transientUsed < max() check ⇒
    // this test goes red (a step is paid and the marker logs at MAX=0).
  }, 30_000);

  test("T3: the forced step ALSO overloads → 529 surfaces; each endpoint paid exactly once", async () => {
    await spin();
    resetTransient();
    overloadEndpoints.add("s0");

    const r1 = await postHaiku();
    expect(r1.status).toBe(529); // one step per request — no second deviation
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1); // never re-paid (the one-shot is consumed)
  }, 30_000);

  test("T3b: two-step cascade — the forced step fails non-quota, the walk stays bounded and each endpoint is paid once", async () => {
    await spin();
    resetTransient({ CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0>s1-ep@fake-s1" });
    // Only the nominal and step 0 overload: step 1 is healthy, but the walk
    // cannot reach it — one transient deviation per request, and without an
    // arm the post-failure resolution goes back to the nominal (documented
    // no-arm semantics), which 529s again and surfaces.
    overloadEndpoints.add("s0");
    const s1Calls = () => calls.s1 ?? 0;

    const r1 = await postHaiku();
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(2); // nominal re-paid once by the natural (un-armed) walk
    expect(calls.s0).toBe(1); // the forced step — exactly once
    expect(s1Calls()).toBe(0); // never reached: no arm ⇒ no walk to step 1

    // Mutation (one-shot consume): delete the forcedTransient=null clear after
    // the handler call ⇒ the stale forced step is re-served by every later
    // iteration of this same request (revisit guard exhausts, then the handler
    // is built from the stale force), calls.s0 goes ≥2 and this pin goes red.
  }, 30_000);
});
