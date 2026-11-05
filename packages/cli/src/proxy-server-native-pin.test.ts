/**
 * Row 3 (#218, Epic #641) — the native-lane version pin, unit pins.
 *
 * The native lane historically ignored the version half of a role mapping:
 * NativeHandler forwards payload.model verbatim, so `opus: "claude-opus-4-8"`
 * classified the lane and pinned nothing (measured on main 2026-09-22: 6 487
 * native responses served as claude-opus-5 over 48 h while the map read
 * claude-opus-4-8).
 *
 * v14 adaptations vs main's `proxy-server-role-map.test.ts`: this base's
 * `modelMap` has no `fable` slot (its role set is opus/sonnet/haiku/subagent),
 * so the fable cases of main's pin block do not exist here — the resolver
 * simply never matches a fable keyword. The subagent slot is not a request
 * keyword either and is deliberately not consulted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { setNativePinOverridesForTests } from "./providers/native-pin-auto.js";
import { resolveNativeModelPin } from "./proxy-server.js";

const modelMap = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

afterEach(() => {
  setNativePinOverridesForTests(null);
});

describe("resolveNativeModelPin", () => {
  const pinMap = { ...modelMap, opus: "claude-opus-5-5" };

  test("pins a native role request to the configured Anthropic version", () => {
    expect(resolveNativeModelPin("claude-opus-5", pinMap)).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("claude-opus-4-8", pinMap)).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("CLAUDE-OPUS-5", pinMap)).toBe("claude-opus-5-5");
  });

  test("never rewrites a no-op", () => {
    expect(resolveNativeModelPin("claude-opus-5-5", pinMap)).toBeUndefined();
  });

  test("leaves the budget lane alone — a provider target never reaches NativeHandler", () => {
    // sonnet/haiku map to vendor@model: pinning those into the body would put a
    // provider spec on the Anthropic wire.
    expect(resolveNativeModelPin("claude-sonnet-5", { sonnet: "glm-5.3" })).toBeUndefined();
    expect(resolveNativeModelPin("claude-haiku-4-5", { haiku: "MiniMax-M3" })).toBeUndefined();
    // A claude-* target that equals the requested id is a no-op too.
    expect(resolveNativeModelPin("claude-sonnet-5", pinMap)).toBeUndefined();
  });

  // Bare and native are not the same predicate. `glm-5.3` is bare, and is kept
  // off the native lane today only by resolving to a remote handler — if it
  // ever stopped resolving, `isNative` would call it native and a bare-only
  // guard would put it on the Anthropic wire, which is strictly worse than the
  // passthrough it replaced.
  test("only pins Anthropic ids — a bare budget target is never a native pin", () => {
    expect(resolveNativeModelPin("claude-opus-5", { opus: "glm-5.3" })).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { opus: "MiniMax-M3" })).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { opus: "gpt-6-astra" })).toBeUndefined();
  });

  test("leaves an explicitly provider-routed request alone despite the role keyword", () => {
    expect(resolveNativeModelPin("zai@claude-opus-5", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("anthropic/claude-opus-5", pinMap)).toBeUndefined();
  });

  test("no mapping, no pin", () => {
    expect(resolveNativeModelPin("claude-opus-5", undefined)).toBeUndefined();
    expect(resolveNativeModelPin("gpt-6-astra", pinMap)).toBeUndefined();
    expect(resolveNativeModelPin("claude-opus-5", { ...pinMap, opus: undefined })).toBeUndefined();
  });

  test("a fable request is never pinned on this base — no fable slot exists", () => {
    // Main pins it (its modelMap carries `fable`); v14's does not, and a
    // subagent-only entry must not accidentally become one.
    expect(resolveNativeModelPin("claude-fable-5-1", pinMap)).toBeUndefined();
    expect(
      resolveNativeModelPin("claude-fable-5-1", {
        ...pinMap,
        subagent: "claude-fable-5-1",
      } as typeof pinMap)
    ).toBeUndefined();
  });

  test("kill switch restores the pre-pin passthrough", () => {
    expect(
      resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "0" })
    ).toBeUndefined();
    // Only an explicit "0" disarms: unset and any other value keep the pin
    // armed, so a stray empty string cannot silently un-pin the fleet.
    expect(resolveNativeModelPin("claude-opus-5", pinMap, {})).toBe("claude-opus-5-5");
    expect(resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "1" })).toBe(
      "claude-opus-5-5"
    );
    expect(resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "" })).toBe(
      "claude-opus-5-5"
    );
    // The switch is checked BEFORE the #219 override is applied, so an adopted
    // override cannot outlive it: "0" always restores the client's own id.
    setNativePinOverridesForTests({ opus: "claude-opus-6-0" });
    expect(
      resolveNativeModelPin("claude-opus-5", pinMap, { CLAUDISH_NATIVE_MODEL_PIN: "0" })
    ).toBeUndefined();
  });

  test("#219 override applies on top of the resolved pin, family-scoped", () => {
    setNativePinOverridesForTests({ opus: "claude-opus-6-0" });
    expect(resolveNativeModelPin("claude-opus-5", pinMap)).toBe("claude-opus-6-0");
    // An opus override never re-points a sonnet pin.
    expect(
      resolveNativeModelPin("claude-sonnet-5", { ...pinMap, sonnet: "claude-sonnet-5-1" })
    ).toBe("claude-sonnet-5-1");
  });
});
