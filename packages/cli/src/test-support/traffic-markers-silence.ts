/**
 * Silence the traffic markers on a CHILD PROCESS's stdout.
 *
 * The capture pipeline (fork/middleware/request-logger.ts,
 * handlers/shared/response-capture.ts, the stream parsers' ttft lines) writes
 * its markers to stdout UNGATED — that is the channel `docker logs` exposes and
 * every traffic-*.ps1 reader consumes, so it must stay that way on a server
 * deployment.
 *
 * Several hermetic tests spawn a child whose stdout IS a protocol stream —
 * exactly one JSON line (recovery-contract/child-proxy-run.ts CP-10, the
 * isolated-HOME Muse probe, muse-reporting's responseScenario, the
 * advisor-panel Codex handler). Anything the proxy prints there breaks the
 * consumer: "Unexpected identifier \"ttft\"" out of JSON.parse, or a line-count
 * assertion of 1 that receives 5.
 *
 * Fixing it at the channel would fork the pinned consumer contract; fixing it
 * at each consumer would duplicate the prefix list. This is the ONE definition,
 * installed by the child itself before the proxy handles a request.
 *
 * The whitelist is deliberately narrow: any OTHER stdout byte — a stray
 * [Recovery] line, a banner, a future ungated marker — still reaches the
 * consumer, so a real leak still fails the test that owns the contract.
 */

const TRAFFIC_MARKER_RE =
  /^(\[claudish\] \[Request\] | {2}\[(ttft|resp)\] | {2}\[(system|msg:\d+)\] )/;

export function silenceTrafficMarkers(): void {
  type WriteChunk = Parameters<typeof process.stdout.write>[0];
  const rawStdoutWrite = process.stdout.write.bind(process.stdout) as (
    chunk: WriteChunk,
    ...rest: unknown[]
  ) => boolean;
  process.stdout.write = ((chunk: WriteChunk, ...rest: unknown[]): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return TRAFFIC_MARKER_RE.test(text) || rawStdoutWrite(chunk, ...rest);
  }) as typeof process.stdout.write;
}
