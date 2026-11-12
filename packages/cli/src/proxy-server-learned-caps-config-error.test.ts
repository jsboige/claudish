/**
 * The #991 follow-up — the learned-caps restore must survive a CONFIG-READ
 * FAILURE, pinned through the real createProxyServer boot.
 *
 * The boot pin (proxy-server-learned-caps-boot.test.ts) proves the order
 * restore → derive → purge on a GOOD config. This file proves the other half
 * of the hoist: `initOverflowCapsPersistence` runs BEFORE (outside) the
 * endpoints try, so a config read that throws degrades the endpoints (builtin
 * set only) without also dropping the user's learned caps for the process
 * lifetime. Red against the pre-hoist code, where the restore sat INSIDE the
 * try, below `loadConfig()`: the throw skipped it and the seeded cap never
 * loaded.
 *
 * WHY A MOCK AT ALL — on the real code path the endpoints try's only live
 * thrower is `loadConfig`'s `ensureConfigDir()` (`mkdirSync` on the machine's
 * `~/.claudish`), which no hermetic test can reach: every parse/read failure
 * inside `loadConfig` is swallowed to defaults, `ensureEndpointsRegistered`
 * is documented never-throwing, and the derivation try catches its own. A
 * config override only REMOVES the thrower (`ensureConfigDir` is skipped).
 * So the failure is injected at the loader seam, with the catalog-warm
 * mock.module recipe: real exports captured first, one export overridden,
 * restored in afterAll (the mock is process-global).
 *
 * WHY SELF-RESPAWN — `mock.module` cannot rebind `proxy-server.js` for a
 * process that already imported it through an earlier test file: in the full
 * `rest` slice this file is the 71st of ~529, after 14 `proxy-server-*`
 * siblings that pre-bind the real loader, and the mock would silently not
 * bite. So the parent (no child key) does exactly one thing: spawn
 * `bun test <this file>` in a DEDICATED process under the child key, and pin
 * its exit code — the pattern of `redact-registry.test.ts`. The child runs
 * the real pin below, alone in its process, where the mock is guaranteed to
 * bind. This also keeps the process-global mock OUT of the parent process:
 * the registration lives in the child branch only.
 *
 * ORDER-ROBUSTNESS (child): the test asserts `throwsServed > 0` — if the mock
 * ever stops intercepting (a bun change to mock.module semantics), the pin
 * turns RED (visible) instead of silently passing without exercising the
 * throw. A false green is the one failure this file must never produce.
 *
 * Harness: the K30 pattern (see the boot pin) — real proxy, quiet boot,
 * sandboxed provider envs, only fetch stubbed inert.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Value import captured BEFORE any mock.module below so afterAll can restore
// the REAL module (the catalog-warm recipe — the spread snapshots the exports
// into a plain object immune to the namespace repointing mock.module does).
import * as __realProfileConfig from "./profile-config.js";

const childKey = "CLAUDISH_CAPS_CFGERR_CHILD";

// Imports used by the child pin. They execute in the parent too (module
// scope), which is harmless — 14 sibling files already import proxy-server in
// the rest slice — but the MOCK is registered in the child branch only, so
// the parent process never sees a throwing loadConfig.
import { setConfigFileOverride } from "./config-override.js";
import { resetFailoverForTests } from "./fork/failover.js";
import { getOverflowCap, resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import { customEndpointCapKey } from "./providers/custom-endpoints-loader.js";
import { clearRuntimeRegistry } from "./providers/runtime-providers.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

if (process.env[childKey] !== "1") {
  /* ─────────────── parent: one spawn, one exit-code pin ─────────────── */

  test(
    "the config-error pin holds in its own process (self-respawn)",
    () => {
      const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env: { ...process.env, [childKey]: "1" },
        timeout: 90_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      console.log(output);
      expect(result.exitCode, output).toBe(0);
    },
    120_000
  );
} else {
  /* ─────────────── child: the real pin, alone in this process ─────────────── */

  const __realProfileConfigExports = { ...__realProfileConfig };

  /** How many loadConfig calls this mock has served with a throw. */
  let throwsServed = 0;

  mock.module("./profile-config.js", () => ({
    ...__realProfileConfigExports,
    loadConfig: () => {
      // The machine state this pin stands for: the config read fails AT BOOT.
      // Every caller in the boot path guards this (the endpoints try, the hook
      // loader, the /v1/models discovery) — the pin is that the caps restore no
      // longer lives downstream of any of them.
      throwsServed++;
      throw new Error("config read failed: EACCES (config-error pin)");
    },
  }));

  afterAll(() => {
    mock.module("./profile-config.js", () => __realProfileConfigExports);
  });

  const realFetch = globalThis.fetch.bind(globalThis);

  // Same hermeticism set as the boot pin: a real machine's provider keys must
  // not shape what registers, and the caps path is the one this file moves.
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
  ];
  const savedEnv: Record<string, string | undefined> = {};

  let tempDir: string;
  let capsPath: string;
  let activeProxy: ProxyServer | null = null;

  // A cap under a real custom-endpoint key: the restore loads it from disk
  // before anything config-shaped runs. capKey computed the way boot computes
  // it (the #660 r2 lesson — never hand-typed).
  const epPlain = {
    kind: "simple",
    url: "http://fake.invalid/plain/v1",
    format: "openai",
    apiKey: "k",
  };
  const capKeyPlain = customEndpointCapKey("ep-plain", epPlain as never);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claudish-caps-cfgerr-"));
    capsPath = join(tempDir, "overflow-caps.json");
    const configPath = join(tempDir, "config.json");

    // The persisted store, under the key a real handler records.
    writeFileSync(
      capsPath,
      JSON.stringify(
        {
          version: 1,
          caps: {
            [`${capKeyPlain}::some-model`]: {
              cap: 99999,
              at: new Date().toISOString(),
              evidence: "seeded for the config-error pin",
            },
          },
        },
        null,
        2
      )
    );

    // The override exists for the OTHER config readers' hermeticity (op-source,
    // onepassword); loadConfig itself is mocked and never reads it.
    writeFileSync(
      configPath,
      JSON.stringify({ version: "1.0.0", defaultProfile: "default", profiles: {} })
    );
    setConfigFileOverride(configPath);

    for (const k of SANDBOX_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    savedEnv.CLAUDISH_OVERFLOW_CAPS_PATH = process.env.CLAUDISH_OVERFLOW_CAPS_PATH;
    process.env.CLAUDISH_OVERFLOW_CAPS_PATH = capsPath;

    globalThis.fetch = (async (_input?: unknown) =>
      // Nothing derives here (no endpoints registered), but background warmers
      // must never hang the boot: inert 200 for everything.
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
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

  describe("#991 follow-up — learned caps survive a config-read failure", () => {
    test("the restore runs outside the config try: a throwing loadConfig skips endpoints, not caps", async () => {
      activeProxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
      });

      // The boot survived the config error (the endpoints try caught it), AND
      // the throw was actually served through the mock — the order-robustness
      // guard: pre-bound real loader ⇒ 0 ⇒ this pin is not silently inert.
      expect(throwsServed).toBeGreaterThan(0);

      // The pin: the seeded cap IS in memory despite the throw. Red against the
      // pre-hoist code (restore inside the try, below loadConfig ⇒ skipped).
      expect(getOverflowCap(capKeyPlain, "some-model")).toBe(99999);
    });
  });
}
