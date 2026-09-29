/**
 * #220: the OpenAI-lane `[resp]` marker must carry the stop_reason the client
 * actually received, instead of a structural `stop=?`.
 *
 * The `[resp]` line is the only per-response countable marker in `docker logs`.
 * Before this, `createResponseCapture` rendered `extra?.stop_reason ?? "?"` and
 * the openai-sse parser never passed one, so every OpenAI-lane response logged
 * `stop=?` (measured on one sidecar: 17 of 17) and a completed turn could not be
 * told apart from a truncated or refused one without opening each capture.
 *
 * Each test drives the real parser, reads the client stream AND the stdout
 * marker, and asserts they agree. `?` keeps its meaning, "the stream ended
 * without one", and is pinned at the capture unit below.
 *
 * A client cancel used to leave no marker at all (the finalize path skips its
 * capture once isClosed is set), which reads like a parser that never reached
 * close. It now closes out as `closed=false stop=client-cancel`, like the
 * Codex and anthropic lanes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamingResponseHandler } from "./openai-sse.js";
import { __resetCaptureDirMemo, createResponseCapture } from "../response-capture.js";

const CAPTURE_DIR = join(tmpdir(), `claudish-resp-marker-${process.pid}`);

function frame(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const READ_SCHEMA = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

function sseResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function handler(upstream: Response, toolSchemas?: any[]): Response {
  return createStreamingResponseHandler(
    { req: {}, body: (s: ReadableStream, init?: any) => new Response(s, init) } as any,
    upstream,
    { processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }) } as any,
    "glm-5.2",
    undefined,
    undefined,
    toolSchemas
  ) as Response;
}

/** Run `fn` with stdout intercepted; returns every line written meanwhile. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: any) => boolean }).write = (chunk: any) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
  }
  return written.join("").split("\n");
}

async function drain(response: Response): Promise<string> {
  let out = "";
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        out += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  return out;
}

/** The stop_reason of the terminal message_delta the client received. */
function clientStopReason(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const d = JSON.parse(line.slice(6));
      if (d.type === "message_delta") found = d.delta?.stop_reason;
    } catch {}
  }
  return found;
}

function respMarker(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("[resp] openai"));
}

async function runLane(raw: string, toolSchemas?: any[]) {
  let output = "";
  const lines = await captureStdout(async () => {
    output = await drain(handler(sseResponse(raw), toolSchemas));
  });
  return { output, marker: respMarker(lines) };
}

beforeEach(() => {
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  __resetCaptureDirMemo();
  process.env.CLAUDISH_CAPTURE_DIR = CAPTURE_DIR;
});

afterEach(async () => {
  delete process.env.CLAUDISH_CAPTURE_DIR;
  // The capture write is fire-and-forget: let it land before removing the dir.
  await new Promise((r) => setTimeout(r, 25));
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  __resetCaptureDirMemo();
});

describe("#220 — the OpenAI-lane [resp] marker reports the stop_reason the client received", () => {
  test("end_turn", async () => {
    const { output, marker } = await runLane(
      frame({ content: "hello" }) + frame({}, "stop") + "data: [DONE]\n\n"
    );
    expect(clientStopReason(output)).toBe("end_turn");
    expect(marker).toBeDefined();
    expect(marker).toContain("closed=true stop=end_turn ");
  });

  test("tool_use", async () => {
    const { output, marker } = await runLane(
      frame({
        tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{"file_path":"/x"}' } }],
      }) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n",
      READ_SCHEMA
    );
    expect(clientStopReason(output)).toBe("tool_use");
    expect(marker).toContain("closed=true stop=tool_use ");
  });

  test("max_tokens: the marker follows the mapped value, not the upstream finish_reason", async () => {
    const { output, marker } = await runLane(
      frame({ content: "cut off mid-" }) + frame({}, "length") + "data: [DONE]\n\n"
    );
    expect(clientStopReason(output)).toBe("max_tokens");
    expect(marker).toContain("closed=true stop=max_tokens ");
  });

  test("a surfaced policy refusal logs the end_turn the client received", async () => {
    const flag = `data: ${JSON.stringify({
      error: {
        code: "invalid_prompt",
        message: "Invalid prompt: flagged as potentially violating our usage policy.",
      },
    })}\n\n`;
    // Visible content first: never retried, surfaced at once (#65).
    const { output, marker } = await runLane(frame({ content: "partial" }) + flag);
    expect(output).toContain("[Upstream policy refusal");
    expect(clientStopReason(output)).toBe("end_turn");
    expect(marker).toContain("closed=true stop=end_turn ");
  });

  test("a client cancel still closes out the capture: closed=false stop=client-cancel", async () => {
    // An upstream that never ends, so the only way out is the client leaving.
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame({ content: "still going" })));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
    const lines = await captureStdout(async () => {
      const reader = handler(upstream).body!.getReader();
      await reader.read();
      await reader.cancel("client went away");
    });
    const marker = respMarker(lines);
    expect(marker).toBeDefined();
    expect(marker).toContain("closed=false stop=client-cancel ");
  });
});

describe("#220 — `?` keeps its meaning: no stop_reason was passed", () => {
  test("done() without a stop_reason logs stop=?", () => {
    const lines = [] as string[];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: any) => boolean }).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      const cap = createResponseCapture("openai", "glm-5.2");
      cap.tap("data: x\n\n");
      cap.done({ closed: true });
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    }
    const marker = lines.find((l) => l.includes("[resp] openai"));
    expect(marker).toContain("closed=true stop=? ");
  });
});
