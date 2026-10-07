/**
 * Producer-side pinning of the `[ttft]` / `[resp]` stdout marker format —
 * claudish #72 grain 1 (the `[Request]` half is pinned in request-logger.test.ts
 * since #3391; this file completes the marker contract for the response side).
 *
 * The parsers that consume these lines live in ANOTHER repo (roo-state-manager
 * `claudish_traffic`, roo-extensions #3391) or in traffic-*.ps1 — so a format
 * drift here breaks consumers weeks later, silently. The pinning is therefore
 * at the PRODUCER: the exact template lives once in traffic-markers.ts, and
 * these tests hold builders and __fixtures__/traffic-format/ files to the same
 * shape. Editing either side goes red in THIS repo's test run.
 *
 * Fixtures mix WILD lines (relay .46 docker logs, timestamp-stripped — the
 * shapes actually observed in production) and PRODUCER-BUILT lines for shapes
 * that corpus held no sample of (`responses` label, headers=-1, `?` fallbacks,
 * client-cancel) — provenance is annotated in each fixture header.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { respMarkerLine, ttftMarkerLine } from "../../handlers/shared/traffic-markers.js";
import {
  __resetCaptureDirMemo,
  createResponseCapture,
} from "../../handlers/shared/response-capture.js";

// ── The contract, as a consumer would write it ──────────────────────────────
// Two leading spaces are PART of the format (both templates start with "  ").
// `headers` and `total` may be -1 ("not measured" — never a bogus sum with -1).
// `closed`/`stop` may be `?`. Field order is load-bearing for latency
// histograms and (pid, reqN) joins; units are suffixed on every numeric field.
const TTFT_RE =
  /^  \[ttft\] (\S+) model=(\S+) reqN=(\d+) headers=(-?\d+)ms firstEvent=(\d+)ms total=(-?\d+)ms$/;
const RESP_RE =
  /^  \[resp\] (\S+) model=(\S+) reqN=(\d+) events~=(\d+) bytes=(\d+) closed=(\S+) stop=(\S+) (\d+)ms -> (\S+)$/;

const FIXTURE_DIR = join(import.meta.dir, "../../../__fixtures__/traffic-format");

/** Fixture lines verbatim (leading spaces kept — they are contract), CRLF-safe. */
function fixtureLines(name: string): string[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return raw
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l && !l.startsWith("#"));
}

describe("ttftMarkerLine — the [ttft] producer", () => {
  test("exact shape, label is the parser, total = headers + firstEvent", () => {
    expect(ttftMarkerLine("anthropic", "glm-5.2", 0, 2881, 3)).toBe(
      "  [ttft] anthropic model=glm-5.2 reqN=0 headers=2881ms firstEvent=3ms total=2884ms\n"
    );
  });

  test("unmeasured header latency is -1 and forces total=-1 (never a bogus sum)", () => {
    expect(ttftMarkerLine("anthropic", "glm-5.2", 7, undefined, 903)).toBe(
      "  [ttft] anthropic model=glm-5.2 reqN=7 headers=-1ms firstEvent=903ms total=-1ms\n"
    );
    expect(ttftMarkerLine("openai", "m", 1, null, 5)).toContain("headers=-1ms");
    expect(ttftMarkerLine("openai", "m", 1, null, 5)).toContain("total=-1ms");
  });

  test("every fixture line matches the contract AND is builder-reproducible", () => {
    // Inputs per fixture line, in order (see provenance in the fixture header).
    const inputs: Array<[string, string, number, number | undefined, number]> = [
      ["anthropic", "glm-5.2", 0, 2881, 3],
      ["openai", "glm-5.2", 1, 4335, 3],
      ["responses", "gpt-5.6-sol", 42, 1204, 87],
      ["anthropic", "glm-5.2", 7, undefined, 903],
    ];
    const lines = fixtureLines("ttft-lines.txt");
    expect(lines.length).toBe(inputs.length);
    lines.forEach((line, i) => {
      expect(TTFT_RE.test(line), `fixture line must match contract: "${line}"`).toBe(true);
      const [label, model, reqN, hdr, fe] = inputs[i];
      expect(ttftMarkerLine(label, model, reqN, hdr, fe)).toBe(line + "\n");
    });
  });
});

describe("respMarkerLine — the [resp] producer", () => {
  test("exact shape with real fields", () => {
    expect(
      respMarkerLine("openai", "glm-5.2", 1, 7, 1019, true, "tool_use", 11, "/captures/resp-1-r0001-x.sse")
    ).toBe(
      "  [resp] openai model=glm-5.2 reqN=1 events~=7 bytes=1019 closed=true stop=tool_use 11ms -> /captures/resp-1-r0001-x.sse\n"
    );
  });

  test("the `?` fallbacks are the caller's meaning, interpolated verbatim", () => {
    const line = respMarkerLine("openai", "glm-5.3", 0, 0, 0, "?", "?", 5, "/captures/x.sse");
    expect(line).toContain("closed=? stop=? ");
    expect(RESP_RE.test(line.trimEnd())).toBe(true);
  });

  test("every fixture line matches the contract; built shapes are builder-reproducible", () => {
    const lines = fixtureLines("resp-lines.txt");
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(RESP_RE.test(line), `fixture line must match contract: "${line}"`).toBe(true);
    }
    // Producer-built fixture lines (3rd and 4th) round-trip exactly.
    expect(
      respMarkerLine("openai", "glm-5.3", 0, 0, 0, "?", "?", 5,
        "/captures/resp-1-r0000-2026-10-07T00-00-00-000Z-openai-glm-5.3.sse")
    ).toBe(lines[2] + "\n");
    expect(
      respMarkerLine("anthropic", "kimi-k2.5", 9, 12, 4096, false, "client-cancel", 501,
        "/captures/resp-1-r0009-2026-10-07T00-00-00-000Z-anthropic-kimi-k2.5.sse")
    ).toBe(lines[3] + "\n");
  });
});

describe("createResponseCapture.done() emits through the pinned builder", () => {
  test("end-to-end: tap → done → marker matches RESP_RE with counted events/bytes", () => {
    // createResponseCapture is a NOOP without CLAUDISH_CAPTURE_DIR — point it at
    // a tmp dir so the real (fire-and-forget) capture path runs.
    const prevDir = process.env.CLAUDISH_CAPTURE_DIR;
    const tmp = join(tmpdir(), `claudish-ttft-contract-${process.pid}-${Date.now()}`);
    process.env.CLAUDISH_CAPTURE_DIR = tmp;
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const cap = createResponseCapture("openai", "glm-5.2", true, 3);
      // events~ counts "\ndata:" occurrences — a data: line at the very start of
      // a tap (no preceding \n in the same chunk) is not counted, hence the
      // leading newline here. Pinned as-is: events~ is explicitly approximate.
      cap.tap("\ndata: {}\n\ndata: {}\n\n");
      cap.done({ stop_reason: "end_turn", closed: true });
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
      if (prevDir === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
      else process.env.CLAUDISH_CAPTURE_DIR = prevDir;
      __resetCaptureDirMemo();
      setTimeout(() => {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {}
      }, 50).unref?.();
    }
    const marker = written.find((l) => l.includes("[resp] openai"));
    expect(marker).toBeDefined();
    const m = RESP_RE.exec(marker!.trimEnd());
    expect(m).not.toBeNull();
    expect(m![1]).toBe("openai");
    expect(m![3]).toBe("3"); // reqN passed explicitly, not the global
    expect(m![4]).toBe("2"); // events~ counted from \ndata: occurrences
    expect(m![5]).toBe("21"); // bytes = tapped length
    expect(m![6]).toBe("true");
    expect(m![7]).toBe("end_turn");
    // file = <captureDir>/resp-<pid>-r<reqN zero-padded 4>-<ts, :/. → ->-<label>-<model>.sse
    expect(m![9]).toMatch(/resp-\d+-r0003-.*-openai-glm-5\.2\.sse$/);
  });
});

describe("emission sites use the shared builders (anti-re-inlining guard)", () => {
  // The [ttft] template used to exist as three independent inline copies — one
  // per stream parser, each free to drift alone. The builders single-source it;
  // this guard fails if a site re-inlines a template instead of calling the
  // builder, which is the one drift the exact-string pins above cannot see.
  test("the three stream parsers call ttftMarkerLine; response-capture calls respMarkerLine", () => {
    const src = (rel: string) =>
      readFileSync(join(import.meta.dir, rel), "utf8");
    for (const rel of [
      "../../handlers/shared/stream-parsers/openai-sse.ts",
      "../../handlers/shared/stream-parsers/anthropic-sse.ts",
      "../../handlers/shared/stream-parsers/openai-responses-sse.ts",
    ]) {
      expect(src(rel), `${rel} must call ttftMarkerLine`).toContain("ttftMarkerLine(");
    }
    expect(
      src("../../handlers/shared/response-capture.ts"),
      "response-capture.ts must call respMarkerLine"
    ).toContain("respMarkerLine(");
  });
});
