/**
 * #747 (b) — unit pins for the serving-banner history strip and the
 * request-side note builder.
 *
 * The strip's job is surgical: remove EXACTLY the banner shapes
 * `buildStreamNoticeText` emits (plus forged copies of them) from assistant
 * history, and nothing else. Three capability tails, labels containing
 * periods ("Kimi K3.1 Pro"), a forged banner fused to model text with no
 * space ("…stronger output.Je vérifie"), and the /compact append TAIL are all
 * in scope; plain text, other `[claudish]` shapes (recovery, condensation)
 * and non-assistant messages must pass through untouched.
 *
 * Mutation proof: loosen the regex to the first `.` and the "Kimi K3.1 Pro"
 * case goes red (stops at "K3."); drop the banner-only-block branch and the
 * block-0 case goes red (block survives emptied); key the walker on all roles
 * and the user-message case goes red.
 */

import { describe, expect, test } from "bun:test";
import {
  stripServingNoticeSegments,
  stripServingNoticesFromRequestBody,
} from "./fork/failover.js";

// ─── real banner shapes (verbatim tails from buildStreamNoticeText) ──────────

const DEGRADED = (label: string, target: string) =>
  `[claudish] You are serving this session as ${label} (\`${target}\`) — the 2nd fallback for the Sonnet role, because the nominal Sonnet model and Mistral GLM ahead of you are also temporarily exhausted. Remaining fallbacks: Qwen prepaid, DeepSeek Flash PAYG. Capability note: ${label} is weaker than the nominal Sonnet model; the inherited context may reflect the nominal's stronger output.`;

const IMPROVED = (label: string, target: string) =>
  `[claudish] You are serving this session as ${label} (\`${target}\`) — the 1st fallback for the Haiku role, because the operator routes the Haiku role away from its nominal model. Capability note: ${label} is stronger than the nominal Haiku model.`;

const EQUIVALENT = (label: string, target: string) =>
  `[claudish] You are serving this session as ${label} (\`${target}\`) — the 1st fallback for the Sonnet role, because the nominal Sonnet model temporarily exhausted. Capability is roughly equivalent; continue the work as normal.`;

describe("#747 stripServingNoticeSegments", () => {
  test("strips all three capability tails, including a label containing periods", () => {
    expect(stripServingNoticeSegments(DEGRADED("Kimi K3.1 Pro", "kc@k3.1-pro"))).toBe("");
    expect(stripServingNoticeSegments(IMPROVED("Sonnet role", "glm-5.3"))).toBe("");
    expect(stripServingNoticeSegments(EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3"))).toBe("");
  });

  test("strips a FORGED banner fused to model text with no space (r0781, 28/10)", () => {
    const text = DEGRADED("GLM-5.3", "glm-5.3") + "Je vérifie immédiatement l'état réel de la machine.";
    expect(stripServingNoticeSegments(text)).toBe("Je vérifie immédiatement l'état réel de la machine.");
  });

  test("strips the banner wherever it sits — opening, tail (/compact append), middle", () => {
    const banner = EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3");
    expect(stripServingNoticeSegments(banner + "Work follows.")).toBe("Work follows.");
    expect(stripServingNoticeSegments("Summary.\n" + banner)).toBe("Summary.\n");
    expect(stripServingNoticeSegments("Before. " + banner + " After.")).toBe("Before.  After.");
  });

  test("strips SEVERAL accumulated banners in one text", () => {
    const a = EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3");
    const b = DEGRADED("Kimi K3.1 Pro", "kc@k3.1-pro");
    expect(stripServingNoticeSegments(a + "Turn one. " + b + "Turn two.")).toBe("Turn one. Turn two.");
  });

  test("leaves everything else untouched — no match, no mangling", () => {
    const plain = "Je vérifie immédiatement l'état réel de la machine et je répare.";
    expect(stripServingNoticeSegments(plain)).toBe(plain);
    // A truncated banner (no capability tail) is LEFT ALONE — a wrong cut
    // would eat real content.
    const truncated = "[claudish] You are serving this session as GLM-5.3 (`glm-5.3`) — annonce tronquée.";
    expect(stripServingNoticeSegments(truncated)).toBe(truncated);
    // Other claudish shapes are out of scope (#747): recovery banner and the
    // condensation notice keep riding history.
    const recovery = "[claudish] You are back on the nominal Sonnet model after serving as Kimi K3.1 Pro (the 2nd fallback).";
    expect(stripServingNoticeSegments(recovery)).toBe(recovery);
    const condensation = "**[claudish] Failover model active.** This condensation is not being served by the nominal model.";
    expect(stripServingNoticeSegments(condensation)).toBe(condensation);
  });

  test("matches a re-typed typographic apostrophe in the degraded tail (forged copies)", () => {
    const forgedTail = "[claudish] You are serving this session as GLM-5.3 (`glm-5.3`) — the 1st fallback for the Sonnet role, because the nominal Sonnet model temporarily exhausted. Capability note: GLM-5.3 is weaker than the nominal Sonnet model; the inherited context may reflect the nominal’s stronger output.";
    expect(stripServingNoticeSegments(forgedTail + "Suite du travail.")).toBe("Suite du travail.");
  });
});

describe("#747 stripServingNoticesFromRequestBody", () => {
  test("drops the banner-only block 0 (the stream notice's own block) and keeps the rest", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3") },
            { type: "text", text: "Real answer." },
          ],
        },
      ],
    };
    stripServingNoticesFromRequestBody(body);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "Real answer." }]);
  });

  test("strips a fused prefix inside a block and the /compact append TAIL", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: DEGRADED("GLM-5.3", "glm-5.3") + "Je vérifie." },
            { type: "text", text: "Summary.\n" + IMPROVED("Sonnet role", "glm-5.3") },
          ],
        },
      ],
    };
    stripServingNoticesFromRequestBody(body);
    expect(body.messages[0].content[0].text).toBe("Je vérifie.");
    expect(body.messages[0].content[1].text).toBe("Summary.\n");
  });

  test("assistant tool_use and thinking blocks pass through untouched", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3") },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      ],
    };
    stripServingNoticesFromRequestBody(body);
    const content = body.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "thinking", thinking: "hmm" });
    expect(content[1]).toEqual({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } });
  });

  test("never strips USER messages and never touches string content it cannot fully keep", () => {
    const banner = DEGRADED("Kimi K3.1 Pro", "kc@k3.1-pro");
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: banner }] },
        { role: "assistant", content: banner }, // string form, banner-only → left as-is
        { role: "assistant", content: banner + "Real work." }, // string form, strippable
      ],
    };
    stripServingNoticesFromRequestBody(body);
    expect(body.messages[0].content).toEqual([{ type: "text", text: banner }]); // user: untouched
    expect(body.messages[1].content).toBe(banner); // would empty the message → no-op
    expect(body.messages[2].content).toBe("Real work.");
  });

  test("a message whose EVERY block is a banner is left untouched (structure over completeness)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: EQUIVALENT("Mistral GLM", "mistral@zai-glm-5-3") }],
        },
      ],
    };
    stripServingNoticesFromRequestBody(body);
    expect(body.messages[0].content).toHaveLength(1); // unchanged, not emptied to []
  });

  test("never throws on garbage bodies", () => {
    expect(() => stripServingNoticesFromRequestBody(null)).not.toThrow();
    expect(() => stripServingNoticesFromRequestBody(undefined)).not.toThrow();
    expect(() => stripServingNoticesFromRequestBody({ messages: "nope" })).not.toThrow();
    expect(() => stripServingNoticesFromRequestBody({ messages: [null, 7, { role: "assistant" }] })).not.toThrow();
  });
});
