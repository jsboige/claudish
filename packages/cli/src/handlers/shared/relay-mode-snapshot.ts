/**
 * Module-level mailbox: what the relay state machine knows, made readable by
 * the capture layer (#877).
 *
 * Why a mailbox and not a direct import: the relay state lives in
 * `fork/server/relay.ts` (owned by standalone-proxy), while
 * `appendConnectionError` is called from deep inside `ComposedHandler` — the
 * shared handler layer must not import the fork server (that is the layering
 * the three-layer architecture pins), and the reverse import would be circular
 * since relay.ts already imports handlers/shared modules. This module imports
 * NOTHING, so both sides can depend on it freely.
 *
 * Semantics:
 *   - `null` → no relay is configured in this process (a hub, or a plain local
 *     proxy): the connection-error line carries NO relay fields at all.
 *   - `{mode: "nominal"}`  → the seat was relaying to the hub when the failure
 *     was captured; `downTrigger` is empty.
 *   - `{mode: "autonomous", downTrigger}` → the seat was serving locally
 *     because the relay had flipped; `downTrigger` is the flip's reason
 *     vocabulary (`heartbeat` / `forward-connect` / `forward-http-<status>`),
 *     detail suffix stripped so the field stays a stable join key.
 *
 * Written by relay.ts at exactly three sites (state creation, the
 * NOMINAL→AUTONOMOUS flip in markFail, the recovery flip after a deep probe) —
 * no new probe, no new env name; the state is already in-process (#877 AC 1).
 */

export interface RelayModeSnapshot {
  mode: "autonomous" | "nominal";
  downTrigger: string;
}

let snapshot: RelayModeSnapshot | null = null;

export function setRelayModeSnapshot(next: RelayModeSnapshot | null): void {
  snapshot = next;
}

export function getRelayModeSnapshot(): RelayModeSnapshot | null {
  return snapshot;
}
