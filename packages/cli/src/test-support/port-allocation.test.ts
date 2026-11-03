import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * In-process route suites bind REAL loopback ports, so two files declaring the
 * same port are a latent flake: `bun test` runs files sequentially, which hides
 * it, but any two concurrent processes (CI shards, a second `bun test` on the
 * same machine, a developer running one suite on each side) fail with
 * `EADDRINUSE` in BOTH — measured 03/11 on port 19921.
 *
 * The convention this pin enforces is one allocation per FILE, not per run:
 * pick the next free value, never reuse one another suite already claims. The
 * scan below is the source of truth — the hand-kept "reserved elsewhere" lists
 * that used to live in individual suites drifted and missed two live collisions,
 * so they now point here instead of enumerating.
 *
 * A declaration is `const <NAME containing PORT> = <4-5 digits>` (PROXY_PORT,
 * UPSTREAM_PORT, PORT_BASE, BOOT_PORT, …). Comments are ignored by the regex,
 * which matters because several suites document their neighbours in prose.
 */

const SRC_ROOT = join(import.meta.dir, "..");
const SELF = "port-allocation.test.ts";
const PORT_DECL = /^\s*(?:const|let)\s+([A-Za-z_]*[Pp][Oo][Rr][Tt][A-Za-z_]*)\s*=\s*(\d{4,5})\b/gm;

interface Declaration {
  file: string;
  name: string;
  port: number;
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function declaredPorts(): Declaration[] {
  const rows: Declaration[] = [];
  for (const file of collectTestFiles(SRC_ROOT)) {
    if (file.endsWith(SELF)) continue;
    const text = readFileSync(file, "utf8");
    const rel = relative(SRC_ROOT, file).split(sep).join("/");
    for (const match of text.matchAll(PORT_DECL)) {
      rows.push({ file: rel, name: match[1]!, port: Number(match[2]!) });
    }
  }
  return rows;
}

describe("port allocation across in-process test suites", () => {
  const rows = declaredPorts();

  test("the scan actually sees the suites it protects (guards a silent no-op)", () => {
    // If the path or the regex ever stops matching, the duplicate check below
    // would pass vacuously — that is the failure mode worth pinning.
    expect(rows.length).toBeGreaterThan(25);
    expect(new Set(rows.map((r) => r.file)).size).toBeGreaterThan(15);
  });

  test("no port is claimed by two different test files", () => {
    const byPort = new Map<number, Declaration[]>();
    for (const row of rows) {
      const owners = byPort.get(row.port) ?? [];
      owners.push(row);
      byPort.set(row.port, owners);
    }

    const collisions: string[] = [];
    for (const [port, owners] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
      const files = [...new Set(owners.map((o) => o.file))];
      if (files.length < 2) continue;
      const detail = owners.map((o) => `${o.file} (${o.name})`).join(", ");
      collisions.push(`port ${port}: ${detail}`);
    }

    expect(collisions.join("\n")).toBe("");
  });
});
