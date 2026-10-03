/**
 * #276 route pin — a NON-QUOTA error on a dwell-pinned cascade step must not
 * deepen the pin, through the real `handleWithCascade` loop.
 *
 * Measured 2026-09-28 (hub po-2025): armed 11:05Z, a session dwell-pinned to
 * cascade step 2 received Qwen's wrapped content-filter false positive
 * `HTTP 400 {"code":"InvalidParameter","message":"data: {\"error\":{\"code\":
 * \"data_inspection_failed\"…}"}` at 12:31Z. The non-quota fail-forward
 * advanced the walk and the session resolution re-pinned it at the NEXT step
 * (the DeepSeek PAYG tail), where the renewed dwell held it for hours while
 * the nominal sat healthy at 47% — no pinned session ever probed the nominal,
 * so no #294 recovery stamp ever landed either. The re-pinned pin was the only
 * thing outliving the 10-min bucket wall, and it did.
 *
 * This file drives the REAL /v1/messages route in-process (same harness
 * contract as proxy-server-role-failover-route.test.ts) with a 2-step sonnet
 * cascade on fake custom endpoints, SESSION_DWELL_MS=1h so the pin, not the
 * dwell clock, is what must give way when the wall expires.
 *
 * Mutation proof (each names its branch):
 *  - predicate: drop `{ nonQuota: true }` at the proxy's STEP-ADVANCE
 *    markStepFailed ⇒ R3 goes red (s1 re-pinned, serves again; nm never
 *    re-paid) — and the seam test's `getSessionDwellPinForTests` assertions
 *    with it.
 *  - tombstone: delete the forfeit check in the pin-set branch ⇒ R3 goes red
 *    (the sibling resolution of the SAME request re-pins s1 in-request).
 *  - scope: pass the flag on the QUOTA branch's markStepFailed too ⇒ the
 *    quota negative goes red (R3' returns to the nominal instead of holding
 *    the dwell).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983).
const PROXY_PORT = 19891;
const UPSTREAM_PORT = 19991;
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
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** All [Failover] stderr lines — the countable-marker pin (DoD 4). */
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

/** `nm` walls (quota) by default; flipped per test/phase. */
let wallEndpoints: Set<string> = new Set(["nm"]);
/** Endpoints returning the measured non-quota 400 (data_inspection_failed). */
let nonQuotaEndpoints: Set<string> = new Set();
/** Endpoints returning a wiring-class 401. */
let wiringEndpoints: Set<string> = new Set();

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

function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The 2026-09-28 12:31Z measured shape: Qwen's gateway wraps a DeepSeek
 * content-filter false positive in a 400 InvalidParameter — non-quota (400 is
 * never quota), non-wiring (not 401/404). */
function nonQuotaError(): Response {
  return new Response(
    JSON.stringify({
      code: "InvalidParameter",
      message:
        'data: {"error":{"code":"data_inspection_failed","message":"the response was filtered by our content moderation system","param":null,"type":"data_inspection_failed_error"}}',
      request_id: "req-fake",
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

function wiringError(): Response {
  return new Response(JSON.stringify({ error: "invalid api key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** The incident env: a 2-step sonnet cascade whose step 1 is the PAYG tail. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
  // 1 h dwell > 10-min bucket wall: the incident shape — what must give way
  // when the wall expires is the PIN, not the dwell clock. With the default
  // 10-min dwell the pin would lapse with the wall and hide the defect.
  CLAUDISH_FAILOVER_SESSION_DWELL_MS: "3600000",
} as Record<string, string>;

/** The sonnet nominal, as the proxy's own resolver would inject it. */
const SONNET_NOMINAL = "nom-ep@fake-nom";

function resetCascade(): void {
  resetFailoverForTests(CASCADE_ENV);
  // Re-inject as createProxyServer does at startup (the proxy owns the modelMap).
  const nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL };
  setRoleNominalResolver((r) => nominals[r]);
}

const SESSION_ID = "route-sess-276";

async function postMessage(): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream: false,
      // The per-session dwell key (#91 point 4) — one conversation across R1-R3.
      metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Advance the wall (and only the wall — the 1 h pin/tombstone survives)
 * past its 10-min TTL: the lazy expiry drops on the next read. */
async function pastWallExpiry(): Promise<void> {
  const realNow = Date.now;
  const at = realNow();
  Date.now = () => at + 11 * 60 * 1000;
  try {
    const r = await postMessage();
    expect(r.status).toBe(200);
  } finally {
    Date.now = realNow;
  }
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0 };
  failoverLog = [];
  wallEndpoints = new Set(["nm"]);
  nonQuotaEndpoints = new Set();
  wiringEndpoints = new Set();
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
    if (wiringEndpoints.has(which)) return wiringError();
    if (nonQuotaEndpoints.has(which)) return nonQuotaError();
    if (wallEndpoints.has(which)) return quotaWall();
    return healthySSE();
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
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
    { sonnet: SONNET_NOMINAL }, // the modelMap: claude-sonnet-5 → the fake nominal
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#276 — non-quota step death does not deepen the dwell pin", () => {
  test("R1→R3: measured case — forfeited dwell returns the session to the nominal after the wall expires, never the PAYG tail", async () => {
    await spin();
    resetCascade();

    // R1: the nominal walls (quota 402) → armed → the cascade serves s0 and the
    // session dwells there (1 h pin).
    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);

    // R2: the nominal has recovered; s0 dies NON-quota with the measured
    // data_inspection_failed 400. The walk fail-forwards to s1 once (that part
    // is correct and stays) — but the dwell is forfeited, not re-pinned.
    wallEndpoints.delete("nm");
    nonQuotaEndpoints.add("s0");
    const r2 = await postMessage();
    expect(r2.status).toBe(200);
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(1);
    // The countable marker (DoD 4): role, session, step, reaction.
    expect(
      failoverLog.some(
        (l) =>
          l.includes("DWELL sonnet session") &&
          l.includes("step 0") &&
          l.includes("died non-quota") &&
          l.includes("re-resolving unpinned")
      )
    ).toBe(true);

    // R3 (+11 min): the bucket wall has expired and the nominal is healthy.
    // Unfixed, the re-pinned s1 pin (1 h) holds and s1 serves again — the
    // measured defect. Fixed, the session rejoins the general resolution.
    await pastWallExpiry();
    expect(calls.nm).toBe(2); // back on the nominal
    expect(calls.s1).toBe(1); // the PAYG tail was paid exactly once
  }, 30_000);

  test("negative: a QUOTA wall of the pinned step still advances AND re-pins — the dwell holds past the wall expiry", async () => {
    await spin();
    resetCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);

    // s0 walls with a real quota 402 → the walk advances to s1 in-request and
    // the pin re-pins there (genuine advancement — #276 must not touch this).
    wallEndpoints.delete("nm");
    wallEndpoints.add("s0");
    const r2 = await postMessage();
    expect(r2.status).toBe(200);
    expect(calls.s1).toBe(1);

    await pastWallExpiry();
    // The pin holds: s1 serves again even though the nominal is healthy —
    // that is the dwell doctrine (recovery yields via the #294 stamp, not here).
    expect(calls.s1).toBe(2);
    expect(calls.nm).toBe(1);
    // And the forfeit marker never fired on the quota path.
    expect(failoverLog.some((l) => l.includes("died non-quota"))).toBe(false);
  }, 30_000);

  test("negative: a wiring fault (401) on the pinned step surfaces and marks nothing — the pin holds", async () => {
    await spin();
    resetCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);

    wiringEndpoints.add("s0");
    const r2 = await postMessage();
    expect(r2.status).toBe(401); // surfaced, never advanced over
    expect(calls.s1).toBe(0);

    wiringEndpoints.delete("s0");
    const r3 = await postMessage();
    expect(r3.status).toBe(200);
    expect(calls.s0).toBe(3); // R1 + R2 + R3 — the pin held s0 throughout
    expect(calls.nm).toBe(1); // never re-paid while walled
    expect(failoverLog.some((l) => l.includes("died non-quota"))).toBe(false);
  }, 30_000);
});
