/**
 * Test-run home sandbox — loaded by bunfig.toml `[test] preload` BEFORE any
 * test file (and so before any module that captures `homedir()` at load time,
 * e.g. profile-config's config path).
 *
 * WHY: on this fleet `~/.claudish` is production state. Sidecar containers
 * bind-mount it as their config dir, native sidecars read it at start, and the
 * agents that run this suite run ON those machines. Several tests overwrite
 * `~/.claudish/config.json` and restore an in-memory copy in afterEach; that
 * copy cannot survive the process dying mid-test or a second test process on
 * the same machine. Both happened on 2026-09-23: one production config was
 * replaced by a test fixture (a live credential that existed only in that file
 * was lost), another by `{}` (#242).
 *
 * Sandboxing the whole run is the only fix that covers every writer: 28 source
 * files resolve paths from homedir(), and every proxy a test starts also
 * writes tokens-<port>.json there.
 *
 * Bun's os.homedir() re-reads USERPROFILE on Windows on every call (HOME is
 * ignored there) and HOME on POSIX, so setting both here is enough — measured
 * on Bun 1.3.13 before writing this. If that ever stops being true the guard
 * below throws, and the run stops before a single test can touch the real home.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX_PREFIX = "claudish-test-home-";

const realHome = homedir();
const sandbox = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));

process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
// For tests that must assert they never touch the operator's home.
process.env.CLAUDISH_TEST_REAL_HOME = realHome;
process.env.CLAUDISH_TEST_HOME_SANDBOX = sandbox;

if (homedir() !== sandbox) {
  throw new Error(
    `test preload: homedir() still resolves to ${homedir()} after sandboxing to ${sandbox} — ` +
      "refusing to run tests that would write the real ~/.claudish"
  );
}

// A killed run never reaches its afterAll, so its sandbox stays behind (with
// whatever the tests wrote, and Bun's own cache files, which follow HOME).
// Sweep earlier runs' leftovers here — one older than a day cannot belong to a
// run still in flight.
const STALE_MS = 24 * 60 * 60 * 1000;
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(SANDBOX_PREFIX)) continue;
  const dir = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

// afterAll in a preload runs once, after the last test file. process "exit"
// and "beforeExit" hooks do not fire under `bun test` (measured, Bun 1.3.13).
afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
});
