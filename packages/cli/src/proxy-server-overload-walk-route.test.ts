/**
 * #299-B — the one-shot overload walk, ported to `replatform/v14`.
 *
 * The defect it removes: a transient 529 (or a 429/503 whose body names an
 * overload, or the proxy's own 400 `connection_error` synthesis) on the
 * NOMINAL is a PROVIDER saying "unreachable / overloaded" — not the role's
 * plan being walled. Measured 2026-10-02 on the hub: 30 % of MiniMax attempts
 * failed so, and the client retried a dozen times against the same overloaded
 * provider before dropping the turn. The walk tries the FIRST SERVABLE
 * cascade step ONCE, for this request only, and writes NO failure state — no
 * arm, no step mark, no bucket wall, no dwell pin — so the moment the overload
 * lifts the next request re-probes the nominal instead of riding a cascade the
 * role was never exiled to.
 *
 * Harness: same contract as proxy-server-serving-note-route.test.ts — the REAL
 * proxy runs on an ephemeral port, the fake endpoints register through the
 * proxy's own entry point (no config file is written), and the outbound legs
 * are answered by a stubbed fetch. The instrument is the per-endpoint CALL
 * COUNT plus the state predicates: "the walk wrote nothing" is measured by
 * REQUEST 2 still trying (nominal, then the SAME first servable step) rather
 * than by the absence of a log line.
 *
 * v14 shape: no `forceTarget` seam exists on this base — `getHandlerForRequest`
 * is single-arg and the loop swaps the step in itself, so the walk serves its
 * concrete through the same construction path a step attempt uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  armFailover,
  earliestWalledReprobeAt,
  isBucketWalled,
  isFailoverActive,
  markStepFailed,
  providerBucketOf,
  resetFailoverForTests,
  resolveTransientStep,
  setRoleNominalBucketResolver,
  setRoleNominalResolver,
} from "./fork/failover.js";
import {
  isConnectionWalkClass,
  isOverloadWalkClass,
  isTransientOverload,
} from "./handlers/composed-handler.js";
import {
  clearEndpointTokenBudgets,
  estimateBudgetTokens,
} from "./handlers/shared/endpoint-token-budget.js";
import type { ClaudishProfileConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);
const realConsoleLog = console.log.bind(console);
const realStderrWrite = (process.stderr as any).write.bind(process.stderr);

/** #769 pins read the marker lines; the call counts alone cannot tell a SKIP
 *  from a step that was never resolved. */
let failoverLog: string[] = [];

let calls: Record<string, number> = {};
/** Per-endpoint HTTP status override. Absent ⇒ 200 healthy SSE. */
let endpointStatus: Record<string, number> = {};
/** Per-endpoint artificial latency, for the walk-budget pin. */
let endpointDelayMs: Record<string, number> = {};
/** W33 (#628): when set to a bucket, the next `tr` hit walls it BEFORE
 *  answering — a concurrent request changing the delegation owner mid-attempt. */
let wallOnTrHit: string | null = null;
/** #654 B3/B4/B5: the FIRST call to this endpoint is HELD until the test
 *  resolves it — the holder's lease stays in flight while another request is
 *  evaluated against the same Σ. */
let holdFirstHit: string | null = null;
let heldResolve: ((r: Response) => void) | null = null;
/** #654 B pins: per-endpoint SSE text — the client-visible proof of WHO
 *  served (absent ⇒ the shared greeting). */
let endpointText: Record<string, string> = {};
/** #654 B1-B5: answer 402s in the PLAIN `{detail}` shape (role-failover's
 * `quotaWall`) instead of `errorBodyFor(402)`. The OpenAI-shaped body makes
 * the handler re-envelope the wall as a 400 `invalid_request_error` — the
 * structured `insufficient_quota` type never survives to the loop, and the
 * arm never fires. The plain shape surfaces as a raw 402, which
 * `isQuotaExhaustion` takes on STATUS alone. */
let plainWall402 = false;
/** #575 (row 7a): when set to an endpoint name, that endpoint answers the
 *  engine's verbatim per-prompt image-cap 400 (fixture body) instead of
 *  `errorBodyFor` — the handler-side `media` skip emitter classifies it. */
let mediaCapOn: string | null = null;
/** #575 — the engine's per-prompt image cap, verbatim from
 * `test-fixtures/upstream-errors/vllm-image-cap-400.json` (10 hits, 12–20/10). */
function vllmImageCap400(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "At most 4 image(s) may be provided in one prompt. (parameter=image)",
        type: "BadRequestError",
        param: "image",
        code: 400,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

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
 *  the real cascade env, and the switches under test must start absent. */
let sandboxedFailoverKeys: string[] = [];
let savedFailoverEnv: Record<string, string | undefined> = {};
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;

function healthySSE(text = "Hello from the cascade."): Response {
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
    chunk({ content: text }) +
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

/** The error shapes the walk answers to (and the ones it must NOT). */
function errorBodyFor(status: number): string {
  if (status === 529)
    return JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } });
  if (status === 503)
    return JSON.stringify({ error: { type: "overloaded_error", message: "service unavailable" } });
  if (status === 400)
    return JSON.stringify({
      type: "error",
      error: { type: "connection_error", message: "connect ECONNREFUSED" },
    });
  if (status === 429)
    return JSON.stringify({
      error: { type: "rate_limit_error", message: "Too many requests — slow down" },
    });
  // W31 (#598): a plan wall — STATE the resolver owns, never a transport event.
  if (status === 402)
    return JSON.stringify({
      error: { type: "insufficient_quota", message: "You exceeded your current quota" },
    });
  return JSON.stringify({ error: { type: "internal_error", message: "boom" } });
}

const SONNET_NOMINAL = "nm-ep@fake-nm";

/** sonnet: nominal nm → two steps s0, s1. NOT armed by default — the walk is
 *  precisely the path that serves a substitute without arming the role. */
const CASCADE_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_SONNET_LABEL: "S0 Fake",
  CLAUDISH_FAILOVER_SONNET_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** Re-init the module with the cascade env and re-inject the nominal resolver
 *  (resetFailoverForTests clears it; the proxy injected its own at startup). */
function armCascade(): void {
  resetFailoverForTests({ ...CASCADE_ENV });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

/** #769: re-init with an ARBITRARY cascade env (the unroutable pins need the
 *  steps to name a provider with no credential in the sandbox). */
function resetWalk(env: Record<string, string>): void {
  resetFailoverForTests({ CLAUDISH_FAILOVER_AUTO: "1", CLAUDISH_FAILOVER_ARM_AFTER: "1", ...env });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

async function postMessage(
  opts: {
    model?: string;
    headers?: Record<string, string>;
    /** #654: rides `metadata.user_id` — the budget signature keys on it. */
    session?: string;
    content?: string;
    /** #575: an explicit content-blocks array (image blocks for the cap pins). */
    contentBlocks?: unknown[];
  } = {}
): Promise<Response> {
  return realFetch(`${activeProxy!.url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: 64,
      stream: false,
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
      messages: [
        {
          role: "user",
          content: opts.contentBlocks ?? opts.content ?? "say hi",
        },
      ],
    }),
  });
}

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
        "nm-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
        "t2-ep": ep("t2"),
        "tr-ep": ep("tr"),
      },
    } as unknown as ClaudishProfileConfig,
    force: true,
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, t2: 0, tr: 0, native: 0 };
  endpointStatus = { nm: 529, native: 529 };
  endpointDelayMs = {};
  wallOnTrHit = null;
  holdFirstHit = null;
  heldResolve = null;
  endpointText = {};
  plainWall402 = false;
  mediaCapOn = null;
  // #654: the endpoint-budget family is per-endpoint-named, so it cannot sit
  // in SANDBOX_ENV_KEYS — sweep the whole family AND the module's global lease
  // registry; a leaked holder lease would phantom-Σ every later pin.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDISH_ENDPOINT_")) delete process.env[k];
  }
  clearEndpointTokenBudgets();
  failoverLog = [];
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (
        line.includes("[Failover]") ||
        line.includes("[EndpointBudget]") ||
        line.includes("[MediaCap]")
      )
        failoverLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (
        line.includes("[Failover]") ||
        line.includes("[EndpointBudget]") ||
        line.includes("[MediaCap]")
      )
        failoverLog.push(line);
    }
    // Re-emit so a failing run still shows the proxy's operator markers.
    realConsoleLog(...args);
  }) as any;
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
  globalThis.fetch = (async (input: any) => {
    // Request / URL instances reach here too (the native lane builds a
    // Request); reading only `input.url` would silently fall through to the
    // catch-all 200 and make a native 529 look like a healthy answer.
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? "");
    let which: string;
    if (url.startsWith("http://fake.invalid/")) {
      which = url.slice("http://fake.invalid/".length, "http://fake.invalid/".length + 2);
    } else if (url.includes("api.anthropic.com")) {
      which = "native";
    } else {
      // Background warmers (pricing / catalog / recommended) and anything else.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    calls[which] = (calls[which] ?? 0) + 1;
    // W33 (#628 review): a CONCURRENT request walls the target's nominal
    // bucket while this attempt is in flight, then the attempt serves 200 —
    // the state change the delegation-owner resolution must not observe.
    if (which === "tr" && wallOnTrHit) {
      armFailover(
        "opus",
        "W33: a concurrent request walled opus's nominal DURING the attempt",
        wallOnTrHit
      );
      wallOnTrHit = null;
    }
    const delay = endpointDelayMs[which] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // #654 B3/B4/B5: hold the FIRST call to `holdFirstHit` — the holder's
    // lease must stay in flight while a second request is evaluated.
    if (holdFirstHit && which === holdFirstHit) {
      holdFirstHit = null;
      return new Promise<Response>((resolve) => {
        heldResolve = resolve;
      });
    }
    const status = endpointStatus[which] ?? 200;
    // #575: the image-cap body beats the status map — the emitter classifies
    // THIS body, and errorBodyFor(400) is a different 400 entirely.
    if (mediaCapOn === which) return vllmImageCap400();
    if (status === 402 && plainWall402) {
      return new Response(
        JSON.stringify({
          detail: "Check your subscription on https://example.invalid/subscription",
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      );
    }
    if (status === 200) return healthySSE(endpointText[which]);
    return new Response(errorBodyFor(status), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  (process.stderr as any).write = realStderrWrite;
  console.log = realConsoleLog;
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
  // #654: same family sweep as beforeEach — a pin that crashed mid-flight
  // must not leave its knobs (or leases) to the file's later tests.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDISH_ENDPOINT_")) delete process.env[k];
  }
  clearEndpointTokenBudgets();
  resetFailoverForTests();
});

/** Default spin: sonnet → the fake custom endpoint. The modelMap mirrors the
 *  hub wiring: the ROLE keyword picks the lane, so "claude-sonnet-5" resolves
 *  to the custom-endpoint nominal — without it the route hands the bare
 *  claude-* name to NativeHandler. W7 passes an EMPTY map plus a stub sk-ant
 *  key so the nominal IS native (the walk's own exclusion). */
async function spin(
  map: Record<string, string> | null = { sonnet: SONNET_NOMINAL },
  apiKey?: string
): Promise<void> {
  activeProxy = await createProxyServer(0, undefined, undefined, false, apiKey, map ?? {}, {
    quiet: true,
  });
}

// ─── module pins ─────────────────────────────────────────────────────────────

describe("#299-B — isOverloadWalkClass pins every clause the walk answers to", () => {
  test("529 and 503 are overload", () => {
    expect(isOverloadWalkClass(529, "")).toBe(true);
    expect(isOverloadWalkClass(529, '{"error":{"type":"overloaded_error"}}')).toBe(true);
    expect(isOverloadWalkClass(503, "")).toBe(true);
    expect(isOverloadWalkClass(503, "service unavailable")).toBe(true);
  });

  test("429 counts only when the body names an overload (never a plain burst)", () => {
    expect(isOverloadWalkClass(429, "The server cluster is overloaded")).toBe(true);
    expect(isOverloadWalkClass(429, "try again later")).toBe(true);
    expect(isOverloadWalkClass(429, "concurrency limit reached")).toBe(true);
    expect(isOverloadWalkClass(429, "Too many requests — slow down")).toBe(false);
    expect(isOverloadWalkClass(429, "")).toBe(false);
  });

  test("400 counts only for the proxy's own connection_error synthesis", () => {
    expect(isOverloadWalkClass(400, '{"type":"error","error":{"type":"connection_error"}}')).toBe(
      true
    );
    expect(isConnectionWalkClass(400, '{"type":"error","error":{"type":"connection_error"}}')).toBe(
      true
    );
    expect(
      isOverloadWalkClass(400, '{"type":"error","error":{"type":"invalid_request_error"}}')
    ).toBe(false);
    expect(isOverloadWalkClass(400, "")).toBe(false);
  });

  test("502/504 are NOT the walk's class (nothing names an overload)", () => {
    expect(isOverloadWalkClass(502, "")).toBe(false);
    expect(isOverloadWalkClass(504, "")).toBe(false);
    expect(isOverloadWalkClass(500, "internal error")).toBe(false);
    expect(isTransientOverload(500, "internal error")).toBe(false);
  });
});

describe("#299-B — resolveTransientStep is read-only resolution, no last-step fallback", () => {
  test("picks the first servable step and returns its concrete", async () => {
    armCascade();
    const walk = await resolveTransientStep("sonnet");
    expect(walk?.stepIndex).toBe(0);
    expect(walk?.concrete).toBe("s0-ep@fake-s0");
  });

  test("a step in per-step backoff is skipped — the walk never re-pays a known-dead target", async () => {
    armCascade();
    markStepFailed("sonnet", 0, "HTTP 500 (test)");
    const walk = await resolveTransientStep("sonnet");
    expect(walk?.stepIndex).toBe(1);
    // …and the mark it read is the ONLY state: resolution wrote nothing new.
    const again = await resolveTransientStep("sonnet");
    expect(again?.stepIndex).toBe(1);
  });

  test("a WALLED provider bucket is skipped, and so is the NOMINAL's own bucket", async () => {
    armCascade();
    armFailover("sonnet", "test: s0 bucket walled", providerBucketOf("s0-ep@fake-s0"));
    expect(isBucketWalled(providerBucketOf("s0-ep@fake-s0"))).toBe(true);
    expect((await resolveTransientStep("sonnet"))?.stepIndex).toBe(1);
    resetFailoverForTests({ ...CASCADE_ENV });
    setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
    const walk = await resolveTransientStep("sonnet", {
      nominalBucket: providerBucketOf("s0-ep@fake-s0"),
    });
    expect(walk?.stepIndex).toBe(1); // same bucket as the 529 that just refused
  });

  test("a role-step whose delegation cannot resolve is SKIPPED, never routed as a model id", async () => {
    resetFailoverForTests({ CLAUDISH_FAILOVER_SONNET: "role:haiku" });
    const walk = await resolveTransientStep("sonnet");
    expect(walk).toBeNull(); // no last-step fallback: surface the original overload
  });

  test("every step unservable ⇒ null, never the last step anyway", async () => {
    armCascade();
    markStepFailed("sonnet", 0, "HTTP 500 (test)");
    markStepFailed("sonnet", 1, "HTTP 500 (test)");
    expect(await resolveTransientStep("sonnet")).toBeNull();
  });
});

// ─── route pins ──────────────────────────────────────────────────────────────

describe("#299-B — a nominal overload walks the cascade ONCE, writing zero failure state", () => {
  test("W1: nominal 529 → step 0 serves; no arm, no bucket wall", async () => {
    await spin();
    armCascade();
    expect(isFailoverActive("sonnet")).toBe(false);

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);
    // A SERVED walk writes success bookkeeping, never failure state.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(providerBucketOf("s0-ep@fake-s0"))).toBe(false);
  }, 30_000);

  test("W2: the walk writes NO step mark — request 2 tries the nominal again, then the SAME step 0", async () => {
    await spin();
    armCascade();
    expect((await postMessage()).status).toBe(200);
    const r2 = await postMessage();
    expect(r2.status).toBe(200);
    // The nominal is re-probed (no arm, no dwell pin)…
    expect(calls.nm).toBe(2);
    // …and step 0 is still the FIRST servable step (a mark would have sent the
    // second walk to s1).
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W3: kill switch CLAUDISH_FAILOVER_OVERLOAD_WALK=0 → the 529 surfaces, no walk", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK = "0"; // read per request off process.env
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W4: nominal 529 arriving PAST the walk budget → skip, original surfaces", async () => {
    await spin();
    process.env.CLAUDISH_FAILOVER_WALK_BUDGET_MS = "50";
    endpointDelayMs.nm = 120;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
  }, 30_000);

  test("W5: the walk step ALSO fails → the client gets the ORIGINAL overload, and nothing is marked", async () => {
    await spin();
    endpointStatus.s0 = 529;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(529); // the nominal's own shape, not the step's
    expect(calls.s0).toBe(1);
    // No mark on step 0: the next request walks there again rather than to s1.
    expect((await postMessage()).status).toBe(529);
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);

  test("W6: a NON-overload nominal failure (500) does not walk — the user's own model failing surfaces", async () => {
    await spin();
    endpointStatus.nm = 500;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W7: a NATIVE-lane 529 does NOT walk — the client's own credential, never a silent substitution", async () => {
    await spin({}, "sk-ant-test-walk");
    resetFailoverForTests({ ...CASCADE_ENV });
    setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));

    const r1 = await postMessage({ headers: { "x-api-key": "sk-ant-test-walk" } });
    expect(r1.status).not.toBe(200);
    expect(calls.native).toBe(1); // the nominal WAS reached and refused
    expect(calls.s0).toBe(0); // the walk is excluded on the native lane
    expect(calls.s1).toBe(0);
  }, 30_000);

  test("W8: HTTP 400 connection_error on the nominal walks (#298 A clause)", async () => {
    await spin();
    endpointStatus.nm = 400;
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
  }, 30_000);

  test("W9: a 429 BURST (no overload wording) neither walks nor arms", async () => {
    await spin();
    endpointStatus.nm = 429; // body: "Too many requests — slow down"
    armCascade();

    const r1 = await postMessage();
    expect(r1.status).not.toBe(200);
    expect(calls.s0).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);
});

// ─── #769 — an unroutable step skips FORWARD, never a terminal routing 400 ────
//
// A step naming `provider@model` whose provider has no credential on THIS host
// throws a RoutingError at handler CONSTRUCTION — before any upstream call.
// That is an IMPASSE, not an attempt failure: the step is healthy, the host
// just cannot route it. `kimi` is the vehicle because KIMI_API_KEY is in
// SANDBOX_ENV_KEYS, so the throw is guaranteed and hermetic.
describe("#769 — an unroutable cascade step advances instead of failing the turn", () => {
  // Site A — the ARMED loop (not the walk) hitting an unroutable step. The
  // skip rides the SAME request-scoped `skippedSteps` set the #431 family
  // uses: no failure mark, no wall, no arm, no pin.
  test("U1: an ARMED cascade whose step 0 is unroutable → step 1 serves, no mark", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "kimi@fake-kimi>s1-ep@fake-s1" });
    // Arm the NOMINAL's bucket so the loop resolves the cascade from attempt 0.
    expect(
      armFailover(
        "sonnet",
        "test: nominal walled, cascade engaged",
        providerBucketOf(SONNET_NOMINAL)
      )
    ).toBe(true);

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(0); // walled nominal — never probed
    expect(calls.s0 ?? 0).toBe(0); // unroutable — construction threw before any call
    expect(calls.s1).toBe(1); // the skip landed on the next step
    // The skip marker names the step, the reason and the concrete (countable).
    expect(
      failoverLog.some(
        (l) =>
          l.includes("[Failover] SKIP sonnet[0]") &&
          l.includes("reason=unroutable") &&
          l.includes("kimi@fake-kimi")
      )
    ).toBe(true);
    // No step marked failed: the last-step marker must NOT appear.
    expect(failoverLog.some((l) => l.includes("STEP-UNROUTABLE sonnet"))).toBe(false);
  }, 30_000);

  // AC 6 — the LAST step unroutable cannot skip: the cascade refuses in the
  // labelled overload form (529 + `x-claudish-step-skip: unroutable`), NOT with
  // a client-shaped routing 400. The gap is host-local, not the caller's fault.
  test("U2: LAST step unroutable → labelled 529 refusal, never a routing 400", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>kimi@fake-kimi" });
    expect(
      armFailover(
        "sonnet",
        "test: nominal walled, cascade engaged",
        providerBucketOf(SONNET_NOMINAL)
      )
    ).toBe(true);
    // Step 0 benched through the plane the ARMED resolver reads, so the
    // resolver hands back the LAST (unroutable) one.
    markStepFailed("sonnet", 0, "test: step 0 benched", undefined, { concrete: "s0-ep@fake-s0" });

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the labelled refusal, retryable
    expect(r1.headers.get("x-claudish-step-skip")).toContain("unroutable");
    const parsed = JSON.parse(await r1.text());
    expect(parsed.error.type).toBe("overloaded_error");
    expect(parsed.error.message).toContain("has no routable step on this host");
    expect(parsed.error.message).toContain("kimi@fake-kimi");
    // The env-var hint of the underlying RoutingError reaches the operator.
    expect(parsed.error.message).toContain("KIMI_API_KEY");
    expect(calls.s0).toBe(0);
    expect(failoverLog.some((l) => l.includes("[Failover] STEP-UNROUTABLE sonnet[1]"))).toBe(true);
  }, 30_000);

  // Site B — the WALK's own construction. Before #769 the catch swallowed this
  // throw as a classless failure and the ORIGINAL 529 surfaced: a host-local
  // routing gap cost the request the whole cascade.
  test("W14: the walk target UNROUTABLE (no credential) → the walk advances and serves", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "kimi@fake-kimi>s1-ep@fake-s1" });
    // NOT armed: the walk is the path that serves a substitute without arming.
    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the overloaded nominal, paid once
    expect(calls.s1).toBe(1); // the unroutable step 0 was skipped, step 1 served
    expect(
      failoverLog.some(
        (l) => l.includes("[Failover] WALK-SKIP sonnet") && l.includes("reason=unroutable")
      )
    ).toBe(true);
  }, 30_000);

  // The advance is bounded to ONE hop: a second unroutable target surfaces the
  // ORIGINAL overload (retryable 529), never a routing 400 and never an
  // unbounded scan of the cascade.
  test("W14b: BOTH walk targets unroutable → the ORIGINAL 529, no 400, no state", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "kimi@fake-kimi>kimi@fake-kimi2" });
    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the nominal's own overload, retryable
    const body = await r1.text();
    expect(body).toContain("overloaded");
    expect(body).not.toContain("could not be routed"); // no routing refusal smuggled in
    expect(calls.nm).toBe(1);
    expect(calls.s1).toBe(0); // nothing callable on either target
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);

  // Review R1, ported from main's #789 (pin U3 there): an unroutable concrete
  // is never PAID, and the walk's exclusion set is built only from what a
  // request paid — so without recording the dead concrete BEFORE walking, the
  // walk re-offers the SAME dead delegation concrete (with `attempt--`) until
  // the candidate bound is hit, and the delegation's own routable steps are
  // never tried. RED when the `paidConcretes.add(concrete)` is dropped
  // (verified by mutation on this port 03/11 — the guard survived with U3 absent).
  test("U3: an unroutable DELEGATION nominal does not loop the walk — the target's own step serves (R1, #769)", async () => {
    // opus's failover-side nominal is UNROUTABLE (no kimi credential in the
    // sandbox — the resolver, not the modelMap, is what the delegation reads);
    // opus's cascade step (t2) is healthy.
    await spin();
    resetWalk({
      CLAUDISH_FAILOVER_SONNET: "role:opus>s1-ep@fake-s1",
      CLAUDISH_FAILOVER_OPUS: "t2-ep@fake-t2",
    });
    setRoleNominalResolver((r) =>
      r === "sonnet" ? SONNET_NOMINAL : r === "opus" ? "kimi@fake-kimi" : undefined
    );
    // Wall the SONNET nominal's bucket so the cascade serves from attempt 0.
    expect(
      armFailover(
        "sonnet",
        "test: nominal walled, cascade engaged",
        providerBucketOf(SONNET_NOMINAL)
      )
    ).toBe(true);

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.t2 ?? 0).toBe(1); // the delegation advanced to the TARGET's step
    expect(calls.s1 ?? 0).toBe(0); // sonnet's step 1 never paid — t2 served first
    // The dead nominal is offered to the walk ZERO times (the pre-fix loop
    // logged `trying kimi@fake-kimi (opus nominal)` twice before skipping).
    expect(failoverLog.some((l) => l.includes("trying kimi@fake-kimi"))).toBe(false);
    expect(
      failoverLog.some(
        (l) =>
          l.includes("[Failover] DELEGATION-WALK sonnet[0]") &&
          l.includes("trying t2-ep@fake-t2 (opus step 0)")
      )
    ).toBe(true);
  }, 30_000);
});

// ─── #598 — a walk step that dies CONNECTION-class advances ONCE ─────────────
//
// The measured driver (2026-10-22 on main): the nominal's egress died and walk
// step 0 sat on the same dead host, so 194/194 sonnet walks re-picked step 0
// and step 1 was never tried. A transport failure writes NO state by design
// (#299 B), so `firstServable` keeps finding that same dead step servable — the
// advance is the only way out, and it must stay strictly narrower than "any
// failure": a 529/429/503 answers about CAPACITY the resolver owns.
describe("#598 — a walk step that dies connection-class advances once", () => {
  test("V1: walk step 0 dies connection-class → step 1 serves, and NOTHING is written", async () => {
    await spin();
    armCascade();
    endpointStatus.s0 = 400; // the proxy's own connection_error synthesis
    endpointStatus.s1 = 200;

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the overloaded nominal, paid once
    expect(calls.s0).toBe(1); // the dead step, paid once — not re-picked in turn
    expect(calls.s1).toBe(1); // the advance's single extra attempt
    expect(
      failoverLog.some(
        (l) =>
          l.includes("[Failover] WALK-ADVANCE sonnet") &&
          l.includes("connection-class") &&
          l.includes("s1-ep@fake-s1")
      )
    ).toBe(true);

    // The discriminator that needs no marker: request 2 RE-PICKS step 0. A
    // written mark would send it straight to step 1 — and a transport failure
    // says nothing about the step's plan, so there must be no mark.
    const r2 = await postMessage({ model: "claude-sonnet-5" });
    expect(r2.status).toBe(200);
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(2);
  }, 30_000);

  test("V2: BOTH walk targets connection-class → the ORIGINAL 529, no routing 400, no state", async () => {
    await spin();
    armCascade();
    endpointStatus.s0 = 400;
    endpointStatus.s1 = 400;

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the nominal's own overload, retryable
    const body = await r1.text();
    expect(body).toContain("overloaded");
    expect(body).not.toContain("could not be routed"); // no routing refusal smuggled in
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1); // one advance, never a scan
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);

  test("V3: a walk step that dies CAPACITY-class (503) does NOT advance", async () => {
    await spin();
    armCascade();
    endpointStatus.s0 = 503; // overloaded_error wording — #299 B's own class
    endpointStatus.s1 = 200;

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the original overload stands
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0); // stepping over capacity would re-buy what #299 B rejected
    expect(failoverLog.some((l) => l.includes("[Failover] WALK-ADVANCE sonnet"))).toBe(false);
    expect(isFailoverActive("sonnet")).toBe(false);
  }, 30_000);

  test("V4: the walk budget gates the ADVANCE — a paid attempt that would overrun is not bought", async () => {
    await spin();
    armCascade();
    process.env.CLAUDISH_FAILOVER_WALK_BUDGET_MS = "50";
    endpointStatus.s0 = 400;
    endpointStatus.s1 = 200;
    endpointDelayMs.s0 = 150; // the first attempt itself eats the budget

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the original overload, not a second overrun
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);
    expect(
      failoverLog.some(
        (l) => l.includes("[Failover] WALK-ADVANCE sonnet skipped") && l.includes("budget")
      )
    ).toBe(true);
  }, 30_000);

  // W31 (#628): the advance is CONNECTION-class only. A plan wall is STATE the
  // resolver owns — stepping over it would re-buy exactly what #299 B rejected.
  // Distinct from V3's 503 on purpose: capacity (503/529/429) and plan wall
  // (402) are different refusals, and the source trunk pins the 402.
  test("W31: a walk step that dies QUOTA (402 plan wall) does NOT advance", async () => {
    await spin();
    armCascade();
    endpointStatus.s0 = 402; // quota-shaped body: insufficient_quota
    endpointStatus.s1 = 200;

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(529); // the original overload, never the step's wall
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(providerBucketOf(SONNET_NOMINAL))).toBe(false);
  }, 30_000);

  // W33 (#628 review, ported from main's W33 — the #331 class): the delegation
  // owner is STATE-DEPENDENT — resolveRoleStep reads the target nominal's
  // bucket wall. Resolved AFTER the round-trip, a wall moved by another request
  // during the attempt credits an owner that never served, and the success
  // clears a step record this request never paid. Shape: sonnet[0] = role:opus,
  // opus's nominal = tr, opus[0] = t2 pre-benched; the walk serves tr and
  // answers 200 while a concurrent request walls tr's bucket mid-flight.
  test("W33 (#628): a concurrent wall mid-attempt must not re-point the owner credit", async () => {
    await spin({ sonnet: SONNET_NOMINAL, opus: "tr-ep@fake-tr" });
    resetWalk({
      CLAUDISH_FAILOVER_SONNET: "role:opus>s1-ep@fake-s1",
      CLAUDISH_FAILOVER_OPUS: "t2-ep@fake-t2",
    });
    setRoleNominalResolver((r) =>
      r === "sonnet" ? SONNET_NOMINAL : r === "opus" ? "tr-ep@fake-tr" : undefined
    );
    // One bucketter on both sides: the arm below and resolveRoleStep's own
    // `nominalBucket` lookup must name the SAME key, or the concurrent wall is
    // invisible to the delegation and this pin measures nothing (#628 measured
    // it green under the mutant until this line existed).
    setRoleNominalBucketResolver((nominal) => providerBucketOf(nominal));
    markStepFailed("opus", 0, "W33: opus's step 0 benched before the walk");
    expect(earliestWalledReprobeAt("opus")).toBeDefined(); // the record this pin defends

    const bucketOfTr = providerBucketOf("tr-ep@fake-tr");
    wallOnTrHit = bucketOfTr;

    const r1 = await postMessage({ model: "claude-sonnet-5" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1);
    expect(calls.tr).toBe(1); // the walk served opus's NOMINAL — the attempt's own concrete
    expect(calls.s1).toBe(0);
    expect(calls.t2 ?? 0).toBe(0); // the target's step was never paid
    // THE PIN: no step record was cleared by a success that did not serve it.
    expect(earliestWalledReprobeAt("opus")).toBeDefined();
    // And a success credits the owner, it never disarms a bucket (TTL owns that).
    expect(isBucketWalled(bucketOfTr)).toBe(true);
  }, 30_000);
});

// ─── #654 — the in-flight token budget per endpoint ─────────────────────────
//
// v14 home: this file (the loop AND the walk integration live in the same
// harness here; the fork carries them in its step-skip route suite, which has
// no v14 counterpart). The budget rides the #431 skip wire (reason=busy): an
// over-budget step is never CALLED, never marked, never armed — the successor
// serves. The nominal refusal is an overload-class diversion feeding the
// #299-B one-shot walk. Unit pins (numbers, estimator, AC5 registry) live in
// endpoint-token-budget.test.ts; these route pins carry the integration:
// zero upstream calls on the budgeted endpoint, no bench after a budget skip,
// real in-flight Σ, the big-cap short-pass, the echo replacement and the
// nominal walk (B7 = the r1 walk-side gate).

describe("#654 — in-flight token budget per endpoint (busy-class skip)", () => {
  /** The knobs are per-endpoint-named (not in SANDBOX_ENV_KEYS): each pin
   * clears the family and the lease registry before AND after itself. */
  const clearBudget = () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("CLAUDISH_ENDPOINT_")) delete process.env[k];
    }
    clearEndpointTokenBudgets();
  };
  /** The client-visible text of a served step, per endpoint name. */
  const sayFrom = (which: "s0" | "s1"): string => `ok-from-${which}`;
  const setHealthy = (which: "nm" | "s0" | "s1"): void => {
    delete endpointStatus[which];
  };
  const releaseHeld = (): void => {
    heldResolve?.(healthySSE("ok-from-s0"));
    heldResolve = null;
  };
  async function responseText(r: Response): Promise<string> {
    const body: any = await r.json();
    return (body?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
  }

  test("B1 (AC2): a step over Σ is NEVER called — the successor serves, no failure mark", async () => {
    clearBudget();
    try {
      await spin();
      armCascade();
      endpointStatus.nm = 402; // arm -> step 0 dispatch
      plainWall402 = true; // plain shape: the OpenAI-shaped wall re-envelopes to 400 and never arms // arm → step 0 dispatch
      // 10 tokens: any real body (~50 est) is over Σ on the FIRST attempt —
      // the refusal happens before any s0 socket exists.
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP = "10";
      endpointText.s0 = sayFrom("s0");
      endpointText.s1 = sayFrom("s1");

      const r = await postMessage({ session: "b1" });
      expect(r.status).toBe(200);
      expect(await responseText(r)).toContain(sayFrom("s1"));
      expect(calls.s0 ?? 0).toBe(0); // THE PIN: the engine never saw the request
      expect(calls.s1).toBe(1);
      expect(
        failoverLog.some(
          (l) =>
            l.includes("[Failover] SKIP sonnet[0] reason=busy") &&
            l.includes("sum=0/10") &&
            l.includes("endpoint token budget")
        )
      ).toBe(true);

      // No failure mark: with the budget removed (read per request), a fresh
      // session resolves step 0 again — a bench would TTL-freeze s0 for 10 min.
      delete process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP;
      const r2 = await postMessage({ session: "b1b" });
      expect(await responseText(r2)).toContain(sayFrom("s0"));
      expect(calls.s0).toBe(1);
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B2 (AC1): no budget env ⇒ zero drift — step 0 serves, no budget marker", async () => {
    clearBudget();
    try {
      await spin();
      armCascade();
      endpointStatus.nm = 402; // arm -> step 0 dispatch
      plainWall402 = true; // plain shape: the OpenAI-shaped wall re-envelopes to 400 and never arms

      const r = await postMessage({ session: "b2" });
      expect(r.status).toBe(200);
      expect((await r.json())?.content?.[0]?.text).toContain("Hello from the cascade.");
      expect(calls.s0).toBe(1);
      expect(calls.s1 ?? 0).toBe(0);
      expect(failoverLog.filter((l) => l.includes("[EndpointBudget]")).length).toBe(0);
      expect(failoverLog.filter((l) => l.includes("endpoint token budget")).length).toBe(0);
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B3 (AC2): Σ counts REAL in-flight leases — the holder trips the second request", async () => {
    clearBudget();
    try {
      await spin();
      armCascade();
      endpointStatus.nm = 402; // arm -> step 0 dispatch
      plainWall402 = true; // plain shape: the OpenAI-shaped wall re-envelopes to 400 and never arms
      // Budget = one estimate + slack: one request fits, two do not.
      const est = estimateBudgetTokens({
        model: "claude-sonnet-5",
        max_tokens: 64,
        stream: false,
        metadata: { user_id: "b3a" },
        messages: [{ role: "user", content: "hold the budget lease" }],
      });
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP = String(est + 10);
      endpointText.s1 = sayFrom("s1");
      holdFirstHit = "s0";

      const r1p = postMessage({ session: "b3a", content: "hold the budget lease" });
      await new Promise((r) => setTimeout(r, 400)); // r1 reaches s0, lease committed
      expect(calls.s0).toBe(1);

      // Different session ⇒ different signature ⇒ its own estimate: est+est >
      // est+10 ⇒ refused at step 0, s1 serves — while r1 still holds its lease.
      const r2 = await postMessage({ session: "b3b", content: "hold the budget lease" });
      expect(await responseText(r2)).toContain(sayFrom("s1"));
      expect(calls.s1).toBe(1);
      expect(calls.s0).toBe(1); // still only the holder

      releaseHeld();
      const r1 = await r1p;
      expect(r1.status).toBe(200);
      expect(await responseText(r1)).toContain(sayFrom("s0"));
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B4 (AC4): the big-concurrency cap refuses the SECOND big body, a short one still passes", async () => {
    clearBudget();
    try {
      await spin();
      armCascade();
      endpointStatus.nm = 402; // arm -> step 0 dispatch
      plainWall402 = true; // plain shape: the OpenAI-shaped wall re-envelopes to 400 and never arms
      process.env.CLAUDISH_ENDPOINT_BIG_LIMIT_S0_EP = "1";
      endpointText.s1 = sayFrom("s1");
      holdFirstHit = "s0";

      // Big #1 (est > 100K): admitted (bigInFlight 0 < 1), holds the lease.
      const big1 = "y".repeat(400_000);
      const r1p = postMessage({ session: "b4a", content: `read: ${big1}` });
      await new Promise((r) => setTimeout(r, 500));
      expect(calls.s0).toBe(1);

      // Big #2, different body: bigInFlight 1 ≥ 1 ⇒ refused reason=big ⇒ s1.
      const big2 = "z".repeat(400_100);
      const r2 = await postMessage({ session: "b4b", content: `read: ${big2}` });
      expect(await responseText(r2)).toContain(sayFrom("s1"));
      expect(
        failoverLog.some(
          (l) => l.includes("[Failover] SKIP sonnet[0] reason=busy") && l.includes("reason=big")
        )
      ).toBe(true);

      // THE AC4 PIN: a short request passes under the saturated big cap.
      const r3 = await postMessage({ session: "b4c", content: "short one please" });
      expect(await responseText(r3)).toContain("Hello from the cascade.");
      expect(calls.s0).toBe(2); // big#1 (holder) + short — big#2 never reached s0

      releaseHeld();
      await r1p;
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B5 (AC5): an identical resubmission REPLACES its predecessor — s0 takes it again", async () => {
    clearBudget();
    try {
      await spin();
      armCascade();
      endpointStatus.nm = 402; // arm -> step 0 dispatch
      plainWall402 = true; // plain shape: the OpenAI-shaped wall re-envelopes to 400 and never arms
      const est = estimateBudgetTokens({
        model: "claude-sonnet-5",
        max_tokens: 64,
        stream: false,
        metadata: { user_id: "b5" },
        messages: [{ role: "user", content: "echo me once" }],
      });
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP = String(est + 10);
      endpointText.s0 = sayFrom("s0");
      holdFirstHit = "s0";

      // Same session, same body: the second copy replaces the first's estimate
      // (Σ stays one est ≤ est+10) instead of refusing it to s1.
      const r1p = postMessage({ session: "b5", content: "echo me once" });
      await new Promise((r) => setTimeout(r, 400));
      expect(calls.s0).toBe(1);
      const r2 = await postMessage({ session: "b5", content: "echo me once" });
      expect(await responseText(r2)).toContain(sayFrom("s0"));
      expect(calls.s0).toBe(2); // THE PIN: s0 again — add-semantics would say s1
      expect(calls.s1 ?? 0).toBe(0);
      expect(
        failoverLog.some((l) => l.includes("[EndpointBudget]") && l.includes("resubmit=2"))
      ).toBe(true);

      releaseHeld();
      const r1 = await r1p;
      expect(r1.status).toBe(200);
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B6: the nominal's budget refusal is a walk — s0 serves, the client never sees the 529", async () => {
    clearBudget();
    try {
      await spin();
      // NO auto-arm: attempt 0 is the healthy nominal — until its budget says no.
      resetFailoverForTests({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1" });
      setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
      setHealthy("nm");
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_NM_EP = "10";
      endpointText.s0 = sayFrom("s0");

      const r = await postMessage({ session: "b6" });
      expect(r.status).toBe(200); // the synthesized 529 never reaches the client
      expect(await responseText(r)).toContain(sayFrom("s0"));
      expect(calls.nm ?? 0).toBe(0); // the budgeted nominal is never called
      expect(calls.s0).toBe(1);
      expect(failoverLog.some((l) => l.includes("budget-skip nominal"))).toBe(true);
    } finally {
      clearBudget();
    }
  }, 30_000);

  test("B7 (#663 r1): a walk target at full Σ gets ZERO calls — the walk advances one hop, the successor serves", async () => {
    clearBudget();
    try {
      await spin();
      // B6 shape (the NOMINAL's own budget refusal triggers the #299-B walk)
      // with the walk's FIRST step budgeted too: s0-ep at Σ=10 refuses any
      // real body (~50 est) BEFORE its call. Before r1 the walk bypassed the
      // gate entirely — s0 was called with the very load the budget exists
      // to bound. The pin is the zero: admission refused, one hop forward.
      resetFailoverForTests({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1" });
      setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
      setHealthy("nm");
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_NM_EP = "10";
      process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP = "10";
      endpointText.s0 = sayFrom("s0");
      endpointText.s1 = sayFrom("s1");

      const r = await postMessage({ session: "b7" });
      expect(r.status).toBe(200);
      expect(await responseText(r)).toContain(sayFrom("s1"));
      expect(calls.nm ?? 0).toBe(0); // the budgeted nominal never pays a round-trip
      expect(calls.s0 ?? 0).toBe(0); // THE PIN: the walk target was refused before its call
      expect(calls.s1).toBe(1);
      expect(
        failoverLog.some(
          (l) =>
            l.includes("[Failover] WALK-SKIP sonnet → s0-ep@fake-s0") &&
            l.includes("sum=0/10") &&
            l.includes("endpoint token budget")
        )
      ).toBe(true);

      // No state written by the refusal: the nominal's budget stays armed (it
      // is what triggers the walk), s0's lifts (read per request) — a fresh
      // session walks again and s0 serves. A bench or wall from the walk-skip
      // would TTL-freeze s0 for 10 min and the walk would land on s1.
      delete process.env.CLAUDISH_ENDPOINT_TOKEN_BUDGET_S0_EP;
      const r2 = await postMessage({ session: "b7b" });
      expect(await responseText(r2)).toContain(sayFrom("s0"));
      expect(calls.s0).toBe(1);
    } finally {
      clearBudget();
    }
  }, 30_000);
});

// ─── #575 (#431 row 7a) — the engine's per-prompt image cap is a skip, not a ───
// failure. The handler-side `media` emitter (composed-handler.ts) classifies the
// engine's verbatim 400, re-labels it exactly, and sets the skip header; the
// loop's wire path (proxy-server.ts readStepSkip) consumes it. Relocated from
// main's step-skip-route suite — this branch has no such suite, and the walk
// suite is where the cascade loop is pinned.
describe("#575 — the vLLM image cap skips forward (#431 row 7a)", () => {
  async function responseText(r: Response): Promise<string> {
    const body = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
    return (body?.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("");
  }
  /** Five screenshots: the cap counts BLOCKS, so the marker must report 5
   *  against the engine's stated 4 — the number the client can act on. */
  const fiveImages = () =>
    Array.from({ length: 5 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(1024) },
    }));

  test("K25: a non-last step refused on the image cap skips forward — no mark, no bench", async () => {
    await spin();
    armCascade();
    endpointStatus.nm = 402; // arm -> step 0 dispatch
    plainWall402 = true; // plain shape: the arm fires on the status alone
    mediaCapOn = "s0"; // step 0 answers the engine's image-cap 400
    endpointText.s1 = "ok-from-s1";

    const r1 = await postMessage({
      session: "k25",
      contentBlocks: [...fiveImages(), { type: "text", text: "what do these show?" }],
    });
    // The successor's answer, never the engine's 400 — a 400 here would end the
    // agent turn on a shape the next step serves perfectly.
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("ok-from-s1");
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
    // The loop's skip marker (v14 wording: STEP-SKIP): reason and the exact
    // countable detail the emitter put on the wire.
    const skipLine = failoverLog.find((l) => l.includes("[Failover] STEP-SKIP sonnet[0]"));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain("media");
    expect(skipLine).toContain("images=5");
    expect(skipLine).toContain("cap=4");
    expect(skipLine).toContain("param=image");
    expect(failoverLog.some((l) => l.includes("[MediaCap]"))).toBe(true);

    // No failure mark (#553's bench is exactly what this class must not arm):
    // a FRESH session's next request resolves step 0 again.
    mediaCapOn = null;
    endpointText.s0 = "ok-from-s0-again";
    const r2 = await postMessage({ session: "k25b" });
    expect(await responseText(r2)).toContain("ok-from-s0-again");
    expect(calls.s0).toBe(2);
  }, 30_000);

  test("K26: on the LAST step the 400 surfaces with the exact label and the skip header", async () => {
    await spin();
    // Single-step cascade — nothing to advance to.
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0" });
    endpointStatus.nm = 402; // arm -> step 0 dispatch
    plainWall402 = true;
    mediaCapOn = "s0";

    const r1 = await postMessage({
      session: "k26",
      contentBlocks: [...fiveImages(), { type: "text", text: "what do these show?" }],
    });
    expect(r1.status).toBe(400);
    // The marker rides the surface path too (harmless to a client that ignores
    // it, greppable for one that looks — same doctrine as the failover notice).
    expect(r1.headers.get("x-claudish-step-skip")).toContain("media");
    const body = (await r1.json()) as { error?: { message?: string } };
    const message = String(body?.error?.message ?? "");
    // The exact label replaced BOTH the engine's jargon and the generic
    // "Request format may be incompatible with provider" that sent the 20/10
    // diagnosis thread hunting a translation bug.
    expect(message).toContain("at most 4 image(s)");
    expect(message).toContain("carries 5");
    expect(message).not.toContain("Request format may be incompatible");
    // Single round-trip, no skip: there is no successor to advance to.
    expect(calls.s0).toBe(1);
    expect(failoverLog.some((l) => l.includes("[Failover] STEP-SKIP"))).toBe(false);
  }, 30_000);
});
