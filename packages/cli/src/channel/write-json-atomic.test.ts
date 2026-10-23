import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "./write-json-atomic.js";

// The regression this pins (upstream 9aef742c, #586 grain 6): session
// meta.json used to be written by a bare writeFileSync while an external
// monitor polls the file — a reader could land on a half-written file.

describe("writeJsonAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes pretty-printed JSON readable back key by key", () => {
    const target = join(dir, "meta.json");
    writeJsonAtomic(target, { sessionId: "s1", status: "running", n: 3 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
      sessionId: "s1",
      status: "running",
      n: 3,
    });
    // exact formatting preserved from the previous writeFileSync call
    expect(readFileSync(target, "utf-8")).toBe(
      JSON.stringify({ sessionId: "s1", status: "running", n: 3 }, null, 2)
    );
  });

  test("replaces a pre-existing target and leaves no temp residue", () => {
    const target = join(dir, "meta.json");
    writeFileSync(target, '{"old":true}', "utf-8");
    writeJsonAtomic(target, { status: "completed" });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ status: "completed" });
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });

  test("a serialization failure leaves the pre-existing target intact and throws", () => {
    const target = join(dir, "meta.json");
    writeFileSync(target, '{"old":true}', "utf-8");
    // BigInt cannot be serialized by JSON.stringify
    expect(() => writeJsonAtomic(target, { bad: 1n })).toThrow();
    expect(readFileSync(target, "utf-8")).toBe('{"old":true}');
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });

  test("repeated writes all land on the final value, no residue", () => {
    const target = join(dir, "meta.json");
    for (let i = 0; i < 20; i++) {
      writeJsonAtomic(target, { seq: i });
    }
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ seq: 19 });
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });
});
