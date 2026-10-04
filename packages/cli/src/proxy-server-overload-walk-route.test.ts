/**
 * #299 part B — a nominal's TRANSIENT OVERLOAD walks the role cascade once,
 * with NO state change, through the real `handleWithCascade` loop.
 *
 * Measured driver (2026-10-02, hub, MiniMax-M3 = the haiku nominal): MiniMax
 * answered HTTP 529 `overloaded_error` on up to 30 % of attempts. A 529 is not
 * a quota wall, so nothing armed and nothing walked — every 529 reached the
 * client, one cron conversation was retried 12 times against the same
 * overloaded provider, then dropped. Part A (already merged) makes a relay
 * pass a hub 529 through instead of replaying it locally; part B is the hub's
 * own local serving: when the resolved target is the role's NOMINAL and it
 * fails with a transient-overload class, try the NEXT cascade step ONCE for
 * this request only — no arm, no stepFailures mark, no bucket wall, no dwell
 * pin. Same separation as the #170 re-forward (`no markFail`).
 *
 * Mutation proof (one per branch — each comment names its branch):
 *  - remove the walk (delete the `#299-B` block) ⇒ W1 goes red (client gets
 *    the 529, s0 never called);
 *  - let the walk arm (call `onNominalRefusal`/`armFailover` on the overload)
 *    ⇒ W1's `isFailoverActive`/`isBucketWalled` pins go red;
 *  - drop the kill-switch read ⇒ W3 goes red (s0 called with the walk off).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  classifyNominalBucket,
  isBucketWalled,
  isFailoverActive,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883).
const PROXY_PORT = 19895;
const UPSTREAM_PORT = 19995;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-role-failover-route.test.ts.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_FAILOVER_OVERLOAD_WALK",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** `[Failover]` lines off BOTH channels: `log(msg, true)` markers (WALK,
 *  STEP-ADVANCE…) go to stdout via console.log, `logStderr` lines (markStepFailed
 *  walls) carry the `[claudish]` prefix on stderr — the #274 file captured only
 *  the latter and would have been blind to this marker. */
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** Per-endpoint status override; unset ⇒ 200 healthy (s0/s1) or 529 (nm). */
let endpointStatus: Record<string, number> = {};

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

/** MiniMax's real 02/10 shape: HTTP 529 with the `overloaded_error` code. */
function overload529(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        code: "2064",
        message: "The server cluster is currently under high load",
      },
    }),
    { status: 529, headers: { "content-type": "application/json" } }
  );
}

function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** sonnet walks s0→s1; the nominal is a fake custom endpoint (never a real key). */
const WALK_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

const SONNET_NOMINAL = "nom-ep@fake-nom";
const bucketOfNominal = () => {
  const nb = classifyNominalBucket(SONNET_NOMINAL, () => false);
  if (!("bucket" in nb)) throw new Error("route test: custom-endpoint nominal must classify to a bucket");
  return nb.bucket;
};

function resetWalk(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...WALK_ENV, ...extra });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

async function postMessage(model: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0 };
  failoverLog = [];
  endpointStatus = {};
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
        "s1-ep": ep("s1"),
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
    const status = endpointStatus[which] ?? (which === "nm" ? 529 : 200);
    if (status === 402) return quotaWall();
    if (status === 529) return overload529();
    if (status >= 400) return new Response(JSON.stringify({ error: "stub failure" }), { status, headers: { "content-type": "application/json" } });
    return healthySSE();
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    // Re-emit so a failing run still shows the proxy's operator markers.
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

async function spin(): Promise<void> {
  // The proxy owns the modelMap — sonnet resolves to the fake custom endpoint
  // that answers 529, so the NOMINAL attempt reaches a real upstream (a bare
  // claude-* with no map would go to the NativeHandler and 403 on shape A).
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#299 B — nominal transient overload walks the cascade once, zero state", () => {
  test("W1: nominal 529 → step 0 serves; no arm, no bucket wall, one WALK marker", async () => {
    await spin();
    resetWalk();
    // nm answers 529; s0 answers 200.
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the overloaded nominal, paid once
    expect(calls.s0).toBe(1); // the walk's one attempt
    expect(calls.s1).toBe(0); // bounded — never deeper

    // THE PIN: no state changed. The 529 is not a wall, so the role is not
    // armed and the bucket is not walled — the NEXT request re-probes the
    // nominal instead of riding the cascade for a 10-min TTL.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);

    // The countable marker, one per walk.
    expect(
      failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("529"))
    ).toBe(true);
  }, 30_000);

  test("W2: nominal 529 then step 0 ALSO fails → the client gets the ORIGINAL 529, no further walk", async () => {
    await spin();
    resetWalk();
    endpointStatus.s0 = 500; // the step fails too
    const r1 = await postMessage("claude-sonnet-5");
    // The original overload surfaces — never the step's own incident.
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0); // bounded to ONE walk
    // Still no state, even though the step failed.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W3: kill switch CLAUDISH_FAILOVER_OVERLOAD_WALK=0 → no walk, the 529 surfaces", async () => {
    await spin();
    resetWalk();
    // The kill switch is read per-request off process.env (like the other
    // per-request switches — CLAUDISH_NATIVE_MODEL_PIN): the fleet flips it
    // mid-flight and a cached value would need a proxy restart. So it is set
    // here directly, not through the initFailover env object.
    process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK = "0";
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // never walked
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W4 control: a QUOTA 402 on the nominal still ARMS (the walk is overload-only)", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 402; // quota wall, not an overload
    const r1 = await postMessage("claude-sonnet-5");
    // The existing armed behavior: ARM_AFTER=1 arms on the first quota refusal
    // and the retry serves step 0 — but the role is now ARMED, the exact
    // contrast the overload walk must NOT produce.
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(isFailoverActive("sonnet")).toBe(true);
    expect(isBucketWalled(bucketOfNominal())).toBe(true);
    // No WALK marker on this path — the quota branch is untouched.
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 30_000);
});
