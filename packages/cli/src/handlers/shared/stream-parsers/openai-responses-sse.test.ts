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
  const { lines, output } = await runStreamCollect(events);
  return { lines, output };
}

async function runStreamCollect(events: Array<Record<string, unknown>>) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseChunks(events)));
      controller.close();
    },
  });
  const response = new Response(stream, { headers: new Headers(SSE_HEADERS) });
  let output = "";
  const lines = await captureStdout(() => {
    const result = createResponsesStreamHandler(mockContext(), response, {
      modelName: "gpt-5.6-sol",
    }) as Response;
    // Drive the pump: the parser's ReadableStream start() only runs when the
    // returned body is consumed. Drain it fully (the client would too).
    return result.body?.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk, { stream: true });
        },
      })
    );
  });
  return { lines, output };
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

  test("parallel tool calls after text get sequential block indices (no gap, no duplicate stop)", async () => {
    // Regression 2026-08-27: the old index arithmetic (blockIndex +
    // functionCalls.size + (hasTextContent?1:0)) emitted 0,1,3 for text+2
    // parallel tools — skipping index 2 — and stopped the text block twice.
    // This is the dominant turn shape of the gpt-5.6-sol agentic lane.
    const { output } = await runStreamCollect([
      { type: "response.output_text.delta", delta: "Checking both." },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "fc_1", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_1", delta: '{"p":"a"}' },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_2", call_id: "fc_2", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", call_id: "fc_2", delta: '{"p":"b"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", id: "fc_1" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_2", id: "fc_2" } },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
    ]);
    const starts = [...output.matchAll(/event: content_block_start\ndata: ([^\n]*)/g)].map((m) => {
      const d = JSON.parse(m[1]);
      return `${d.index}:${d.content_block.type}`;
    });
    expect(starts).toEqual(["0:text", "1:tool_use", "2:tool_use"]);
    const stops = [...output.matchAll(/event: content_block_stop\ndata: ([^\n]*)/g)].map((m) => JSON.parse(m[1]).index);
    expect(stops).toEqual([0, 1, 2]); // exactly one stop per block, in order
  });
});