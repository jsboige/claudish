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
        if ($name) { $poolNames += $name.Trim() }
    }
}

# A list that normalises to NOTHING is not a pass. Measured in review (2026-11-26): -Pools ','
# left $poolNames empty and the guard answered exit 0 with pools=[] - a scheduled collector would
# have recorded a success while no pool was read at all, which is the very failure class this
# instrument exists to catch. Refused on both forms, as a dead instrument (exit 1); `unreadable`
# is set to 1 so a collector that only sums the counters still trips.
if ($poolNames.Count -eq 0) {
    $given = (@($Pools) -join ',')
    $why = "-Pools [$given] leaves no pool name after normalisation - nothing was checked"
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

foreach ($pool in $poolNames) {
    if (-not $pool) { continue }
    $r = Invoke-Native -FilePath $AppCmd -ArgumentList @('list', 'apppool', $pool, ('/text:recycling.periodicRestart.time'))
    $value = $r.Text.Trim()
    if ($r.Code -ne 0 -or -not $value) {
        # Both halves are needed: appcmd may answer rc 0 with an empty body when the pool
        # name does not resolve, and rc 1 on a real read failure. Neither says "in spec".
        $verdict = 'UNREADABLE'
        $detail = if ($r.Code -ne 0) { "exit=$($r.Code)" } else { 'empty output' }
    } elseif ($value -eq $Expected) {
        $verdict = 'OK'
        $detail = ''
    } else {
        $verdict = 'DRIFT'
        $detail = ''
    }
    [void]$results.Add([PSCustomObject]@{
        pool    = $pool
        value   = $value
        expected = $Expected
        verdict = $verdict
        detail  = $detail
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
        $line = 'POOL {0} value=[{1}] expected=[{2}] verdict={3}' -f $x.pool, $x.value, $x.expected, $x.verdict
        if ($x.detail) { $line += ' (' + $x.detail + ')' }
        Write-Output $line
    }
    Write-Output ('GUARD pools={0} drift={1} unreadable={2} at={3}' -f $results.Count, $drift.Count, $blind.Count, [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
    if ($blind.Count -gt 0) {
        Write-Output 'VERDICT INSTRUMENT: a pool could not be read - this is NOT a pass and NOT a drift; check appcmd and the pool name'
    } elseif ($drift.Count -gt 0) {
        Write-Output 'VERDICT DRIFT: the periodic recycle differs from the expected value - any repair is a separate [PROPOSAL] + [ACK] gesture'
    } else {
        Write-Output 'VERDICT OK: every pool reads the expected periodic recycle'
    }
}

if ($blind.Count -gt 0) { exit 1 }
if ($drift.Count -gt 0) { exit 2 }
exit 0
