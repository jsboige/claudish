<#
.SYNOPSIS
  Persist the local claudish proxy's RELAY MODE over time (read-only).

.DESCRIPTION
  Mode transitions (NOMINAL relay <-> AUTONOMOUS) live only in `docker logs`,
  and a recreate destroys them - the same class of loss as #347, for a
  different event type. This watcher samples the proxy's own `/health`
  (`role`, `instanceId`, `uptimeSec`) and appends one line per sample, so the
  history survives a recreate and a gap in the file is itself evidence (the
  watcher died) rather than silence.

  Sanctioned shape (decision ai-01, 2026-10-27 22:15Z, grain 7 of the v8 file):
  read-only `/health`, a local append-only file with a size cap and simple
  rotation, no container write, no scheduled task, no UAC.

  Line format, one per sample - deliberately greppable and diffable:

    2026-10-28T00:12:34Z role=relay-nominal instance=66c786a1 up=22089 streams=1
    2026-10-28T00:13:34Z role=UNAVAILABLE reason=timeout

  A sample is written EVERY tick, not only on change: a steady line proves the
  watcher was alive, and `-Report` derives the transitions. Writing only on
  change would make "no transition" and "watcher dead" the same file contents.

  `-Report` reads the same file and prints: per-role sample counts, every
  transition with its timestamp, restart boundaries (a change of `instance`
  or a decrease of `up`), and gaps longer than three intervals - which are
  the only way to tell a quiet night from a blind instrument.

.PARAMETER BaseUrl
  Local proxy root. Default http://localhost:3000 (the seat's own sidecar).

.PARAMETER LogPath
  Append-only ledger. Default %USERPROFILE%\.claudish\mode-transitions.log.

.PARAMETER IntervalSec
  Sampling period in loop mode. Default 60.

.PARAMETER MaxBytes
  Rotation threshold. At the threshold the live file becomes `<LogPath>.1`
  (single generation, previous `.1` replaced) and sampling continues in a
  fresh file. Default 1048576 (1 MiB ~ 12 days at one line per minute).

.PARAMETER TimeoutSec
  Per-sample HTTP timeout. Default 5.

.PARAMETER Once
  Take exactly one sample and exit (manual tick / external scheduler).

.PARAMETER Report
  Do not sample: read LogPath and print the summary.

.EXAMPLE
  powershell -NoProfile -File scripts/claudish-mode-watch.ps1 -Once

.EXAMPLE
  powershell -NoProfile -File scripts/claudish-mode-watch.ps1 -Report
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "http://localhost:3000",
    [string]$LogPath = (Join-Path $env:USERPROFILE ".claudish\mode-transitions.log"),
    [int]$IntervalSec = 60,
    [int]$MaxBytes = 1048576,
    [int]$TimeoutSec = 5,
    [switch]$Once,
    [switch]$Report
)

$ErrorActionPreference = "Stop"

function Get-UtcStamp {
    [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Initialize-LogDirectory {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

function Invoke-Rotation {
    if (-not (Test-Path -LiteralPath $LogPath)) { return }
    $len = (Get-Item -LiteralPath $LogPath).Length
    if ($len -lt $MaxBytes) { return }
    $archived = "$LogPath.1"
    if (Test-Path -LiteralPath $archived) {
        Remove-Item -LiteralPath $archived -Force
    }
    Move-Item -LiteralPath $LogPath -Destination $archived
}

function Add-LogLine([string]$line) {
    Initialize-LogDirectory
    Invoke-Rotation
    # AppendAllText with an explicit no-BOM encoding: Out-File/-Encoding utf8
    # writes a BOM on PowerShell 5.1 and would corrupt the first line of a
    # fresh file (global rule: UTF-8 BOM breaks parsers).
    # Single line on purpose: the ledger-confinement test reads the target of
    # every write from the SAME line, so a wrapped call would escape the guard.
    [System.IO.File]::AppendAllText($LogPath, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function New-Sample {
    $stamp = Get-UtcStamp
    try {
        $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec $TimeoutSec -Method Get
    }
    catch {
        $reason = "error"
        if ($_.Exception.Message -match "timed out|timeout") { $reason = "timeout" }
        return ("{0} role=UNAVAILABLE reason={1}" -f $stamp, $reason)
    }

    $role = $health.role
    if (-not $role) { $role = "unknown" }
    $instance = "none"
    if ($health.instanceId) { $instance = ([string]$health.instanceId).Substring(0, [Math]::Min(8, ([string]$health.instanceId).Length)) }
    $up = "na"
    if ($null -ne $health.uptimeSec) { $up = $health.uptimeSec }
    $streams = "na"
    if ($null -ne $health.activeStreams) { $streams = $health.activeStreams }

    return ("{0} role={1} instance={2} up={3} streams={4}" -f $stamp, $role, $instance, $up, $streams)
}

function ConvertFrom-LogLine([string]$line) {
    $out = [ordered]@{ stamp = $null; role = $null; instance = $null; up = $null; streams = $null; reason = $null }
    $tokens = $line.Trim() -split "\s+"
    if ($tokens.Count -eq 0) { return $null }
    $out.stamp = $tokens[0]
    for ($i = 1; $i -lt $tokens.Count; $i++) {
        $kv = $tokens[$i] -split "=", 2
        if ($kv.Count -ne 2) { continue }
        if ($out.Contains($kv[0])) { $out[$kv[0]] = $kv[1] }
    }
    return $out
}

function Show-Report {
    if (-not (Test-Path -LiteralPath $LogPath)) {
        Write-Output "mode-watch: no ledger at $LogPath - nothing has been sampled yet."
        $script:ReportExitCode = 1
        return
    }
    # ReadAllLines rather than `Get-Content | Where-Object`: an explicit
    # encoding and an explicit array, so the reader never depends on cmdlet
    # pipeline defaults.
    #
    # EDITOR WARNING, measured the hard way on 28/10: this file must stay ASCII
    # (or keep its UTF-8 BOM, as it does). A UTF-8 em dash in a BOM-less .ps1 is
    # decoded as cp1252 by Windows PowerShell 5.1, where 0x94 IS a closing
    # double quote -- the string ends early and the parser fails a hundred
    # lines further down, pointing at innocent code. The symptom does not look
    # like an encoding problem, which is why it costs an hour.
    $rawLines = [System.IO.File]::ReadAllLines($LogPath, (New-Object System.Text.UTF8Encoding($false)))
    $lines = @()
    foreach ($candidate in $rawLines) {
        if ($null -ne $candidate -and $candidate.Trim().Length -gt 0) { $lines += $candidate }
    }
    if ($lines.Count -eq 0) {
        Write-Output "mode-watch: ledger exists but is empty - the watcher has never completed a sample."
        $script:ReportExitCode = 1
        return
    }

    $samples = @()
    foreach ($candidate in $lines) {
        $rec = ConvertFrom-LogLine $candidate
        if ($rec -and $rec.stamp) { $samples += [pscustomobject]$rec }
    }
    if ($samples.Count -eq 0) {
        Write-Output "mode-watch: $($lines.Count) line(s) in the ledger but none parsed - the format changed under the reader."
        $script:ReportExitCode = 1
        return
    }

    Write-Output ("ledger      : {0}" -f $LogPath)
    Write-Output ("samples     : {0}  ({1} -> {2})" -f $samples.Count, $samples[0].stamp, $samples[-1].stamp)

    $byRole = $samples | Group-Object role | Sort-Object Count -Descending
    Write-Output "per role    :"
    foreach ($g in $byRole) {
        Write-Output ("  {0,-18} {1}" -f $g.Name, $g.Count)
    }

    $transitions = @()
    for ($i = 1; $i -lt $samples.Count; $i++) {
        if ($samples[$i].role -ne $samples[$i - 1].role) {
            $transitions += ("{0}  {1} -> {2}" -f $samples[$i].stamp, $samples[$i - 1].role, $samples[$i].role)
        }
    }
    Write-Output ("transitions : {0}" -f $transitions.Count)
    foreach ($t in $transitions) { Write-Output "  $t" }

    # Restart detection walks forward against the last sample that HAD an
    # instance, not against the adjacent line. An UNAVAILABLE sample carries no
    # instance and no uptime, so an adjacent-only comparison silently swallows
    # the restart that follows an outage - the very moment it is most likely.
    $restarts = @()
    $prevKnown = $null
    foreach ($cur in $samples) {
        if (-not $cur.instance -or $cur.instance -eq "none") { continue }
        if ($null -ne $prevKnown) {
            $movedInstance = ($prevKnown.instance -ne $cur.instance)
            $upWentBack = ($prevKnown.up -match '^\d+$') -and ($cur.up -match '^\d+$') -and ([int]$cur.up -lt [int]$prevKnown.up)
            if ($movedInstance -or $upWentBack) {
                $restarts += ("{0}  instance {1} -> {2}, up {3} -> {4}" -f $cur.stamp, $prevKnown.instance, $cur.instance, $prevKnown.up, $cur.up)
            }
        }
        $prevKnown = $cur
    }
    Write-Output ("restarts    : {0}" -f $restarts.Count)
    foreach ($r in $restarts) { Write-Output "  $r" }

    # Gaps: the instrument's own blind spots, which no reader can infer from a
    # role column. Threshold is 3x the sampling interval if the median spacing
    # says what that is, else 3 minutes.
    $gaps = @()
    for ($i = 1; $i -lt $samples.Count; $i++) {
        $a = [DateTime]::Parse($samples[$i - 1].stamp, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
        $b = [DateTime]::Parse($samples[$i].stamp, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
        $delta = ($b - $a).TotalSeconds
        if ($delta -gt ($IntervalSec * 3)) {
            $gaps += ("{0}  {1}s unobserved (watcher not running)" -f $samples[$i].stamp, [int]$delta)
        }
    }
    Write-Output ("gaps >{0}s : {1}" -f ($IntervalSec * 3), $gaps.Count)
    foreach ($g in $gaps) { Write-Output "  $g" }
    $script:ReportExitCode = 0
}

if ($Report) {
    $script:ReportExitCode = 0
    Show-Report
    exit $script:ReportExitCode
}

$line = New-Sample
Add-LogLine $line
Write-Output $line

if ($Once) { exit 0 }

while ($true) {
    Start-Sleep -Seconds $IntervalSec
    $line = New-Sample
    Add-LogLine $line
    Write-Output $line
}
