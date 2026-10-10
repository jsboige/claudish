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
- **`resp-*.sse`** — Response SSE with metadata header (elapsed_ms, stop_reason, event count). Correlates with req via shared counter (req-1-0042 → resp-1-r0042).
- **Archives** — `D:\claudish-captures\archive\captures-YYYY-MM-DD.7z` (LZMA2, ~100-130:1 ratio), mirrored to `G:\Mon Drive\Backups-Cloud\claudish\` via Google Drive Desktop (plain Windows file copy, no API; online-only — never pin that folder for offline access). Local retention 0 days: each local archive is deleted as soon as its GDrive copy is size-confirmed, so GDrive is the single home of history (2026-08-27 disk mandate; a DriveFS outage defers the purge, it never deletes unconfirmed).
- **Heavy analysis is host-saturating — schedule it.** Decompressing a weeks-old 7z and parsing 100k+ `req-*.json` pegs the hub host and produces the HUB-LENT signature (event-loop stall, gateway latency still clean) for minutes at a time. Measured: same signature as a crisis wave, yet with streams ≈ 1 it costs nobody anything. Rule: heavy capture analysis runs in the **05-07Z trough**, extracts to **D: never C:**, and is *expected + attributed* there — not a crisis.

## Turn autopsy (#328 G12)

**`scripts/turn-autopsy.py` answers a question no counter can: what KIND of turn was this?** The July-vs-now investigation (`jsboige/claudish#328`) is "×3.4 requests for ~half the PRs"; the counts decomposed the *what* (`ctx total ×6.13 = ×3.41 requests × ×1.80 harness floor`, 05/07 vs 30/09) and cannot reach the *why*, because the why is only in the bodies. This tool turns a 400-600 KB request body into a ~1.5 KB reading slice, so a reader classifies 50-100 turns/hour without opening a JSON by hand. It does **not** classify — it extracts, then aggregates the labels the reader wrote.

```powershell
# work-list for one era (a bounded, seeded sample)
python .\scripts\turn-autopsy.py sample --archive 'G:\Mon Drive\Backups-Cloud\claudish\captures-2026-07-05.7z' `
  --era july --n 50 --seed 328 --stratify lane --out worklist-july.jsonl
python .\scripts\turn-autopsy.py show      --worklist worklist-july.jsonl      # the reading slices
python .\scripts\turn-autopsy.py label     --worklist worklist-july.jsonl --out labels.jsonl
python .\scripts\turn-autopsy.py stats     --worklist worklist-both.jsonl      # trigger x era
python .\scripts\turn-autopsy.py aggregate --worklist worklist-both.jsonl --labels labels.jsonl
```

**The three axes are separate on purpose** (arbitration ai-01, 2026-10-08): `nature` (production · verification · coordination · navigation · context-repair · duplicate-restart · waiting-poll) × `result` (advanced · no-op · regression) × `confidence` (measured · inferred · uncertain). "Absence of mutation is not proof of ceremony" — a turn that produced no artefact is not therefore a wasted turn, and the grid forces that distinction instead of folding it into one label.

### Instrument traps, all measured

- **The lane comes out of the resp filename** — `resp-1-r0001-<ts>-<handler>-<model>.sse` — so stratification by lane is free, with no body parse. But the timestamp must be matched with a **strict shape** (`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`): a loose `(.+?)-([a-z0-9_.-]+)-(.+?)` split eats the timestamp itself (`T` and `Z` are outside the class), manufactures one "lane" per turn, and an allocation that forces a minimum per lane then turns `--n 50` into "extract 14 244 members". The tool prints the lane count **before** extracting: a lane count near the turn count is that bug.
- **The capture counter is NOT unique per day.** Measured on `captures-2026-07-05`: 10 498 `resp-*` files for **7 114 distinct counters** (`resp-1-r9997-…` appears twice with different timestamps) — the counter restarts across container restarts and `pid` is always 1 in a container. Since CR #424 the tool pairs by counter **and timestamp**: a resp pairs the LATEST req of its counter whose ts it follows, within a 20-min bound (real calendar arithmetic — digit concatenation reads a 1-ms hour rollover as ~4e7 units); homonyms outside the bound stay `unpaired`, never mispaired.
- **A counter with SEVERAL resps is an attempt chain, not ambiguity** (probe, CR #424): on 2026-07-05, 2 598 counters carry ≥2 resps, closest pairs p50 5 s apart on **different lanes** (`openai/glm-5.2` then `anthropic/MiniMax-M3`, or twice glm) — the cascade writes one capture per upstream attempt, and the attempt that serves the client is the LAST. The tool pairs the latest and counts the earlier ones as `attempts` (work-list field + stats block).
- **Pre-#98 captures carry `machine` but not `entrypoint` / `workload` / `device_id8`** (measured on the July archive). The tool returns `None` — the fields are never invented, so an era comparison must not read a `null` as "no entrypoint".
- **A solid archive pays one full block decompression per `7z e` call** (`Blocks = 1` on a daily pack), and the archive lives on DriveFS. Copy it local once (`--copy-local`, default for a non-`D:` path) and batch the members (`--reuse` skips extraction once the work-dir is populated).

### Pilot result (05/07 vs 30/09, n=49 + n=50, seed 328 — re-run on the CR-#424-corrected instrument)

| trigger (last message) | july | now |
|---|---|---|
| automatic (`todo-nudge`, `bg-notification`, `date-change`, `cron`) | **5 (10 %)** | **1 (2 %)** |
| `system-reminder` | 0 | 1 |
| tool-result | **37 (76 %)** | 22 (44 %) |
| human | 6 (12 %) | 6 (12 %) |
| `system` role | 1 | 20 (40 %) |

pairing: july 33 paired / 16 unpaired · now 50/0 — attempt-chained turns (**cascade burned ≥1 earlier upstream attempt**): **july 8/49, now 0/50**.

**The first pilot's headline is WITHDRAWN.** Its "17 (35 %) automatic July triggers" was an artifact of the pre-CR classification: ~12 of those were tool-result turns whose Bash output quoted `"Command running in background with ID:"` — the agent's own tool result, not a harness notification (CR #424 bloquant 2, the exact case the review named). On the corrected instrument the automatic share is 5/49 vs 1/50, and the old claim of a *constant* ~⅓ harness-driven share in both eras does not reproduce at this sample size: the last message is `system`-role in 6/49 July vs 21/50 now. Both eras' numbers moved more than any conclusion should — n≈50 reads direction, not magnitude, and the direction itself changed with the instrument. The ×3.4 question stays open; the pilot's calibrated job (instrument + sample size for the mass reading) is done.

What stands: the **lane count, 3 → 14** (July: `glm-5.2` 21, `MiniMax-M3` 10, `opus-4-8` 2; 30/09: `glm-5.3` 19, `MiniMax-M3` 15, `opus-5-5` 5, plus 9 single-turn lanes), and the **attempt-chain contrast** (8/49 vs 0/50) — July's cascade churned upstream attempts on a sixth of its turns, the now-era none. Treat both as hypotheses a larger sample must confirm, not as findings.

**Not done, and deliberately**: no mass reading. The grid is arbitrated but not yet validated against a second reader — ai-01's protocol calls for ~20 turns read twice, independently, with agreement/uncertainty published. The pilot's job was to calibrate the grid and to size the next sample; it does that and stops.

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
