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

    2. Which processes are behind them, and is anything bursting?
       Source: Win32_Process (CIM, not Get-Process — the latter fails silently
       on VS Code "utility-node" parents and invents ghost parents, measured
       2026-10-04 po-2024). A claude.exe carries NO session id in its command
       line when VS Code spawns it (--output-format stream-json stdio), so
       process->session mapping is impossible by design: the session check is
       (1), the process check is bursts and orphaned ancestors.

    3. Are the scheduled launchers sane?
       Source: Get-ScheduledTask. Flags: a task whose action launches `claude`
       WITHOUT the VBS/PowerShell indirection (repointing/leak signature,
       doctrine 2026-09-27), two tasks sharing one action target (real
       duplication — COUNT BY ACTION, NEVER BY NAME: one task with three
       triggers prints three identical rows in schtasks /v and is NOT a
       duplicate, measured 2026-10-05 po-2025), and State=Running with a
       non-zero LastTaskResult (the 0x800710E0 "already running" refusal).

  READ-ONLY. No process, service, task or file is modified. A detector that
  acts on what it finds is the #173 shape (teardown without rebuild).

  ⚠ Coverage limit, printed in the report: a NON-ELEVATED run is blind to
  SYSTEM-owned tasks (the #169 trap — an empty result is indistinguishable
  from absence). Run elevated for full task coverage; the session and process
  sections are complete either way.

.PARAMETER ActiveMinutes
  Transcript mtime window that counts as "live". Default 30.

.PARAMETER BurstMin
  Flag when this many processes of one family are born within BurstWindowSec
  under the same root ancestor. Default 5: VS Code and MCP servers legitimately
  spawn 2-3 children together on load, so a lower threshold is pure noise
  (measured 2026-10-05: 3 node.exe in one second under one Code.exe is routine;
  11 across the machine in one second is a reload).

.EXAMPLE
  pwsh -File scripts/split-brain-scan.ps1
  powershell -ExecutionPolicy Bypass -File scripts/split-brain-scan.ps1 -ActiveMinutes 120
#>
[CmdletBinding()]
param(
    [int]$ActiveMinutes = 30,
    [string]$ProjectsRoot = (Join-Path $env:USERPROFILE '.claude\projects'),
    [int]$BurstWindowSec = 3,
    [int]$BurstMin = 5
)

$ErrorActionPreference = 'Continue'
$now = Get-Date
$flags = New-Object System.Collections.Generic.List[string]

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
$procs = @()
try {
    $procs = Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -match '^(claude|node|bun)(\.exe)?$' } |
        Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine
} catch {
    Write-Output ("  (Win32_Process query failed: " + $_.Exception.Message + ")")
}
$byPid = @{}
foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }
function Get-RootAncestor([int]$procId) {
    $seen = @{}
    $cur = $procId
    while ($byPid.ContainsKey($cur)) {
        if ($seen.ContainsKey($cur)) { break }
        $seen[$cur] = $true
        $par = [int]$byPid[$cur].ParentProcessId
        if (-not $byPid.ContainsKey($par)) {
            # parent outside our family: name it if the OS still knows it
            try {
                $o = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $par) -ErrorAction Stop
                return ($o.Name + "(" + $par + ")")
            } catch { return "(gone:$par)" }
        }
        $cur = $par
    }
    return ("(self:" + $procId + ")")
}
$rows = @()
foreach ($p in $procs) {
    $rows += [pscustomobject]@{
        Pid     = [int]$p.ProcessId
        Name    = $p.Name
        Started = $p.CreationDate
        Root    = (Get-RootAncestor ([int]$p.ProcessId))
    }
}
$rows | Sort-Object Started | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
Write-Output ("  total: {0}" -f $rows.Count)

foreach ($g in ($rows | Group-Object Root, Name)) {
    $sorted = $g.Group | Sort-Object Started
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $j = $i
        while (($j + 1) -lt $sorted.Count -and (($sorted[$j + 1].Started - $sorted[$i].Started).TotalSeconds -le $BurstWindowSec)) { $j++ }
        if (($j - $i + 1) -ge $BurstMin) {
            # build the message first: `"..." -f a, b, c` INSIDE a method call is
            # parsed as several Add() arguments, and -f then gets one arg for
            # four placeholders (measured 2026-10-05).
            $msg = "PROCESS-BURST: {0} x {1} born within {2}s under {3} (first {4})" -f (($j - $i + 1), $sorted[$i].Name, $BurstWindowSec, $sorted[$i].Root, $sorted[$i].Started)
            $flags.Add($msg)
            $i = $j
        }
    }
}

# ------------------------------------------------------------------ 3. tasks
Write-Section "SCHEDULED TASKS (launcher shape and duplication)"
$tasks = @()
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop
} catch {
    Write-Output ("  (Get-ScheduledTask failed: " + $_.Exception.Message + ")")
}
$info = @()
foreach ($t in $tasks) {
    $act = @($t.Actions) | Where-Object { $_.Execute } | Select-Object -First 1
    if (-not $act) { continue }
    $target = ("" + $act.Execute + " " + $act.Arguments).Trim()
    if ($target -notmatch 'claude|wscript|claude-hidden-launchers|compress-captures') { continue }
    $last = $null
    try { $last = (Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop).LastTaskResult } catch {}
    $info += [pscustomobject]@{
        Name     = ($t.TaskPath + $t.TaskName)
        State    = ("" + $t.State)
        Triggers = (@($t.Triggers)).Count
        LastRes  = $last
        Target   = $target
    }
}
$info | Sort-Object Name | Format-Table Name, State, Triggers, LastRes -AutoSize | Out-String -Width 200 | Write-Output
Write-Output ("  launcher-shaped tasks visible: {0}   (a NON-ELEVATED run cannot see SYSTEM tasks)" -f $info.Count)

# real duplication = two task names sharing one action target (NEVER by name alone)
foreach ($g in ($info | Group-Object Target | Where-Object { $_.Count -gt 1 })) {
    $flags.Add("DUPLICATE-TASK: $($g.Count) tasks share one action target: " + (($g.Group | ForEach-Object { $_.Name }) -join ' | '))
}
# the repointing/leak signature: a task LAUNCHING the claude binary with no
# VBS/PowerShell indirection. Match a real launch, never a mere path that
# happens to contain "claude" (…\Temp\claude\<session>\… is a data path).
$launchesClaude = 'claude\.(exe|cmd|bat)\b|\bnpx\s+(@?anthropic[^\s]*\s+)?claude\b|(^|\s)claude\s+(-p|--print|--resume|--continue|--model)'
foreach ($t in $info) {
    if ($t.Target -match $launchesClaude -and $t.Target -notmatch 'wscript|\.vbs|\.ps1') {
        $flags.Add("DIRECT-CLAUDE-TASK: $($t.Name) launches the claude binary without the VBS/PowerShell indirection -> " + $t.Target.Substring(0, [Math]::Min(140, $t.Target.Length)))
    }
    # Task result codes are INTERPRETED, never tested by `!= 0` — two benign
    # codes print a non-zero LastTaskResult on a perfectly healthy running task
    # (both measured 2026-10-05, po-2025):
    #   2147946720 = 0x800710E0  MultipleInstances=IgnoreNew refused a second
    #                            start (#199/#205) = SKIPPED(already-running)
    #   267009     = 0x41301     SCHED_S_TASK_RUNNING = "still running"
    $benign = 0, 2147946720, 267009
    if (($t.State -eq 'Running') -and ($t.LastRes -ne $null) -and ($benign -notcontains [long]$t.LastRes)) {
        $flags.Add("TASK-NONZERO-RESULT: $($t.Name) State=Running LastTaskResult=$($t.LastRes)")
    }
}

# ----------------------------------------------------------------- 4. verdict
Write-Section "VERDICT"
if ($flags.Count -eq 0) {
    Write-Output "  OK - no split-brain, burst or launcher-shape flag on this machine."
} else {
    foreach ($f in $flags) { Write-Output ("  FLAG  " + $f) }
}
Write-Output ""
Write-Output "  Sources: transcripts (live sessions), Win32_Process (bursts), Get-ScheduledTask (launchers)."
Write-Output "  Hub-side complement (which session burned which lane/model) lives in the #41 consumption organs, not here."
exit $(if ($flags.Count -gt 0) { 1 } else { 0 })
