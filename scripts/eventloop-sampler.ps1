# Claudish event-loop sampler — turns the hub's /health lag numbers into a
# TIME SERIES that survives a recreate.
#
# WHY (#739 item (b), file v16 item 2). The proxy already publishes
# `eventLoopMax60sMs` (a 60 s windowed max that RETIRES), `eventLoopBlockedMs5m`
# (the floored sum of lag over 5 min) and `eventLoopMaxMs` (cumulative
# high-water mark). Read once per agent cycle, those numbers only ever CONFIRM
# a gap: ai-01 measured a `eventLoopMaxMs` of 3830 ms since the 06:09Z recreate
# and could not date it. The high-water mark is pinned forever by one GC pause,
# and the 60 s window has already retired by the time anyone looks — so the
# episode that caused it is unreadable after the fact. A one-line-per-minute
# series is what makes "when did the hub stall, and for how long" answerable
# from a file, on the same clock as the sidecars' AUTONOMOUS lines.
#
# WHY A HOST-SIDE POLLER AND NOT AN IN-PROCESS `setInterval` (the deviation,
# stated because the published form said otherwise). The agreed form asked for
# a 60 s interval INSIDE the proxy writing to `~/.claudish/eventloop-blocked.log`.
# The container has no mount for that directory: it sees `D:/claudish-shadow/config`
# as /root/.claudish and `D:/claudish-captures` as /captures, nothing else.
# Writing there from the process would mean adding a mount — a compose change,
# i.e. a hub recreate plus a fleet-facing announcement — to obtain numbers the
# proxy ALREADY serves. Polling `/health` costs one unauthenticated GET a
# minute and needs no container change at all, and it works identically on the
# five seats whether they run the hub, a relay or a sidecar.
#
# SAMPLING CADENCE vs WINDOW (the coverage argument). One tick a minute against
# a 60 s window means a late tick can let ONE windowed max retire unseen. That
# is deliberate and harmless: `eventLoopBlockedMs5m` is a FIVE-minute window, so
# any block stays visible for its next five ticks. The durable signal is
# `blocked5m`; `max60s` is the sharper, best-effort one. A reader that wants
# "the worst 60 s in that hour" takes the max over the ticks it has, and never
# claims a tick that is missing.
#
# A FAILED PROBE IS RECORDED, NOT SKIPPED. An empty series cannot distinguish
# "the proxy was calm" from "the sampler was dead" — the same trap the
# failover-events collector names. Each tick writes a line whatever happens:
# `{ts, probe:"ok", ...}` or `{ts, probe:"fail", error}`. The state file adds a
# bounded tick history, so "was the sampler even running at 03:49Z?" is
# answerable from this machine alone.
#
# THERE IS NO ACTUATOR HERE (#173, same rule as the failover collector):
# collecting is not acting. Nothing gats on these numbers, and this file
# contains no Restart-*/Stop-*/docker verb.
#
# DRY RUN before installing (Register-ScheduledTask has no -WhatIf):
#   powershell -ExecutionPolicy Bypass -File <this file> -ClaudishHome $env:TEMP\el-dry
# then inspect %TEMP%\el-dry\eventloop-blocked.log — the line is the one the
# task will write, produced by the same code path. Only then install:
#   schtasks /create /tn "ClaudishEventLoopSampler" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\dev\claudish\scripts\eventloop-sampler.ps1" /sc minute /mo 1 /f
# and verify by RE-READING the registered task, never by trusting the create:
#   schtasks /query /tn "ClaudishEventLoopSampler" /v /fo list
#
# Reading the series: scripts/eventloop-trend.py (the single reader).
#
# Targets PowerShell 5.1 (scheduled tasks run `powershell`, not `pwsh`).

param(
    [string]$ClaudishHome = "C:\Users\jsboi\.claudish",

    # Unauthenticated on every seat (the relay heartbeats it with no key).
    [string]$HealthUrl = "http://127.0.0.1:3000/health",

    [int]$TimeoutSec = 5,

    [long]$MaxLogBytes = 5242880,
    [int]$KeepRotated = 5,

    # Bounded tick history (240 ticks = 4 h at 1 min).
    [int]$HistoryCap = 240,

    # Test seam: define the functions and stop BEFORE the first probe. Dot-sourced
    # with this switch the file is a library, so scripts/tests can exercise the
    # shaping and rotation logic with no HTTP and no home directory.
    [switch]$LibraryOnly
)

$ErrorActionPreference = "Stop"
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

if (-not $LibraryOnly -and -not (Test-Path -LiteralPath $ClaudishHome)) {
    throw "ClaudishHome '$ClaudishHome' does not exist. Pass -ClaudishHome <path> in the scheduled-task command line."
}

$LogPath   = Join-Path $ClaudishHome 'eventloop-blocked.log'
$StatePath = Join-Path $ClaudishHome 'eventloop-blocked-state.json'

# ---- pure logic (exercised by scripts/tests without HTTP) -------------------

function ConvertTo-LagSample {
    <#
      Shape one tick. Accepts the /health object (or $null on a probe failure)
      and returns the ordered record that becomes one NDJSON line.

      Every field is allow-listed. /health also carries proxyKeyPreviousHits
      and admissionFreeze; neither belongs in a lag series, and a future field
      must be added here deliberately rather than leak by copying the object.
      Numbers are rounded to 0.1 ms — finer than the probe's own resolution and
      enough to keep the line short; a missing/non-numeric field is `$null`,
      NEVER 0 (0 would read as "perfectly healthy" for a field the proxy did
      not publish, which is the whole failure mode this instrument exists to
      avoid).
    #>
    param(
        # NOT [Mandatory]: a probe failure passes $null, and Mandatory rejects
        # it with a binding error — the one path that must never throw would
        # have thrown on every tick where /health was down (measured before
        # install, first dry run of the failure path).
        [Parameter(Mandatory = $false)] [AllowNull()] $Health,
        [Parameter(Mandatory = $true)] [datetime] $AtUtc,
        [string]$ErrorText = ''
    )

    $ts = $AtUtc.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)

    if ($null -eq $Health) {
        return [pscustomobject]@{
            ts    = $ts
            probe = 'fail'
            error = $(if ([string]::IsNullOrWhiteSpace($ErrorText)) { 'unreachable' } else { $ErrorText })
        }
    }

    function Get-Num($obj, [string]$name) {
        if ($null -eq $obj) { return $null }
        $p = $obj.PSObject.Properties[$name]
        if ($null -eq $p -or $null -eq $p.Value) { return $null }
        $d = 0.0
        if ([double]::TryParse([string]$p.Value, [System.Globalization.NumberStyles]::Float, $Invariant, [ref]$d)) {
            return [math]::Round($d, 1)
        }
        return $null
    }

    $role = $null
    $rp = $Health.PSObject.Properties['role']
    if ($null -ne $rp) { $role = [string]$rp.Value }
    $iid = $null
    $ip = $Health.PSObject.Properties['instanceId']
    if ($null -ne $ip) { $iid = [string]$ip.Value }
    $status = $null
    $sp = $Health.PSObject.Properties['status']
    if ($null -ne $sp) { $status = [string]$sp.Value }

    return [pscustomobject]@{
        ts               = $ts
        probe            = 'ok'
        status           = $status
        role             = $role
        instanceId       = $iid
        uptimeSec        = Get-Num $Health 'uptimeSec'
        activeStreams    = Get-Num $Health 'activeStreams'
        max60sMs         = Get-Num $Health 'eventLoopMax60sMs'
        blocked5mMs      = Get-Num $Health 'eventLoopBlockedMs5m'
        maxCumulativeMs  = Get-Num $Health 'eventLoopMaxMs'
    }
}

function Test-RotationDue {
    param([long]$CurrentBytes, [long]$LimitBytes)
    return ($CurrentBytes -ge $LimitBytes)
}

function Get-RotatedName {
    param([string]$Path, [int]$Index)
    return ("{0}.{1}" -f $Path, $Index)
}

function Invoke-LogRotation {
    <#
      Rotate <path> -> <path>.1 -> ... keeping -KeepRotated files. Never throws
      on a missing file: the first tick of a fresh home has nothing to rotate.

      Uses [System.IO.File]::Delete rather than Remove-Item on purpose: the AST
      pin in scripts/tests/claudish-eventloop-sampler.Tests.ps1 refuses ANY
      Remove-Item in this file, so a future edit cannot quietly widen a rotation
      helper into a general-purpose deleter.
    #>
    param([string]$Path, [int]$KeepRotated)
    if ($KeepRotated -lt 1) { return }
    $oldest = Get-RotatedName -Path $Path -Index ($KeepRotated + 1)
    if (Test-Path -LiteralPath $oldest) { [System.IO.File]::Delete($oldest) }
    for ($i = $KeepRotated - 1; $i -ge 1; $i--) {
        $from = Get-RotatedName -Path $Path -Index $i
        $to   = Get-RotatedName -Path $Path -Index ($i + 1)
        if (Test-Path -LiteralPath $from) {
            if (Test-Path -LiteralPath $to) { [System.IO.File]::Delete($to) }
            [System.IO.File]::Move($from, $to)
        }
    }
    $first = Get-RotatedName -Path $Path -Index 1
    if (Test-Path -LiteralPath $first) { [System.IO.File]::Delete($first) }
    [System.IO.File]::Move($Path, $first)
}

function Add-SamplerLine {
    <#
      Append one NDJSON line, rotating first when the file is over the limit.
      No BOM: Add-Content under 5.1 writes one on creation, and a BOM in front
      of the first `{` makes the very first line unparseable — the same defect
      the failover collector fixed for its state file.
    #>
    param(
        [string]$Path,
        [string]$Line,
        [long]$MaxLogBytes,
        [int]$KeepRotated
    )

    $bytes = 0
    if (Test-Path -LiteralPath $Path) {
        $bytes = (Get-Item -LiteralPath $Path).Length
        if (Test-RotationDue -CurrentBytes $bytes -LimitBytes $MaxLogBytes) {
            Invoke-LogRotation -Path $Path -KeepRotated $KeepRotated
        }
    }

    $enc = New-Object System.Text.UTF8Encoding($false)
    $sw = New-Object System.IO.StreamWriter($Path, $true, $enc)
    try {
        $sw.WriteLine($Line)
    } finally {
        $sw.Dispose()
    }
}

function Read-SamplerState {
    param([string]$StatePath)
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Write-SamplerState {
    param([string]$StatePath, $State)
    try {
        $json = $State | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($StatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Output ("[eventloop-sampler] state write failed: {0}" -f $_.Exception.Message)
    }
}

# ---- one tick ---------------------------------------------------------------

if ($LibraryOnly) { return }

$tickUtc = (Get-Date).ToUniversalTime()
$health = $null
$errText = ''

if (-not [string]::IsNullOrWhiteSpace($HealthUrl)) {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec $TimeoutSec
    } catch {
        $health = $null
        # The exception TYPE first, the message after: the message is localized
        # (measured: "Le délai de l'opération a expiré." on this seat), so a
        # reader that greps the text learns nothing portable. The type name is
        # stable and English on every seat.
        $errText = ('{0}: {1}' -f $_.Exception.GetType().Name, $_.Exception.Message)
    }
}

$sample = ConvertTo-LagSample -Health $health -AtUtc $tickUtc -ErrorText $errText
$line = $sample | ConvertTo-Json -Compress -Depth 4
Add-SamplerLine -Path $LogPath -Line $line -MaxLogBytes $MaxLogBytes -KeepRotated $KeepRotated

# State: last tick + a bounded history. This is what separates a DEAD sampler
# from a QUIET proxy — an empty log proves nothing on its own.
$state = Read-SamplerState -StatePath $StatePath
$history = @()
if ($null -ne $state -and $null -ne $state.History) { $history = @($state.History) }
$history += $sample
if ($history.Count -gt $HistoryCap) { $history = @($history | Select-Object -Last $HistoryCap) }

Write-SamplerState -StatePath $StatePath -State ([pscustomobject]@{
    LastTickUtc = $sample.ts
    LogPath     = $LogPath
    History     = $history
})

Write-Output $line
