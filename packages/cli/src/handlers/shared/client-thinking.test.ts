import { describe, expect, it } from "bun:test";
import { clientRequestedThinking } from "./client-thinking.js";

describe("clientRequestedThinking", () => {
  it("enabled is a request", () => {
    expect(clientRequestedThinking({ type: "enabled", budget_tokens: 31999 })).toBe(true);
  });
  it("adaptive is a request (Claude Code's dominant shape)", () => {
    expect(clientRequestedThinking({ type: "adaptive" })).toBe(true);
  });
  it("disabled is not", () => {
    expect(clientRequestedThinking({ type: "disabled" })).toBe(false);
  });
  it("absent, null and typeless are not", () => {
    expect(clientRequestedThinking(undefined)).toBe(false);
    expect(clientRequestedThinking(null)).toBe(false);
    expect(clientRequestedThinking({})).toBe(false);
    expect(clientRequestedThinking({ type: "" })).toBe(false);
  });
  it("an unknown future type counts as a request", () => {
    expect(clientRequestedThinking({ type: "auto" })).toBe(true);
  });
});
