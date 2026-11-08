// #921 grain 2 — deliberate failure, RED demonstration ONLY.
//
// This file exists for exactly one CI run: proving the test job now GATES
// after `continue-on-error` was dropped from test.yml. The run pushed with
// this commit must come back RED (job failure); the very next commit
// deletes this file and the branch head must come back GREEN. If the RED
// run were green, the flip gated nothing.
import { expect, test } from "bun:test";

test("deliberate failure — RED demo, #921 grain 2", () => {
  expect("red-demo").toBe("green");
});
