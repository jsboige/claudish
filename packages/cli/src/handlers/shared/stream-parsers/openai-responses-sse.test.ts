/**
 * Instrumentation regression tests for the OpenAI Responses SSE parser.
 * The responses lane was operationally invisible (0 completion markers) — these
 * guard the [resp] / EOF-WITHOUT-COMPLETION / INCOMPLETE markers that make
 * gpt-5.6-sol completions measurable on the hub.
 */

import { describe, expect, test } from "bun:test";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function sseChunks(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

function mockContext() {
  const headers = new Headers();
  const json = () => null;
  const c: any = { header: (k: string, v: string) => headers.set(k, v), json, headers, req: {} };
  return c;
}

async function captureStdout(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as any;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" ") + "\n");
  };
  try {
    await run();
    // Give the pump's microtasks a tick to flush their writes.
    await Bun.sleep(50);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return lines;
}

async function runStream(events: Array<Record<string, unknown>>) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseChunks(events)));
      controller.close();
    },
  });
  const response = new Response(stream, { headers: new Headers(SSE_HEADERS) });
  const lines = await captureStdout(() => {
    const result = createResponsesStreamHandler(mockContext(), response, {
      modelName: "gpt-5.6-sol",
    }) as Response;
    // Drive the pump: the parser's ReadableStream start() only runs when the
    // returned body is consumed. Drain it fully (the client would too).
    return result.body?.pipeTo(new WritableStream({ write() { /* discard */ } }));
  });
  return { lines };
}

describe("openai-responses-sse instrumentation", () => {
  test("response.completed emits a [resp] responses marker with usage and events", async () => {
    const { lines } = await runStream([
      { type: "response.output_text.delta", delta: "ok" },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 5 } },
      },
    ]);
    const respLine = lines.find((l) => l.startsWith("  [resp] responses"));
    expect(respLine).toBeDefined();
    expect(respLine).toContain("model=gpt-5.6-sol");
    expect(respLine).toContain("closed=true stop=end_turn");
    expect(respLine).toContain("usage=12+5");
    // No premature-termination warning on a clean completed stream.
    expect(lines.some((l) => l.includes("EOF-WITHOUT-COMPLETION"))).toBe(false);
  });

  test("early EOF without completion logs EOF-WITHOUT-COMPLETION (previously silent)", async () => {
    const { lines } = await runStream([
      { type: "response.output_text.delta", delta: "partial" },
    ]);
    const warnLine = lines.find((l) => l.includes("EOF-WITHOUT-COMPLETION"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("model=gpt-5.6-sol");
    expect(warnLine).toContain("text=true");
  });

  test("response.incomplete logs INCOMPLETE with the reason", async () => {
    const { lines } = await runStream([
      { type: "response.incomplete", reason: "max_output_tokens" },
    ]);
    expect(lines.some((l) => l.includes("INCOMPLETE model=gpt-5.6-sol"))).toBe(true);
    expect(lines.some((l) => l.includes("reason=max_output_tokens"))).toBe(true);
  });

  test("an in-stream API error is logged with its code", async () => {
    const { lines } = await runStream([
      { type: "error", error: { code: "server_error", message: "boom" } },
    ]);
    expect(
      lines.some((l) => l.includes("API error model=gpt-5.6-sol") && l.includes("code=server_error"))
    ).toBe(true);
  });
});