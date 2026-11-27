# iis-pool-recycle-guard.ps1 - read-only drift check on an IIS app pool's periodic recycle.
#
# WHY (#1156): recycling.periodicRestart.time of the pool serving models.myia.io was set to
# 00:00:00 on 2026-11-23 17:45:14Z. The SAME setting had already been lost once before (the
# 28/08 correction was gone by 23/11: 582 x event 5074 over ~25 days, and the System log's
# oldest record predates the loss). Nothing on the fleet watched it. This script is the
# missing instrument: it READS one value per pool and reports a drift. It never writes, never
# recycles and never elevates - every repair is a separate, announced gesture.
#
# It is a MEASUREMENT, so the three outcomes stay distinct:
#   0  every pool read and equal to -Expected
#   2  at least one pool DRIFTED (read, and different) - the alert
#   1  at least one pool could not be read: an empty output or a non-zero exit is NOT a
#      pass and NOT a drift, it is a dead instrument (measured lesson: "an empty output is
#      not a negative, it is a dead command")
#
# TWO settings, because `time` alone is blind (measured 2026-11-27): the front runs 44 pools whose
# `periodicRestart.time` is 00:00:00 AND whose `[schedule]` carries one clock entry, so a pool that
# recycles every day at a fixed hour reads as perfectly healthy on `time` alone. A non-empty
# `[schedule]` is therefore a DRIFT in its own right, and the block is read, never assumed empty.
# The read is ONE `list apppool <name> /text:*` per pool, because that form prints the object it
# actually resolved (`APPPOOL.NAME:"<name>"`); measured the same day, `appcmd list apppool "<name>"
# /config` prints NO object name and rendered an EMPTY <schedule> for mcp-tools.myia.io where
# /text:* and the whole-section dump both show 04:38:00, and an EMPTY pool name makes appcmd answer
# the whole pool list (3572 lines, "DefaultAppPool" first). The guard therefore proves that the name
# it read equals the name it asked for, and refuses the pool as UNREADABLE when it cannot.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/iis-pool-recycle-guard.ps1
#   ... -Pools models.myia.io,embeddings.myia.io -Expected 01:00:00
#   ... -Json            # one JSON object, for a scheduled collector
# Windows PowerShell 5.1 is the interpreter that runs the fleet's scheduled tasks: no 7.x
# syntax here ($PSScriptRoot is used at body scope only, never in a param() default).

[CmdletBinding()]
param(
    [string[]]$Pools = @('models.myia.io'),
    [string]$Expected = '00:00:00',
    [string]$AppCmd = '',
    [switch]$Json
)

$ErrorActionPreference = 'Continue'

if (-not $AppCmd) {
    $AppCmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
}

function Invoke-Native {
    # A native command's stderr under 'Stop' becomes a terminating NativeCommandError
    # (measured 2026-11-25 while preparing an admin window: the expected "Access denied"
    # killed the run). Capture here, classify at the call site.
    param([string]$FilePath, [string[]]$ArgumentList)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $FilePath @ArgumentList 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    $lines = @()
    foreach ($item in @($raw)) {
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $msg = if ($item.Exception -and $item.Exception.Message) { $item.Exception.Message } else { $item.ToString() }
        } else {
            $msg = "$item"
        }
        foreach ($part in ($msg -split "`r?`n")) {
            if (-not $part) { continue }
            if ($part -match '^System\.Management\.Automation\.RemoteException$') { continue }
            $lines += $part
        }
    }
    return [PSCustomObject]@{ Lines = $lines; Text = ($lines -join ' ').Trim(); Code = $code }
}

$results = New-Object System.Collections.ArrayList

# -Pools accepts both forms: a real array (-Pools a,b from PowerShell) and the single
# comma-joined string a child process receives when the same line crosses a process
# boundary (-File ... -Pools a,b). Measured 2026-11-26: without the split the whole list
# is read as ONE pool name and appcmd answers an empty body - a silent false reading.
$poolNames = @()
foreach ($entry in @($Pools)) {
    if (-not $entry) { continue }
    foreach ($name in ($entry -split '\s*,\s*')) {
        # Trim FIRST, then test. Measured in review (2026-11-26): testing before the trim let a
        # whitespace-only entry in as "" - the list then counted ONE name, walked past the empty-list
        # refusal below, and the read loop skipped that entry: exit 0, pools=[], unreadable=0.
        $trimmed = $name.Trim()
        if ($trimmed) { $poolNames += $trimmed }
    }
}

# A list that normalises to NOTHING is not a pass. Measured in review (2026-11-26): -Pools ','
# left $poolNames empty and the guard answered exit 0 with pools=[] - a scheduled collector would
# have recorded a success while no pool was read at all, which is the very failure class this
# instrument exists to catch. Refused on both forms, as a dead instrument (exit 1); `unreadable`
# is set to 1 so a collector that only sums the counters still trips. A whitespace-only list
# (-Pools ' ') is refused the same way - a blank is not a pool name.
if ($poolNames.Count -eq 0) {
    $given = (@($Pools) -join ',')
    # A blank between brackets is invisible in a log; the text form says how long it was.
    # The JSON `given` field keeps the raw input, exactly as received.
    $shown = $given
    if (-not $given.Trim()) { $shown = '(blank - {0} whitespace char(s))' -f $given.Length }
    $why = "-Pools [$shown] leaves no pool name after normalisation - nothing was checked"
    if ($Json) {
        [PSCustomObject]@{
            checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            expected     = $Expected
            appcmd       = $AppCmd
            given        = $given
            verdict      = 'INSTRUMENT'
            detail       = $why
            pools        = @()
            drift        = 0
            unreadable   = 1
        } | ConvertTo-Json -Depth 5 -Compress
    } else {
        Write-Output ('GUARD pools=0 drift=0 unreadable=1 at={0}' -f [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
        Write-Output ('VERDICT INSTRUMENT: {0} - this is NOT a pass and NOT a drift' -f $why)
    }
    exit 1
}

# Parses the /text:* block of ONE pool. Every "could not read it" is reported as a MISSING
# marker (empty Seen / -not Has...), never as an empty value: an absent [schedule] section must
# not read as "empty schedule", which is the false pass this extension exists to close.
function Read-RecyclingBlock {
    param([string[]]$Lines)
    $seen = ''
    $time = ''
    $hasPeriodic = $false
    $hasSchedule = $false
    $schedule = @()
    $start = -1
    $baseIndent = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $l = $Lines[$i]
        if ($l -match '^\s*APPPOOL\.NAME:"(.*)"\s*$') { $seen = $Matches[1]; continue }
        if ($start -lt 0) {
            if ($l -match '^(\s*)\[periodicRestart\]\s*$') {
                $start = $i
                $baseIndent = $Matches[1].Length
                $hasPeriodic = $true
            }
            continue
        }
        # Inside the block: a section header at or left of [periodicRestart] ends it ([failure]).
        if ($l -match '^(\s*)\[') {
            if ($Matches[1].Length -le $baseIndent) { break }
            if ($l -match '^\s*\[schedule\]\s*$') { $hasSchedule = $true }
            continue
        }
        if ($l -match '^\s*time:"(.*)"\s*$') {
            if (-not $time) { $time = $Matches[1] }
            continue
        }
        if ($l -match '^\s*value:"(.*)"\s*$') { $schedule += $Matches[1] }
    }
    return [PSCustomObject]@{
        Seen        = $seen
        Time        = $time
        HasPeriodic = $hasPeriodic
        HasSchedule = $hasSchedule
        Schedule    = @($schedule)
    }
}

# Every name kept above is non-blank, so every name is read: no entry is ever skipped here.
foreach ($pool in $poolNames) {
    $r = Invoke-Native -FilePath $AppCmd -ArgumentList @('list', 'apppool', $pool, '/text:*')
    $block = Read-RecyclingBlock -Lines $r.Lines
    $value = $block.Time
    if (-not $value -and $r.Code -ne 0 -and $r.Text) {
        # a dead read still carries its reason into the report (the stderr text), bounded so a
        # whole-list answer can never flood the log
        $value = $r.Text
        if ($value.Length -gt 200) { $value = $value.Substring(0, 200) + '...' }
    }
    $sched = @($block.Schedule)
    $schedText = ($sched -join ',')
    if ($r.Code -ne 0) {
        # Both halves are needed: appcmd may answer rc 0 with an empty body when the pool
        # name does not resolve, and rc 1 on a real read failure. Neither says "in spec".
        $verdict = 'UNREADABLE'
        $detail = "exit=$($r.Code)"
    } elseif ($r.Lines.Count -eq 0) {
        $verdict = 'UNREADABLE'
        $detail = 'empty output'
    } elseif (-not $block.Seen) {
        $verdict = 'UNREADABLE'
        $detail = 'identity absent'
    } elseif ($block.Seen -ne $pool) {
        $verdict = 'UNREADABLE'
        $detail = "identity=$($block.Seen)"
    } elseif (-not $block.HasPeriodic) {
        $verdict = 'UNREADABLE'
        $detail = 'periodicRestart absent'
    } elseif (-not $block.HasSchedule) {
        $verdict = 'UNREADABLE'
        $detail = 'schedule absent'
    } elseif (-not $value) {
        $verdict = 'UNREADABLE'
        $detail = 'time absent'
    } elseif ($sched.Count -gt 0) {
        # A clock recycle is as much a drift as a non-zero time: the pool WILL restart at that
        # hour, whatever `time` says. Measured on the front 2026-11-27: 44 pools carry one entry.
        $verdict = 'DRIFT'
        $detail = "schedule=[$schedText]"
    } elseif ($value -eq $Expected) {
        $verdict = 'OK'
        $detail = ''
    } else {
        $verdict = 'DRIFT'
        $detail = ''
    }
    [void]$results.Add([PSCustomObject]@{
        pool     = $pool
        value    = $value
        expected = $Expected
        schedule = $sched
        verdict  = $verdict
        detail   = $detail
    })
}

$drift = @($results | Where-Object { $_.verdict -eq 'DRIFT' })
$blind = @($results | Where-Object { $_.verdict -eq 'UNREADABLE' })

if ($Json) {
    [PSCustomObject]@{
        checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        expected     = $Expected
        appcmd       = $AppCmd
        pools        = $results
        drift        = $drift.Count
        unreadable   = $blind.Count
    } | ConvertTo-Json -Depth 5 -Compress
} else {
    foreach ($x in $results) {
        # The detail stays IMMEDIATELY after verdict=, and the schedule goes at the END: the pins
        # written against the first version assert "verdict=UNREADABLE (empty output)" as one
        # contiguous run, so inserting a field between them would turn the existing regression net
        # red for a purely cosmetic reason. Reading order also stays "why" before "what".
        $line = 'POOL {0} value=[{1}] expected=[{2}] verdict={3}' -f $x.pool, $x.value, $x.expected, $x.verdict
        if ($x.detail) { $line += ' (' + $x.detail + ')' }
        $line += ' schedule=[' + (@($x.schedule) -join ',') + ']'
        Write-Output $line
    }
    Write-Output ('GUARD pools={0} drift={1} unreadable={2} at={3}' -f $results.Count, $drift.Count, $blind.Count, [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
    if ($blind.Count -gt 0) {
        Write-Output 'VERDICT INSTRUMENT: a pool could not be read - this is NOT a pass and NOT a drift; check appcmd and the pool name'
    } elseif ($drift.Count -gt 0) {
        Write-Output 'VERDICT DRIFT: the periodic recycle differs from the expected value, or a [schedule] entry recycles the pool by clock - any repair is a separate [PROPOSAL] + [ACK] gesture'
    } else {
        Write-Output 'VERDICT OK: every pool reads the expected periodic recycle and carries no [schedule] entry'
    }
}

if ($blind.Count -gt 0) { exit 1 }
if ($drift.Count -gt 0) { exit 2 }
exit 0
