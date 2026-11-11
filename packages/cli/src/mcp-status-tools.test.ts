/**
 * Shape + no-secret tests for the #985 read-only MCP surface.
 *
 * Run: bun test packages/cli/src/mcp-status-tools.test.ts
 *
 * Two obligations from the issue:
 *  1. Form: claudish_status reports tier→effective mapping, armed steps,
 *     configured/auto, reset clocks; claudish_capabilities reports vision,
 *     the REAL context window (measured > declared > catalog), tool-use, thinking.
 *  2. No secret value ever leaves the surface — scrubbed by SHAPE, so a rotated
 *     or future credential cannot slip through.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCapabilities, renderStatus, scrubForWire, scrubScalar } from "./mcp-status-tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_SOURCE = readFileSync(join(__dirname, "mcp-server.ts"), "utf-8");

// ── Secret scrubbing ─────────────────────────────────────────────────────────

describe("scrubForWire — no secret value leaves the MCP surface", () => {
  test("redacts Anthropic / OpenAI / OpenRouter / z.ai key shapes", () => {
    expect(scrubScalar("sk-ant-abc123def456ghi")).toBe("[redacted]");
    expect(scrubScalar("sk-or-v1-9f8e7d6c5b4a")).toBe("[redacted]");
    expect(scrubScalar("sk-proj-ABCDEFGHIJKL")).toBe("[redacted]");
  });

  test("redacts bearer tokens and JWTs", () => {
    expect(scrubScalar("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe("[redacted]");
    const jwt = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccc";
    expect(scrubScalar(jwt)).toBe("[redacted]");
  });

  test("a credential-NAMED key never carries its value out, whatever the value", () => {
    const out = scrubForWire({
      apiKey: "not-even-a-real-key-but-field-is-credential",
      "x-proxy-key": "cluster-secret",
      authorization: "Bearer whatever",
      nested: { proxy_key: "abc", safe: "glm-5.3" },
    });
    expect(out.apiKey).toBe("[redacted]");
    expect(out["x-proxy-key"]).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.nested.proxy_key).toBe("[redacted]");
    expect(out.nested.safe).toBe("glm-5.3");
  });

  test("non-secret model/provider names pass through untouched", () => {
    expect(scrubScalar("gc@glm-5.3")).toBe("gc@glm-5.3");
    expect(scrubScalar("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(scrubScalar("cx@gpt-6-luna")).toBe("cx@gpt-6-luna");
  });

  test("numbers/booleans/null are not stringified or dropped", () => {
    const out = scrubForWire({ n: 262144, ok: true, none: null, arr: [1, 2, 3] });
    expect(out.n).toBe(262144);
    expect(out.ok).toBe(true);
    expect(out.none).toBeNull();
    expect(out.arr).toEqual([1, 2, 3]);
  });

  test("input is never mutated (returns a new structure)", () => {
    const src = { apiKey: "sk-secret", role: "sonnet" };
    const out = scrubForWire(src);
    expect(src.apiKey).toBe("sk-secret"); // original intact
    expect(out.apiKey).toBe("[redacted]");
  });

  test("a secret buried inside an armed-step target string is redacted", () => {
    const out = scrubForWire({
      roles: [{ serving: { target: "custom@model key-sk-ant-abc123def456" } }],
    });
    expect(out.roles[0].serving.target).toBe("[redacted]");
  });
});

// ── claudish_status form ─────────────────────────────────────────────────────

describe("renderStatus — form", () => {
  test("reports tier→effective mapping, serving step, configured/auto, reset clock", () => {
    const out = renderStatus({
      profile: "default",
      roles: [
        {
          role: "sonnet",
          nominal: "gc@glm-5.3",
          configuredSteps: ["ds@deepseek-flash"],
          activeStep: { target: "ds@deepseek-flash", stepIndex: 0, bucket: "glm-coding" },
          auto: true,
          resetAt: "2026-11-11T15:52:00.000Z",
        },
        {
          role: "haiku",
          nominal: "cx@gpt-6-luna",
          configuredSteps: [],
          auto: false,
          resetAt: null,
        },
      ],
    });
    const sonnet = out.roles.find((r) => r.role === "sonnet")!;
    expect(sonnet.effective).toBe("gc@glm-5.3");
    expect(sonnet.serving.diverted).toBe(true);
    expect(sonnet.serving.target).toBe("ds@deepseek-flash");
    expect(sonnet.serving.stepIndex).toBe(0);
    expect(sonnet.configured).toEqual(["ds@deepseek-flash"]);
    expect(sonnet.auto).toBe(true);
    expect(sonnet.resetAt).toBe("2026-11-11T15:52:00.000Z");

    const haiku = out.roles.find((r) => r.role === "haiku")!;
    expect(haiku.serving.diverted).toBe(false);
    expect(haiku.effective).toBe("cx@gpt-6-luna");
  });

  test("an unmapped role reports null effective, not a crash", () => {
    const out = renderStatus({ roles: [{ role: "fable", configuredSteps: [], auto: false }] });
    expect(out.roles[0].effective).toBeNull();
    expect(out.roles[0].serving.diverted).toBe(false);
  });
});

// ── claudish_capabilities form ───────────────────────────────────────────────

describe("renderCapabilities — form and window provenance", () => {
  test("reports vision/toolUse/thinking and the MEASURED window when present", () => {
    const out = renderCapabilities({
      model: "swift-1.5-27b",
      provider: "vllm-myia",
      catalog: { vision: false, toolUse: true, thinking: true, context: 262144 },
      declaredContextLimit: 262144,
      derivedContextLimit: 262144,
    });
    expect(out.vision).toBe(false);
    expect(out.toolUse).toBe(true);
    expect(out.thinking).toBe(true);
    expect(out.contextWindow).toBe(262144);
    expect(out.contextWindowSource).toBe("measured");
  });

  test("a DECLARED window (a claim) is labeled declared, never measured", () => {
    const out = renderCapabilities({ model: "m", declaredContextLimit: 200000 });
    expect(out.contextWindow).toBe(200000);
    expect(out.contextWindowSource).toBe("declared");
  });

  test("catalog-only window falls back to catalog source", () => {
    const out = renderCapabilities({ model: "m", catalog: { context: "200K" } });
    expect(out.contextWindow).toBe("200K");
    expect(out.contextWindowSource).toBe("catalog");
  });

  test("absent catalog = unknown flags, never a guess", () => {
    const out = renderCapabilities({ model: "obscure-model" });
    expect(out.vision).toBeNull();
    expect(out.toolUse).toBeNull();
    expect(out.thinking).toBeNull();
    expect(out.contextWindowSource).toBe("unknown");
  });
});

// ── source-level wiring guard ────────────────────────────────────────────────

describe("mcp-server.ts — both read-only tools are wired", () => {
  test("exposes claudish_status and claudish_capabilities", () => {
    expect(MCP_SERVER_SOURCE).toContain('name: "claudish_status"');
    expect(MCP_SERVER_SOURCE).toContain('name: "claudish_capabilities"');
  });

  test("both are in the low-level group (always available)", () => {
    // each tool block pushes group: "low-level"
    const statusIdx = MCP_SERVER_SOURCE.indexOf('name: "claudish_status"');
    const capIdx = MCP_SERVER_SOURCE.indexOf('name: "claudish_capabilities"');
    expect(MCP_SERVER_SOURCE.slice(statusIdx, statusIdx + 600)).toContain('group: "low-level"');
    expect(MCP_SERVER_SOURCE.slice(capIdx, capIdx + 600)).toContain('group: "low-level"');
  });

  test("handlers route through the scrubbing module (no direct unscrubbed render)", () => {
    expect(MCP_SERVER_SOURCE).toContain("renderStatus(");
    expect(MCP_SERVER_SOURCE).toContain("renderCapabilities(");
    expect(MCP_SERVER_SOURCE).toContain('from "./mcp-status-tools.js"');
  });
});
