/**
 * #693 — per-machine step exclusion (CLAUDISH_FAILOVER_STEP_EXCLUDE), ported to
 * `replatform/v14`.
 *
 * Why this is not a copy of main's `fork/failover.test.ts` §#693: that FILE does
 * not exist on this base (the fork failover module was ported without its unit
 * suite — `git ls-tree HEAD packages/cli/src/fork/` lists no `failover.test.ts`).
 * Porting the whole file would mean re-deriving every behaviour of a narrower
 * module; what this file does instead is pin exactly the #693 surface that the
 * v14 port implements, one case per claim, so nothing looks covered that is not.
 *
 * Every assertion below was read off a RUN of this base, not copied from main:
 * the one place the two could have diverged silently is the `role:` step's
 * in-place `target` refresh (v14 does it through `resolveRoleStep`, same as
 * main), and a failing run confirms it before any of it is pinned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  getSessionDwellPinForTests,
  initFailover,
  markStepFailed,
  resetFailoverForTests,
  resolveFailoverTarget,
  resolveFailoverTargetForSession,
  resolveTransientStep,
  setRoleNominalResolver,
} from "./failover.js";

// The mandate shape (hub 2026-10-25): ONE global haiku cascade, but ai-01's
// ~330k condensation prompts must never land on the local engine when the
// nominal walls — its walk starts at role:sonnet. Everyone else keeps vllm as
// step 0.
const MANDATE_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "vllm-myia@swift-1.5-27b!own>role:sonnet>ds@deepseek-payg",
  CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>kc@k3.1-pro",
  CLAUDISH_FAILOVER_ACTIVE: "haiku",
  CLAUDISH_FAILOVER_STEP_EXCLUDE: "vllm-myia@swift-1.5-27b:myia-ai-01",
} as NodeJS.ProcessEnv;

/** Capture what `logStderr` writes during `fn` — the load-time attestations are
 * half the contract (an ignored entry must be VISIBLE, not silent). */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
  }
  return lines;
}

/** MANDATE_ENV minus a key — a spread keeps the key with an `undefined` VALUE,
 * which bun turns into the string "undefined" for a real assign (see the
 * `bun-env-undefined-is-a-string` trap); an omitted key has no ambiguity. */
function without(key: keyof typeof MANDATE_ENV, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...MANDATE_ENV };
  delete env[key];
  return { ...env, ...extra };
}

beforeEach(() => {
  resetFailoverForTests();
  setRoleNominalResolver((r) => (r === "sonnet" ? "gc@glm-5.3" : undefined));
});

describe("#693 — per-machine step exclusion", () => {
  test("the named machine's walk skips the excluded step; every other machine keeps it", () => {
    const lines = captureStderr(() => initFailover(MANDATE_ENV));
    expect(lines.some((l) => l.includes("STEP-EXCLUDE haiku[0]") && l.includes("myia-ai-01"))).toBe(
      true
    );

    // The excluded machine lands on role:sonnet — its delegation resolves to
    // the sonnet nominal, exactly the mandated "MiniMax > Role Sonnet" tail.
    const ai01 = resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-ai-01");
    expect(ai01.stepIndex).toBe(1);
    expect(ai01.step!.roleRef).toBe("sonnet");
    expect(ai01.step!.target).toBe("gc@glm-5.3");

    // Machine-blind (canary, notices) and every other machine keep step 0 —
    // and the `!own` class suffix must not have broken target matching.
    expect(resolveFailoverTarget("haiku", "minimax-coding").stepIndex).toBe(0);
    expect(
      resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-po-2023").stepIndex
    ).toBe(0);

    // Unarmed role: nominal for every machine alike.
    resetFailoverForTests(without("CLAUDISH_FAILOVER_ACTIVE"));
    expect(resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-ai-01")).toEqual({
      step: null,
      stepIndex: -1,
    });
  });

  test("matches machine and target case-insensitively, and accepts several machines", () => {
    // Comma separates ENTRIES; machines within one entry are space-separated.
    initFailover({
      ...MANDATE_ENV,
      CLAUDISH_FAILOVER_STEP_EXCLUDE: "VLLM-MYIA@Swift-1.5-27b:Myia-AI-01 myia-po-2028",
    } as NodeJS.ProcessEnv);
    for (const m of ["myia-ai-01", "MYIA-AI-01", " myia-po-2028 "]) {
      expect(resolveFailoverTarget("haiku", "minimax-coding", undefined, m).stepIndex).toBe(1);
    }
    expect(
      resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-po-2023").stepIndex
    ).toBe(0);
  });

  test("an unknown target or malformed entry is ignored with a log — inert, never arming", () => {
    const lines = captureStderr(() =>
      initFailover({
        ...MANDATE_ENV,
        CLAUDISH_FAILOVER_STEP_EXCLUDE: "vllm-myia@nope-model:myia-ai-01, justgarbage, targetonly:",
      } as NodeJS.ProcessEnv)
    );
    expect(lines.some((l) => l.includes("no cascade step matches"))).toBe(true);
    expect(
      lines.filter((l) => l.includes("Ignoring malformed CLAUDISH_FAILOVER_STEP_EXCLUDE")).length
    ).toBe(2);
    // Nothing armed a diversion, no walk changed.
    expect(
      resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-ai-01").stepIndex
    ).toBe(0);
  });

  test("an exclusion naming EVERY step of a role is dropped at load (machine-stranding refused)", () => {
    const lines = captureStderr(() =>
      initFailover({
        ...MANDATE_ENV,
        CLAUDISH_FAILOVER_STEP_EXCLUDE:
          "vllm-myia@swift-1.5-27b:myia-ai-01, role:sonnet:myia-ai-01, ds@deepseek-payg:myia-ai-01",
      } as NodeJS.ProcessEnv)
    );
    expect(lines.some((l) => l.includes("named every step"))).toBe(true);
    // The walk for myia-ai-01 is back to the global one.
    expect(
      resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-ai-01").stepIndex
    ).toBe(0);
  });

  test("the last-step PAYG fallback refuses an EXCLUDED last step — the raw refusal surfaces", () => {
    initFailover({
      CLAUDISH_FAILOVER_HAIKU: "gc@glm-5.3>ds@deepseek-payg",
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
      CLAUDISH_FAILOVER_STEP_EXCLUDE: "ds@deepseek-payg:myia-ai-01",
    } as NodeJS.ProcessEnv);
    // Every earlier step TTL-failed: the fallback is the only candidate left.
    markStepFailed("haiku", 0, "glm walled");
    expect(resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-ai-01")).toEqual({
      step: null,
      stepIndex: -1,
    });
    // A machine without the exclusion keeps the PAYG bet.
    expect(
      resolveFailoverTarget("haiku", "minimax-coding", undefined, "myia-po-2023").stepIndex
    ).toBe(1);
  });

  test("a dwell pin on a step newly excluded for the machine yields and re-pins at the machine's walk", () => {
    initFailover(MANDATE_ENV);
    // A machine-blind resolution (notice/canary seam) pins the session on step 0.
    resolveFailoverTargetForSession("haiku", "s-ai01", "minimax-coding");
    expect(getSessionDwellPinForTests("haiku", "s-ai01")?.stepIndex).toBe(0);
    // The same session resolving WITH its machine header cannot hold an
    // excluded step — it yields, walks to role:sonnet, and re-pins there.
    const r = resolveFailoverTargetForSession(
      "haiku",
      "s-ai01",
      "minimax-coding",
      undefined,
      "myia-ai-01"
    );
    expect(r.stepIndex).toBe(1);
    expect(getSessionDwellPinForTests("haiku", "s-ai01")?.stepIndex).toBe(1);
    // Another machine's session keeps its step-0 pin untouched.
    resolveFailoverTargetForSession("haiku", "s-po2023", "minimax-coding");
    resolveFailoverTargetForSession(
      "haiku",
      "s-po2023",
      "minimax-coding",
      undefined,
      "myia-po-2023"
    );
    expect(getSessionDwellPinForTests("haiku", "s-po2023")?.stepIndex).toBe(0);
  });

  test("the #299-B overload walk skips the machine's excluded step (review pin: mutation left the suite green)", async () => {
    // The body and the doc claim the exclusion rides EVERY walk — armed,
    // session, AND the transient overload walk. The first two were pinned;
    // deleting the guard inside resolveTransientStep left the whole family
    // green on main (verified during review of #694), so this pin holds the
    // third. It is ported with the claim, not appended after the fact.
    initFailover(MANDATE_ENV);
    // Machine-blind (the one-shot walk's own resolution) and every other
    // machine keep step 0 — the walk is unchanged for them.
    const blind = await resolveTransientStep("haiku");
    expect(blind?.stepIndex).toBe(0);
    const po2023 = await resolveTransientStep("haiku", { machine: "myia-po-2023" });
    expect(po2023?.stepIndex).toBe(0);
    // The excluded machine's overload walk starts past the engine — the same
    // subtraction as its armed walk, landing on the role:sonnet delegation.
    const ai01 = await resolveTransientStep("haiku", { machine: "myia-ai-01" });
    expect(ai01?.stepIndex).toBe(1);
    expect(ai01?.step.roleRef).toBe("sonnet");
  });
});
