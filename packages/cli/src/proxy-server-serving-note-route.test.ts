/**
 * #747 (b) — route-level pins through the REAL v14 `handleWithCascade` loop:
 * what the UPSTREAM receives once the in-content banners stop being the
 * model's channel. Ported from main's proxy-server-serving-note-route.test.ts
 * onto THIS base's harness (same contract as
 * proxy-server-role-failover-route.test.ts: the proxy runs on an ephemeral
 * port, custom endpoints register through the proxy's own entry point — no
 * config file is written — and the outbound legs are answered by a stubbed
 * fetch whose captured REQUEST BODIES are the instrument).
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
 * PLACEMENT NOTE (v14): on main the strip sits at the top of
 * handleWithCascade because logRequest runs at the route; on this base
 * logRequest lives INSIDE the loop at attempt 0, so the strip sits right
 * after it — the capture still records the client's verbatim history. The
 * observable contract (upstream never sees a banner) is identical, which is
 * what T1/T4 pin.
 *
 * Mutation proof (run against a throwaway copy, restored byte-exact):
 *  - delete the strip call after logRequest ⇒ T1 goes red (UNIQUE-PLANTED
 *    reaches the upstream) and T4 stays green (its expectation is the strip's
 *    absence);
 *  - delete the servingNote/restore seam ⇒ T1 goes red (no "S0 Fake" in the
 *    upstream body);
 *  - apply the note when response.ok (drop the restore) ⇒ T1's "exactly
 *    once" count survives only per-request; the restore is pinned by the
 *    walk in T1 request 2 re-earning its note fresh — a leaked system would
 *    double it;
 *  - flip either kill switch's polarity ⇒ T4/T5 go red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Everything the proxy's outbound calls can reach. No socket is opened by the
 *  test itself: the REAL proxy runs on an ephemeral port, and only its outbound
 *  legs are answered here (test-support pattern of #604). */
let calls: Record<string, number> = {};
/** Upstream request bodies per endpoint key — THE instrument of this file. */
let bodies: Record<string, any[]> = {};
/** Endpoints answering the quota wall (402 + subscription body). */
let wallEndpoints = new Set<string>();

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
  "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_DEFAULT_PROVIDER",
];
/** Plus a FULL CLAUDISH_FAILOVER_* wipe: this seat's interactive shells carry
 *  the real cascade env, and the two switches under test
 *  (NOTICE_STRIP / REQUEST_NOTE) must start absent. */
let sandboxedFailoverKeys: string[] = [];
let savedFailoverEnv: Record<string, string | undefined> = {};
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

/** The wall shape isQuotaExhaustion classifies on STATUS alone (402). */
function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

const SONNET_NOMINAL = "nom-ep@fake-nom";

/** sonnet: nominal nm (walls by default) → one degraded step s0. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0",
  CLAUDISH_FAILOVER_SONNET_LABEL: "S0 Fake",
  CLAUDISH_FAILOVER_SONNET_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_AUTO: "1",
  // The module's DEFAULT arm-after is 2 consecutive refusals (burst
  // discrimination); these pins measure the substitution, so the first arms.
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** Re-init the module with the cascade env and re-inject the nominal resolver
 *  (resetFailoverForTests clears it; the proxy injected its own at startup). */
function armCascade(): void {
  resetFailoverForTests({ ...CASCADE_ENV });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
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
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream: opts.stream === true,
      // The stream banner (the human channel) is session-keyed — without a
      // stable session id there is no client-visible banner either.
      metadata: {
        user_id: JSON.stringify({ session_id: "sess-note-1", device_id: "d", account_uuid: "a" }),
      },
      messages,
    }),
  });
}

/** The last body sent to an endpoint, as a flat string (format-agnostic). */
const lastBodyText = (which: string): string => JSON.stringify(bodies[which]?.at(-1) ?? {});
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** Register the fake providers through the SAME entry point the proxy uses,
 *  with an explicit config: no file is written, so a crashed run cannot leave
 *  a machine's real `~/.claudish/config.json` overwritten. */
function registerFakeEndpoints(): void {
  const ep = (name: string) => ({
    kind: "simple",
    url: `http://fake.invalid/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  ensureEndpointsRegistered({
    config: {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
      },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0 };
  bodies = { nm: [], s0: [] };
  wallEndpoints = new Set(["nm"]);
  registerFakeEndpoints();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sandboxedFailoverKeys = Object.keys(process.env).filter((k) =>
    k.startsWith("CLAUDISH_FAILOVER_")
  );
  savedFailoverEnv = {};
  for (const k of sandboxedFailoverKeys) {
    savedFailoverEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith("http://fake.invalid/")) {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    calls[which] = (calls[which] ?? 0) + 1;
    try {
      bodies[which].push(
        typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? {})
      );
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

/** Default spin: sonnet → nom-ep (the fake custom endpoint). The modelMap
 *  mirrors the hub wiring: the ROLE keyword picks the lane, so
 *  "claude-sonnet-5" resolves to the custom-endpoint nominal — without it the
 *  route hands the bare claude-* name to NativeHandler and the first attempt
 *  dies on shape A before any wall. */
async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    0,
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
    armCascade();

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
    armCascade();
    wallEndpoints = new Set(); // nominal healthy

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(lastBodyText("nm")).not.toContain("You are serving this session as");
  }, 30_000);

  test("T3: the client-visible banner is UNCHANGED — the stream still opens with the injected block", async () => {
    await spin();
    armCascade();

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
    armCascade();

    const r1 = await postMessage({ history: true });
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(lastBodyText("s0")).toContain("UNIQUE-PLANTED"); // today's behavior
  }, 30_000);

  test("T5: kill switch CLAUDISH_FAILOVER_REQUEST_NOTE=0 serves the substitute with no system note", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_REQUEST_NOTE = "0"; // read per request off process.env
    armCascade();

    const r1 = await postMessage({ history: true });
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    const t1 = lastBodyText("s0");
    expect(t1).not.toContain("You are serving this session as");
    expect(t1).not.toContain("UNIQUE-PLANTED"); // the strip is INDEPENDENT of the note
  }, 30_000);
});
