/**
 * #660 r1 — the boot SEQUENCE, pinned through the real createProxyServer.
 *
 * The unit suite (context-limit-derivation.test.ts, #660 r2) proves the purge
 * loop given derived outcomes and the displayName keying. Only this file
 * proves the ORDER the boot path runs in: restore FIRST, then derive, then
 * purge. The init call was the missing piece on v14 — `initOverflowCapsPersistence`
 * had no production caller, so the boot purge always ran on an empty store:
 * nothing was ever restored, and `purgeCapsReplacedByDerivation`'s 0 was
 * read as "nothing to purge" when it actually meant "nothing was loaded".
 *
 * Two endpoints, one boot, both with a cap pre-seeded in the caps file:
 *
 *   ep-derive (deriveContextLimit: true) — its cap must be GONE after boot:
 *     restored into memory, then dropped by the purge when the derivation
 *     measures a window that replaces it. On DISK too (the rewrite only
 *     happens when the restore armed persistence).
 *   ep-plain (no opt-in) — its cap must SURVIVE the boot untouched: the
 *     derivation never issues a probe for it (INERT), so no outcome, no purge.
 *
 * Red without the init call in proxy-server.ts: nothing is restored, so the
 * survivor assert fails (undefined ≠ 99999). Red if the restore ever lands
 * AFTER the purge: both caps resurface, so the gone assert fails. The green is
 * the order, not just the call.
 *
 * Harness: the K30 pattern (proxy-server-context-admission-route.test.ts) —
 * the real proxy on an ephemeral port via a temp config file
 * (setConfigFileOverride, so a crashed run cannot touch a machine's real
 * config), only the outbound probe answered by a stubbed fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "./config-override.js";
import { resetFailoverForTests } from "./fork/failover.js";
import { getOverflowCap, resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import { customEndpointCapKey } from "./providers/custom-endpoints-loader.js";
import { clearRuntimeRegistry } from "./providers/runtime-providers.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const realFetch = globalThis.fetch.bind(globalThis);

// Same hermeticism set as the K30 harness: boot with quiet:true still reads
// provider envs, and a real machine's keys must not shape what registers.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODING_API_KEY",
  "LITELLM_API_KEY",
  "POE_API_KEY",
  "DEEPSEEK_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDISH_NO_ANTHROPIC",
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_CONTEXT_ADMISSION",
  // The one this file moves itself (below): CLAUDISH_OVERFLOW_CAPS_PATH.
];
const savedEnv: Record<string, string | undefined> = {};

let tempDir: string;
let capsPath: string;
let configPath: string;
let activeProxy: ProxyServer | null = null;

// The two endpoints of the pin. ep-derive opts in (its probe succeeds with a
// 262144 window that replaces the stale seeded cap); ep-plain never probes.
const epDerive = {
  kind: "simple",
  url: "http://fake.invalid/drv/v1",
  format: "openai",
  apiKey: "k",
  contextLimit: 200000, // stale config value — the measurement must win
  deriveContextLimit: true,
};
const epPlain = {
  kind: "simple",
  url: "http://fake.invalid/plain/v1",
  format: "openai",
  apiKey: "k",
};
// capKeys computed the way boot computes them — never hand-typed, the #660 r2
// lesson (the config key and the transport displayName differ for lowercase
// names, and a hand-typed "ep-derive" would seed a cap nobody ever reads).
const capKeyDerive = customEndpointCapKey("ep-derive", epDerive as never);
const capKeyPlain = customEndpointCapKey("ep-plain", epPlain as never);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-caps-boot-"));
  capsPath = join(tempDir, "overflow-caps.json");
  configPath = join(tempDir, "config.json");

  // The persisted store, under the keys a real handler records.
  const now = new Date().toISOString();
  writeFileSync(
    capsPath,
    JSON.stringify(
      {
        version: 1,
        caps: {
          [`${capKeyDerive}::swift-1.5-27b`]: {
            cap: 120000,
            at: now,
            evidence: "seeded for the boot pin",
          },
          [`${capKeyPlain}::some-model`]: {
            cap: 99999,
            at: now,
            evidence: "seeded for the boot pin",
          },
        },
      },
      null,
      2
    )
  );

  // The config the boot reads (loadConfig honours setConfigFileOverride and
  // carries customEndpoints through its merge allowlist).
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: { "ep-derive": epDerive, "ep-plain": epPlain },
    })
  );
  setConfigFileOverride(configPath);

  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedEnv.CLAUDISH_OVERFLOW_CAPS_PATH = process.env.CLAUDISH_OVERFLOW_CAPS_PATH;
  process.env.CLAUDISH_OVERFLOW_CAPS_PATH = capsPath;

  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? "");
    if (url === "http://fake.invalid/drv/v1/models") {
      // The derivation probe for the ONE opted-in endpoint.
      return new Response(
        JSON.stringify({ data: [{ id: "swift-1.5-27b", max_model_len: 262144 }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Background warmers and anything unexpected: inert 200, never a hang.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  for (const k of [...SANDBOX_ENV_KEYS, "CLAUDISH_OVERFLOW_CAPS_PATH"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetOverflowCapsForTests();
  resetFailoverForTests();
  clearRuntimeRegistry();
  setConfigFileOverride(null);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("#660 r1 — learned caps boot order through createProxyServer", () => {
  test("a restored cap for a DERIVED endpoint is purged; a non-derived one survives, in memory and on disk", async () => {
    activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
    });

    // The survivor: restored AND untouched — ep-plain never opts in, so no
    // probe, no outcome, no purge. Fails outright without the init call.
    expect(getOverflowCap(capKeyPlain, "some-model")).toBe(99999);

    // The purge: ep-derive's stale cap did not outlive the measurement that
    // replaced it. Fails if the restore ever lands AFTER the purge.
    expect(getOverflowCap(capKeyDerive, "swift-1.5-27b")).toBeUndefined();

    // Disk too: the purge rewrites the file ONLY when the restore armed
    // persistence — without the init call the file still holds BOTH keys.
    const onDisk = JSON.parse(readFileSync(capsPath, "utf-8")) as {
      caps: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.caps)).toEqual([`${capKeyPlain}::some-model`]);
  });
});
