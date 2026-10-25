/**
 * The die-side `activeStreams` count, logged from inside the SIGTERM path
 * (#255, split from #244's measurement gap).
 *
 * `server.shutdown()` is `http.Server.close()`: the listening socket drops
 * immediately, so `/health` stops answering for the whole grace window while
 * in-flight responses finish — `activeStreams` at the die is invisible from
 * outside, and the only die-side signal was a no-stop capture written at the
 * die instant (an inference, not a count).
 *
 * stderr, not stdout: Node writes stderr synchronously, so the line survives
 * the `process.exit()` that immediately follows even when stdout is a pipe
 * with an unflushed buffer — the docker logs of a dying container are exactly
 * that. The marker is greppable like the other countable ones (`[ttft]`,
 * `[Relay]`, `[ConnectRetry]`).
 */
export function emitShutdownDieLine(die: "graceful" | "forced", activeStreams: number): void {
  process.stderr.write(`[Shutdown] die=${die} activeStreams=${activeStreams}\n`);
}
