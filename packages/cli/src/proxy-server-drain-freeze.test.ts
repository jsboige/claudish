/**
 * #306 — route-level pin: the opt-in admission freeze.
 *
 * The drain is passive: while it waits for a lull the proxy keeps accepting
 * NEW requests, so the "N in flight" a restart cuts is a lower bound (streams
 * starting in the decision→action gap are uncounted). With the operator's
 * consent (drain-freeze.enabled, token "enabled" — same bar as wedge-watch /
 * relaunch-preflight), the drain writes drain-freeze right before its gesture
 * and the proxy answers new admissions with 503 + Retry-After. In-flight
 * streams never re-enter a route, so they are untouched by construction.
 *
 * This file drives the REAL routes in-process (createProxyServer on a loopback
 * port, same harness contract as native-passthrough-strip.test.ts). The
 * proxy's home is the real ~/.claudish, so the consent/flag fixtures are
 * backed up and restored around each test (same hermeticism contract).
 *
 * Mutation proof: remove the drainFreezeGate() call in /v1/messages ⇒ the
 * "frozen" and "chat ingress" tests go red while "default OFF" stays green;
 * age the flag past DRAIN_FREEZE_MAX_AGE_MS and the freeze is ignored without
 * any code change (the expiry IS the crashed-drain backstop, AC3).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests } from "./fork/failover.js";
import { DRAIN_FREEZE_MAX_AGE_MS } from "./handlers/shared/admission-freeze.js";
import type { ProxyServer } from "./types.js";

// ---- harness -------------------------------------------------------------------

// Distinct range from native-passthrough-strip.test.ts (19871).
const PROXY_PORT = 19921;
const HOME = join(homedir(), ".claudish");
const CONSENT_PATH = join(HOME, "drain-freeze.enabled");
const FLAG_PATH = join(HOME, "drain-freeze");

// Same hermeticism contract as native-passthrough-strip.test.ts: keys would
// change resolution and CLAUDISH_PROXY_KEY would 401 before the route runs.
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
let anthropicCalls = 0;

const backups: { path: string; content: string | null }[] = [];

function backupAndRemove(path: string): void {
  backups.push({ path, content: existsSync(path) ? readFileSync(path, "utf-8") : null });
  if (existsSync(path)) rmSync(path);
}
function restoreBackups(): void {
  for (const b of backups) {
    if (b.content === null) {
      if (existsSync(b.path)) rmSync(b.path);
    } else {
      writeFileSync(b.path, b.content, "utf-8");
    }
  }
  backups.length = 0;
}

function writeConsent(): void {
  writeFileSync(CONSENT_PATH, "enabled", "utf-8");
}
function writeFlag(ageMs = 0): void {
  writeFileSync(FLAG_PATH, new Date().toISOString(), "utf-8");
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    utimesSync(FLAG_PATH, old, old);
  }
}

/** Inbound fleet-client auth: sk-ant-oat-shaped so the #296 guard lets the
 * passthrough serve (fixture dressing — assertions are about freeze vs flow). */
const INBOUND_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  authorization: "Bearer sk-ant-oat01-fake-client-oauth-freeze-test",
  "anthropic-version": "2023-06-01",
};

const MESSAGES_BODY = JSON.stringify({
  model: "claude-sonnet-5",
  max_tokens: 8,
  messages: [{ role: "user", content: "ok" }],
});

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
}

beforeEach(() => {
  mkdirSync(HOME, { recursive: true });
  backupAndRemove(CONSENT_PATH);
  backupAndRemove(FLAG_PATH);
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  anthropicCalls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      anthropicCalls++;
      return new Response(
        JSON.stringify({
          id: "msg_freeze_fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  restoreBackups();
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetFailoverForTests();
});

// ---- the pin --------------------------------------------------------------------

describe("#306 — opt-in admission freeze (drain's final pre-restart window)", () => {
  test("default OFF: flag present but NO consent file — admissions flow", async () => {
    writeFlag();
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
    expect(anthropicCalls).toBe(1);
  });

  test("frozen: consent + fresh flag — admission gets 503 + Retry-After, nothing upstream", async () => {
    writeConsent();
    writeFlag();
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    // #318 — the marker a relaying sidecar keys on to pass this 503 through
    // instead of replaying it locally as a hub failure. Its absence on a
    // frozen answer is a wire-contract break (hub-half mutation pin).
    expect(res.headers.get("x-claudish-drain-freeze")).toBe("1");
    const body: any = await res.json();
    expect(body.error.type).toBe("overloaded_error");
    expect(anthropicCalls).toBe(0); // refused at admission, zero upstream work
  });

  test("an UNFROZEN answer never carries the #318 drain-freeze marker", async () => {
    // The control from the other side: a 200 must not claim the marker, or a
    // relay would pass through ordinary traffic under drain semantics.
    writeConsent();
    writeFlag();
    rmSync(FLAG_PATH);
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-claudish-drain-freeze")).toBeNull();
  });

  test("unfrozen: flag removed — admissions flow again", async () => {
    writeConsent();
    writeFlag();
    rmSync(FLAG_PATH);
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
  });

  test("AC3 safety expiry: flag older than DRAIN_FREEZE_MAX_AGE_MS is ignored (crashed drain backstop)", async () => {
    writeConsent();
    writeFlag(DRAIN_FREEZE_MAX_AGE_MS + 60_000);
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
  });

  test("/health is NOT gated — and it REPORTS the freeze state (drain's confirmation channel)", async () => {
    writeConsent();
    writeFlag();
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/health`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.admissionFreeze).toBe("flag");
    // And the unfrozen reason is observable too — the drain distinguishes
    // "no-consent" (home/mount mismatch) from "expired" (VM clock skew) from it.
    rmSync(FLAG_PATH);
    const res2 = await realFetch(`http://127.0.0.1:${PROXY_PORT}/health`);
    const body2: any = await res2.json();
    expect(body2.admissionFreeze).toBe("no-flag");
  });

  test("default /health reports no-consent when nothing is set up", async () => {
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/health`);
    const body: any = await res.json();
    expect(body.admissionFreeze).toBe("no-consent");
  });

  test("count_tokens freezes too — no counting for a message that cannot be admitted (review: asymmetry)", async () => {
    writeConsent();
    writeFlag();
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages/count_tokens`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "ok" }] }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(anthropicCalls).toBe(0);
  });

  test("OpenAI ingress freezes too: /v1/chat/completions gets the same 503", async () => {
    writeConsent();
    writeFlag();
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ok" }] }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
  });
});
