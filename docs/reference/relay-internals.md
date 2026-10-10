# Relay / sidecar mode — internals

**Deferred from `CLAUDE.md` (v7.2+ section).** The mode table, env vars and hard gotchas stay in `CLAUDE.md`; this file holds the mechanism. Operational runbook: `docs/deployment/relay-sidecar-deployment.md`.

## Motivation (historical)

Historically every cluster machine pointed Claude Code's `ANTHROPIC_BASE_URL` directly at po-2023's proxy container. That made po-2023 a **single point of failure** — when it crashed (2026-07-02), the whole cluster stalled. The relay design removes that: each capable machine runs its own claudish container (a **sidecar**) that relays to the central hub in nominal mode but takes over locally when the hub dies.

## Components (`packages/cli/src/fork/server/relay.ts`)

- `forwardToUpstream(c, body, state)` — builds outbound headers (copies inbound minus hop-by-hop, **preserves `X-Claudish-Machine`** so central attribution survives the relay, then **injects the cluster key as `x-proxy-key`** — NOT `x-api-key` — and **keeps the client `authorization`**). The `x-proxy-key` form passes the hub's auth gate without triggering `NativeHandler`'s proxyKey→Anthropic swap, so a relayed native (Opus) request from ai-01 passes through to Anthropic on ai-01's own OAuth (the hub stores no Anthropic key). `x-api-key` would arm the swap → strip auth → 401. Optionally gzips the request body, `fetch`es `${upstream}/v1/messages`. Pre-stream failure → returns `null` (caller falls through to local for that request). Success streaming → repiped via `createAnthropicPassthroughStream(…, { capture: false })` (ping keepalive + `finalizeWithError`, so a mid-stream hub death still emits a terminal `message_stop`).
- `startUpstreamProber(state)` — heartbeat `GET /health` every 10s. **Hysteresis:** 2 consecutive failures → AUTONOMOUS (fast failover); recovery needs 3 OK heartbeats **+ 60s cooldown + a deep tool-call probe** (`glm-5.2`, must complete with `message_stop`) before returning to NOMINAL (anti-flap).
- `readRequestBody(c)` — inflates a gzipped request body on the hub (detects gzip magic bytes, so it's correct whether or not the runtime auto-inflates). Zero cost on the uncompressed LAN path.

## Wiring

The relay branch sits in the `/v1/messages` route **before** `interceptWebTools` / `getHandlerForRequest` / `logRequest` — so nominal forwards bypass local capture automatically (mode-aware capture for free). `standalone-proxy.ts` reads the env, builds `RelayState`, passes it in `ProxyServerOptions.relay`, and starts the prober.

## Leak-policy backstop (defense in depth)

`CLAUDISH_NO_ANTHROPIC=1` (set on every machine ≠ ai-01) makes `getHandlerForRequest` reroute any bare native (`isNative`) target to the budget `modelMap.sonnet` instead of real `api.anthropic.com`. Depth-guarded recursion + a fail-closed refusal handler prevent both infinite loops and leaks on a misconfigured mapping. See memory `leak-policy-binary-by-machine`.

## Compression (Phase B, WAN only)

LAN sidecars do **not** compress (the hub decompresses to proxy anyway; the LAN isn't the bottleneck). WAN externals (po-2025, web1 → models.myia.io) set `CLAUDISH_RELAY_COMPRESS=1` → native `Content-Encoding: gzip` on the **request body only** (never the SSE response — gzip buffering would risk a hang). The uplink (system + history + tools) is the constrained asymmetric direction.

## Outage capture reconciliation (Phase C)

On a sidecar, loose captures exist *only* because an outage forced AUTONOMOUS mode — so any loose `req-*/resp-*` files ARE outage captures. `scripts/reconcile-outage-captures.ps1` packs them into `reconcile/outage-<machine>-<start>_<end>.7z` (machine-namespaced, no collision with daily `captures-YYYY-MM-DD.7z`), uploads to GDrive `reconcile/`, and deletes loose only after a verified archive + confirmed off-site copy. The hub merges them nightly; attribution is correct because each `req-*.json` body carries `machine` (commit 141d160). `CaptureUtils.psm1` → `Get-OutageArchives`.

## The two upstream failure signatures

A relay flap has **two** signatures, and they do not mean the same thing. Only the first is local.

| Signature | What it is | Who absorbs it |
|---|---|---|
| **Connect failure** — refused / reset, fails in milliseconds | *client-side transport* **only under #80's precondition — the hub independently reachable at the same moment** (there: the Docker Desktop tunnel); a refusal with the hub down is the hub, not the transport | the single +250 ms retry (#80 part 2); an absorbed retry does **not** `markFail` |
| **Invalid response** — TCP accepted, nothing valid returned | **hub-end availability**: the port is open, the process answers nothing readable | nobody — it reaches the client |

Measured on po-203, **2026-10-08 `08:48:52→08:50:55Z`**, the same signature on **three independent
paths to the same hub**: the host's own `curl http://192.168.0.50:3000/health` (**no Docker in the
path at all**), the `:18182` TCP relay (`relay.js`, a raw `net` pipe), and **IIS ARR on the ingress**,
which logged **34 × 502** (substatus 3/6, **win32 12152 = `ERROR_WINHTTP_INVALID_SERVER_RESPONSE`**)
over the window — the failed entries including real client `POST /v1/messages` from
`claude-cli/2.1.292|2.1.293`. Between the probes bracketing the window, the hub's `/health`
`instanceId` changed (`9a8295e5…` → `99c2feef…`) and `uptimeSec` reset — read from po-203's side as
a process replacement **bounded to that interval** (an id change dates nothing by itself); the relay
returned NOMINAL 32 s later. **The replacement is corroborated hub-side, and its cause is a Docker
Desktop engine recovery — see below.**

**What the hub-side journal holds (po-2025, `~/.claudish/docker-events.log` — the durable collector
of issue #169).** At 08:50:56Z a `container start claudish-proxy` **carrying the same container id**
(`32c3f1378a91`) — and between 06:34:11Z and that event **no `create`, `stop`, `die`, `kill` or
`destroy` at all**. A container cannot be *started* without having been stopped, and the daemon that
would have logged the stop was itself gone. ⚠ **`com.docker.compose.replace=claudish-proxy`
identifies no actor and no recreate**: it is stamped at creation and persists, so it reads as a
recreate on a container that was never recreated (its `environment_file=D:\claudish-shadow\.env` is
a creation-time fact for the same reason) — and the refutation here is direct, since **no `create`
event exists anywhere in the window**. The same-second sibling closes it: `08:50:58Z start
myia_vllm-mini-frognano-4b d5d45279654c`, again the id created earlier (08:26:33) with no prior
`die` — **two bare starts, 2 s apart, on two containers of two different compose projects = the
Docker Desktop engine restart signature**, the same shape the watchdog names the same day
(`ENGINE-DOWN: docker CLI cannot reach the engine`, then `DIAG[engine-down]: port 3000 DEAF
(refused)`); a create/start/die/destroy burst of ephemeral containers at 08:00–08:01Z shows the
engine had already bounced that morning. Not a reboot: the System log 08:40–08:56Z holds no
41/6008/1074.

**Reconciled 2026-10-10 (issue #419, c.6093767933) — the two readings were never in conflict.**
po-2025's watchdog uptime comes from `docker inspect State.StartedAt` (the daemon-held container
record), *not* from a probe; the `/health` `instanceId`/`uptimeSec` pair is the in-process view; and
`watchdog.log` is stamped **local (UTC+2)** while `docker inspect` and `/health` are **UTC** —
comparing the two without conversion fabricates a false 2 h gap. The corrected readings are
`2.2 h` at `08:47:25Z` → `0.2 h` at `09:02:04Z`: **`StartedAt` and the process identity reset
together at the event**, the two instruments agree, and the "contradiction" was a transcription
error on po-2025's side, retracted. What stays unestablished is only the *cause of the engine
event*, never the shape of what the relay saw.

Day scale stays counted by the journal's shape (a `start` with no logged `stop`) — the honest unit,
since the collector can also lose ticks (#417/#419): **3 such `start`s on 2026-10-08** (06:34:11Z,
08:50:56Z, 11:20:37Z — the last with no observed process replacement, `RestartCount=0`,
`StartedAt=12:02:02Z`), against **2 drained gestures** that day; over the whole available journal,
**20 such `start`s across 82 hub `start`s since 22/09**. `drain.log` is silent on all three —
correctly so for an engine recovery: **there was nothing to drain**. That silence is why the durable
collector matters here: `scripts/docker-events-collect.ps1` (#169).

**The fully-attributed counter-example (2026-10-10 01:03:47Z).** One night later the same fleet
produced the pair with a cause we own end to end: a **watchdog proactive** restart (uptime 11.9 h
≥ 11 h, quiet window), drain to a true zero in **84 s** — `0 in flight — no client interrupted` —
`docker restart` back in 9 s, `OUTCOME success`. `StartedAt` and the process counters reset
together, and **the two edge 502s that night (01:03:42/46Z) are the stop-start interval of that
restart** — the sharpest available measurement of what a hub restart costs on a fallback-less WAN
path (po-203, 2026-10-10).

**Day scale (2026-10-08, closed).** **11 AUTONOMOUS episodes, 11 recoveries** (03:26:02 → 11:13:21);
**10 of the 11 have matching 502 minutes**, and **179 of the day's 184 502s fall inside a flap
window** (13 729 requests, 1.3 %). The single episode with no 502 anywhere
(**05:49:05→05:50:28**, 83 s) is the one consistent with the local transport class: the two
signatures coexist, neither abolishes the other.

⚠ **The relay tally is a lagging, insensitive proxy, and two blind spots make it lossy.** The
heartbeat arms on **2 consecutive** failures, so it never flaps on a single-minute blip (2026-10-08:
502s at **00:09, 03:12, 03:41, 03:44, 19:52** — present in the 502 record, absent from the tally),
and it can miss a hub restart outright (**12:01**: one 502, the hub's process replaced ~12:02 — **no
flap at all**). Reading the tally alone therefore **under-counts** hub unavailability *on the WAN
ingress*. The instrument that does not is the **ingress IIS log** (`W3SVC49/u_ex<yymmdd>.log`):
`awk '$12==502'` over the **status / substatus / win32** columns — with its own scope: it sees
**only the requests that traverse it**; LAN-direct clients and sidecar traffic on the `:18182`
tunnel never appear. Joined to `/health`'s `instanceId` + `uptimeSec` for process identity, an
`instanceId` change *bounds* a replacement between two observations; it does not date it, absent a
corroborating timestamped event.

**Client impact beyond the 502s — #410 owns the defect; the *timing tie* now holds.** The Zod
rejection is real and measured: `config.json` carried `maxConcurrency: 16`, the image then in
service (07/10) caps at 8, and an endpoint failing validation is dropped whole (by design, with a
stderr warning), so the entire `frognano` entry was skipped and **`frognano-4b` and `mini` stayed
down until the revert at 11:17:25Z** — about 2.5 h. *"The 08:50:56Z restart re-read `config.json`"*
holds because the replacement at that instant is corroborated hub-side (same container id restarted
by the engine, no `create` anywhere in the window): the process did restart there, and a process
restart is the instant a config never validated against the *running* image takes effect. (Read
strictly, the 2.5 h window is bounded by two observable ends — the restart and the 11:17:25Z revert
— and the general rule survives whatever timestamp the restart carries.) On ai-01 the same window
sent clients to the walled last step of the local cascade, a 403 (#409).

**Consequence, standing.** On this fleet **a relay flap is a reading of hub *reachability from the
relay* — not a local Docker artifact, and not a cause localisation**: the three concordant paths
qualify *this* window (the failures sat at the hub end of the path on 08/10); they do not
pre-locate the cause of future flaps. Never let *"impact client nul"* cover the **WAN entry**. Only
the relay-**bypassed** *local* clients are shielded from a hub outage — which is the measured
argument for pointing the WAN entry at a relay rather than straight at the hub
(`models.myia.io`, IIS site id=49).

## Tests

`relay.test.ts` (16 — hysteresis, header build incl. ai-01 Opus passthrough, gzip, never-hang delegation). Budget-free resilience E2E: `bun run packages/cli/src/fork/server/relay-e2e.ts` (real prober + mock hub: NOMINAL → FAILOVER → RECOVERY over real HTTP, ~2-3 min).

## Fleet deployment

`scripts/install-sidecar.ps1` idempotently stands up a sidecar on a target machine (clone/pull, per-machine `.env`, `docker compose up --build`, end-to-end probe). Runbook + per-machine config table: `docs/deployment/relay-sidecar-deployment.md`. Sidecars go on every machine except po-2023 (hub) and web1 (stays on `models.myia.io`). The client prerequisite — the `x-proxy-key` custom header — is documented in memory `proxy-key-custom-header-auth`.

## Compose environment surface

`docker-compose.yml` carries a default for every relay variable, so the hub runs with **no `.env` at
all**: `CLAUDISH_RELAY_UPSTREAM`, `CLAUDISH_RELAY_COMPRESS`, `CLAUDISH_NO_ANTHROPIC`,
`CLAUDISH_HOST_PORT`, `CLAUDISH_CONTAINER_NAME`, `CLAUDISH_CAPTURE_HOST_DIR`,
`CLAUDISH_CAPTURE_DIR`, plus the `CLAUDISH_FAILOVER_*` family.

`CLAUDISH_CONTAINER_NAME` is what lets one host run hub and sidecar side by side (`claudish-proxy`
vs `claudish-sidecar`); `scripts/install-sidecar.ps1` sets it per machine. Pass-through is
**per-variable** in compose — a variable absent from the list silently never reaches the container,
which is how `CLAUDISH_FAILOVER_*_RESET` was inert until `ffb7f39`.
