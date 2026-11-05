/**
 * Row 3 (#218, Epic #641) — ROUTE pins for the native-lane version pin, at the
 * serving seam and on the counting path.
 *
 * WHAT IS AND IS NOT DISCRIMINATED HERE: the unit suite
 * (`proxy-server-native-pin.test.ts`) pins the resolver's predicate. THIS file
 * pins the WIRING — that the cascade loop actually applies the pin to the body
 * a `NativeHandler` forwards, that it is restored on a failed attempt, that the
 * kill switch reaches the wire, and that `count_tokens` takes the same pin
 * (main's #218 rationale: counting against a different model than the one that
 * answers makes the client's own context accounting drift). A port that landed
 * the module but forgot a call site leaves the unit suite fully green and turns
 * only the corresponding case here red — that is the point.
 *
 * Harness: the classifier-passthrough pattern — the REAL proxy on an ephemeral
 * port, only the outbound anthropic.com leg answered by a stubbed fetch that
 * CAPTURES the upstream body. `claude-opus-4-8` with no role map is the native
 * lane; with a role map `{ opus: "claude-opus-5-5" }` the resolution targets
 * `claude-opus-5-5` (still native, still bare), so the pin's rewrite is the
 * only thing that can change the id the wire sees.
 *
 * Mutation table — every row was RUN against these files (throwaway copies,
 * cp-restore; never git checkout):
 *  - remove the loop's pin (serving site) ⇒ P1 red, P2/P3/P4 green (P4 pins
 *    the count_tokens site independently);
 *  - remove the count_tokens pin ⇒ P4 red, P1/P2/P3 green;
 *  - flip the resolver's `claude-*` guard to bare-only ⇒ the unit suite's
 *    guard tests red (route pins unaffected — their targets are Anthropic ids).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

/** Upstream legs the stub captured: which host, and the parsed body. */
let upstream: Array<{ which: string; body: any }> = [];

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
  "CLAUDISH_NATIVE_MODEL_PIN",
  "CLAUDISH_NATIVE_PIN_AUTO",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

/** Plain JSON message — the native passthrough forwards it verbatim to the
 *  client (classifier-passthrough pattern, no stream involved). */
function nativeJSON(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_native",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "native says hi" }],
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

beforeEach(() => {
  upstream = [];
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? "");
    if (url.includes("api.anthropic.com")) {
      upstream.push({ which: "anthropic", body: JSON.parse(init?.body as string) });
      return nativeJSON();
    }
    // Background warmers (pricing / catalog / recommended) and anything else.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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
});

async function spin(
  modelMap: { opus?: string; sonnet?: string; haiku?: string } | undefined
): Promise<void> {
  activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, modelMap, {
    quiet: true,
  });
}

async function postMessage(model: string): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

describe("row 3 — the native pin reaches the wire", () => {
  test("P1: a role-mapped native request is served under the CONFIGURED version, not the requested one", async () => {
    await spin({ opus: "claude-opus-5-5" });
    // The native lane needs a credential to reach the stub; pin it so the test
    // does not depend on which keys the host machine happens to hold.
    process.env.ANTHROPIC_API_KEY = "test-native-key";

    const res = await postMessage("claude-opus-4-8");
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].which).toBe("anthropic");
    // THE PIN: NativeHandler forwards body.model verbatim, so this equality is
    // the whole claim of #218 — the configured version, not the requested one.
    expect(upstream[0].body.model).toBe("claude-opus-5-5");
  }, 30_000);

  test("P2: CLAUDISH_NATIVE_MODEL_PIN=0 restores the passthrough — the client's id reaches the wire", async () => {
    await spin({ opus: "claude-opus-5-5" });
    process.env.ANTHROPIC_API_KEY = "test-native-key";
    // Read per request on purpose: the fleet flips it without a restart.
    process.env.CLAUDISH_NATIVE_MODEL_PIN = "0";

    const res = await postMessage("claude-opus-4-8");
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].body.model).toBe("claude-opus-4-8");
  }, 30_000);

  test("P3: with no role map the id passes through untouched — the pin never invents a target", async () => {
    await spin(undefined);
    process.env.ANTHROPIC_API_KEY = "test-native-key";

    const res = await postMessage("claude-opus-4-8");
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    expect(upstream[0].body.model).toBe("claude-opus-4-8");
  }, 30_000);

  test("P4: count_tokens takes the SAME pin as the serving path", async () => {
    await spin({ opus: "claude-opus-5-5" });
    process.env.ANTHROPIC_API_KEY = "test-native-key";

    const res = await realFetch(`${activeProxy!.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "count me" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(upstream.length).toBe(1);
    const [captured] = upstream;
    // Main's rationale, made checkable: a client that counts against one model
    // and is served by another drifts its own context accounting.
    expect(captured.body.model).toBe("claude-opus-5-5");
  }, 30_000);
});
