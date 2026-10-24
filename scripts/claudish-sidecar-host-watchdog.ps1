#Requires -Version 5.1
<#
.SYNOPSIS
    Host-side watchdog for the Claudish sidecar on Docker Desktop (Windows).

.DESCRIPTION
    The container's own healthcheck cannot see the two failure classes that
    took every lane on a host down (myia-po-2028, 21/10 and 24/10). This
    script watches them from the HOST, opt-in gated, with bounded actuators
    whose rebuild halves were MEASURED on myia-po-2028 (2026-10-24: kill of
    the orphaned wslrelay restored service on 21/10 and 24/10; `wsl
    --terminate docker-desktop` was followed by an unassisted Desktop
    respawn, container healthy and relay-nominal, in under 3 minutes).

    It reuses the fleet-tested primitives from scripts/lib/claudish-engine.psm1:
      - Test-HttpAlive: ANY HTTP status proves the pipe alive (the 09-20
        lesson: a 200-only check invents a wedge on a healthy machine under
        the production interpreter - HTTP 400 under 5.1, 200 under pwsh 7).
      - Test-ClaudishOptIn: consent = a file that exists AND carries the
        literal token 'enabled'; an empty file does not arm.

    Probes and rungs (each bounded, journalized to sidecar-host-watchdog.log):
      R1 - wslrelay wedge: probe http://[::1]:<port>/health EXPLICITLY (a
           'localhost' probe reads healthy straight through this outage -
           measured: wslrelay owns [::1] alone while the backend wildcard
           keeps serving 127.0.0.1; Node clients resolve ::1 first and die).
           When the probe gets NO answer (transport failure, not a status
           code) and a wslrelay process holds the loopback listeners for the
           port: kill exactly those PIDs. The Docker backend's 0.0.0.0/[::]
           wildcard then serves loopback again (measured 21/10 + 24/10).
           Only wslrelay is ever killed - never the backend, never the VM.
      R2 - docker engine wedge: the Docker Desktop backend runs but the
           docker-desktop WSL distro answers HTTP 500 (or hangs the CLI) -
           "docker refuses to restart after a kill". Remediation
           `wsl --terminate docker-desktop` fires only when: 2 consecutive
           failing runs have passed, the engine cooldown (30 min) has
           elapsed, no claudish-drain is in flight, AND com.docker.backend
           is running - the respawn precondition measured on 24/10. Without
           the backend there is nobody to respawn the distro: that is R3.
      R3 - engine down AND no Docker Desktop backend: ESCALATE log line
           only. Deliberately no actuator: the rebuild half of an
           engine-relaunch has never been proven here (the po-2025 2026-09-20
           lesson: a teardown whose rebuild half was broken caused an outage
           worse than the wedge; #172 AC4). The log line names the manual
           gesture; the worker cycle relays it.

    Single-observer rule: this script is THE watcher for the
    localhost-path / docker-engine condition on a sidecar host. Do not add a
    second one; extend this file instead. It is INERT until an operator
    writes the consent file (no consent = not even measured, no log line).

.PARAMETER Port
    Published host port of the sidecar (default 3000).

.PARAMETER ClaudishHome
    State/log directory (default ~/.claudish). The consent file
    'sidecar-host-watchdog.enabled' (content: the literal 'enabled') lives
    here.

.PARAMETER ConsecutiveEngineFailures
    Failing runs required before R2/R3 (default 2 = ~10 min at the /5 min
    scheduled cadence).

.PARAMETER EngineCooldownMin
    Minutes between R2/R3 attempts (default 30).

.PARAMETER DryRun
    Probes run for real (read-only); remediations print [DRYRUN] instead of
    executing.

.NOTES
    Interpreter: Windows PowerShell 5.1 (the interpreter scheduled tasks
    actually use). Per-user scheduled task, no UAC:
      schtasks /Create /TN ClaudishSidecarHostWatchdog /TR "powershell.exe
        -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\claudish-sidecar-host-watchdog.ps1"
        /SC MINUTE /MO 5 /F
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$ClaudishHome = (Join-Path $env:USERPROFILE '.claudish'),
    [int]$ConsecutiveEngineFailures = 2,
    [int]$EngineCooldownMin = 30,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$LogPath = Join-Path $ClaudishHome 'sidecar-host-watchdog.log'
$StatePath = Join-Path $ClaudishHome 'sidecar-host-watchdog.state.json'
$ConsentFileName = 'sidecar-host-watchdog.enabled'
$LogMaxBytes = 2MB

$EngineModule = Join-Path $PSScriptRoot 'lib\claudish-engine.psm1'
try {
    Import-Module $EngineModule -Force -ErrorAction Stop
} catch {
    # Fail safe: no module, no probe, no actuator - one line and out.
    Write-Output "sidecar-watchdog module_import_failed inert_exit"
    exit 0
}

# Consent BEFORE any probe: a machine that never opted in is not even
# measured (the 09-20 lesson: a guard that armed by accident armed on every
# machine in the fleet).
if (-not (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName $ConsentFileName)) {
    exit 0
}

function Write-WdLog {
    param([string]$Message)
    # ASCII only - Add-Content encoding stability across 5.1 seats.
    $line = ('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), ($Message -replace '[^\x20-\x7E]', '?'))
    try {
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt $LogMaxBytes)) {
            Move-Item -Path $LogPath -Destination ($LogPath + '.old') -Force
        }
        Add-Content -Path $LogPath -Value $line -Encoding Ascii
    } catch { }
    Write-Output $line
}

function Read-WdState {
    if (Test-Path $StatePath) {
        try {
            $raw = Get-Content $StatePath -Raw | ConvertFrom-Json
            return @{
                EngineFailures = [int]$raw.engineFailures
                LastEngineActionUtc = [datetime]$raw.lastEngineActionUtc
            }
        } catch { }
    }
    return @{ EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue }
}

function Write-WdState {
    param([hashtable]$State)
    try {
        $last = if ($State.LastEngineActionUtc -eq [datetime]::MinValue) { $null } else { $State.LastEngineActionUtc.ToString('o') }
        $obj = @{ engineFailures = $State.EngineFailures; lastEngineActionUtc = $last }
        New-Item -ItemType Directory -Force -Path $ClaudishHome | Out-Null
        [System.IO.File]::WriteAllText($StatePath, ($obj | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    } catch { Write-WdLog "state_write_error $($_.Exception.Message)" }
}

function Get-LoopbackSquatters {
    # wslrelay PIDs listening on the loopback pair for $Port. The process-name
    # filter IS the safety: the Docker backend is never returned.
    $squatters = @()
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch { return $squatters }
    foreach ($c in $conns) {
        if ($c.LocalAddress -ne '127.0.0.1' -and $c.LocalAddress -ne '::1') { continue }
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'wslrelay') {
            $squatters += [pscustomobject]@{ ProcId = $c.OwningProcess; LocalAddress = $c.LocalAddress }
        }
    }
    return $squatters
}

function Test-DockerEngine {
    # Returns 'up', 'down' or 'hang'. Bounded with a .NET Process handle:
    # the Start-Process -PassThru wrapper never populates ExitCode on 5.1
    # (Refresh() is not enough - a healthy engine read as 'down'; caught in
    # dry-run on myia-po-2028). Output is tiny, reading pipes after exit is
    # safe.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'docker'
    $psi.Arguments = 'version --format {{.Server.Version}}'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return 'down'
    }
    if (-not $p.WaitForExit(15000)) {
        try { $p.Kill() } catch { }
        return 'hang'
    }
    if ($p.ExitCode -eq 0) { return 'up' }
    return 'down'
}

function Test-DrainInFlight {
    # A drain owns the container lifecycle while it runs; R2 must not race it
    # (drain = deliberate gesture, watchdog = recovery of an abandoned state).
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'powershell%'" -ErrorAction Stop
        foreach ($pr in $procs) {
            if ($pr.CommandLine -and $pr.CommandLine -match 'claudish-drain') { return $true }
        }
    } catch { }
    return $false
}

function Test-DesktopBackendPresent {
    # com.docker.backend running = the respawn precondition measured on
    # 24/10 (Desktop respawned the terminated distro unassisted).
    return [bool](Get-Process -Name 'com.docker.backend' -ErrorAction SilentlyContinue)
}

# ---------------- main ----------------

New-Item -ItemType Directory -Force -Path $ClaudishHome | Out-Null
$State = Read-WdState
$actions = @()

# --- R1: loopback path (wslrelay squatter). Explicit [::1] - see .DESCRIPTION.
$ipv6Alive = Test-HttpAlive -Url "http://[::1]:$Port/health" -TimeoutSec 8
if (-not $ipv6Alive) {
    $squatters = Get-LoopbackSquatters
    foreach ($s in $squatters) {
        if ($DryRun) {
            $actions += "DRYRUN_R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress)"
        } else {
            $actions += "R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress)"
            try { Stop-Process -Id $s.ProcId -Force -Confirm:$false -ErrorAction Stop } catch { }
        }
    }
    if (-not $DryRun -and $squatters.Count -gt 0) {
        Start-Sleep -Seconds 3
        $ipv6After = Test-HttpAlive -Url "http://[::1]:$Port/health" -TimeoutSec 8
        $actions += "R1_REPROBE ipv6_alive=$ipv6After"
        if ($ipv6After) { $ipv6Alive = $true }
    }
}

# --- R2/R3: docker engine ---
$engine = Test-DockerEngine
if ($engine -eq 'up') {
    if ($State.EngineFailures -gt 0) { $actions += 'ENGINE_RECOVERED' }
    $State.EngineFailures = 0
} else {
    $State.EngineFailures++
    $sinceAction = (([DateTimeOffset]::UtcNow).UtcDateTime - $State.LastEngineActionUtc).TotalMinutes
    $cooldownElapsed = $sinceAction -ge $EngineCooldownMin
    $drainGuard = Test-DrainInFlight
    $backendPresent = Test-DesktopBackendPresent

    if ($State.EngineFailures -lt $ConsecutiveEngineFailures) {
        $actions += "ENGINE_FAILURE pending failures=$($State.EngineFailures)/$ConsecutiveEngineFailures"
    } elseif ($drainGuard) {
        $actions += "ENGINE_GUARD_DRAIN_IN_FLIGHT failures=$($State.EngineFailures)"
    } elseif (-not $cooldownElapsed) {
        $actions += "ENGINE_GUARD_COOLDOWN failures=$($State.EngineFailures) since_last_action_min=$([int]$sinceAction)"
    } elseif ($backendPresent) {
        # R2 - the measured path: backend respawns the distro unassisted.
        if ($DryRun) {
            $actions += "DRYRUN_R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($State.EngineFailures)"
        } else {
            $actions += "R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($State.EngineFailures)"
            Start-Process -FilePath 'wsl' -ArgumentList @('--terminate', 'docker-desktop') -NoNewWindow -Wait
        }
        $State.EngineFailures = 0
        $State.LastEngineActionUtc = ([DateTimeOffset]::UtcNow).UtcDateTime
    } else {
        # R3 - ESCALATE ONLY. No engine-relaunch actuator: the rebuild half
        # has never been proven here (po-2025 2026-09-20; #172 AC4). The
        # worker cycle relays this line.
        $actions += 'R3_ESCALATE_ENGINE_DOWN_NO_BACKEND operator_gesture=start Docker Desktop manually'
        $State.EngineFailures = 0
        $State.LastEngineActionUtc = ([DateTimeOffset]::UtcNow).UtcDateTime
    }
}

Write-WdState -State $State
$verdict = if ($ipv6Alive) { 'HEALTHY' } else { 'LOOPBACK6_DOWN' }
$detail = ($actions -join '; ')
Write-WdLog ("verdict=$verdict engine=$engine port=$Port" + $(if ($detail) { " actions=$detail" } else { '' }))
