/**
 * #641 G3 — the auth middleware runs BEFORE the relay branch.
 *
 * The registration order IS the security property: `app.use("/v1/*", auth)` at
 * the CORS seam runs ahead of the /v1/messages route handler, whose relay
 * branch would otherwise forward an unauthenticated request to the hub and let
 * the hub's guard be the only one to see it. This pins the order on a real
 * listening NOMINAL sidecar (upstream configured AND alive — the state where
 * the relay branch WINS), against a stub hub that counts what actually
 * reached it:
 *
 *   A1  keyless non-native (`gpt-4o`) ⇒ 401 from the sidecar, hub saw NOTHING
 *       — refused before any forward could happen.
 *   A2  keyed non-native ⇒ auth passes, the relay forwards, hub saw ONE
 *       request carrying the cluster key (without this case A1 could pass on
 *       a relay that forwards nothing at all).
 *   A3  keyless NATIVE (`claude-opus-5-5`) ⇒ the exemption branch admits, the
 *       forward DOES happen and the hub sees it keyless (#416 preserved — the
 *       mark the auth branch now sets is what the forward reads).
 *
 * `app.request` is not enough here: the relay forward and the keyless mark
 * live on the Request the real server built (same reason as
 * relay-keyless-forward.test.ts, which pins the forward's header shape; this
 * file pins the ORDER — neither subsumes the other).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../../proxy-server.js";
import type { ProxyServer } from "../../types.js";
import { createRelayState } from "../server/relay.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19921, 19961, 19971/19972).
const SIDECAR_PORT = 19981;
const HUB_PORT = 19982;
const HUB_BASE = `http://127.0.0.1:${HUB_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "CLAUDISH_PROXY_KEY",
  "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_CAPTURE_HOST_DIR",
  "CLAUDISH_RELAY_UPSTREAM",
  "CLAUDISH_NO_ANTHROPIC",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-g3-order";
const OPUS = "claude-opus-5-5";

/** What the stub hub actually received. */
interface Seen {
  headers: Record<string, string>;
  body: any;
}
let seen: Seen[] = [];

// node:http, not Bun.serve: same server stack as the proxy itself (see
// relay-keyless-forward.test.ts for the Bun Response-rejection detail).
let hub: import("node:http").Server | null = null;
let sidecar: ProxyServer | null = null;

const HUB_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_g3","model":"relay","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"relayed"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

beforeEach(async () => {
  seen = [];
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  // No routing / customEndpoints / inboundKeys: `claude-opus-5-5` stays a plain
  // native name so the exemption branch (and its #416 mark) applies.
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CLAUDISH_PROXY_KEY = PROXY_KEY;

  hub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {}
      seen.push({ headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(HUB_SSE);
    });
  });
  await new Promise<void>((resolve) => hub!.listen(HUB_PORT, "127.0.0.1", resolve));
});

afterEach(async () => {
  if (sidecar) {
    await sidecar.shutdown();
    sidecar = null;
  }
  if (hub) {
    await new Promise<void>((resolve) => hub!.close(() => resolve()));
    hub = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A NOMINAL sidecar: upstream configured AND alive, so the relay branch wins. */
async function spinSidecar(): Promise<void> {
  sidecar = await createProxyServer(
    SIDECAR_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      quiet: true,
      relay: createRelayState({ upstream: HUB_BASE, proxyKey: PROXY_KEY }),
      // #641 G2 (branch-only): the v14 startup warmers dispatch real background
      // fetches that poison cross-suite globals (relay.test.ts measured it).
      skipBackgroundWarmers: true,
    }
  );
}

async function post(auth: Record<string, string>, model: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${SIDECAR_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...auth,
    },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe("G3 order: proxy auth runs BEFORE the relay forward (#641)", () => {
  test("A1 — keyless non-native is refused 401 by the SIDECAR, the hub is never contacted", async () => {
    await spinSidecar();
    const res = await post({}, "gpt-4o");
    expect(res.status).toBe(401);
    const text = await readAll(res);
    expect(text).toContain("invalid proxy authentication");
    expect(seen.length).toBe(0); // refused before any forward
  });

  test("A2 — keyed non-native passes auth and IS forwarded (the relay path itself is live)", async () => {
    await spinSidecar();
    const res = await post({ "x-proxy-key": PROXY_KEY }, "gpt-4o");
    expect(res.status).toBe(200);
    await readAll(res);
    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-proxy-key"]).toBe(PROXY_KEY);
  });

  test("A3 — keyless NATIVE is exempted, forwarded, and reaches the hub keyless (#416 through the auth branch)", async () => {
    await spinSidecar();
    const res = await post({}, OPUS);
    expect(res.status).toBe(200);
    await readAll(res);
    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-proxy-key"]).toBeUndefined();
  });
});
