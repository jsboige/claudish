/**
 * #641 B8 — the `fable` role keyword, pinned on the synced v14 head.
 *
 * The Fable rollout (fleet-state.md §Fable role, user mandate 13/11) wires every
 * claudish seat with a profile entry `fable = claude-fable-5-2` and, on armed
 * seats, `CLAUDISH_FAILOVER_FABLE = role:opus`. Both hang off ONE recognition:
 * `roleFromModelName()` must see the "fable" keyword in the client's model name.
 * A client speaking the role id (`claude-fable[1m]` in settings) or the resolved
 * version on the wire relies on that substring — nothing else routes it.
 *
 * Like failover-step-exclude.test.ts, this file is a fresh pin rather than a
 * port of main's failover.test.ts: that file does not exist on this base, and
 * the B8 proof only needs the keyword surface. Mutation proof (run before
 * landing): delete the `if (m.includes("fable")) return "fable";` line and this
 * suite goes red — the "red when the keyword is removed" half of the row.
 */

import { describe, expect, test } from "bun:test";
import { roleFromModelName } from "./failover";

describe("roleFromModelName — the fable keyword (#641 B8)", () => {
  test("maps the wire spellings of the Fable rollout to the fable role", () => {
    // What seats actually send, read off the rollout: the role id in client
    // settings, and the resolved versions served on the wire.
    expect(roleFromModelName("claude-fable-5-2")).toBe("fable");
    expect(roleFromModelName("claude-fable-5-1")).toBe("fable");
    expect(roleFromModelName("claude-fable[1m]")).toBe("fable");
    expect(roleFromModelName("Claude-Fable-5-2")).toBe("fable"); // matcher lowercases
  });

  test("a name without the keyword is never fable", () => {
    // Without CLAUDISH_FAILOVER_ROLE_MODELS aliases loaded, non-keyword names
    // fall through the ladder to null; with aliases configured they may map to
    // another role — either way, never fable.
    expect(roleFromModelName("glm-5.2")).not.toBe("fable");
    expect(roleFromModelName("mmc@MiniMax-M3.1-Flash")).not.toBe("fable");
    expect(roleFromModelName("claude-opus-5-5")).not.toBe("fable"); // opus wins first
    expect(roleFromModelName(undefined)).toBeNull();
    expect(roleFromModelName("")).toBeNull();
  });
});
