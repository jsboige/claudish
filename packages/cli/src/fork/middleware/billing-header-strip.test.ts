import { describe, expect, test } from "bun:test";
import { stripBillingHeaderFromBody } from "./billing-header-strip.js";

// The `cch=` hash changes every turn, so a strict prefix-caching backend
// re-reads the whole prefix unless the header line goes away. These pins
// hold the exact behaviours main relies on: the two `system` shapes, the
// native no-op, and that a second pass is harmless (attempt 0 strips, the
// cascade's later attempts see an already-clean body).

describe("stripBillingHeaderFromBody", () => {
  test("removes the billing line from a string system, keeping other text", () => {
    const body = {
      system: "x-anthropic-billing-header: cc_version=1.0.99; cch=abc123;\nYou are Claude.",
    };
    stripBillingHeaderFromBody(body, false);
    expect(body.system).toBe("You are Claude.");
  });

  test("consumes the trailing newline so no blank line is left behind", () => {
    const body = { system: "x-anthropic-billing-header: cc_version=1; cch=d;\n\nafter" };
    stripBillingHeaderFromBody(body, false);
    // The header's own newline is eaten; the pre-existing blank line stays.
    expect(body.system).toBe("\nafter");
  });

  test("removes every occurrence, not just the first", () => {
    const body = {
      system:
        "x-anthropic-billing-header: cc_version=1; cch=a;\nfirst\nx-anthropic-billing-header: cc_version=1; cch=b;\nsecond",
    };
    stripBillingHeaderFromBody(body, false);
    expect(body.system).toBe("first\nsecond");
  });

  test("strips the line inside text blocks of an array system", () => {
    const body = {
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=q;\nkeep me" },
        { type: "text", text: "untouched" },
      ],
    };
    stripBillingHeaderFromBody(body, false);
    expect(body.system[0].text).toBe("keep me");
    expect(body.system[1].text).toBe("untouched");
  });

  test("leaves non-text blocks alone in an array system", () => {
    const imageBlock = { type: "image", source: { type: "base64" } };
    const body = {
      system: [
        imageBlock,
        { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=z;\nclean" },
      ],
    };
    stripBillingHeaderFromBody(body, false);
    expect(body.system[0]).toBe(imageBlock);
    expect((body.system[1] as { text: string }).text).toBe("clean");
  });

  test("keeps the header for native traffic — it is the party it is for", () => {
    const original = "x-anthropic-billing-header: cc_version=1.0.99; cch=native;\nsystem";
    const body = { system: original };
    stripBillingHeaderFromBody(body, true);
    expect(body.system).toBe(original);
  });

  test("is a no-op when no header is present", () => {
    const body = { system: "plain system prompt", messages: [] };
    const before = JSON.stringify(body);
    stripBillingHeaderFromBody(body, false);
    expect(JSON.stringify(body)).toBe(before);
  });

  test("is idempotent — a second pass changes nothing", () => {
    const body = {
      system: "x-anthropic-billing-header: cc_version=1; cch=twice;\nstable text",
    };
    stripBillingHeaderFromBody(body, false);
    const once = body.system;
    stripBillingHeaderFromBody(body, false);
    expect(body.system).toBe(once);
    expect(body.system).toBe("stable text");
  });
});
