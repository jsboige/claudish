/**
 * Per-process identity (#156).
 *
 * The relay heartbeat needs to recognise ITS OWN /health coming back at it —
 * the 2026-09-19 shape: a hub recreated as a relay forwarding to itself through
 * a public URL (ARR loops back) is invisible to every string comparison, because
 * nothing in "https://models.myia.io" resembles anything the process knows about
 * itself. A random nonce published on /health fixes that: if the upstream's id
 * equals ours, the upstream IS this process, whatever the URL says.
 *
 * Random, derived from nothing (never from a secret or a hostname), stable for
 * the process lifetime, different on every start — including two instances on
 * the same machine.
 */
import { randomUUID } from "node:crypto";

const INSTANCE_ID = randomUUID();

export function getInstanceId(): string {
  return INSTANCE_ID;
}
