/** Unit pins for the #831 settle primitives — no pane, no magmux, any OS. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForJson, waitForTextContaining } from "./wait-for-json.js";

describe("#831 waitForJson / waitForTextContaining", () => {
  test("waitForJson refuses a half-written file, then settles when the writer finishes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudish-831-")), "probe.json");
    writeFileSync(path, '{"argv": ["par'); // exists, unparseable — the old read died here
    const pending = waitForJson<{ argv: string[] }>(path, 5_000, 20);
    await new Promise((resolve) => setTimeout(resolve, 100)); // polls must see the partial
    writeFileSync(path, '{"argv":["claude"]}');
    expect((await pending).argv[0]).toBe("claude");
  });

  test("waitForJson resolves once a late file appears — no separate existence wait", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudish-831-")), "absent.json");
    const pending = waitForJson<{ a: number }>(path, 5_000, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(path, '{"a":1}');
    expect((await pending).a).toBe(1);
  });

  test("waitForJson fails on deadline with the size and head of what it saw", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudish-831-")), "partial.json");
    writeFileSync(path, '{"argv": ["par');
    await expect(waitForJson(path, 150, 20)).rejects.toThrow(
      /never parsed within 150 ms — 14 chars, head=/
    );
  });

  test("waitForTextContaining settles on the substrings, not on existence", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudish-831-")), "log.txt");
    writeFileSync(path, "before ");
    const pending = waitForTextContaining(path, ["MY_SERVICE_TOKEN="], 5_000, 20);
    await new Promise((resolve) => setTimeout(resolve, 100)); // polls see the partial
    writeFileSync(path, "before MY_SERVICE_TOKEN=***REDACTED***");
    expect(await pending).toContain("***REDACTED***");
  });

  test("waitForTextContaining fails naming the first missing substring", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "claudish-831-")), "log.txt");
    writeFileSync(path, "half");
    await expect(
      waitForTextContaining(path, ["MY_SERVICE_TOKEN=", "argv"], 150, 20)
    ).rejects.toThrow(/still missing 2 substring\(s\).*first missing: /);
  });
});
