<#
.SYNOPSIS
  Idempotent guard for the host TCP pipe backing the WAN entry
  (models.myia.io -> IIS site 49 -> :18182 node pipe -> hub .50:3000).

.DESCRIPTION
  The pipe (D:\Production\claudish-relay-po2025\relay.js) used to be started
  only by the HKCU\...\Run value at LOGON: a reboot without an opened session
  left the fleet-facing entry dead with no automatic recovery (Q65, user GO
  2026-11-01 (b): convert to a startup task with a guard).

  This guard is what the scheduled task runs: at startup (before any logon)
  and every N minutes. It starts the pipe ONLY when nothing is listening on
  the port, so it is safe to run next to the legacy HKCU launcher -- whichever
  starts first wins, the other is a no-op. It never kills or restarts a live
  pipe: liveness of the HUB behind the pipe is the relay container's business
  (hysteresis), not this guard's.

  Written for Windows PowerShell 5.1 -- the interpreter scheduled tasks
  actually use on this fleet. ASCII only, no PS7-only syntax, no
  HashSet-ordered output assumptions.

.PARAMETER RelayDir
  Directory holding relay.js (logs guard.log there).

.PARAMETER Port
  Local TCP port of the pipe (default 18182).

.PARAMETER NodeExe
  node.exe path (default: the standard per-machine install).

.PARAMETER ProbeTimeoutMs
  Connect timeout for the liveness probe (a hung listen backlog must not hang
  the guard).

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File relay-guard.ps1
#>
[CmdletBinding()]
param(
    [string]$RelayDir = 'D:\Production\claudish-relay-po2025',
    [int]$Port = 18182,
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [int]$ProbeTimeoutMs = 1500
)

$ErrorActionPreference = 'Stop'

function Write-GuardLog {
    param([string]$Line)
    $ts = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    try {
        Add-Content -LiteralPath (Join-Path $RelayDir 'guard.log') -Value "$ts $Line" -Encoding ASCII
    } catch {
        # a read-only log must never stop the guard from doing its job
    }
}

function Test-PipeUp {
    param([int]$P, [int]$TimeoutMs)
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $P, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { $client.Close() }
    }
}

if (Test-PipeUp -P $Port -TimeoutMs $ProbeTimeoutMs) {
    # happy path: no log line, so a 10-minute cadence never floods the file
    exit 0
}

$relayJs = Join-Path $RelayDir 'relay.js'
if (-not (Test-Path -LiteralPath $relayJs)) {
    Write-GuardLog "ERROR relay.js missing at $relayJs -- cannot start the pipe"
    exit 1
}
if (-not (Test-Path -LiteralPath $NodeExe)) {
    Write-GuardLog "ERROR node.exe missing at $NodeExe -- cannot start the pipe"
    exit 1
}

try {
    Start-Process -FilePath $NodeExe -ArgumentList @($relayJs) -WorkingDirectory $RelayDir -WindowStyle Hidden -ErrorAction Stop
    Write-GuardLog "START pipe down on :$Port -> launched node $relayJs"
    exit 0
} catch {
    Write-GuardLog "ERROR launch failed: $($_.Exception.Message)"
    exit 1
}
