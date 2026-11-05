import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./write-json-atomic";

/**
 * #831 — pins for the write side. The class is "read a JSON another process is still
 * writing"; the reader's net is in ./wait-for-json.test.ts, this file pins the cure.
 */
describe("#831 writeJsonAtomic", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "write-json-atomic-"));

  test("writes exactly the text the previous in-place write produced (indent 1)", () => {
    // Behaviour must not drift while the mechanism changes: every existing assertion on
    // a probe's content was written against this exact byte string.
    const root = dir();
    const path = join(root, "probe.json");
    const value = { env: { A: "1" }, cwd: "/w", argv: ["-i", "--model", "m"] };
    writeJsonAtomic(path, value);
    expect(readFileSync(path, "utf-8")).toBe(JSON.stringify(value, null, 1));
  });

  test("replaces by rename, not in place — the mechanism the whole fix rests on", () => {
    // A reader opens either the old file or the new one; a torn state needs a file whose
    // bytes are being overwritten. In-place rewriting keeps the inode, rename swaps it,
    // so the inode is the observable that separates the two: this is what would go red
    // if someone "simplified" the helper back to writeFileSync.
    const root = dir();
    const path = join(root, "probe.json");
    writeFileSync(path, '{"old":true}');
    const before = statSync(path).ino;
    writeJsonAtomic(path, { fresh: true });
    expect(readFileSync(path, "utf-8")).toBe(JSON.stringify({ fresh: true }, null, 1));
    expect(statSync(path).ino).not.toBe(before);
  });

  test("leaves no temporary sibling behind", () => {
    const root = dir();
    writeJsonAtomic(join(root, "probe.json"), { a: 1 });
    expect(readdirSync(root)).toEqual(["probe.json"]);
  });

  test("a value that cannot be serialised leaves the previous file intact", () => {
    // Serialisation happens BEFORE the destination is touched, so a caller's bug cannot
    // empty a file a reader is about to open — the failure mode is a throw, not a truncation.
    const root = dir();
    const path = join(root, "probe.json");
    writeFileSync(path, '{"previous":true}');
    expect(() => writeJsonAtomic(path, { big: 1n })).toThrow();
    expect(readFileSync(path, "utf-8")).toBe('{"previous":true}');
    expect(readdirSync(root)).toEqual(["probe.json"]);
  });

  test("a payload larger than one buffer still lands whole", () => {
    // The probes are tiny, but the guarantee is about any size: a reader polling during a
    // multi-chunk write is exactly the macOS failure, so the helper must not assume small.
    const root = dir();
    const path = join(root, "probe.json");
    const value = { blob: "x".repeat(512 * 1024), n: 1 };
    writeJsonAtomic(path, value);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(value);
  });
});
