/** Process-level coverage for caller setup inheritance in a real headless magmux pane. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { waitForJson } from "../test-support/wait-for-json.js";
import { SessionManager } from "./session-manager.js";

const T_PANE = 30_000;

type ChildProbe = { argv: string[]; env: Record<string, string>; cwd: string };
type InheritedSettings = { enabledPlugins: Record<string, boolean>; model?: string };

/**
 * #831 — the probe's read side, hoisted so its settle guard can be pinned
 * without a pane. `existsSync` proved the directory entry existed, not that the
 * child had finished writing: a loaded macOS CI leg read a half-written probe
 * and `JSON.parse` died on EOF. Reading AND parsing until it settles makes
 * existence and completeness the same condition.
 */
async function childProbeAt(
  probePath: string,
  manager: SessionManager,
  sessionId: string
): Promise<ChildProbe> {
  const path = probePath.replace("{session}", manager.getSession(sessionId).claudeSessionId);
  return waitForJson<ChildProbe>(path);
}

describe.skipIf(!MAGMUX)(
  `SessionCreateOptions setup inheritance (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let sessionsDir: string;
    let probe: string;
    let managers: SessionManager[];

    beforeEach(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      probe = join(t.tmp, "probe-{session}.json");
      managers = [];
    });

    afterEach(async () => {
      for (const m of managers) await m.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, 10_000);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    }, 30_000);

    function makeManager(): SessionManager {
      const manager = new SessionManager({
        sessionsDir,
        hostPid: 1,
        parentEnv: { ...t.env, FAKE_PROBE_FILE: probe },
        paneTimings: { replStableMs: 200 },
      });
      managers.push(manager);
      return manager;
    }

    async function childProbe(manager: SessionManager, sessionId: string): Promise<ChildProbe> {
      return childProbeAt(probe, manager, sessionId);
    }

    async function expectInheritedSession(claudishFlags: string[]): Promise<InheritedSettings> {
      const caller = join(t.tmp, "caller");
      const work = join(t.tmp, "work");
      mkdirSync(join(caller, ".claude"), { recursive: true });
      mkdirSync(work);
      const callerSettings = join(caller, ".claude", "settings.json");
      writeFileSync(callerSettings, '{"enabledPlugins":{"dev@magus":true}}\n');
      const before = readFileSync(callerSettings);
      const manager = makeManager();

      const sessionId = await manager.createSession({
        model: "fake-env_probe",
        cwd: work,
        setupFrom: caller,
        claudishFlags,
      });
      const child = await childProbe(manager, sessionId);
      const sessionDir = join(sessionsDir, sessionId);
      expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
      expect(child.argv.filter((arg) => arg === "--settings")).toHaveLength(1);
      expect(child.argv.some((arg) => arg.startsWith("--settings="))).toBe(false);
      const settingsPath = child.argv[child.argv.indexOf("--settings") + 1];
      expect(isAbsolute(settingsPath)).toBe(true);
      expect(settingsPath).toBe(join(sessionDir, "inherited-settings.json"));
      expect(settingsPath.startsWith(`${sessionsDir}${sep}`)).toBe(true);
      expect(settingsPath.startsWith(`${work}${sep}`)).toBe(false);
      expect(settingsPath.startsWith(`${caller}${sep}`)).toBe(false);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as InheritedSettings;
      expect(settings.enabledPlugins["dev@magus"]).toBe(true);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(child.cwd).toBe(realpathSync(work));
      const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(spawn.setupFrom).toBe(caller);

      await manager.shutdownAll();
      expect(readdirSync(work)).toEqual([]);
      expect(readFileSync(callerSettings)).toEqual(before);
      return settings;
    }

    test(
      "inherits caller plugins through one private settings file outside the work directory",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        await expectInheritedSession([]);
      },
      T_PANE
    );

    test(
      "merges a caller settings flag into the inherited file without adding another settings flag",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const settings = await expectInheritedSession(["--settings", '{"model":"c"}']);
        expect(settings.model).toBe("c");
      },
      T_PANE
    );

    test(
      "omitting setupFrom adds no settings flag, inherited file, or spawn metadata",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const work = join(t.tmp, "work");
        mkdirSync(work);
        const manager = makeManager();
        const sessionId = await manager.createSession({
          model: "fake-env_probe",
          cwd: work,
          claudishFlags: [],
        });
        const child = await childProbe(manager, sessionId);
        const sessionDir = join(sessionsDir, sessionId);

        expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
        expect(
          child.argv.filter((arg) => arg === "--settings" || arg.startsWith("--settings="))
        ).toEqual([]);
        expect(existsSync(join(sessionDir, "inherited-settings.json"))).toBe(false);
        const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
          string,
          unknown
        >;
        expect(spawn).not.toHaveProperty("setupFrom");
        expect(child.cwd).toBe(realpathSync(work));

        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );
  }
);

describe("#831 settle guards (no pane needed)", () => {
  const stubManager = {
    getSession: () => ({ claudeSessionId: "pin" }),
  } as unknown as SessionManager;

  test("childProbeAt refuses a half-written probe, then settles when the writer finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-831-probe-"));
    const path = join(dir, "probe-pin.json");
    writeFileSync(path, '{"argv": ["par'); // exists, unparseable — the old read died here
    const pending = childProbeAt(join(dir, "probe-{session}.json"), stubManager, "s");
    await new Promise((resolve) => setTimeout(resolve, 100)); // polls must see the partial
    writeFileSync(path, '{"argv":["claude","--x"],"env":{},"cwd":"/w"}');
    const child = await pending;
    expect(child.argv[0]).toBe("claude");
  });
});
