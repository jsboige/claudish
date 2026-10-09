# Traffic analysis — full reference

**Deferred from `CLAUDE.md`.** The script table and the container/sidecar traps stay in `CLAUDE.md`; this file holds the capture format, attribution, and leak-diagnosis detail.

**Use the scripts, not hand-rolled grep.** The proxy log format has traps that produce false positives when grepped naively (see `proxy-log-monitoring` memory: `bytes=NNNN` matching error codes, timestamp digits matching `429`, `[msg:N]` body previews matching keywords). The scripts encode the precise filters.

## Pick the level

| Need | Script | Source | Speed |
|------|--------|--------|-------|
| **Live surveillance** (cron, quick health check) | `traffic-live.ps1` | `docker logs` stdout | fast |
| **Rich detail** (workspace, session, CC version, tokens) | `traffic-summary.ps1` / `traffic-sessions.ps1` | `req-*.json` captures | slower |
| **"Where's the Anthropic traffic from?"** (recurring leak question) | `traffic-anthropic.ps1` | `req-*.json` captures | slower |
| **Per-session live attribution** ("who pulls what, now") | `live-session-scan.py` | `req-*.json` captures | fast |
| **History** (past days from compressed archives) | `traffic-history.ps1` | `captures-*.7z` | slow |

## Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `traffic-live.ps1` | **Live analysis from docker logs** — model/machine/handler distribution, precise error counts, never-hang check, client-named Anthropic overview (descriptive only), session-loop detection. This is what the 6h surveillance cron runs. **`-Container` defaults to `claudish-proxy` (the hub name) — on a sidecar machine you MUST pass `-Container claudish-sidecar`, otherwise the script exits 1 with `No such container`.** | `.\scripts\traffic-live.ps1 [-Hours N] [-Container name]` |
| `traffic-summary.ps1` | Overview from captures: machines, models, workspaces, sessions | `.\scripts\traffic-summary.ps1 [-Hours N]` |
| `traffic-sessions.ps1` | Detailed session list with timing, models, data volume | `.\scripts\traffic-sessions.ps1 [-Hours N] [-All]` |
| `traffic-anthropic.ps1` | **Answers "where does the Anthropic traffic come from?"** — attributes every Anthropic-native (opus/fable) request by **machine + workspace** (workspace = proof, from the system prompt; not stdout). Per-request verdict: `[OK]` ai-01 · `[REVIEW]` po-2025 · `[INFO]` fable during a `-FableOverrideActive` window · `[LEAK-SUBAGENT]` rogue Opus sub-agent (`cc_is_subagent=true`, **exit 1**) · `[REVIEW-INTERACTIVE]` user-driven non-ai-01 session (exit 0). sonnet-4-6 shown separately (remapped to glm → not Anthropic). | `.\scripts\traffic-anthropic.ps1 [-Hours N] [-FableOverrideActive]` |
| `traffic-history.ps1` | Historical analysis from 7z archives | `.\scripts\traffic-history.ps1 [-Date yyyy-MM-dd] [-Days N]` |
| `live-session-scan.py` | **Per-session live attribution (#362)** — aggregates in-window `req-*.json` by session (user_id + session_id) with two flag classes: `OPENAI-SHAPED` (`gpt-\|codex\|-sol\|o3-\|o4-`, LEAK-grade — the OpenAI plan is last-chance, non-renewable credit) and `RETIRED-ID` (`claude-sonnet-4-6\|glm-5.2\|qwen3.6-35b-a3b`, INFO-grade — ids removed from the catalogs but still named by drifted client configs). Two-speed read: 6 KiB head + 16 KiB tail by default, `--deep` for the full JSON parse. | `python .\scripts\live-session-scan.py [--hours N] [--top N] [--models regex] [--deep] [--json]` |
| `compress-captures.ps1` | Nightly 7z compaction + GDrive backup + 30d local purge (scheduled task) | Runs automatically at 04:17 |
| `claudish-watchdog.ps1` | Proxy health: tool-call stream test + proactive restart (uptime >11h) + auto-recovery on hang. Scheduled every 15min. | Runs automatically |
| `CaptureUtils.psm1` | Shared module (capture parsing, device mapping, 7z extraction) | Imported by the scripts above |

## Quick commands

```powershell
# Live health check — what's happening right now?
.\scripts\traffic-live.ps1 -Hours 1

# Standard 6h surveillance window (cron default)
.\scripts\traffic-live.ps1 -Hours 6

# On a SIDECAR machine (ai-01, po-2024...) the container is not named claudish-proxy.
# Expect ~0 requests when the sidecar is NOMINAL: a relayed request writes no capture
# and emits no [Request] line, so local traffic analysis is blind by construction.
.\scripts\traffic-live.ps1 -Hours 3 -Container claudish-sidecar

# Rich detail: which workspace/session is active?
.\scripts\traffic-summary.ps1 -Hours 2
.\scripts\traffic-sessions.ps1

# Historical analysis from compressed archives
.\scripts\traffic-history.ps1 -Days 7
```

## Live session scan

**`live-session-scan.py` answers "who pulls what, right now" per SESSION** — the instrument the 2026-10-06 incident showed missing: a stopped "adjoint" CoursIA-2 session kept pulling `gpt-6-sol` on the OpenAI plan (last-chance, non-renewable gift-card credit) and nothing saw it continuously. It aggregates in-window `req-*.json` captures by `metadata.user_id` + `session_id`, sorts `OPENAI-SHAPED` sessions to the top, and digests both flag classes in one line. Reporting organ only — exit 0 even when flags are present; alarming is the caller's job.

```powershell
python .\scripts\live-session-scan.py                                     # last hour, top 20
python .\scripts\live-session-scan.py --hours 6 --models "gpt-|codex|-sol|o3-|o4-" --top 10
python .\scripts\live-session-scan.py --deep --hours 24                   # slow: full JSON parse
python .\scripts\live-session-scan.py --json                              # machine output
```

Measured traps (2026-10-06, 400 newest captures): `body.metadata` is serialized at the **tail**, never the head — its last `"metadata":{` occurrence sits 368-426 bytes before EOF, always after every message/tool block, so the fast pass reads a 6 KiB head (envelope model/machine + workdir hint) plus a 16 KiB tail where **last occurrence wins** (an echo inside message prose precedes the real block). 11.8% of files carry **no metadata block at all** (envelope `machine` empty too — SDK-shaped bodies); they stay countable in a dedicated `(no-metadata)` bucket instead of vanishing. `metadata.user_id` is a JSON-encoded string (`{"device_id","account_uuid","session_id"}`), so machine attribution comes from the envelope `machine` field. Fast and deep produce **identical session/model aggregates** (verified on a frozen 200-file sample); the one divergence is the workdir hint — its marker sits at p50 ~267 KB inside message 0, beyond the fast head, so `--deep` is the mode that recovers it. Fast pass measured on the hub host: 12 882 files over a 6 h window in ~1 min 50 s — and the honest caveat that comes with it: warm-cache `--deep` on the same window ran 1 min 29 s, so the fast pass's edge is **I/O volume** (~284 MB read vs ~9 GB for the full parse), which is what matters on a cold or contended host, not warm wall time.

## Capture format

- **`req-*.json`** — Envelope `{ts, src, machine, model, pid, device_id8?, entrypoint?, workload?, body}` wrapping the full Anthropic request body (messages, system, tools, metadata). Since #98 the envelope persists the attribution fields the proxy sees at capture time: `device_id8` (first 8 hex of `metadata.user_id`'s device_id), `entrypoint`/`workload` (`cc_entrypoint`/`cc_workload` from the billing-header system block — captured **before** the billing strip removes it for non-native providers). Absent = simply omitted; pre-#98 captures keep the body-regex fallback in the analysis scripts (`native-consumption.py`, `traffic-consumption.py` prefer the envelope fields). Still extractable from the body heuristically: workspace (most-cited path root), session_id (metadata.user_id), CC version (billing header). Written to `/captures` inside the container, bind-mounted to `D:\claudish-captures` (persists across container recreates).
- **`resp-*.sse`** — Response SSE with metadata header (elapsed_ms, stop_reason, event count). Correlates with req via shared counter (req-1-0042 → resp-1-r0042). The label is the **parser** id, not the provider billed (`[resp] anthropic` for a GLM on the anthropic wire). **Coverage is an invariant, not a best effort**: every module in `handlers/shared/stream-parsers/` that owns a client stream (`*-sse.ts`, `*-jsonl.ts`) taps `createResponseCapture` — `lane-capture-coverage.test.ts` fails on a new parser that does not, because an unwired lane is **indistinguishable from a silent one** (every script here infers "no traffic" from the absence of a file; that is how the responses lane read as idle from 28/08 to 12/09). Wired: `anthropic` (covers the native pass-through too), `openai`, `responses`, and since 2026-10-09 `gemini` + `ollama`. The tap is at `controller.enqueue`, so a capture is the translated stream the client actually received and is replayable as a fixture. A **relay in NOMINAL** writes nothing locally on purpose — the hub captures centrally.
- **Archives** — `D:\claudish-captures\archive\captures-YYYY-MM-DD.7z` (LZMA2, ~100-130:1 ratio), mirrored to `G:\Mon Drive\Backups-Cloud\claudish\` via Google Drive Desktop (plain Windows file copy, no API; online-only — never pin that folder for offline access). Local retention 0 days: each local archive is deleted as soon as its GDrive copy is size-confirmed, so GDrive is the single home of history (2026-08-27 disk mandate; a DriveFS outage defers the purge, it never deletes unconfirmed).
- **Heavy analysis is host-saturating — schedule it.** Decompressing a weeks-old 7z and parsing 100k+ `req-*.json` pegs the hub host and produces the HUB-LENT signature (event-loop stall, gateway latency still clean) for minutes at a time. Measured: same signature as a crisis wave, yet with streams ≈ 1 it costs nobody anything. Rule: heavy capture analysis runs in the **05-07Z trough**, extracts to **D: never C:**, and is *expected + attributed* there — not a crisis.

## Machine attribution

Machines are identified by the `X-Claudish-Machine` header (set via `ANTHROPIC_CUSTOM_HEADERS` in Claude Code settings). When missing, `CaptureUtils.psm1` falls back to device_id fingerprinting. Known device IDs are hardcoded in the module's `$DeviceMap` (currently partial — po-2023 + ai-01 only; update when new machines are seen without the header).

## Anthropic leak diagnostics

By cluster policy, **Anthropic-billed models (Opus, Fable, Sonnet) must come from `myia-ai-01` only**.

**For the recurring "where is the Anthropic traffic coming from (machine + workspace)?" question, use `traffic-anthropic.ps1`** — it attributes each Anthropic-native request to its machine AND workspace (the workspace is the proof, read from the system prompt in the capture, not stdout), and — crucially — it splits a non-ai-01 hit into `[LEAK-SUBAGENT]` (a rogue Opus sub-agent, `cc_is_subagent=true`, the dangerous kind → exit 1) vs `[REVIEW-INTERACTIVE]` (a user driving their own interactive session on their own machine → exit 0, not alarmed). That split is what stops the tool from crying wolf on legitimate dev sessions.

`traffic-live.ps1` prints only a **descriptive** client-named Anthropic overview (which machines named `claude-*` ids this window). It emits **no verdicts**: a client-named model id is remapped by the cascade and is not a billing attribution, so the old OK/REVIEW/LEAK tags were false positives by construction in relay topology (measured 2026-09-25 — the stdout `[Request]` line carries the client's requested id, and the proxy holds no Anthropic credential to bill anything). Verdicts live in the capture-based tools above, never in the stdout pass.

**Sub-agent leaks vs legitimate sessions** — the distinction that matters:
- **Real sub-agent leak** = requests carry `cc_is_subagent=true` (in the billing header, *not* on the stdout `[Request]` line) + Anthropic model + non-authorized machine. The Agent tool spawns sub-agents that default to "best available" = Opus.
- **Legitimate Anthropic session** = `agent-sdk/X` + entrypoint `claude-vscode` + same source IP across requests + `msgs=60+` (large context = main session, not sub-agent). No `cc_is_subagent`.

`cc_is_subagent` lives in the request body, not stdout — so it's not visible via `docker logs` alone. To confirm a sub-agent leak, inspect a capture:
```bash
# Find the billing header in a suspect capture
docker exec claudish-proxy sh -c "head -c 500 /captures/req-1-NNNN-*.json"
# Look for: cc_is_subagent=true  → sub-agent. Absent → main session (not a leak).
```

**Fix for a confirmed leak:** add a global rule in `~/.claude/rules/` instructing the model to always specify `model: "sonnet"` (or equivalent) when spawning sub-agents, reserving Opus for genuinely complex tasks. This is client-side behavior — not fixable in the proxy.
