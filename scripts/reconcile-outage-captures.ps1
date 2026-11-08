#requires -Version 5.1
<#
.SYNOPSIS
  Package a sidecar's outage-window captures for reconciliation on the hub.

.DESCRIPTION
  In the relay/sidecar topology (see docker-compose.yml + relay.ts), a sidecar
  machine forwards ALL traffic to the central hub (po-2023) in NOMINAL mode. That
  forward path bypasses local capture entirely (the branch returns before
  logRequest, and the response pipe uses capture:false) — so the hub owns the
  single central capture stream, with 30:1 compression.

  A sidecar writes loose captures ONLY while AUTONOMOUS, i.e. during a hub outage.
  Therefore, by construction, ANY loose req-*/resp-* files on a sidecar ARE
  outage captures — no time-window guessing needed. This script packs them into a
  single machine-namespaced archive

      reconcile/outage-<machine>-<start>_<end>.7z

  (start/end = min/max capture timestamp, UTC, compact yyyyMMddTHHmmss), verifies
  it, copies it to the GDrive reconcile/ subfolder, and ONLY THEN deletes the
  loose originals (same never-delete-without-verified-offsite-copy safety as
  compress-captures.ps1). The hub picks up reconcile/*.7z nightly, extracts, and
  merges — attribution is correct because each req-*.json body carries `machine`
  (the capture-machine-attribution foundation, commit 141d160).

  DO NOT schedule this on the hub (po-2023): the hub's captures are normal traffic
  packed by compress-captures.ps1 as captures-YYYY-MM-DD.7z (different prefix, no
  collision). This script is a SIDECAR-only job.

.PARAMETER CaptureDir
  Directory holding the loose req-*/resp-* capture files (the sidecar's mount).

.PARAMETER Machine
  Machine name for the archive namespace. Default: read from the first capture's
  `machine` field (X-Claudish-Machine), falling back to the hostname.

.PARAMETER GDriveDir
  Off-site GDrive root for claudish captures. The archive lands in its reconcile/
  subfolder. Empty = skip GDrive (local staging only; loose files are then KEPT,
  never deleted without an off-site copy).

.PARAMETER WhatIf
  Show what would be archived/copied/deleted without changing anything.

.PARAMETER Register
  #912 (arbitrage a): register the hourly per-seat reconciliation task
  'ClaudishReconcileOutageCaptures' and exit. The task runs THIS script (no
  -Register) under the CURRENT operator account, RunLevel Limited — a per-user
  task needs no elevation, which the registering run itself proves (it must
  never raise a UAC prompt). Remove the task with:

    Unregister-ScheduledTask -TaskName 'ClaudishReconcileOutageCaptures' -Confirm:$false

.NOTES
  Schedule on each sidecar (Task Scheduler), e.g. hourly or a few minutes after a
  watchdog-detected recovery. Idempotent: with no loose captures it is a no-op.
  install-sidecar.ps1 registers the task as part of a sidecar install (-Register);
  on a seat installed before that, run this script once with -Register.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$CaptureDir = "D:\claudish-captures",
  [string]$Machine    = "",
  [string]$SevenZip   = "D:\Apps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe",
  [string]$GDriveDir  = "G:\Mon Drive\MyIA\backups\claudish-captures",
  [switch]$Register
)

$ErrorActionPreference = "Stop"
$ReconcileDir = Join-Path $CaptureDir "reconcile"
$logFile = Join-Path $CaptureDir "reconcile.log"

function Log([string]$msg) {
  $line = "{0:yyyy-MM-ddTHH:mm:ssZ} {1}" -f (Get-Date).ToUniversalTime(), $msg
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch {}
}

# --- -Register: create the per-seat task, then exit (#912 arbitrage a) --------
# Never elevated, never a service principal: the task runs as the installing
# operator, RunLevel Limited. Registering a per-user task under one's own
# account requires no UAC consent — the non-elevated registering run is itself
# the proof the grain asks for.
if ($Register) {
    $self = $PSCommandPath
    if (-not $self) { Write-Host "FATAL: -Register needs the script file path (not dot-sourced)"; exit 2 }
    # pwsh 7 where installed (the fleet's scheduled interpreter), powershell.exe
    # 5.1 otherwise — this script is 5.1-clean on purpose (#requires 5.1) and
    # both interpreters must stay able to run it (test:scripts + :win51).
    $pwsh7 = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    $exe   = if (Test-Path -LiteralPath $pwsh7) { $pwsh7 } else { "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }
    $action  = New-ScheduledTaskAction -Execute $exe `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $self)
    # Hourly repetition, first run a few minutes out. The job is an idempotent
    # no-op while the sidecar stays NOMINAL, so hourly costs one directory
    # listing — and StartWhenAvailable catches suspended-hours misses.
    # RepetitionDuration: a large-but-VALID bound, never [TimeSpan]::MaxValue —
    # MaxValue serializes to PT99999999DT23H59M59S, which Task Scheduler rejects
    # as out-of-range XML ("valeur incorrectement formatée ou hors limites",
    # caught by the non-elevated registering run). 10 years is indefinite enough.
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) `
        -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    $princ   = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'ClaudishReconcileOutageCaptures' `
        -Action $action -Trigger $trigger -Settings $set -Principal $princ -Force | Out-Null
    Write-Host ("OK  task ClaudishReconcileOutageCaptures registered: hourly, as {0}\{1}, RunLevel Limited (no elevation)" -f $env:USERDOMAIN, $env:USERNAME)
    exit 0
}

# --- preconditions -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $SevenZip))   { Log "FATAL: 7z not found at $SevenZip"; exit 2 }
if (-not (Test-Path -LiteralPath $CaptureDir)) { Log "FATAL: capture dir not found: $CaptureDir"; exit 2 }

# --- enumerate loose captures (outage captures by construction on a sidecar) --
$rx = '^(req|resp)-.*?(?<d>\d{4}-\d{2}-\d{2})T(?<t>\d{2}-\d{2}-\d{2})'
$loose = Get-ChildItem -LiteralPath $CaptureDir -File | Where-Object { $_.Name -match $rx }
if (-not $loose) { Log "nothing to do (0 loose capture files — sidecar stayed nominal, no outage)"; Log "END"; exit 0 }

# Timestamp window from filenames (UTC). The capture filename time uses dashes
# (HH-mm-ss); normalize to a real datetime, then to compact yyyyMMddTHHmmss.
$stamps = foreach ($f in $loose) {
  if ($f.Name -match $rx) {
    $iso = "{0}T{1}" -f $matches['d'], ($matches['t'] -replace '-', ':')
    try { [datetime]::Parse($iso, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal) } catch {}
  }
}
$stamps = @($stamps | Where-Object { $_ }) | Sort-Object
if (-not $stamps) { Log "FATAL: could not parse any capture timestamps"; exit 2 }
$startTag = $stamps[0].ToString('yyyyMMddTHHmmss')
$endTag   = $stamps[-1].ToString('yyyyMMddTHHmmss')

# --- resolve machine name (namespace) ----------------------------------------
if (-not $Machine) {
  $firstReq = $loose | Where-Object { $_.Name -like 'req-*' } | Select-Object -First 1
  if ($firstReq) {
    try {
      $j = Get-Content $firstReq.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
      if ($j.machine) { $Machine = [string]$j.machine }
    } catch {}
  }
}
if (-not $Machine) { $Machine = ($env:COMPUTERNAME).ToLower() }
# Filename-safe: keep alnum + dash only.
$Machine = ($Machine -replace '[^A-Za-z0-9\-]', '-')

$rawBytes = ($loose | Measure-Object -Property Length -Sum).Sum
$archiveName = "outage-$Machine-${startTag}_${endTag}.7z"
$archivePath = Join-Path $ReconcileDir $archiveName

Log ("START reconcile: {0} loose files, {1:N1} MB, window {2}..{3}, machine={4}" -f `
     $loose.Count, ($rawBytes/1MB), $startTag, $endTag, $Machine)

if (-not $PSCmdlet.ShouldProcess("$($loose.Count) files", "7z -> $archiveName, copy to GDrive/reconcile, delete loose")) {
  Log "END (WhatIf)"; exit 0
}

if (-not (Test-Path -LiteralPath $ReconcileDir)) { New-Item -ItemType Directory -Path $ReconcileDir -Force | Out-Null }

# --- compress + verify -------------------------------------------------------
$listFile = Join-Path $env:TEMP ("claudish-reconcile-{0}.lst" -f $PID)
[System.IO.File]::WriteAllLines($listFile, ($loose | ForEach-Object { $_.Name }), (New-Object System.Text.UTF8Encoding($false)))

Push-Location $CaptureDir
try {
  # -md=32m -mmt=8: same memory bound as compress-captures.ps1 (jsboige/
  # Maintenance#281 — -md=128m -mmt=on measured 15.2 G of commit, machine
  # unresponsive ~3 h on 06/11). This script runs on demand, often beside the
  # nightly job, so the bound matters twice here.
  & $SevenZip a -t7z -m0=lzma2 -mx=9 -md=32m -mfb=273 -mmt=8 -bso0 -bsp0 "$archivePath" "@$listFile" | Out-Null
  $addRc = $LASTEXITCODE
  & $SevenZip t -bso0 -bsp0 "$archivePath" | Out-Null
  $testRc = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item -LiteralPath $listFile -Force -ErrorAction SilentlyContinue
}

if ($addRc -ne 0 -or $testRc -ne 0 -or -not (Test-Path -LiteralPath $archivePath)) {
  Log ("ERROR: 7z add rc={0} test rc={1} -> KEEPING loose files (not deleted)" -f $addRc, $testRc)
  exit 1
}
$archBytes = (Get-Item -LiteralPath $archivePath).Length
$ratio = if ($archBytes -gt 0) { [Math]::Round($rawBytes / $archBytes, 1) } else { 0 }
Log ("OK  archived {0} files, {1:N1} MB -> {2:N1} MB ({3}:1): {4}" -f `
     $loose.Count, ($rawBytes/1MB), ($archBytes/1MB), $ratio, $archiveName)

# --- off-site copy to GDrive reconcile/ --------------------------------------
# Loose files are deleted ONLY after a verified archive AND a confirmed off-site
# copy (size match). No GDrive => keep loose (retry next run); we never lose data.
$offsiteOk = $false
if ($GDriveDir) {
  $gdReconcile = Join-Path $GDriveDir "reconcile"
  if (Test-Path -LiteralPath $GDriveDir) {
    try {
      if (-not (Test-Path -LiteralPath $gdReconcile)) { New-Item -ItemType Directory -Path $gdReconcile -Force | Out-Null }
      Copy-Item -LiteralPath $archivePath -Destination $gdReconcile -Force -ErrorAction Stop
      $dest = Join-Path $gdReconcile $archiveName
      if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $archBytes) {
        $offsiteOk = $true
        Log ("GDRIVE uploaded reconcile/{0} ({1:N1} MB)" -f $archiveName, ($archBytes/1MB))
      } else {
        Log "WARN GDrive copy size mismatch -> loose KEPT, retry next run"
      }
    } catch {
      Log ("WARN GDrive copy failed: {0} -> loose KEPT, retry next run" -f $_.Exception.Message)
    }
  } else {
    Log ("WARN GDriveDir not mounted ({0}) -> loose KEPT, retry next run" -f $GDriveDir)
  }
} else {
  Log "INFO GDriveDir empty -> local staging only, loose KEPT (never delete without off-site copy)"
}

# --- delete loose only after verified archive + confirmed off-site copy -------
if ($offsiteOk) {
  $loose | Remove-Item -Force
  Log ("CLEANUP {0} loose files deleted (safe: verified archive + GDrive copy)" -f $loose.Count)
} else {
  Log "CLEANUP skipped (no confirmed off-site copy) -> loose files retained"
}

Log "END"
exit 0
