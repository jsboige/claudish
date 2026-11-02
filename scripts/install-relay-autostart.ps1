<#
.SYNOPSIS
  Registers the startup + guard scheduled task that keeps the host TCP pipe
  (:18182 -> hub) alive across reboots WITHOUT an opened session.

.DESCRIPTION
  Q65 (user GO 2026-11-01, option b): convert the logon-only
  HKCU\...\Run\ClaudishRelayPo2025 launcher into a startup task with a guard.

  What gets registered, exhaustively -- nothing else is touched:
    Task name : -TaskName          (default ClaudishRelayPo2025)
    Action    : powershell.exe 5.1 -NoProfile -ExecutionPolicy Bypass
                -WindowStyle Hidden -File <RelayDir>\relay-guard.ps1
    Trigger 1 : AtStartup          (fires before any logon)
    Trigger 2 : once + repetition every -IntervalMinutes (the guard)
    Principal : SYSTEM, ServiceAccount, RunLevel Highest
    Settings  : StartWhenAvailable, no battery stop, 5 min execution cap,
                MultipleInstances=IgnoreNew

  The guard itself is idempotent (see relay-guard.ps1): it starts the pipe
  only when nothing listens, so this task coexists with the legacy HKCU
  launcher. This installer does NOT delete the HKCU value -- that is a
  separate, reversible step taken only after the guard has proven it restarts
  a dead pipe.

  -DryRun assembles and validates the task object graph and prints exactly
  what would be written, WITHOUT registering anything and WITHOUT copying the
  guard (per the UAC discipline: the dry-run output is posted before the
  elevation window).

  Written for Windows PowerShell 5.1. ASCII only.

.EXAMPLE
  powershell.exe -NoProfile -File install-relay-autostart.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$RelayDir = 'D:\Production\claudish-relay-po2025',
    [string]$GuardSource = '',
    [string]$TaskName = 'ClaudishRelayPo2025',
    [int]$IntervalMinutes = 10,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is EMPTY inside a param() default under Windows PowerShell 5.1
# (measured 2026-11-01: Join-Path threw ParameterArgumentValidationError before
# any side effect). Resolve it here, at body scope, where it is populated.
if (-not $GuardSource) {
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $GuardSource = Join-Path $root 'relay-guard.ps1'
}

$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$guardTarget = Join-Path $RelayDir 'relay-guard.ps1'
$relayJs = Join-Path $RelayDir 'relay.js'

# ---- preflight: every failure here happens BEFORE any elevation is needed ----
if (-not (Test-Path -LiteralPath $GuardSource)) { throw "guard source not found: $GuardSource" }
if (-not (Test-Path -LiteralPath $relayJs))    { throw "relay.js not found under RelayDir: $relayJs" }
if (-not (Test-Path -LiteralPath $ps51))       { throw "Windows PowerShell 5.1 not found: $ps51" }
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1440) { throw "IntervalMinutes out of range 1..1440" }

$actionArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -RelayDir "{1}"' -f $guardTarget, $RelayDir
$action      = New-ScheduledTaskAction -Execute $ps51 -Argument $actionArgs -WorkingDirectory $RelayDir
$tStart      = New-ScheduledTaskTrigger -AtStartup
$tGuard      = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
# No -RepetitionDuration ON PURPOSE, measured 2026-11-01 under PS 5.1:
#   [TimeSpan]::MaxValue serialises to Duration P99999999DT23H59M59S and the
#   scheduler rejects the XML (0x80041318, "incorrectly formatted or out of
#   bounds"), -- and that rejection happens BEFORE the privilege check, so a
#   dry-run that only builds the object graph does not catch it. An EMPTY
#   Duration is the canonical "repeat indefinitely" shape; a Daily trigger
#   cannot take both -RepetitionInterval and -RepetitionDuration in 5.1.
$principal   = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings    = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                   -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

if ($DryRun) {
    $existing = $null
    try { $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $existing = $null }

    Write-Output 'DRY-RUN -- nothing was written, nothing was registered.'
    Write-Output ''
    Write-Output ("task name        : {0}" -f $TaskName)
    Write-Output ("already present  : {0}" -f $(if ($existing) { "YES (state=$($existing.State)) -- -Force would replace it" } else { 'no' }))
    Write-Output ("guard source     : {0}" -f $GuardSource)
    Write-Output ("guard target     : {0}" -f $guardTarget)
    Write-Output ("relay.js         : {0}" -f $relayJs)
    Write-Output ("execute          : {0}" -f $action.Execute)
    Write-Output ("arguments        : {0}" -f $action.Arguments)
    Write-Output ("trigger 1        : {0}" -f $tStart.CimClass.CimClassName)
    Write-Output ("trigger 2        : once at {0:yyyy-MM-ddTHH:mm:ss}, repetition every {1} min, duration '{2}'" -f `
                      $tGuard.StartBoundary, $IntervalMinutes, $(if ($tGuard.Repetition.Duration) { $tGuard.Repetition.Duration } else { '(empty = indefinite)' }))
    Write-Output ("principal        : {0} / {1} / {2}" -f $principal.UserId, $principal.LogonType, $principal.RunLevel)
    Write-Output ("settings         : StartWhenAvailable={0} ExecLimit={1} MultipleInstances={2}" -f `
                      $settings.StartWhenAvailable, $settings.ExecutionTimeLimit, $settings.MultipleInstances)
    Write-Output ''
    Write-Output 'Would run, in this order:'
    Write-Output ("  1. Copy-Item '{0}' -> '{1}'" -f $GuardSource, $guardTarget)
    Write-Output ("  2. Register-ScheduledTask -TaskName '{0}' -Trigger (@(AtStartup, Once+{1}min)) -Principal SYSTEM -Force" -f $TaskName, $IntervalMinutes)
    Write-Output '  (nothing else: the HKCU Run value, relay.js and the running pipe are untouched)'
    exit 0
}

# ---- real run: register (needs elevation -- access denied otherwise) ----
Copy-Item -LiteralPath $GuardSource -Destination $guardTarget -Force
$task = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($tStart, $tGuard) -Principal $principal -Settings $settings -Force
$info = $task | Get-ScheduledTaskInfo
Write-Output ("REGISTERED {0} | state={1} | lastRun={2} | lastResult={3}" -f $task.TaskName, $task.State, $info.LastRunTime, $info.LastTaskResult)
