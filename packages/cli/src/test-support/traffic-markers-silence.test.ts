import { afterEach, describe, expect, it } from "bun:test";
import { silenceTrafficMarkers } from "./traffic-markers-silence.js";

/**
 * Pin for the ONE definition of "pinned traffic marker prefixes".
 *
 * The end-to-end consumers are hermetic children whose stdout is a JSON
 * protocol stream (recovery-contract CP-10, the Muse probe, muse-reporting,
 * the advisor-panel Codex handler). Two of those children cannot run on a
 * Windows seat at all (they isolate $HOME, which Windows ignores), so this
 * unit test is the part of the contract every seat can exercise: the filter
 * drops exactly the pinned prefixes and passes every other byte through.
 */
describe("silenceTrafficMarkers — pinned prefixes only", () => {
  const realWrite = process.stdout.write;
  afterEach(() => {
    process.stdout.write = realWrite;
  });

  /** Install the filter with a recording sink beneath it. */
  function installWithSink(): string[] {
    const sink: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    silenceTrafficMarkers(); // wraps the sink: filtered prefixes never reach it
    return sink;
  }

  it("drops every pinned marker prefix", () => {
    const sink = installWithSink();
    process.stdout.write("[claudish] [Request] model=x\n");
    process.stdout.write("  [ttft] anthropic model=x\n");
    process.stdout.write("  [resp] reqN=1\n");
    process.stdout.write("  [system] text\n");
    process.stdout.write("  [msg:0] hello\n");
    process.stdout.write("  [msg:12] hello\n");
    expect(sink).toEqual([]);
  });

  it("passes the JSON protocol line and any foreign byte through", () => {
    const sink = installWithSink();
    process.stdout.write('{"status":200}\n');
    process.stdout.write("[Recovery] boom\n");
    process.stdout.write("[claudish] ordinary log line\n");
    expect(sink).toEqual([
      '{"status":200}\n',
      "[Recovery] boom\n",
      "[claudish] ordinary log line\n",
    ]);
  });
});
