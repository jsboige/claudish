/**
 * Control tests for the env gate itself (#175): both gate directions must hold
 * in the same run — an inactive class registers, skips loudly and never runs
 * its body; an active class executes its body for real. The registry must
 * count every gated test.
 *
 * `active` here is a CONSTANT on purpose: these tests exercise the gate
 * mechanism, not a machine property — the doctrine "active must be a measured
 * probe" applies to real gated classes, not to the gate's own controls.
 */
import { describe, test, expect } from "bun:test";
import { envDescribe } from "./env-gate";

let activeRan = false;

envDescribe(
  {
    id: "ctl-inactive",
    active: false,
    reason: "control: condition false",
    activation: "control: never",
  },
  "control inactive class"
)((test) => {
  test("inactive class body must NOT run", () => {
    throw new Error("gate failed closed: body of an inactive class executed");
  });
});

envDescribe(
  {
    id: "ctl-active",
    active: true,
    reason: "control: condition true",
    activation: "control: always",
  },
  "control active class"
)((test) => {
  test("active class runs its body", () => {
    activeRan = true;
    expect(1 + 1).toBe(2);
  });
  // skipIf inside an ACTIVE class delegates to bun's named-skip: condition
  // true ⇒ skipped by name, body never runs, but the name still registers.
  test.skipIf(true)("active class conditional test skips by name", () => {
    throw new Error("skipIf(true) must skip, not run");
  });
});

envDescribe(
  {
    id: "ctl-inactive-skipif",
    active: false,
    reason: "control: condition false",
    activation: "control: never",
  },
  "control inactive class with conditional test"
)((test) => {
  test("plain test of an inactive class must NOT run", () => {
    throw new Error("gate failed closed: body of an inactive class executed");
  });
  // The class gate dominates the test's own condition: an inactive class
  // never runs a conditional body either, whatever skipIf says — and the
  // name registers for the manifest (#175 Group 2 test 3 shape).
  test.skipIf(true)("conditional test registers, never runs", () => {
    throw new Error("gate failed closed: conditional body executed");
  });
});

describe("env-gate controls", () => {
  // Both envDescribe calls above are registered at module top level, so their
  // tests have already executed by the time this describe runs (declaration
  // order) — registering a gated class INSIDE a test would invert that order,
  // which is the exact hazard these controls pin.
  test("active class actually ran its body", () => {
    expect(activeRan).toBe(true);
  });

  test("registry holds both classes with counted tests", () => {
    const reg = (globalThis as { __claudishEnvGate?: Array<{ cls: { id: string }; testNames: string[] }> }).__claudishEnvGate ?? [];
    const ids = reg.map((e) => `${e.cls.id}:${e.testNames.length}`);
    expect(ids).toContain("ctl-inactive:1");
    expect(ids).toContain("ctl-active:2");
    expect(ids).toContain("ctl-inactive-skipif:2");
  });
});

describe("env-gate doctrine: real reds are never gatable", () => {
  // #175 dispatch, standing rule: classes 2 (stale contract) and 2b (win32
  // source defect) must STAY red — a gate that swallows them would turn a
  // broken-on-main defect into a green line, the exact false-green this
  // mechanism exists to prevent. TEST-15 (team-orchestrator
  // validateSessionPath, `startsWith(cwd + "/")` on win32) is the known 2b
  // resident: this static pin refuses the "cleanup" that would silence it.
  // Positive control: the posix-path-shim file below IS allowed to gate, so
  // this test can never pass by matching nothing.
  test("class-2b host file carries no env gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const gated = readFileSync(
      join(dirname(import.meta.dir), "channel", "channel-wire-format.test.ts"),
      "utf-8",
    );
    expect(gated).toContain("envDescribe"); // positive control: detector works
    const host2b = readFileSync(
      join(dirname(import.meta.dir), "team-orchestrator.test.ts"),
      "utf-8",
    );
    expect(host2b).not.toContain("envDescribe");
    expect(host2b).not.toContain("env-gate");
  });
});
