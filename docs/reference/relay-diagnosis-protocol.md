# Relay and hub diagnosis protocol — rules earned by incident

For the agent who has to decide, on any machine of the fleet, whether its sidecar is actually relaying, whether the hub is alive, why a turn was lost, or whether a change to the relay path worked. Every rule below was learned the hard way on a live seat and is stated with the incident that earned it. The mechanism — how the forward is built, which headers travel, how the drain works — lives in `docs/reference/relay-internals.md`; this page is the reading discipline layered on top of it.

## How to use this page

Rules are grouped by the moment they apply: proving a mode, reading health, attributing a request, deciding the hub is down, validating a change, and reading a series of episodes. Terms: a **hub** is the one node with `CLAUDISH_RELAY_UPSTREAM` unset; a **sidecar** sets it and runs in **NOMINAL** (forwarding to the hub) or **AUTONOMOUS** (serving locally after hysteresis); an **episode** is one NOMINAL→AUTONOMOUS→NOMINAL window; a **capture** is the `req-*.json` / `resp-*.sse` pair a locally-served request writes; the **deep probe** is the real tool-call stream the relay must see end in `message_stop` before it returns to NOMINAL.

## Proving which mode served a request

### Read the status code before you read a mode verdict

**Why.** Two failures of method cost a full outage on ai-01 on 2026-08-10. On 11/08 a mode probe was run with the provider key instead of the proxy key: four `401`. The test — "do the captures stay invariant?" — still printed **NOMINAL**, because a request rejected at the auth gate writes no capture in NOMINAL *any more than* in AUTONOMOUS. A reassuring verdict with zero discriminating power. Re-run with `CLAUDISH_PROXY_KEY`: four `200`, captures 6→6, and only then was the verdict valid. The post-outage probe of 10/08 had the same shape: a `curl` with no `authorization`, against a bug that destroyed the credential it did not carry.

**Apply.** Take the key from the container, never from `~/.claudish/config.json` (which holds *provider* keys); never echo it:

```bash
KEY=$(docker inspect claudish-sidecar --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CLAUDISH_PROXY_KEY=//p')
curl -s -o /dev/null -w '%{http_code}\n' -H "x-proxy-key: $KEY" -H 'content-type: application/json' \
  -d '{"model":"<client id>","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}' \
  http://localhost:3002/v1/messages
```

Any non-2xx verdict is discarded, not interpreted — including a 4xx that "looks like the hub". This probe is a real, billed request: on this fleet a probe that consumes budget goes through a `[PROPOSAL]` first (`.claude/skills/claudish-coordinate/SKILL.md` §Phase 5b — Contrôle des gestes).

### On a NOMINAL sidecar the `[ttft]` line is the volume and its `reqN` is stale — the loop alarm is an artifact

**Why.** Measured 2026-09-11 on ai-01's sidecar: `traffic-live.ps1 -Hours 6` announced **0 request / 0 response** and, in the same output, `reqN=6 x246 (review for loop)`. Both statements are true. The relay branch returns before `logRequest`, so a relayed request emits no `[Request]` line and writes no capture — but it does emit **one `[ttft]` per forwarded stream**. `reqN` is never advanced on that path, so it keeps its last local value (6, set on 10/09 at 19:38Z); `traffic-live.ps1`'s Session Loop Check counts repetitions at ≥6 and calls it a loop.

**Apply.** On a sidecar, count `[ttft]` lines for volume and ignore the loop check while the mode is NOMINAL. `model=` on those lines is the client's requested id, pre-remap — never a billing attribution.

```bash
docker logs --since 6h claudish-sidecar 2>&1 | grep -c '\[ttft\]'
```

## Reading health

### A healthcheck answers "this process is alive", not "the engine works"

**Why.** 2026-09-12 17:02:21Z: an inference engine was wedged with the signature `health=200 decode=000 (24 tok >40s)` — the API answered perfectly while the engine produced no token; the restart warmed in 10 minutes. Probing `/health` by hand returned **200 in 3.9 ms**, which is exactly the signal the watchdog proves blind. Two false signals sat in the same measurement: that 200, and a `401` on `/v1/models` that is the expected auth rather than a fault. And one wedge does not explain a series — over `10:16:38Z → 17:15:11Z` (795 OK probes) there was one wedge while two condensations had failed.

**Apply.** A liveness check that matters must produce **output under a time bound**, not a status code: N tokens within T. The relay already does this — its recovery probe is a tool-call stream that must reach `message_stop` — and a `/health` that only reports liveness must not be promoted to "serving". When a status code and an output probe disagree, the output probe is the verdict.

## Attributing a request to a machine

### Identify an unknown request by its body and its trigger, never by its IP or its model id

**Why.** An "external actor" in the hub corpus resolved to a relay recovery probe: `max_tokens: 100`, tools `Bash` and `Read`, a single user message — "List the current directory using Bash. Do it now." — and no system prompt; four such probes in the day, each ending in `message_stop`. The IP was the site's own published A record, i.e. a LAN device hairpinning, not an intruder. The model cannot carry the identification: on 2026-10-25, 371 `[ttft] glm-5.3` lines in 5.6 h (12 % of turns) came with **zero** AUTONOMOUS episodes — a client lane naming a provider id, not probes — and since #613 the probe's model is a role-shaped id by default (`CLAUDISH_RELAY_PROBE_MODEL`, `glm-5.3` only as `CLAUDISH_RELAY_PROBE_FALLBACK_MODEL`), so the same body now travels under two different ids.

**Apply.** Count the trigger first: probes exist only on resumption, so **0 lines ending `→ AUTONOMOUS` ⇒ 0 probes**, whatever the model says. Then read the body (tool names, one message, no system, `max_tokens`), and resolve the site's own A record before reading an IP as external (`docs/reference/traffic-analysis.md` §Machine attribution).

### Read every field of a probe reply — on a multi-tenant hub a handler-held value can belong to another session

**Why.** 2026-10-18 (#518): a probe against the hub was green on the field it was proving, and the same response carried `message_start.usage.input_tokens = 166322` for a 233-token request. Handlers are cached **per target model**, so "the previous turn" the usage seed reads was another session's turn. Nobody had seen it because probes only read the field they are proving. Upstream claudish is a single-client local proxy; the fork made it a multi-session hub, so every piece of state on a handler or a module singleton is a candidate cross-session leak.

**Apply.** Glance at **all** usage fields and every block of a probe reply, not just the one under test. In review, any new field on `ComposedHandler`, `TokenTracker` or a module singleton gets one question — "keyed by session or global?" — and the session seam is `extractSessionKey` (`packages/cli/src/fork/failover.ts`).

## When the hub looks down — or the wrong hub answers

### Before you charge a flap to the hub, look for a second seat's flap on the same second — and at your own host

**Why.** On 2026-08-30 an episode was published as hub reachability; it fell **six minutes before the local host stopped dead**, and the driver storm began ~5 min *after* the episode ended — no mechanism is established, so the attribution was withdrawn and not replaced. The counter-case settles the direction: on 2026-09-29 the seat's own local load was proposed as the cause of a sidecar episode, and po-2023's relay had flipped `04:36:13→04:37:27Z`, **to the second**, from another host — two independent heartbeats falling together means the hub, an isolated one means the path or the seat.

**Apply.** Three reads before any attribution: (1) the local host over the same window — System events `1074`/Kernel-Power, boot time, Docker exits; (2) another relay's transitions on the same second; (3) a known external cause — an announced deploy or recreate, or the watchdog's proactive restart. A capture gap corroborates only at high throughput: after 05:00Z at ~0.5 evt/s, 10-second holes are ordinary.

### Source the entry's canonical name before you name an entry outage

**Why.** 2026-10-26: a cycle health check typed a hostname that exists nowhere in the repository or the inventory. `NXDOMAIN` on two public resolvers, apex resolved, local DNS healthy — and the standing rule "an outage detected is escalated in the same cycle" pushed toward posting it. It was not an outage: the canonical entry answered 200 at that moment. The name had been invented, and the probe was measuring the wrong address, not the wrong service.

**Apply.** Read the canonical entry name from `docs/deployment/fleet-state.md` (the matrix of record) before probing it. An `NXDOMAIN` on a name you cannot source is a **non-signal**; "I find no trace of the entry" means "I am testing the wrong address" first, and only a name you sourced can carry an escalation.

## Validating a change to the relay path

### Name the population your validation covers — request class, host class, credential shape — before calling a deployment validated

**Why.** Three measured ways to validate the wrong population. **Request class** (2026-08-10): the sidecar was validated with a model the bug spared, on the one machine the bug killed. **Host class** (2026-08-20): the repoint's success on ai-01 — five native Opus answers served in AUTONOMOUS during a real outage — held only because `CLAUDISH_NO_ANTHROPIC` was **empty** there; on the other seats it was set, and the same request in AUTONOMOUS was refused with a 503 because their profiles mapped no budget model to reroute to (`noAnthropicDecision` in `packages/cli/src/proxy-server.ts`: a mapped sonnet reroutes, none refuses). **Credential shape** (2026-10-20): a canary carrying no credential at all received a 403, and the conclusion drawn was "only ai-01 can serve Anthropic"; the canary had measured one shape of the auth guard, not an authenticated client — po-2028's refusals came from a stray `ANTHROPIC_API_KEY` in its `settings.json`.

**Apply.** Before writing "validated", state the three populations and test inside them; for a repoint, check the target's failover prerequisites by **presence** (a role mapping covering the native lane), not by value. And read where the client actually goes — enumerate `settings.json`, the container env, `netsh interface portproxy show all` and the firewall rules, and read each **target**: on 2026-08-20 a port-forward rule read as covering one lane pointed at the hub's proxy, not the local sidecar: it read as "protected" and was not.

### A route you configured is not a route in use — count its traffic before you promise it

**Why.** 2026-09-08: a vLLM lane resolved and served correctly, and had **1 request out of 677** local captures (counter `r0006`, i.e. a manual test) and **0** files in the whole hub corpus. The documented bare prefix `vllm@` resolves through `VLLM_BASE_URL`, whose documented default is `http://localhost:8000` — a port nothing on that seat listened on — so the documented form pointed at a dead route while the explicit `endpoint@model` form worked. Separately, `claudish --probe` is a **real request** (`max_tokens: 1`): cheap, not free.

**Apply.** Before delegating work to a lane, count its captures in the corpus that can see all of it (`docs/reference/traffic-analysis.md`), and prefer the explicit `endpoint@model` form, which inherits nothing. Verify wiring with `claudish --probe <model>`, and report it as a request you paid for.

## Flaps, lost turns, and what they cost

### There are two independent flap layers; the relay's is the one that moves traffic onto a node that pays

**Why.** On 2026-09-11 a mandate to amortize the provider "yoyo" described it as a budget-failover problem. Two layers exist: budget failover arms on a single qualifying 429 and disarms on a short fixed timer (10 min on the first rung); the relay's hysteresis flips NOMINAL→AUTONOMOUS after **2 consecutive `/health` failures at a 10 s interval** — ~20 s of unreachability. Measured that day at 10:36Z on ai-01: a **98 s** relay episode while the hub was alive without interruption; the request flipped, met a `[GLM Coding] 429` on the local path, and the client retried 8 times in 74.8 s without succeeding — the turn lost, from the layer the ticket did not describe. The same layer costs money: over a 5 h window, the traffic of the machines pointed at the relay was served during AUTONOMOUS windows by a local cascade descending to PAYG — **494 `ds@` requests, 80.5 M input tokens in 3.3 h** — against **80 forward failures in 5 h** on a hub answering 200 in 4 ms.

**Apply.** When a flap is to be amortized, name the layer the loss came from (a `[Relay] … → AUTONOMOUS` line, or a `[Failover]` arm/wall line) before touching a knob, and do not let a fix on one layer close the issue. And arm the sidecar: a role with no armed step does not degrade, it **closes** — 100 % of that role's requests fail, with no next step to walk.

### A capture trail records your decision, never the peer's state — and it is a lower bound, so qualify the series before publishing it

**Why.** 2026-08-22: a series of **21 AUTONOMOUS episodes** was reconstructed from ai-01's captures and published; ten minutes later, two messages unread in the inbox for two days held the exclusions — four `docker compose up -d` by the hub's owner that day (75 of the 285 requests sat in three of the windows) and a then-daily 02:00Z hub restart predicted to the second, which the series listed as a failure. Later the same day the title itself proved too generous: **two mechanisms write a capture** — a real flip (`[Relay] upstream … DOWN after 2 failure(s) (heartbeat) → AUTONOMOUS`) and an isolated forward failure (`[Relay] forward failed (connect: AbortError) → this request served LOCALLY [1/2 …]`), which serves locally and captures **while the mode stays NOMINAL**. Over 20/08 20:26Z → 22/08 17:45Z: **4 real flips against 15 isolated forward failures**, 14 of them at `[1/2]`. A "15 min of silence" clustering rule welded five independent `[1/2]` failures into a false 24-minute episode — choosing a grouping threshold is choosing how many events you will see. And the series only holds the episodes during which you were emitting traffic: a hole is not a healthy period.

**Apply.** Count only lines that **end** with `→ AUTONOMOUS`; read `[Relay] forward failed …` as served-locally, not a flip; never call a one-request episode a brief outage — it is the weakest signal there is. Before publishing a series, ask the owner of the observed system for its deploy and restart windows; "I flipped N times" is measured, "the hub went down N times" is not, until each episode meets one of those windows.

## Already covered elsewhere in this repository

| Lesson | Where |
|---|---|
| A 200 never proves the relay: in NOMINAL the branch returns before `logRequest`/capture, so assert the mode by the **absence** of a local `[Request]` line and of a capture file | `docs/reference/traffic-analysis.md` §Quick commands · `docs/deployment/relay-sidecar-deployment.md` §Troubleshooting — Docker cannot reach the LAN hub |
| Counting episodes by grepping `AUTONOMOUS` overcounts ~6× (the string also rides `[x/2 before AUTONOMOUS]`), and copying the visual arrow into the pattern silently matches nothing — anchor on the word alone | `docs/reference/traffic-analysis.md` §Traffic Analysis & Anthropic Policy |
| Capture files are not a count of mode switches (~30× over-count measured); a request served locally after a header timeout captures exactly like an AUTONOMOUS one | `docs/reference/relay-internals.md` §Relay / Sidecar Mode — Two capture variables |
| The heartbeat bound is a per-seat knob; on a WAN upstream the 4 s default manufactures outages (`CLAUDISH_RELAY_HEARTBEAT_TIMEOUT_MS`, range 2000–9000) | `docs/reference/relay-internals.md` §Relay / Sidecar Mode — heartbeat bound (#711) |
| A gap in the capture series is a detector, never a classifier — simultaneity across machines and an actor named by its own log do the attributing | `docs/reference/traffic-analysis.md` §Machine attribution |
| A missed heartbeat is an observer event until the hub journal corroborates it (log density, `[Request]` lines from the observer's host, ttfts, loop gauges) | `docs/reference/relay-internals.md` §2026-11-01 — two missed heartbeats |
| The entry probe says **which layer** is down (`ENTRY-DOWN` / `PATH-BROKEN` / `FACADE-502-ONLY` / `ENTRY-UNRESPONSIVE` / `PROBE-BLIND` / `UNKNOWN`) — one probe cannot tell "hub dead" from "path dead" | `docs/reference/relay-internals.md` §The entry probe's mode-dependent verdicts · `scripts/hub-entry-probe.py` |
| A healthy hub can be the wrong hub: loop topology is detected by `instanceId` and `x-claudish-hops`, and the self-heal is what made the 2026-09-19 recursion last 4 h 40 with every consumer-side instrument green | `docs/reference/relay-internals.md` §Relay / Sidecar Mode — Loop topology · `CLAUDE.md` §Fleet-Rollout Verification |
| `machine` empty marks a client that presented no identity header — nothing more; it is never, on its own, a stranger (measured 31/964, 2026-10-09) | `docs/reference/traffic-analysis.md` §Machine attribution |
| The hub's idle floor is zero (92 364 samples: 4.62 % at zero, lulls mean 5.9 s), so a drain holds a true-zero wait first and only then relaxes | `docs/reference/never-hang.md` §Never-Hang Constraints · `scripts/claudish-drain.ps1` |
| A relayed request emits one `[ttft]` per forwarded stream and nothing else — that is the only local sight of forwarded volume (~100× undercount if you count `[Request]`), and `model=` there is the client's id | `docs/reference/traffic-analysis.md` §Traffic Analysis & Anthropic Policy |
| An "ignored" header is not a stripped header — a transparent passthrough still sends it upstream (#282/#289); check the names at the exit with a fetch stub, never the logic that ignores them | `docs/reference/relay-internals.md` §Relay / Sidecar Mode — cluster key · `CLAUDE.md` §Relay / Sidecar Mode |
| A role with no armed step does not degrade, it closes; arm the sidecars too | `docs/reference/budget-failover.md` §Failover targets on sidecars; armed state by value · `CLAUDE.md` §Budget Failover |

## Provenance

| Rule | Source note (ai-01 memory slug) | Dated |
|---|---|---|
| Read the status code before you read a mode verdict | `validate-on-the-traffic-class-that-breaks` | 2026-08-10 · 2026-08-11 |
| On a NOMINAL sidecar `[ttft]` is the volume and its `reqN` is stale | `relay-nominal-emits-ttft-with-stale-reqn` | 2026-09-11 |
| A healthcheck is not an engine | `health-200-is-not-engine-liveness` | 2026-09-12 |
| Identify an unknown request by its body and its trigger | `relay-deep-probe-has-a-body-signature` | 2026-09-29 · 2026-10-25 |
| Read every field of a probe reply | `single-client-state-leaks-on-the-hub` | 2026-10-18 |
| A flap is charged to the hub only against a second seat | `relay-down-can-originate-locally` | 2026-08-30 · 2026-09-29 |
| Source the entry's canonical name first | `wan-entry-requires-proxy-key` | 2026-10-26 |
| Name the population your validation covers | `validate-on-the-traffic-class-that-breaks` · `repointing-to-sidecar-does-not-generalize` · `a-credentialless-canary-measures-shape-a` | 2026-08-10 · 2026-08-20 · 2026-10-20 |
| A configured route is not an exercised route | `vllm-route-configured-but-unexercised` | 2026-09-08 |
| Two independent flap layers, and the relay's layer moves traffic onto a node that pays | `two-independent-flap-layers` | 2026-09-11 |
| A capture trail records your decision and is a lower bound | `capture-trail-records-my-decision` | 2026-08-22 |