/**
 * Endpoint-gate smoke (#1115 / file 20261119c item 7) — ISOLATED from the
 * transport tests in magmux-ui.test.ts on purpose.
 *
 * Why a separate file: the win32 defect this pins (Bun.listen binds AF_UNIX
 * without creating an fs node, measured bun 1.3.14 win32) once made the whole
 * transport file red alongside the gate itself — a reviewer could not tell a
 * win32 socket-behavior finding from a transport regression. This file carries
 * its own MINIMAL listener (no FakeMagmux, no fake clock) so the gate contract
 * can be judged — and run — alone: `bun test ./magmux-ui.endpoint-gate-smoke.test.ts`.
 *
 * Platform note: the smoke is NOT win32-only. On POSIX a bound unix socket IS
 * an fs node, so B16b asserts the node's presence there — the guarantee the
 * gate removal must preserve (a dead path still fails to connect via ENOENT
 * semantics that POSIX exposes as a missing node).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { closeAllEpisodes, joinEpisode } from "./coordinator.js";
import type { EpisodeSeed } from "./coordinator.js";
import {
  __resetUiStateForTests,
  describeLease,
  installRecoveryUi,
  shutdownRecoveryUi,
  uiLeaseValid,
} from "./magmux-ui.js";

const SOCKET_TEST_TIMEOUT = 20_000;
const SMOKE_TEST_TIMEOUT = SOCKET_TEST_TIMEOUT;

// ───────────────────────────────────────────────────────────────────────────
// Minimal listener: accepts, parses newline JSON, acks every id-carrying
// message (`ok: true`), answers `list` with an empty pane set. Nothing else —
// the transport behaviors live in magmux-ui.test.ts.
// ───────────────────────────────────────────────────────────────────────────

interface Conn {
  buf: string;
  decoder: TextDecoder;
}

interface WireMsg {
  type?: string;
  id?: number | string;
  [key: string]: unknown;
}

class MinimalMagmux {
  readonly received: WireMsg[] = [];
  private listener: UnixSocketListener<Conn> | null;

  constructor(readonly path: string) {
    if (existsSync(path)) unlinkSync(path);
    this.listener = Bun.listen<Conn>({
      unix: path,
      socket: {
        open: (s) => {
          // Bun leaves s.data unset until the open handler assigns it — without
          // this, the first inbound chunk throws inside the handler (silently)
          // and the listener looks mute.
          s.data = { buf: "", decoder: new TextDecoder() };
        },
        data: (s, chunk) => {
          s.data.buf += s.data.decoder.decode(chunk, { stream: true });
          for (let nl = s.data.buf.indexOf("\n"); nl >= 0; nl = s.data.buf.indexOf("\n")) {
            const line = s.data.buf.slice(0, nl);
            s.data.buf = s.data.buf.slice(nl + 1);
            if (line.trim() !== "") this.onLine(s, line);
          }
        },
        error: () => {},
      },
    });
  }

  private write(s: Socket<Conn>, obj: unknown): void {
    try {
      s.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // the peer went away; a real magmux would not care either
    }
  }

  private onLine(s: Socket<Conn>, line: string): void {
    let msg: WireMsg;
    try {
      msg = JSON.parse(line) as WireMsg;
    } catch {
      return;
    }
    this.received.push(msg);
    if (msg.id === undefined) return; // no reply expected
    const panes = msg.type === "list" ? { panes: [] } : {};
    this.write(s, { type: "reply", id: msg.id, ok: true, result: panes });
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}

let sockSeq = 0;

function sockPath(): string {
  const name = `mmx-gate-smoke-${process.pid}-${++sockSeq}.sock`;
  const preferred = join(tmpdir(), name);
  // sun_path is 104 bytes on macOS; a long TMPDIR would make bind() fail.
  return Buffer.byteLength(preferred) < 100 ? preferred : join("/tmp", name);
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll in real time — this smoke deliberately wires no fake clock. */
async function eventually(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (performance.now() >= end) return false;
    await sleepReal(10);
  }
}

/** Give real socket I/O every chance to deliver something that should NOT happen. */
async function settle(ms = 150): Promise<void> {
  await sleepReal(ms);
}

function smokeSeed(): EpisodeSeed {
  return {
    providerName: "mmx-gate-smoke",
    providerDisplayName: "Zephyr Cloud",
    endpoint: "http://127.0.0.9:9/v1/chat/completions",
    kind: "refused",
    code: "ConnectionRefused",
    reason: "Cannot reach Zephyr Cloud: the connection was refused.",
    deadlineAt: Date.now() + 270_000,
  };
}

let savedMagmuxSock: string | undefined;
let f: MinimalMagmux | null = null;
let episode: ReturnType<typeof joinEpisode> | null = null;

beforeAll(() => {
  // A developer running this inside magmux must never have the suite draw on
  // their real pane.
  savedMagmuxSock = process.env.MAGMUX_SOCK;
  delete process.env.MAGMUX_SOCK;
});

afterAll(() => {
  if (savedMagmuxSock !== undefined) process.env.MAGMUX_SOCK = savedMagmuxSock;
});

afterEach(async () => {
  // Cross-file state leak (CI run 44532601904, hermetic macOS 2/3): the smoke
  // ran before coordinator.test.ts in the same bun process and its open
  // episode survived into `episodeCount()` there (Expected 1 / Received 2).
  // Coordinator state is process-global; a test file that opens episodes
  // closes them, mirroring magmux-ui.test.ts's own afterEach.
  __resetUiStateForTests();
  try {
    episode?.leave();
  } catch {
    // already closed
  }
  episode = null;
  closeAllEpisodes();
  try {
    await shutdownRecoveryUi();
  } catch {
    // not installed in every test
  }
  f?.stop();
  f = null;
});

describe("B16: endpoint gate vs a live listener", () => {
  test(
    "B16: a live magmux socket whose path has no fs node still receives the banner (Bun.listen creates no node on win32)",
    async () => {
      f = new MinimalMagmux(sockPath());
      // #1115 (measured 19/11, bun 1.3.14 win32): existsSync(socketPath) is
      // FALSE while the listener is alive — Bun.listen binds AF_UNIX without
      // creating a filesystem node. A gate that requires existsSync(sock)
      // before connecting therefore refuses a LIVE magmux on every win32 seat.
      // POSIX guarantee to preserve: a bound unix socket IS an fs node there,
      // so this test is just as green (and the dead-path refusal stays: a
      // nonexistent path still fails to connect).
      const sockExists = existsSync(f.path);
      console.error(
        `B16-PROBE platform=${process.platform} bun=${Bun.version} socketFsNodeExists=${sockExists}`
      );

      installRecoveryUi(f.path);
      const h = joinEpisode(smokeSeed());
      episode = h;

      const bannered = await eventually(() => f !== null && f.received.length > 0);
      expect(bannered).toBe(true); // the banner MUST land: the listener is live
      const leased = await eventually(() => uiLeaseValid(h.episodeId));
      expect(leased).toBe(true); // the ok-reply grants the lease
      expect(describeLease(h.episodeId).connected).toBe(true);
    },
    SMOKE_TEST_TIMEOUT
  );

  test(
    "B16: the SOCKET node is absent after listen while its PARENT directory stays visible — separate existence questions",
    async () => {
      f = new MinimalMagmux(sockPath());
      // Two different answers, never collapsed into one: a missing PARENT means
      // the listener could never bind; a missing SOCKET node on a live listener
      // means the OS exposes no fs node for it (win32). The gate must only ever
      // need the connection, not the node.
      expect(existsSync(dirname(f.path))).toBe(true);
      const sockExists = existsSync(f.path);
      console.error(
        `B16-PROBE-2 platform=${process.platform} socketFsNode=${sockExists} parentDir=true`
      );
      if (process.platform !== "win32") expect(sockExists).toBe(true); // POSIX guarantee
      await settle(50);
      expect(f.received.length).toBe(0); // nobody sent anything; listener still bound
    },
    SMOKE_TEST_TIMEOUT
  );
});
