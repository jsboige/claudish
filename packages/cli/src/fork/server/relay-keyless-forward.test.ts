/**
 * #416 — the relay's cluster key authenticates the RELAY, never its client.
 *
 * `forwardToUpstream` used to inject `x-proxy-key = state.proxyKey` on every
 * forward. A client that reached a sidecar WITHOUT a key of its own therefore
 * arrived at the hub holding the cluster's credential — the elevation #412
 * closes at the resolution site, reopened by the hop that carries the request.
 * `createProxyAuthMiddleware` marks such a request (keyless-exempt.ts) before
 * the relay branch runs; the forward now reads that mark and forwards it
 * keyless, so the hub's own guard decides.
 *
 * This file pins the RELAY side of the contract on a real listening sidecar
 * forwarding to a real stub hub. The hub-side reading of a relay-shaped request
 * is pinned separately (proxy-server-keyless-exempt-route.test.ts, T5) — that
 * one proves what a keyed forward means at the hub; it cannot prove the relay
 * never manufactures that shape for a keyless client, which is this file's job.
 *
 * `app.request` is not usable here: the mark lives on the Request the real
 * server built, and `app.request` constructs a fresh one, so the guard would
 * read an unmarked object and every case would pass whatever the relay did.
 *
 * Cases:
 *   F1  keyless native forward ⇒ the stub sees NO x-proxy-key, and DOES see the
 *       client's own `authorization` (the ai-01 OAuth lane that must keep
 *       traversing sidecar → hub → Anthropic)
 *   F2  keyed forward ⇒ the stub sees `x-proxy-key` (the nominal path is
 *       untouched; without this case F1 could pass on a relay that injects
 *       nothing at all)
 *   F3  keyless client authenticating with its OWN `sk-ant-…` in `x-api-key` ⇒
 *       that header survives the forward. Deleting it (the keyed branch's rule)
 *       would leave the hub with no credential at all and turn a working
 *       passthrough into the #296 shape-A 403.
 *   F4  keyless client sending a bogus `x-proxy-key` ⇒ dropped. It is the
 *       relay's own header namespace, and a non-matching value must not be
 *       re-presented at a hub whose key differs.
 *
 * Mutation proof — EXECUTED, each mutation run against this file with its red
 * set recorded (the header states what was measured, not what was intended):
 *   - drop the `!keyless` condition (inject unconditionally, the pre-#416
 *     shape) ⇒ F1, F3, F4 red; F2 stays green. F3 rides along because the
 *     unconditional branch also reinstates the `x-api-key` delete it exists to
 *     contrast with — the keyed rule is the wrong rule here, and that is the
 *     point of the case.
 *   - drop `delete headers["x-proxy-key"]` from the keyless branch ⇒ F4 red
 *     alone.
 *   - add `delete headers["x-api-key"]` to the keyless branch (the keyed
 *     branch's rule, applied where it does not hold) ⇒ F3 red alone.
 * A fourth mutation (leave everything else, remove the `logStderr` marker) has
 * no test behind it by design: the marker is operational evidence for the
 * post-deploy consumer check, not a behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../../proxy-server.js";
import { createRelayState } from "./relay.js";
import type { ProxyServer } from "../../types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19921, 19961).
const SIDECAR_PORT = 19971;
const HUB_PORT = 19972;
const HUB_BASE = `http://127.0.0.1:${HUB_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_CAPTURE_HOST_DIR",
  "CLAUDISH_RELAY_UPSTREAM", "CLAUDISH_NO_ANTHROPIC",
  "ANTHROPIC_API_KEY", "CLAUDE_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

const PROXY_KEY = "fake-cluster-key-relay-416";
const OAUTH_BEARER = "Bearer sk-ant-oat01-relay-416";
const CLIENT_OWN_KEY = "sk-ant-api03-client-own-416";
const OPUS = "claude-opus-5-5";

/** What the stub hub actually received. */
interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
let seen: Seen[] = [];

// node:http, not Bun.serve: the proxy itself listens through @hono/node-server,
// so the stub speaks the same server stack, and `Bun.serve` rejects a Response
// it did not construct ("Expected a Response object, but received '_Response'")
// with the test file's Response — noise that would mask a real server error.
let hub: import("node:http").Server | null = null;
let sidecar: ProxyServer | null = null;

const HUB_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_416","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
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
  // No routing / customEndpoints / inboundKeys: `claude-opus-5-5` must stay a
  // plain native name so the middleware's exemption (and its mark) applies.
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
      seen.push({ url: req.url ?? "", headers, body });
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
    undefined, // no stored Anthropic key — the point is the CLIENT's credential
    undefined,
    { quiet: true, relay: createRelayState({ upstream: HUB_BASE, proxyKey: PROXY_KEY }) }
  );
}

async function post(auth: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${SIDECAR_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...auth,
    },
    body: JSON.stringify({
      model: OPUS,
      max_tokens: 16,
      metadata: { user_id: JSON.stringify({ session_id: "sess-416-relay" }) },
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** Drain so the relay's forward has completed before assertions. */
async function drain(res: Response): Promise<string> {
  return await res.text();
}

describe("#416 relay — the cluster key stays at the relay", () => {
  test("F1 keyless native forward reaches the hub WITHOUT x-proxy-key, keeping the client OAuth", async () => {
    await spinSidecar();
    const res = await post({ authorization: OAUTH_BEARER });
    expect(res.status).toBe(200);
    // The client's stream still terminates — the forward is a passthrough, and
    // a header change must not have cost the never-hang contract.
    expect(await drain(res)).toContain("message_stop");

    // Positive control first: the request really was forwarded (a relay that
    // served locally would otherwise satisfy the header assertion vacuously).
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe("/v1/messages");
    expect(seen[0].body?.model).toBe(OPUS);
    expect(seen[0].headers["x-proxy-key"]).toBeUndefined();
    expect(seen[0].headers["authorization"]).toBe(OAUTH_BEARER);
  });

  test("F2 keyed forward still carries the cluster key", async () => {
    await spinSidecar();
    const res = await post({ "x-proxy-key": PROXY_KEY });
    expect(res.status).toBe(200);
    await drain(res);

    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-proxy-key"]).toBe(PROXY_KEY);
    // The keyed branch's delete is unchanged: a stale x-api-key would re-arm
    // the hub's proxyKey→Anthropic swap.
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
  });

  test("F3 a keyless client's OWN x-api-key survives the forward", async () => {
    await spinSidecar();
    const res = await post({ "x-api-key": CLIENT_OWN_KEY });
    expect(res.status).toBe(200);
    await drain(res);

    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-proxy-key"]).toBeUndefined();
    // Stripping this would leave the hub credential-less → #296 shape A → 403.
    expect(seen[0].headers["x-api-key"]).toBe(CLIENT_OWN_KEY);
  });

  test("F4 a bogus x-proxy-key from a keyless client is dropped, never re-presented", async () => {
    await spinSidecar();
    const res = await post({ "x-proxy-key": "not-the-cluster-key", authorization: OAUTH_BEARER });
    expect(res.status).toBe(200);
    await drain(res);

    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-proxy-key"]).toBeUndefined();
    expect(seen[0].headers["authorization"]).toBe(OAUTH_BEARER);
  });
});
