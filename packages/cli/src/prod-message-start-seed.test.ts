/**
 * #1019 — every `message_start` the proxy builds itself seeds both cache
 * counters (#179 rule b, `docs/reference/model-routing.md`).
 *
 * The client merges usage per key and takes a delta only when it is `> 0`;
 * otherwise the `message_start` seed stands. It then sums the three input
 * counters raw to get the conversation size. A cache key absent from the seed
 * is therefore `undefined` after the merge, and the sum is `NaN`.
 *
 * #444 seeded the five stream parsers, #1014 the two synthetic starts of
 * `anthropic-sse.ts`. Two builders were left: the overflow recovery turn
 * (`buildOverflowRecoveryStream`, #79 / #565 / the pre-stream policy refusal)
 * and the web-tools answer (`buildTextResponse`). This file pins both by
 * behaviour, then pins the CLASS by structure so a ninth builder cannot ship
 * a keyless seed unnoticed.
 *
 * Behaviour pins: the seed and the terminal delta are run through the
 * client's documented merge, and the resulting size must be a finite number.
 * Red by mutation: revert a site to its keyless literal and both its
 * behaviour pin and the corpus scan fail.
 *
 * Structural pin: every `type: "message_start"` property line in production
 * sources opens an object that carries both cache counters, through
 * `messageStartUsage(` or as explicit keys (the Codex lane keeps an explicit
 * literal on purpose, #186). Positive controls run the same detector over
 * synthetic sources first: if it can go blind, they fail before the corpus
 * scan can certify anything. A construction written in a shape the detector
 * cannot read is reported, never skipped.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildOverflowRecoveryStream } from "./handlers/shared/context-overflow.js";
import { buildTextResponse } from "./proxy-server.js";

type Usage = Record<string, number | undefined>;

/** Parsed `data:` payloads of an SSE body, in order. */
function sseEvents(body: string): Array<Record<string, any>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function seedAndDelta(body: string): { seed: Usage; delta: Usage } {
  const events = sseEvents(body);
  const start = events.find((e) => e.type === "message_start");
  const delta = events.find((e) => e.type === "message_delta");
  expect(start, "the turn opens with a message_start").toBeTruthy();
  expect(delta, "the turn carries a terminal message_delta").toBeTruthy();
  return { seed: start!.message.usage as Usage, delta: delta!.usage as Usage };
}

/**
 * The conversation size as the client computes it: per-key merge (a delta is
 * taken only when `> 0`, else the seed stands), then the raw three-way sum.
 */
function clientContextSize(seed: Usage, delta: Usage): number {
  const pick = (key: string): number => {
    const d = delta[key];
    return (d != null && d > 0 ? d : seed[key]) as number;
  };
  return (
    pick("input_tokens") + pick("cache_creation_input_tokens") + pick("cache_read_input_tokens")
  );
}

describe("#1019 synthetic message_start seeds, by behaviour", () => {
  test("overflow recovery turn: the client's size is exactly the real input count", async () => {
    const res = buildOverflowRecoveryStream("context is full", 405_000, "claude-sonnet-5");
    const { seed, delta } = seedAndDelta(await res.text());

    expect(seed.cache_read_input_tokens).toBe(0);
    expect(seed.cache_creation_input_tokens).toBe(0);
    // The gauge must advance by the real size, not by NaN.
    expect(clientContextSize(seed, delta)).toBe(405_000);
  });

  test("overflow builder called with 0 (pre-stream policy refusal): the size stays a positive number", async () => {
    const res = buildOverflowRecoveryStream("refused upstream", 0, "claude-sonnet-5");
    const { seed, delta } = seedAndDelta(await res.text());

    expect(seed.cache_read_input_tokens).toBe(0);
    expect(seed.cache_creation_input_tokens).toBe(0);
    // A delta of 0 is discarded by the merge: whatever the seed carries is
    // what the client records. Neither NaN nor a bare 0 (#179: a zero
    // input_tokens is a trap).
    const size = clientContextSize(seed, delta);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
  });

  test("web-tools answer: the size stays a positive number", async () => {
    const res = buildTextResponse("glm-5.3", "search results", true);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await res.text();
    const { seed, delta } = seedAndDelta(body);

    expect(seed.cache_read_input_tokens).toBe(0);
    expect(seed.cache_creation_input_tokens).toBe(0);
    const size = clientContextSize(seed, delta);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
    // Still a complete turn.
    expect(body).toContain("event: message_stop");
  });
});

// ---------------------------------------------------------------------------
// Structural pin
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dir);

/** `type: "message_start"` alone on its line: an object-literal property. */
const PROPERTY_LINE = /^\s*type:\s*"message_start",?\s*$/;
/** The same construction anywhere on a line of code. */
const ANY_CONSTRUCTION = /\btype:\s*"message_start"/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/** A code line without its trailing `// …` comment (a `//` glued to a
 * non-space character, as in a URL, is left alone). */
function code(line: string): string {
  if (COMMENT_LINE.test(line)) return "";
  return line.replace(/\s\/\/.*$/, "");
}

interface Finding {
  line: number;
  problem: "keyless-seed" | "unreadable-shape";
}

/**
 * For each `message_start` construction: the rest of the object it opens (up
 * to the brace that closes it) must carry both cache counters.
 */
function scanSource(content: string): { sites: number; findings: Finding[] } {
  const lines = content.split("\n");
  const findings: Finding[] = [];
  let sites = 0;
  lines.forEach((raw, idx) => {
    const line = code(raw);
    if (!ANY_CONSTRUCTION.test(line)) return;
    sites++;
    if (!PROPERTY_LINE.test(line)) {
      // Inline shape (`{ type: "message_start", message: … }` on one line):
      // the extent below would be read wrong. Reported, never skipped.
      findings.push({ line: idx + 1, problem: "unreadable-shape" });
      return;
    }
    let depth = 0;
    const extent: string[] = [];
    for (let j = idx + 1; j < lines.length && depth >= 0; j++) {
      const l = code(lines[j]);
      for (const ch of l) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth < 0) break;
      }
      extent.push(l);
    }
    const object = extent.join("\n");
    const seeded =
      object.includes("messageStartUsage(") ||
      (/\bcache_read_input_tokens\s*:/.test(object) &&
        /\bcache_creation_input_tokens\s*:/.test(object));
    if (!seeded) findings.push({ line: idx + 1, problem: "keyless-seed" });
  });
  return { sites, findings };
}

/** Production .ts files: everything under src except tests, the test-support
 * harness and checked-in fixtures (same corpus as prod-no-controller-error). */
function collectProdFiles(): string[] {
  const skipDirs = new Set(["test-support", "test-fixtures", "node_modules", "dist"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(entry)) walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      files.push(full);
    }
  };
  walk(SRC_ROOT);
  return files;
}

describe("#1019 synthetic message_start seeds, by structure", () => {
  test("positive controls: the detector flags a keyless seed and nothing else", () => {
    const keyless = [
      "send({",
      '  type: "message_start",',
      "  message: {",
      "    id,",
      "    // cache_read_input_tokens: and messageStartUsage( in a comment are not a seed",
      "    usage: { input_tokens: 0, output_tokens: 0 },",
      "  },",
      "});",
      "const later = messageStartUsage(1); // outside the object: not a seed either",
    ].join("\n");
    expect(scanSource(keyless)).toEqual({
      sites: 1,
      findings: [{ line: 2, problem: "keyless-seed" }],
    });

    const viaHelper = [
      "send({",
      '  type: "message_start",',
      "  message: {",
      "    usage: messageStartUsage(prior),",
      "  },",
      "});",
    ].join("\n");
    expect(scanSource(viaHelper)).toEqual({ sites: 1, findings: [] });

    const explicitKeys = [
      "send({",
      '  type: "message_start",',
      "  message: {",
      "    usage: {",
      "      input_tokens: 0,",
      "      output_tokens: 0,",
      "      cache_read_input_tokens: 0,",
      "      cache_creation_input_tokens: 0,",
      "    },",
      "  },",
      "});",
    ].join("\n");
    expect(scanSource(explicitKeys)).toEqual({ sites: 1, findings: [] });

    const oneKeyOnly = [
      "send({",
      '  type: "message_start",',
      "  message: {",
      "    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },",
      "  },",
      "});",
    ].join("\n");
    expect(scanSource(oneKeyOnly).findings).toEqual([{ line: 2, problem: "keyless-seed" }]);

    const inline = 'send({ type: "message_start", message: { usage: messageStartUsage() } });';
    expect(scanSource(inline)).toEqual({
      sites: 1,
      findings: [{ line: 1, problem: "unreadable-shape" }],
    });

    const mentionsOnly = [
      '// type: "message_start" in a comment is not a construction',
      ' * type: "message_start" in a doc block is not one either',
      'if (event.type === "message_start") sawStart = true;',
    ].join("\n");
    expect(scanSource(mentionsOnly)).toEqual({ sites: 0, findings: [] });
  });

  test("the scan covers the production corpus and every construction is seeded", () => {
    const files = collectProdFiles();
    // Guard against a silently-empty corpus (a path change making the walk
    // find nothing would otherwise certify a vacuous green).
    expect(files.length).toBeGreaterThan(100);

    let sites = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const result = scanSource(readFileSync(f, "utf-8"));
      sites += result.sites;
      for (const finding of result.findings) {
        offenders.push(`${relative(SRC_ROOT, f)}:${finding.line} (${finding.problem})`);
      }
    }
    // Eight builders exist at #1019 (five parsers with anthropic-sse counting
    // twice, the overflow turn, the web-tools answer). Finding fewer means
    // the detector lost sight of some: lower this floor only with the site
    // that was removed in hand.
    expect(sites).toBeGreaterThanOrEqual(8);
    expect(
      offenders.length === 0
        ? "every message_start construction seeds both cache counters"
        : `message_start built without both cache counters (seed via messageStartUsage()):\n  ${offenders.join("\n  ")}`
    ).toBe("every message_start construction seeds both cache counters");
  });
});
