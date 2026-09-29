/**
 * Did the CLIENT ask for thinking? (#237 review, 2026-09-23)
 *
 * Claude Code sends `{"type":"enabled","budget_tokens":N}`, `{"type":"adaptive"}`
 * (the dominant shape on the Opus/Sonnet lanes), `{"type":"disabled"}`, or no
 * field at all. Anything present and not `disabled` is a request for
 * reasoning — MiniMax honors `adaptive` (live probe through the hub,
 * 2026-09-23: `[thinking, text]`). An `=== "enabled"` test reads an adaptive
 * client as one that never asked: the stream filter then strips the blocks it
 * requested, and a forced policy overwrites its choice.
 *
 * An unknown future type counts as a request too: wrongly keeping blocks a
 * client can ignore is cheaper than silently dropping blocks it asked for.
 */
export function clientRequestedThinking(thinking: unknown): boolean {
  const type = (thinking as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && type !== "" && type !== "disabled";
}
