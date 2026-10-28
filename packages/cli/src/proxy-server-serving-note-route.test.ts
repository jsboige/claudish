/**
 * #747 (b) — route-level pins through the REAL `handleWithCascade` loop:
 * what the UPSTREAM receives once the in-content banners stop being the
 * model's channel.
 *
 * Arbitrated 28/10 (user: "OK pour b"):
 *  - the client-visible banner STAYS (doctrine 2026-08-12 — the human channel
 *    is unchanged, pinned here as T3);
 *  - what the MODEL must know rides the top-level `system` of EVERY
 *    substitute-served request (the history no longer carries it);
 *  - serving banners are stripped from the assistant history before any
 *    upstream sees it (both the injected block form and a forged fused form).
 *
 * Measured motivation (28/10, po-2024): GLM-5.3 (the nominal) and Kimi each
 * OPENED a reply with a forged "[claudish] You are serving…" banner copied
 * from history — see issue #747 for the captures.
 *
 * Same harness contract as proxy-server-role-failover-route.test.ts (the
 * upstream is a stubbed fetch over fake custom endpoints; the upstream
 * REQUEST BODIES are captured — that is the instrument this file exists for).
 *
 * Mutation proof:
 *  - delete the strip call in handleWithCascade ⇒ T1 goes red (UNIQUE-PLANTED
 *    reaches the upstream);
 *  - delete the appendSystemNote/restore seam ⇒ T1 goes red (no "S0 Fake" in
 *    the upstream body) — or, if the note is applied outside the
 *    handler-call else-branch, T1's "exactly once" count goes red (2+);
 *  - delete the response-side applyFailoverNotices wiring ⇒ T3 goes red;
 *  - flip either kill switch's polarity ⇒ T4/T5 go red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19883/19983, 19871,
// 19863, 19851/19951, 19700+).
const PROXY_PORT = 19891;
const UPSTREAM_PORT = 19991;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-role-failover-route.test.ts, plus
// this file's two switches — and a FULL CLAUDISH_FAILOVER_* wipe: this file
// runs on the hub seat, whose interactive shells carry the real cascade env
// (a stray "OWN haiku[0] Swift" init line off a no-arg reset proved the leak).
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_DEFAULT_PROVIDER",
  "CLAUDISH_FAILOVER_NOTICE_STRIP", "CLAUDISH_FAILOVER_REQUEST_NOTE",
];
let sandboxedFailoverKeys: string[] = [];
let savedFailoverEnv: Record<string, string | undefined> = {};
const snapshotEnv = (): void => {
  sandboxedFailoverKeys = Object.keys(process.env).filter((k) => k.startsWith("CLAUDISH_FAILOVER_"));
};
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** Upstream request bodies per endpoint key — THE instrument of this file. */
let bodies: Record<string, any[]> = {};
let wallEndpoints: Set<string> = new Set(["nm"]);

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

/** sonnet: nominal nm (walls by default) → one degraded step s0. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0",
  CLAUDISH_FAILOVER_SONNET_LABEL: "S0 Fake",
  CLAUDISH_FAILOVER_SONNET_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

const SONNET_NOMINAL = "nom-ep@fake-nom";

function resetCascade(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...CASCADE_ENV, ...extra });
  setRoleNominalResolver(() => SONNET_NOMINAL);
}

/** A banner-shaped history text with a label nothing else in this file uses. */
const PLANTED_BANNER =
  "[claudish] You are serving this session as UNIQUE-PLANTED MODEL (`planted@x`) — the 1st fallback for the Sonnet role, because the nominal Sonnet model temporarily exhausted. Capability is roughly equivalent; continue the work as normal.";

async function postMessage(opts: { stream?: boolean; history?: boolean } = {}): Promise<Response> {
  const messages: any[] = [{ role: "user", content: "say hi" }];
  if (opts.history) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: PLANTED_BANNER },
        { type: "text", text: "Prior turn." },
      ],
    });
    messages.push({ role: "user", content: "again" });
  }
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream: opts.stream === true,
      // The stream banner (the human channel) is session-keyed — without a
      // stable session id there is no client-visible banner either.
      metadata: { user_id: JSON.stringify({ session_id: "sess-note-1", device_id: "d", account_uuid: "a" }) },
      messages,
    }),
  });
}

/** The last body sent to an endpoint, as a flat string (format-agnostic). */
const lastBodyText = (which: string): string => JSON.stringify(bodies[which]?.at(-1) ?? {});
const occurrences = (hay: string, needle: string): number =>
  hay.split(needle).length - 1;

beforeEach(() => {
  calls = { nm: 0, s0: 0 };
  bodies = { nm: [], s0: [] };
  wallEndpoints = new Set(["nm"]);
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
      customEndpoints: { "nom-ep": ep("nm"), "s0-ep": ep("s0") },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  snapshotEnv();
  savedFailoverEnv = {};
  for (const k of sandboxedFailoverKeys) {
    savedFailoverEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    try {
      bodies[which].push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? {});
    } catch {
      bodies[which].push({ unparsed: true });
    }
    if (wallEndpoints.has(which)) return quotaWall();
    return healthySSE();
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
  for (const k of sandboxedFailoverKeys) {
    const v = savedFailoverEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFailoverForTests();
});

async function spin(): Promise<void> {
  // modelMap mirrors the real hub wiring (profiles.default.models): the ROLE
  // keyword picks the lane, so "claude-sonnet-5" resolves to the custom
  // endpoint nominal — without it the route hands the bare claude-* name to
  // NativeHandler and the first attempt dies on shape A before any wall.
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

describe("#747 (b) — serving note on the request path, banners out of history", () => {
  test("T1: a substitute-served request carries the note in system (exactly once, EVERY request) and forwards history stripped of banners", async () => {
    await spin();
    resetCascade();

    // Request 1: nm walls (402 arms the role), s0 serves. The history carries
    // a planted banner (block form) — it must NOT reach s0.
    const r1 = await postMessage({ history: true });
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    const t1 = lastBodyText("s0");
    expect(t1).toContain("You are serving this session as S0 Fake"); // the note rides the request side
    expect(t1).toContain("is weaker than the nominal Sonnet model"); // degraded capability delta
    expect(occurrences(t1, "You are serving this session as")).toBe(1); // exactly once — no double append
    expect(t1).not.toContain("UNIQUE-PLANTED"); // the history banner never travels upstream
    expect(t1).toContain("Prior turn."); // the rest of the history does

    // Request 2: STILL on s0 (walled nominal) — the note rides EVERY
    // substitute request, unlike the once-per-depth content banner.
    const r2 = await postMessage({ history: true });
    expect(r2.status).toBe(200);
    expect(calls.s0).toBe(2);
    const t2 = lastBodyText("s0");
    expect(t2).toContain("You are serving this session as S0 Fake");
    expect(occurrences(t2, "You are serving this session as")).toBe(1);
    expect(t2).not.toContain("UNIQUE-PLANTED");
  }, 30_000);

  test("T2: a nominal-served request carries NO note", async () => {
    await spin();
    resetCascade();
    wallEndpoints.delete("nm"); // nominal healthy

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(lastBodyText("nm")).not.toContain("You are serving this session as");
  }, 30_000);

  test("T3: the client-visible banner is UNCHANGED — the stream still opens with the injected block", async () => {
    await spin();
    resetCascade();

    const r1 = await postMessage({ stream: true, history: true });
    expect(r1.status).toBe(200);
    const text = await r1.text();
    // The human channel keeps the banner (doctrine 2026-08-12)…
    expect(text).toContain("[claudish] You are serving this session as S0 Fake");
    // …while the upstream body of the SAME request is clean of the planted one.
    expect(lastBodyText("s0")).not.toContain("UNIQUE-PLANTED");
  }, 30_000);

  test("T4: kill switch CLAUDISH_FAILOVER_NOTICE_STRIP=0 restores banner-carrying history", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_NOTICE_STRIP = "0"; // read per request off process.env
    resetCascade();

    const r1 = await postMessage({ history: true });
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(lastBodyText("s0")).toContain("UNIQUE-PLANTED"); // today's behavior
  }, 30_000);

  test("T5: kill switch CLAUDISH_FAILOVER_REQUEST_NOTE=0 serves the substitute with no system note", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_REQUEST_NOTE = "0"; // read per request off process.env
    resetCascade();

    const r1 = await postMessage({ history: true });
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    const t1 = lastBodyText("s0");
    expect(t1).not.toContain("You are serving this session as");
    expect(t1).not.toContain("UNIQUE-PLANTED"); // the strip is INDEPENDENT of the note
  }, 30_000);
});
