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
           ONCE PER OUTAGE EPISODE: the unassisted respawn held on the
           24/10 morning occurrence (engine back < 3 min) and FAILED on the
           11:00Z one (distro never returned, CLI then answered "Docker
           Desktop is unable to start"; only a full chain stop + GUI
           relaunch recovered it). A rung whose rebuild half holds 1 time
           out of 2 gets one shot, then escalates - never a repeated
           teardown of a component it cannot rebuild.
      R3 - engine down AND no Docker Desktop backend: ESCALATE log line
           only. Deliberately no actuator: the rebuild half of an
           engine-relaunch has never been proven here (the po-2025 2026-09-20
           lesson: a teardown whose rebuild half was broken caused an outage
           worse than the wedge; #172 AC4). The log line names the manual
           gesture; the worker cycle relays it.

      R3 also covers a THIRD class, measured 2026-10-24 afternoon: the WSL
      SERVICE itself is wedged. A plain `wsl -d <distro> -- /bin/true` times
      out while `wsl --list --running` still answers (a metadata call) and
      vmmemWSL keeps its RAM; Docker's backend log says `bootstrapping main
      distribution: Wsl/Service/WSAETIMEDOUT`. No Docker rung can reach that
      layer - a distro termination returned, and the GUI was relaunched, and
      the engine still answered `Docker Desktop is unable to start`. Detected
      here by a bounded 20 s probe, escalated with the measured recipe
      (`wsl --shutdown`, then stop the Desktop chain and relaunch the GUI),
      never acted: `wsl --shutdown` tears down every distro on the host and
      one measured rebuild is not a proven one.

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
    actually use). Per-user scheduled task, no UAC.

    DEPLOY A STABLE COPY, never the repo path: on 2026-10-24 a branch switch
    removed this file from the working tree and every scheduled run died at
    launch (`powershell -File` on an absent path exits -196608 = 0xFFFD0000)
    with not one log line for 2.5 h. Copy the script to
    <ClaudishHome>\bin\ and the module to <ClaudishHome>\bin\lib\, then
    register with stdout captured - the scheduler discards it, and the
    launch diagnostics are the only thing that names a module that did not
    import:

      Copy-Item scripts\claudish-sidecar-host-watchdog.ps1 $HOME\.claudish\bin\ -Force
      New-Item -ItemType Directory -Force $HOME\.claudish\bin\lib | Out-Null
      Copy-Item scripts\lib\claudish-engine.psm1 $HOME\.claudish\bin\lib\ -Force
      schtasks /Create /TN ClaudishSidecarHostWatchdog /TR "cmd.exe /c
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File
        %USERPROFILE%\.claudish\bin\claudish-sidecar-host-watchdog.ps1
        1>>%USERPROFILE%\.claudish\sidecar-host-watchdog.task.out 2>&1"
        /SC MINUTE /MO 5 /F

    Refresh the copy after any change to this file or the module; the log's
    `copy_mtime=` field names WHICH file actually executed.
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

# Module resolution: the scheduled task runs a STABLE COPY outside the repo
# (~/.claudish/bin + ~/.claudish/bin/lib), so a branch switch cannot remove
# the script mid-day; `lib\` next to the copy is the first candidate, then
# the in-repo layouts for manual runs from a checkout.
$moduleCandidates = @(
    (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1'),
    (Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1')
)
$EngineModule = $null
foreach ($cand in $moduleCandidates) {
    if (Test-Path $cand) { $EngineModule = $cand; break }
}
if (-not $EngineModule) {
    # LOUD to the LOG FILE too, not stdout alone: a scheduled task discards
    # stdout, and on 2026-10-24 exactly this failure left 2.5 h of silence
    # with every run dying before its first log line.
    $msg = 'sidecar-watchdog module_missing inert_exit candidates=' + ($moduleCandidates -join ',')
    try { Add-Content -Path $LogPath -Value (('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), $msg)) -Encoding Ascii } catch { }
    Write-Output $msg
    exit 1
}
try {
    Import-Module $EngineModule -Force -ErrorAction Stop
} catch {
    $msg = 'sidecar-watchdog module_import_failed inert_exit ' + $_.Exception.Message
    try { Add-Content -Path $LogPath -Value (('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), $msg)) -Encoding Ascii } catch { }
    Write-Output $msg
    exit 1
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
                EngineActionsSinceDown = [int]$raw.engineActionsSinceDown
            }
        } catch { }
    }
    return @{ EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0 }
}

function Write-WdState {
    param([hashtable]$State)
    try {
        $last = if ($State.LastEngineActionUtc -eq [datetime]::MinValue) { $null } else { $State.LastEngineActionUtc.ToString('o') }
        $obj = @{ engineFailures = $State.EngineFailures; lastEngineActionUtc = $last; engineActionsSinceDown = $State.EngineActionsSinceDown }
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
            # StartTime separates the two measured wedge shapes (po-2023,
            # 2026-10-24): a relay OLDER than the Desktop GUI is a stale
            # chain from a previous engine generation; a relay NEWER than
            # the GUI wedged on its own (po-2028 11:11 vs GUI 09:32).
            $squatters += [pscustomobject]@{ ProcId = $c.OwningProcess; LocalAddress = $c.LocalAddress; StartTime = $proc.StartTime }
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

function Test-WslServiceResponsive {
    # 'ok' | 'timeout'. Separate class, measured 2026-10-24 13:0x local: the
    # engine would not start at all (`Docker Desktop is unable to start`, backend
    # log: bootstrapping main distribution: Wsl/Service/WSAETIMEDOUT) while a
    # plain `wsl -d Ubuntu -- ps` ALSO timed out - the host<->VM channel was
    # wedged, with `wsl --list --running` still answering (metadata call) and
    # vmmemWSL holding 24.5 GB. `wsl --terminate docker-desktop` cannot fix that
    # class, and neither could a GUI relaunch; `wsl --shutdown` then a Desktop
    # chain restart brought the engine up in ~10 s.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl'
    $psi.Arguments = '-d docker-desktop -- /bin/true'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return 'ok'   # cannot even launch: not this class, do not divert
    }
    if (-not $p.WaitForExit(20000)) {
        try { $p.Kill() } catch { }
        return 'timeout'
    }
    return 'ok'
}

# ---------------- main ----------------

New-Item -ItemType Directory -Force -Path $ClaudishHome | Out-Null
$State = Read-WdState
$actions = @()

# --- R1: loopback path (wslrelay squatter). Explicit [::1] - see .DESCRIPTION.
$ipv6Alive = Test-HttpAlive -Url "http://[::1]:$Port/health" -TimeoutSec 8

# Second instrument BEFORE declaring the loopback dead (peer review, po-2028
# Maintenance, 2026-10-24). .NET sends a Host header that a literal IPv6
# address does not satisfy on some builds - Invoke-WebRequest returns 400 where
# curl.exe returns 200 on the same address, same second. Test-HttpAlive already
# treats any status as alive, so that class cannot fire here; this is the belt
# for the NEXT variant, because a probe that lies in the DOWN direction costs a
# phantom R1 kill. Anything that answers with a 3-digit status is alive.
$curlHttp = ''
if (-not $ipv6Alive) {
    try {
        $raw = & curl.exe -s -o NUL -w '%{http_code}' --max-time 8 "http://[::1]:$Port/health" 2>$null
        $curlHttp = (($raw | Out-String).Trim())
    } catch { }
    if ($curlHttp -match '^\d{3}$') {
        $ipv6Alive = $true
        $actions += "PROBE_DOTNET_BLIND curl_http=$curlHttp"
    }
}

if (-not $ipv6Alive) {
    $squatters = Get-LoopbackSquatters
    foreach ($s in $squatters) {
        if ($DryRun) {
            $actions += "DRYRUN_R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress) relay_start=$($s.StartTime.ToString('o'))"
        } else {
            $actions += "R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress) relay_start=$($s.StartTime.ToString('o'))"
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
    $State.EngineActionsSinceDown = 0
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
    } elseif ((Test-WslServiceResponsive) -eq 'timeout') {
        # The WSL service wedge preempts every Docker rung: a distro termination
        # cannot reach a wedged host<->VM channel (measured: terminate + GUI
        # relaunch both failed, `wsl --shutdown` then a chain restart fixed it).
        # ESCALATE only - `wsl --shutdown` tears down EVERY distro on the host,
        # and one measured rebuild is not a proven one (#172 AC4).
        $actions += 'R3_ESCALATE_WSL_SERVICE_WEDGED operator_gesture=wsl --shutdown ; stop com.docker.backend+com.docker.build+Docker Desktop+wslrelay ; relaunch "C:\Program Files\Docker\Docker\Docker Desktop.exe"'
        $State.EngineFailures = 0
        $State.LastEngineActionUtc = ([DateTimeOffset]::UtcNow).UtcDateTime
    } elseif ($State.EngineActionsSinceDown -ge 1) {
        # R2 is ONCE per outage episode, never a repeated teardown. Measured on
        # this host 2026-10-24: the morning termination WAS followed by an
        # unassisted Desktop respawn (<3 min), the 11:00Z one was NOT - the
        # distro stayed absent, the CLI then answered "Docker Desktop is
        # unable to start", and only stopping the whole Desktop chain and
        # relaunching the GUI brought the engine back. A rung whose rebuild
        # half holds 1 time out of 2 may fire once per episode, then the
        # human gesture (#172 AC4: teardown only where the rebuild is proven).
        $actions += 'R3_ESCALATE_ENGINE_DOWN_AFTER_R2 operator_gesture=stop com.docker.backend/building/Docker Desktop then relaunch "C:\Program Files\Docker\Docker\Docker Desktop.exe"'
        $State.EngineFailures = 0
        $State.LastEngineActionUtc = ([DateTimeOffset]::UtcNow).UtcDateTime
    } elseif ($backendPresent) {
        # R2 - the READ path, not a guaranteed one: the Desktop respawned the
        # distro unassisted on the 24/10 morning occurrence and did not on the
        # 11:00Z one - hence once per episode (branch above).
        # BOUNDED, and logged BEFORE the action: on 2026-10-24 the unbounded
        # `-Wait` could hold a task instance with the distro wedged (every
        # later trigger is then refused), and a log written only at the end
        # of a run leaves a hang invisible. A hang must leave a line and must
        # not hold the slot.
        if ($DryRun) {
            $actions += "DRYRUN_R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($State.EngineFailures)"
        } else {
            Write-WdLog "action=R2_WSL_TERMINATE_DOCKER_DESKTOP_BEGIN failures=$($State.EngineFailures)"
            $actions += "R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($State.EngineFailures)"
            try {
                $wp = Start-Process -FilePath 'wsl' -ArgumentList @('--terminate', 'docker-desktop') -PassThru -NoNewWindow
                if (-not $wp.WaitForExit(60000)) {
                    try { $wp.Kill() } catch { }
                    $actions += 'R2_TERMINATE_KILLED_AFTER_60s'
                }
            } catch {
                $actions += "R2_TERMINATE_LAUNCH_ERROR $($_.Exception.Message)"
            }
        }
        if (-not $DryRun) { $State.EngineActionsSinceDown++ }
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

# A dry run measures; it must not move the state machine (its failure counters
# and cooldown would then fire on the next real run as if work had been done).
if (-not $DryRun) { Write-WdState -State $State }
$verdict = if ($ipv6Alive) { 'HEALTHY' } else { 'LOOPBACK6_DOWN' }
$detail = ($actions -join '; ')
# copy_mtime names WHICH file executed: on 2026-10-24 a branch switch removed
# the script from the working tree and every scheduled run died at launch
# (powershell -File on an absent path) with no line to show for it.
$copyMtime = ''
try { $copyMtime = (Get-Item $PSCommandPath).LastWriteTimeUtc.ToString('o') } catch { }
Write-WdLog ("verdict=$verdict engine=$engine curl=$curlHttp port=$Port pid=$PID copy_mtime=$copyMtime" + $(if ($detail) { " actions=$detail" } else { '' }))
