/**
 * #409 route pin — a walled LAST cascade step must surface as 429
 * rate_limit_error, never as the provider's own status.
 *
 * Measured twice in production:
 *  - 2026-10-08, ai-01 sidecar AUTONOMOUS: Kimi's weekly 403 surfaced verbatim;
 *    Claude Code renders any 403 as "Failed to authenticate" and offered an
 *    Anthropic login prompt — a session stayed blocked on it until the user
 *    intervened.
 *  - 2026-10-09 11:04-11:20Z, hub: DeepSeek's 402 "Insufficient Balance" (the
 *    last PAYG step) surfaced verbatim to every Sonnet/Haiku client — 51
 *    `walled` marks in 12 min, each reading as a wiring error to fix by hand.
 *
 * Both ARE budget walls (isQuotaExhaustion classified them; the steps above
 * walled the same way), so the rewrite says so in the vocabulary the client
 * already retries: 429 rate_limit_error — what Anthropic's own weekly cap
 * returns — with a retry-after bounded by the proxy's NEXT RE-PROBE of any
 * walled element (review CR1a: bucket-wall TTL expiry, step backoff expiry,
 * or a known step reset), never by a far-future announced reset alone, and
 * capped at the bucket-wall TTL max (CR1b, ARM_TTL_MAX_MS = 40 min): Claude
 * Code honors a multi-day retry-after (up to 2^31 ms) by sleeping through
 * the moment service returns — Kimi announcing a week while GLM reopens
 * every 5 h must not produce an 83-day header.
 *
 * Mutation proofs: delete the rewrite block at the last-step return (leave
 * `return response`) ⇒ R1/R2 go red (client sees 403/402 raw) and the
 * WALL-SURFACE marker assertions with them. Revert CR1a's horizon to
 * resets-only (the pre-review accessor) ⇒ R1 goes red at 2400 s (the capped
 * 83-day Kimi reset) against its ≤ 600 s expectation.
 *
 * Same harness contract as proxy-server-nonquota-unpin-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19895/19995).
const PROXY_PORT = 19905;
const UPSTREAM_PORT = 20005;
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
/** All [Failover] lines — the countable-marker pin. `log(..., true)` reaches
 * console.log while logStderr reaches stderr, so BOTH are hooked (the
 * overload-walk harness does the same). */
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** What the LAST step (s1) answers this test; nm and s0 always wall (quota). */
let lastStepResponse: () => Response = () => kimiWeekly403();
/** What nm and s0 answer — default: the silent Mistral 402. R1b points all
 * three at near-future resets so every walled element names its re-probe. */
let midStepResponse: () => Response = () => quotaWall();

function quotaWall(): Response {
  // Mistral's silent subscription 402 — walls on status alone, names no reset.
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The 2026-10-08 ai-01 shape: Kimi's weekly 403. Arms through the "usage
 * limit" wording (quota is evaluated BEFORE wiring), and names a reset the
 * body parser can read (`reset at MM-DD HH:mm:ss UTC`). */
function kimiWeekly403(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "permission_error",
        message:
          "You've reached your weekly (7-day) usage limit. Your quota will reset at 12-31 23:59:00 UTC",
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

/** The 2026-10-09 11:04Z hub shape: DeepSeek's last-step 402. Walls on status
 * alone; names NO reset — the retry-after then comes from the re-probe
 * horizons (wall TTL / step backoff), never invented. */
function deepseekBalance402(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Insufficient Balance" } }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** Qwen-format reset stamp for `msFromNow` out — the abs branch
 * parseResetAtFromBody reads (MM-DD HH:mm:ss UTC, current-year inference). */
function resetAtIn(msFromNow: number): string {
  const d = new Date(Date.now() + msFromNow);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `reset at ${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

/** Kimi's weekly-403 shape with a NEAR reset — R1b's last step. */
function kimiWeekly403ResettingIn(msFromNow: number): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "permission_error",
        message: `You've reached your weekly (7-day) usage limit. Your quota will ${resetAtIn(msFromNow)}`,
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

/** A 402 quota wall that names a reset `msFromNow` out — R1b's nm/s0. */
function quotaWallResettingIn(msFromNow: number): Response {
  return new Response(
    JSON.stringify({ detail: `Usage limit reached. Your quota will ${resetAtIn(msFromNow)}` }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

function rawStatus(status: number): Response {
  return new Response(JSON.stringify({ error: { message: `stub ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The incident env: a 2-step sonnet cascade whose step 1 is the last word. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** The sonnet nominal, as the proxy's own resolver would inject it. */
const SONNET_NOMINAL = "nom-ep@fake-nom";

function resetCascade(): void {
  resetFailoverForTests(CASCADE_ENV);
  const nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL };
  setRoleNominalResolver((r) => nominals[r]);
}

async function postMessage(
  model = "claude-sonnet-5",
  headers: Record<string, string> = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, native: 0 };
  failoverLog = [];
  lastStepResponse = () => kimiWeekly403();
  midStepResponse = () => quotaWall();
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
    // The native lane: stubbed so the test NEVER touches the real
    // api.anthropic.com, credential or not. Answers the Anthropic weekly-cap
    // shape (an account 429 naming a usage limit), which arms the native
    // bucket and lets the request walk to the cascade steps.
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "This request would exceed your account's usage limit. Please try again later.",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      );
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    if (which === "s1") return lastStepResponse();
    return midStepResponse(); // nm and s0 wall — the walk must reach the LAST step
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

describe("#409 — a walled last cascade step surfaces as 429 rate_limit_error", () => {
  test("R1: Kimi weekly 403 at the last step → 429 rate_limit_error, labeled, retry-after bounded by the next re-probe (≤ base TTL)", async () => {
    await spin();
    resetCascade();
    lastStepResponse = () => kimiWeekly403();

    const r1 = await postMessage();
    // THE PIN: not the raw 403 Claude Code renders as an auth failure.
    expect(r1.status).toBe(429);
    const body: any = await r1.json();
    expect(body?.error?.type).toBe("rate_limit_error");
    // Labeled: role, concrete, ORIGINAL status — the wall is never silent.
    expect(body?.error?.message).toContain("[Failover] sonnet: every step walled");
    expect(body?.error?.message).toContain("s1-ep@fake-s1 403:");
    expect(body?.error?.message).toContain("weekly (7-day) usage limit");
    // CR1a: the horizon is the proxy's next RE-PROBE, not Kimi's announced
    // 12-31 reset (~83 days out). Here every other walled element re-probes
    // within the base window — the nominal-bucket wall's TTL and step 0's
    // first backoff rung are both 10 min — so the header must be ≤ 600 s even
    // though the only ANNOUNCED reset is 83 days away. (Mutation sensor:
    // revert the horizon to resets-only and this goes red at 2400 s.)
    const ra = r1.headers.get("retry-after");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThan(0);
    expect(Number(ra)).toBeLessThanOrEqual(600);
    expect(failoverLog.some((l) => l.includes("capped"))).toBe(false);
    // The walk really reached the last step, and the marker is countable.
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
    expect(
      failoverLog.some((l) => l.includes("[Failover] WALL-SURFACE sonnet") && l.includes("HTTP 403"))
    ).toBe(true);
  }, 30_000);

  test("R1b: every walled element names a near-future reset → retry-after = the earliest of them, under the TTL bound", async () => {
    await spin();
    resetCascade();
    midStepResponse = () => quotaWallResettingIn(30 * 60_000);
    lastStepResponse = () => kimiWeekly403ResettingIn(5 * 60_000);

    const r1 = await postMessage();
    expect(r1.status).toBe(429);
    const body: any = await r1.json();
    expect(body?.error?.type).toBe("rate_limit_error");
    // The earliest horizon among the walled elements is the LAST step's
    // +5 min reset (nm/s0 name +30 min, the nominal wall's TTL says 10 min —
    // neither is the earliest): strictly below the ≤ 600 s bound R1 pins on
    // unknown-reset elements, and far below the 40-min defensive cap.
    const ra = r1.headers.get("retry-after");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThanOrEqual(200);
    expect(Number(ra)).toBeLessThan(600);
    expect(failoverLog.some((l) => l.includes("[Failover] WALL-SURFACE sonnet") && l.includes("HTTP 403"))).toBe(true);
    expect(failoverLog.some((l) => l.includes("capped"))).toBe(false);
    expect(calls.s1).toBe(1);
  }, 30_000);

  test("R2: DeepSeek 402 Insufficient Balance at the last step → 429 rate_limit_error, retry-after from the re-probe horizon (no reset named anywhere)", async () => {
    await spin();
    resetCascade();
    lastStepResponse = () => deepseekBalance402();

    const r1 = await postMessage();
    expect(r1.status).toBe(429);
    const body: any = await r1.json();
    expect(body?.error?.type).toBe("rate_limit_error");
    expect(body?.error?.message).toContain("s1-ep@fake-s1 402:");
    expect(body?.error?.message).toContain("Insufficient Balance");
    // No step named a reset and no _RESET is configured — but the walled
    // elements still have re-probe horizons (the nominal-bucket wall's TTL,
    // step 0's and the last step's first backoff rungs: all 10 min), so the
    // header is bounded by those rather than omitted or invented (CR1a).
    const ra = r1.headers.get("retry-after");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThan(0);
    expect(Number(ra)).toBeLessThanOrEqual(600);
    expect(
      failoverLog.some((l) => l.includes("[Failover] WALL-SURFACE sonnet") && l.includes("retry-after"))
    ).toBe(true);
  }, 30_000);

  test("N1: a 401 at the last step surfaces UNCHANGED — a wiring mistake must stay visible", async () => {
    await spin();
    resetCascade();
    lastStepResponse = () => rawStatus(401);

    const r1 = await postMessage();
    expect(r1.status).toBe(401); // raw, never rewritten
    expect(failoverLog.some((l) => l.includes("WALL-SURFACE"))).toBe(false);
  }, 30_000);

  test("N2: a 404 at the last step surfaces UNCHANGED — a bad model id must stay visible", async () => {
    await spin();
    resetCascade();
    lastStepResponse = () => rawStatus(404);

    const r1 = await postMessage();
    expect(r1.status).toBe(404);
    expect(failoverLog.some((l) => l.includes("WALL-SURFACE"))).toBe(false);
  }, 30_000);

  test("N3: the NATIVE lane is excluded — a native-bucket request's last walled step still surfaces the provider status verbatim", async () => {
    // EMPTY modelMap (not undefined — `map ?? default` would restore it): bare
    // claude-sonnet-5 resolves to NativeHandler, whose bucket is
    // anthropic-native/<model>. The client SENDS an sk-ant- key (the ai-01
    // passthrough shape) so the #296 guard lets it through, and the fetch stub
    // answers the weekly-cap 429 — no real network, ever. The native 429 arms,
    // the request walks the cascade, and its LAST step walls with a 402: the
    // rewrite must NOT fire — the native meter is the client's own credential.
    await spin({});
    resetCascade();
    lastStepResponse = () => deepseekBalance402();

    const r1 = await postMessage("claude-sonnet-5", { "x-api-key": "sk-ant-test-409" });
    expect(calls.native).toBe(1); // the nominal WAS reached and refused
    expect(calls.s1).toBe(1); // the walk did reach the last step
    expect(r1.status).toBe(402); // the provider's own status, verbatim
    const text = await r1.text();
    expect(text).toContain("Insufficient Balance");
    expect(failoverLog.some((l) => l.includes("WALL-SURFACE"))).toBe(false);
  }, 30_000);
});
