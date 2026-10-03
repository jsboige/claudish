/**
 * #306 — opt-in admission freeze for the final pre-restart window.
 *
 * The drain is passive: while it waits for a lull, the proxy keeps accepting
 * NEW requests, so the "N in flight" a restart finally cuts is a lower bound
 * (a stream started in the decision→action gap — measured 18 ms — is
 * uncounted; claudish-drain.ps1 header, "READING drain.log"). With the
 * operator's consent, the drain flips a file flag just before its gesture and
 * the proxy answers NEW admissions with 503 + Retry-After instead — Claude
 * Code retries cleanly, no turn lost. In-flight streams are never touched:
 * the freeze gates admissions only, never a stream already serving.
 *
 * Consent + flag, both plain files in ~/.claudish (bind-mounted into the
 * container as /root/.claudish, the same channel the drain's host side and
 * the proxy already share):
 *
 *   drain-freeze.enabled — CONSENT, must exist AND carry the literal token
 *                          "enabled" (Test-ClaudishOptIn semantics: an empty
 *                          file from a stray New-Item must not arm anything).
 *                          Absent (the default on every machine) ⇒ the flag
 *                          below is inert: zero behavior change without
 *                          opt-in, same bar as wedge-watch / relaunch-preflight.
 *   drain-freeze         — FLAG, written by the drain right before its
 *                          restart gesture, removed right after. Content is
 *                          a human-readable timestamp; the proxy reads the
 *                          mtime, not the bytes.
 *
 * Safety expiry: a drain killed mid-gesture would leave the flag behind and
 * freeze admissions forever. The proxy ignores any flag older than
 * DRAIN_FREEZE_MAX_AGE_MS — the flag is posed AFTER the drain's wait, so the
 * bound only needs to cover the gesture itself (docker stop 120 s + compose
 * ~124 s ≈ 244 s worst case); 900 s keeps ~3.7× margin over that while
 * staying far below any plausible legitimate restart interval (review 03/10:
 * the earlier "MaxWaitSec + gesture" arithmetic double-counted the wait,
 * which has already happened by the time the flag exists). The drain also
 * clears the flag in a finally block — but only logs a freeze window the
 * PROXY confirmed via /health (drain home and container mount can differ);
 * the expiry is the belt to all of that.
 *
 * Deliberately a leaf module with NO env var: every CLAUDE/CLAUDISH_* name
 * the code reads must also reach the containers (compose coverage, #310/#311)
 * — a constant serves the safety bound here without adding a name to that
 * ledger. Reads are stat+read per call: admission is not a hot loop, and a
 * cached flag would keep refusing after the drain cleared it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONSENT_FILE = "drain-freeze.enabled";
const FLAG_FILE = "drain-freeze";
const CONSENT_TOKEN = "enabled";

/** See module doc — hard safety bound, deliberately not configurable. */
export const DRAIN_FREEZE_MAX_AGE_MS = 900_000;

export interface AdmissionFreezeState {
  frozen: boolean;
  /** Why — for the log marker, never a secret (no flag content is read). */
  reason: "flag" | "no-consent" | "no-flag" | "expired";
}

function claudishHome(): string {
  return join(homedir(), ".claudish");
}

function consentPresent(home: string): boolean {
  const path = join(home, CONSENT_FILE);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.trim() === CONSENT_TOKEN;
  } catch {
    return false;
  }
}

export function admissionFreezeState(): AdmissionFreezeState {
  const home = claudishHome();
  if (!consentPresent(home)) return { frozen: false, reason: "no-consent" };
  const flagPath = join(home, FLAG_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(flagPath).mtimeMs;
  } catch {
    return { frozen: false, reason: "no-flag" };
  }
  if (Date.now() - mtimeMs > DRAIN_FREEZE_MAX_AGE_MS) {
    return { frozen: false, reason: "expired" };
  }
  return { frozen: true, reason: "flag" };
}

export function admissionFreezeActive(): boolean {
  return admissionFreezeState().frozen;
}
