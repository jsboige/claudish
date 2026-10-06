<#
.SYNOPSIS
  Split-brain / ghost-session scan for a Claude Code host (read-only).

.DESCRIPTION
  Answers three questions a fleet operator actually asks, each from a source
  that is authoritative for that question — never from a proxy signal:

    1. Which Claude sessions are LIVE on this machine right now?
       Source: transcript files under <ProjectsRoot>\<project>\<session>.jsonl,
       by mtime. A session id spread over MORE THAN ONE file is flagged
       DUPLICATE — the one shape a split brain leaves behind at rest, since a
       single live session owns exactly one transcript.

    2. Which processes are behind them, and did anything double-fire?
       Source: ONE unfiltered Win32_Process snapshot (CIM, not Get-Process —
       the latter fails silently on VS Code "utility-node" parents and invents
       ghost parents, measured 2026-10-04 po-2024). A claude.exe carries NO
       session id in its command line when VS Code spawns it (--output-format
       stream-json stdio), so process->session mapping is impossible by
       design: the session check is (1), the process check is the double-fire
       signature — THE SAME COMMAND STARTED TWICE BY THE SAME PARENT in the
       window — never a same-name burst: one Claude Code session legitimately
       launches several MCP servers at once (launcher+server node.exe each,
       DISTINCT command lines), so any name/threshold burst is in permanent
       alarm on a real host (measured on ai-01, review #342: rc=1, 20
       PROCESS-BURST flags on a healthy machine — 21:06:27Z session start,
       3 MCPs = 6 node.exe under explorer.exe); and never a
       same-command-different-parent burst either: after a host reboot + VS
       Code update, ELEVEN restored windows each launched an identical
       450-char claude.exe command under ELEVEN DISTINCT Code.exe parents and
       the (name, command) key flagged them all (rc=1, 35 flags, 2026-10-05
       20:40:17-20:41:54Z) — the parent pid joined the key after that. The
       single snapshot also serves root-ancestor
       resolution for the display — a per-process filtered query costs
       ~1.5 s each and a 40-process scan spent a minute on them (review #342).

    3. Are the scheduled launchers sane?
       Source: Get-ScheduledTask, EVERY action of each task (a task with
       several actions is inspected on each — a first-action-only read misses
       a direct claude launch hidden as action #2, review #342). Flags: an
       action launching `claude` WITHOUT the VBS/PowerShell indirection
       (repointing/leak signature, doctrine 2026-09-27), several actions
       sharing one target (real duplication — COUNT BY ACTION, NEVER BY NAME:
       one task with three triggers prints three identical rows in
       schtasks /v and is NOT a duplicate, measured 2026-10-05 po-2025), and
       a failing LastTaskResult in ANY state. Result codes are INTERPRETED,
       never tested by `!= 0`: 0x800710E0 (MultipleInstances=IgnoreNew refused
       a second start while the previous instance still runs, #199/#205) and
       0x41301 (SCHED_S_TASK_RUNNING) are benign; anything else non-zero
       flags — a Ready task whose last run died (LastTaskResult=1) is exactly
       the "ghost cron fails on every tick" shape the old Running-only test
       could not see.

  READ-ONLY. No process, service, task or file is modified. A detector that
  acts on what it finds is the #173 shape (teardown without rebuild). The
  suite pins this with an AST guard.

  ⚠ Coverage limit, printed in the report: a NON-ELEVATED run is blind to
  SYSTEM-owned tasks (the #169 trap — an empty result is indistinguishable
  from absence). Run elevated for full task coverage; the session and process
  sections are complete either way.

  Exit codes: 0 = all three sources read, no flag · 1 = flags found ·
  2 = INCOMPLETE — a source was unreadable (ProjectsRoot absent, Win32_Process
  query failed, Get-ScheduledTask failed), so its section is blind and "no
  flag" there is a non-verdict. 2 outranks 1: a cron wrapper must never
  mistake blindness for clean.

  PROCESS-BURST flags a DOUBLE-FIRE only — the same command line started
  twice BY THE SAME PARENT within BurstWindowSec — because a burst of
  DISTINCT commands is what every healthy session start looks like, and the
  same command under distinct parents is what a VS Code window restore looks
  like (both measured on ai-01, review #342). A process whose command line is
  unreadable (access denied, non-elevated) is never grouped: two unknowns are
  not equal.

  Flags carry ISO 8601 UTC timestamps (machine-local times drift across hosts
  and against the hub's UTC logs).

.PARAMETER ActiveMinutes
  Transcript mtime window that counts as "live". Default 30.

.PARAMETER BurstWindowSec
  Birth window for the PROCESS-BURST double-fire signature: two or more
  processes launched BY ONE PARENT with an IDENTICAL command line within this
  many seconds. Default 3. A machine-wide co-birth count is ALSO printed
  unconditionally — raw visibility, no threshold.

.EXAMPLE
  pwsh -File scripts/split-brain-scan.ps1
  powershell -ExecutionPolicy Bypass -File scripts/split-brain-scan.ps1 -ActiveMinutes 120
#>
[CmdletBinding()]
param(
    [int]$ActiveMinutes = 30,
    [string]$ProjectsRoot = (Join-Path $env:USERPROFILE '.claude\projects'),
    [int]$BurstWindowSec = 3
)

$ErrorActionPreference = 'Continue'
$now = Get-Date
$flags = New-Object System.Collections.Generic.List[string]
$incomplete = New-Object System.Collections.Generic.List[string]

function Write-Section([string]$t) { Write-Output ''; Write-Output ("=== " + $t + " ===") }

# ---------------------------------------------------------------- 1. sessions
Write-Section "LIVE SESSIONS (transcripts touched in the last $ActiveMinutes min)"
$live = @()
if (Test-Path -LiteralPath $ProjectsRoot) {
    foreach ($proj in (Get-ChildItem -LiteralPath $ProjectsRoot -Directory -ErrorAction SilentlyContinue)) {
        foreach ($f in (Get-ChildItem -LiteralPath $proj.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)) {
            $age = ($now - $f.LastWriteTime).TotalMinutes
            if ($age -le $ActiveMinutes) {
                $live += [pscustomobject]@{
                    Session = $f.BaseName
                    Project = $proj.Name
                    AgeMin  = [math]::Round($age, 1)
                    SizeMB  = [math]::Round($f.Length / 1MB, 2)
                }
            }
        }
    }
} else {
    # Absent root = the whole section is blind, not "no sessions": the default
    # path can be reallocated by an env change, and an OK verdict built on an
    # unread source is the false-clean shape exit 2 exists for (review #342).
    $incomplete.Add("transcripts (no ProjectsRoot at '$ProjectsRoot')")
}
if ($live.Count -eq 0) {
    Write-Output "  (none)"
} else {
    $live | Sort-Object AgeMin | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
}

# the one at-rest split-brain shape: one session id, several transcript files
$dupes = $live | Group-Object Session | Where-Object { $_.Count -gt 1 }
foreach ($d in $dupes) {
    $flags.Add("DUPLICATE-SESSION: session $($d.Name) is live in $($d.Count) transcript files: " + (($d.Group | ForEach-Object { $_.Project }) -join ', '))
}
Write-Output ("  live sessions: {0}   distinct ids: {1}" -f $live.Count, ($live | Select-Object -ExpandProperty Session -Unique).Count)

# --------------------------------------------------------------- 2. processes
Write-Section "PROCESSES (claude / node / bun) and birth bursts"
$snap = @()
try {
    $snap = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    Write-Output ("  (Win32_Process query failed: " + $_.Exception.Message + ")")
    $incomplete.Add('Win32_Process (process section blind)')
}
$allProcs = @{}
foreach ($p in $snap) { $allProcs[[int]$p.ProcessId] = $p }
$procs = @($snap | Where-Object { $_.Name -match '^(claude|node|bun)(\.exe)?$' })

function Get-RootAncestor([int]$procId) {
    # Walks the ONE snapshot — no per-process CIM round-trip. A parent pid
    # absent from the snapshot is gone-or-protected: the topmost reachable
    # node IS the root and is named. (The original branch queried the missing
    # parent and its catch was dead code — a filtered Win32_Process query for
    # a dead pid returns $null, it does not throw, so the "gone" case rendered
    # as an empty name; review #342.)
    $seen = @{}
    $cur = $procId
    while ($allProcs.ContainsKey($cur)) {
        if ($seen.ContainsKey($cur)) { return ("(cycle:" + $cur + ")") }
        $seen[$cur] = $true
        $par = [int]$allProcs[$cur].ParentProcessId
        if (-not $allProcs.ContainsKey($par)) {
            return ($allProcs[$cur].Name + "(" + $cur + ")")
        }
        $cur = $par
    }
    return ("(gone:" + $cur + ")")
}
$rows = @()
foreach ($p in $procs) {
    $rows += [pscustomobject]@{
        Pid       = [int]$p.ProcessId
        ParentPid = [int]$p.ParentProcessId
        Name      = $p.Name
        Started   = $p.CreationDate
        Cmd       = ("" + $p.CommandLine).Trim()
        Root      = (Get-RootAncestor ([int]$p.ProcessId))
    }
}
$rows | Sort-Object Started | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
Write-Output ("  total: {0}" -f $rows.Count)

# PROCESS-BURST = what a double-fire IS: THE SAME LAUNCHER starting THE SAME
# COMMAND twice in the window. Key = (parent pid, Name, command) — review
# #342, second pass. The first rework keyed on (Name, command) alone and the
# ai-01 live run refuted it: after the 19:56Z host reboot + VS Code update,
# ELEVEN restored windows each launched a Claude Code panel between
# 20:40:17 and 20:41:54Z — eleven claude.exe with the SAME 450-char command
# line (VS Code puts no session id on it) under ELEVEN DISTINCT Code.exe
# parents: 35 PROCESS-BURST flags, rc=1 at both interpreters, on a healthy
# machine. Measured on the same snapshot: (Name, command) groups 11 of them,
# (parent, Name, command) groups 0. A double-fire is the same LAUNCHER doing
# the same thing twice — an extension host opening two identical panels, a
# claude.exe launching one MCP server twice, two identical actions under one
# Schedule service — all still caught; two windows each restoring their panel
# is not that shape. The arguments are kept in the FLAG, exactly as DIRECT
# does; only equality is tested. Threshold 2: any second launch of an
# identical command by the same parent inside the window is a duplication,
# never a burst of distinct commands.
# A process whose CommandLine is UNREADABLE (access denied, non-elevated — 3
# on ai-01) enters NO equality group: "unavailable" is a rendering, not an
# identity, and two unknowns are not equal.
$groupable = @($rows | Where-Object { $_.Cmd })
foreach ($g in ($groupable | Group-Object ParentPid, Name, Cmd)) {
    $sorted = $g.Group | Sort-Object Started
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $j = $i
        while (($j + 1) -lt $sorted.Count -and (($sorted[$j + 1].Started - $sorted[$i].Started).TotalSeconds -le $BurstWindowSec)) { $j++ }
        if (($j - $i + 1) -ge 2) {
            # UTC ISO timestamp: machine-local times drift across hosts and
            # against the hub's UTC logs (review #342). The message is built
            # before Add(): `"..." -f a, b, c` inside a method call parses as
            # several Add() arguments and -f gets one arg for four
            # placeholders (measured 2026-10-05).
            $ts = ([datetime]$sorted[$i].Started).ToUniversalTime().ToString('o')
            $msg = "PROCESS-BURST: {0} x identical {1} command born within {2}s under parent {3} (first {4}) -> {5}" -f (($j - $i + 1), $sorted[$i].Name, $BurstWindowSec, $sorted[$i].ParentPid, $ts, $sorted[$i].Cmd)
            $flags.Add($msg)
            $i = $j
        }
    }
}

# Machine-wide co-birth count, printed unconditionally (info, never a flag):
# the per-parent grouping above answers "did ONE launcher start the same thing
# twice" and deliberately does NOT see the same command spawned by different
# parents — the legitimate VS Code window-restore shape (05/10) — so the raw
# number is what keeps that shape visible without flagging it.
$allSorted = @($rows | Sort-Object Started)
$maxCo = 0
for ($i = 0; $i -lt $allSorted.Count; $i++) {
    $j = $i
    while (($j + 1) -lt $allSorted.Count -and (($allSorted[$j + 1].Started - $allSorted[$i].Started).TotalSeconds -le $BurstWindowSec)) { $j++ }
    if (($j - $i + 1) -gt $maxCo) { $maxCo = ($j - $i + 1) }
}
Write-Output ("  machine-wide max co-births within {0}s (all roots): {1}" -f $BurstWindowSec, $maxCo)

# ------------------------------------------------------------------ 3. tasks
Write-Section "SCHEDULED TASKS (launcher shape and duplication)"
$tasks = @()
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop
} catch {
    Write-Output ("  (Get-ScheduledTask failed: " + $_.Exception.Message + ")")
    $incomplete.Add('Get-ScheduledTask (task section blind)')
}

# ONE ROW PER MATCHING ACTION (review #342): a task with several actions is
# inspected on each — the first-action-only read missed a direct claude launch
# sitting as action #2 behind an innocent VBS action #1. Duplication below is
# counted by ACTION TARGET, never by task name and never by trigger count.
$info = @()
foreach ($t in $tasks) {
    foreach ($act in @($t.Actions)) {
        if (-not $act -or -not $act.Execute) { continue }
        $target = ("" + $act.Execute + " " + $act.Arguments).Trim()
        if ($target -notmatch 'claude|wscript|claude-hidden-launchers|compress-captures') { continue }
        # Per-task LastTaskResult may be unreadable (throttle/ACL): unknown is
        # NOT failed — the row stays with an empty cell, never a flag.
        $last = $null
        try { $last = (Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop).LastTaskResult } catch {}
        $wd = ''
        try { $wd = "" + $act.WorkingDirectory } catch {}
        $info += [pscustomobject]@{
            Name     = ($t.TaskPath + $t.TaskName)
            State    = ("" + $t.State)
            Triggers = (@($t.Triggers)).Count
            LastRes  = $last
            Target   = $target
            Execute  = ("" + $act.Execute)
            WorkDir  = $wd
        }
    }
}
# The table shows the EXECUTABLE and working directory, not the full target:
# arguments can carry tokens verbatim (the #192 healthcheck lesson). The
# PROCESS-BURST flag DOES echo the full command line — that is what the
# double-fire signature requires (review #342); a redaction seam here would
# have to be owned by the launcher conventions, which never embed secrets
# (the DirectSecretArg pin lives in the task section's tests).
$info | Sort-Object Name | Format-Table Name, State, Triggers, LastRes, Execute, WorkDir -AutoSize | Out-String -Width 220 | Write-Output
Write-Output ("  launcher-shaped actions visible: {0}   (a NON-ELEVATED run cannot see SYSTEM tasks)" -f $info.Count)

# real duplication = several actions sharing one target (NEVER by name alone —
# and same-target actions inside ONE task fire the launcher twice, which is a
# double-fire even though only one task name is involved)
foreach ($g in ($info | Group-Object Target | Where-Object { $_.Count -gt 1 })) {
    $names = @($g.Group | ForEach-Object { $_.Name } | Select-Object -Unique) -join ' | '
    $flags.Add("DUPLICATE-TASK: $($g.Count) actions share one target under: $names -> " + $g.Name)
}
# the repointing/leak signature: an action LAUNCHING the claude binary with no
# VBS/PowerShell indirection. Match a real launch, never a mere path that
# happens to contain "claude" (…\Temp\claude\<session>\… is a data path).
$launchesClaude = 'claude\.(exe|cmd|bat)\b|\bnpx\s+(@?anthropic[^\s]*\s+)?claude\b|(^|\s)claude\s+(-p|--print|--resume|--continue|--model)'
foreach ($t in $info) {
    if ($t.Target -match $launchesClaude -and $t.Target -notmatch 'wscript|\.vbs|\.ps1') {
        # Executable PATH only, arguments withheld — a task argument can carry
        # a credential in clear (review #342, the #192 healthcheck class).
        $flags.Add("DIRECT-CLAUDE-TASK: $($t.Name) launches the claude binary without the VBS/PowerShell indirection -> $($t.Execute) (arguments withheld — verify manually)")
    }
    # Task result codes are INTERPRETED, never tested by `!= 0` — two benign
    # codes print a non-zero LastTaskResult on a perfectly healthy task (both
    # measured 2026-10-05, po-2025):
    #   2147946720 = 0x800710E0  MultipleInstances=IgnoreNew refused a second
    #                            start while the previous instance still runs
    #                            (#199/#205) — the healthy overlap shape.
    #   267009     = 0x41301     SCHED_S_TASK_RUNNING = "still running".
    # Any OTHER non-zero flags in ANY state (review #342): the Running-only
    # test was blind to a Ready task failing on every tick.
    $benign = 0, 2147946720, 267009
    if (($null -ne $t.LastRes) -and ($benign -notcontains [long]$t.LastRes)) {
        $flags.Add(("TASK-NONZERO-RESULT: {0} State={1} LastTaskResult={2} (0x{3:X8})" -f $t.Name, $t.State, $t.LastRes, [long]$t.LastRes))
    }
}

# ----------------------------------------------------------------- 4. verdict
Write-Section "VERDICT"
if ($flags.Count -gt 0) {
    foreach ($f in $flags) { Write-Output ("  FLAG  " + $f) }
}
if ($incomplete.Count -gt 0) {
    foreach ($s in $incomplete) { Write-Output ("  INCOMPLETE SOURCE  " + $s) }
    Write-Output "  A blind source makes its section's 'no flag' a non-verdict — rerun with the source available (elevated for SYSTEM tasks)."
    exit 2
}
if ($flags.Count -eq 0) {
    # Scoped claim: this scan checks defined signatures; absence of a flag is
    # absence OF THOSE SIGNATURES, never proof that no split-brain exists.
    Write-Output "  OK - none of the checked signatures found (duplicate session, double-fired command, duplicate/direct launcher, failing task result)."
}
Write-Output ""
Write-Output "  Sources: transcripts (live sessions), Win32_Process (bursts), Get-ScheduledTask (launchers)."
Write-Output "  Hub-side complement (which session burned which lane/model) lives in the #41 consumption organs, not here."
exit $(if ($flags.Count -gt 0) { 1 } else { 0 })
