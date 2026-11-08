<#
.SYNOPSIS
One seat's sidecar image-vintage row: image Created, /health key count,
commit distance on packages/cli/src.

.DESCRIPTION
A sidecar's image vintage is named for free by its /health shape: the
eventLoop* gauges arrived with #615 (7f8c1b5f, 2026-10-24), so a sidecar
that renders 11 keys with no gauge is pre-#615 whatever its container row
says (measured 01/11: hub 15 keys; po-2027 14 keys WITH gauges, image
2026-10-27; ai-01 11 keys, image 2026-10-11; po-2024 image 2026-10-19).
The deployment check of the hub never controls each sidecar's image, and a
sidecar several never-hang/failover fixes behind can relay for weeks
unseen - this row makes the drift one command away on any seat.

Every cell is read-only: docker inspect (the IMAGE's Created, not the
container's - #291's lesson: a seat that recreated this morning would
otherwise read as "image built today"), the published host port, GET
/health (top-level key count, eventLoop gauge count), and git log (commits
touching packages/cli/src since the image was created).

Cells that cannot be measured render '?' - UNKNOWN is a first-class value
(a blank would read as "ok"). A zero commit distance is a measured zero,
never '?'.

Read-only: no container is touched, restarted or drained.

.PARAMETER Container
Container to census. Default 'claudish-sidecar'; the hub seat passes
-Container claudish-proxy.

.PARAMETER HealthPort
Port for the /health probe when it cannot be derived from the container's
published port map. Default: derived (HostPort-first, #291).

.PARAMETER RepoPath
Repo whose packages/cli/src counts the commit distance. Default: the repo
this script lives in.

.OUTPUTS
A detail block then one markdown table row. Exit 0 on a fully measured
row, 1 when at least one cell read '?', 2 when docker is unreachable
(every docker-read cell is '?' then).

.EXAMPLE
pwsh -NoProfile -File scripts/sidecar-vintage.ps1
#>
[CmdletBinding()]
param(
    [string]$Container = 'claudish-sidecar',
    [int]$HealthPort = 0,
    [string]$RepoPath = ''
)

$ErrorActionPreference = 'Stop'
$script:VintageExitCode = 0

if (-not $RepoPath) {
    # $PSScriptRoot = scripts -> ONE parent up is the repo root. Two would
    # land on the parent OF the checkout (measured 01/11: repo read D:\dev,
    # git exited 128, distance rendered '?' - a path bug dressed as unknown).
    $RepoPath = Split-Path -Parent $PSScriptRoot
}

function Get-DockerLines([string[]]$Arguments) {
    # Output-based, like fleet-matrix: $LASTEXITCODE is not set by Pester
    # fakes. No output = no signal, delivered to the caller as $null -
    # reserved for "docker gave no signal", never for a measured empty set.
    try { return @(& docker @Arguments 2>$null) } catch { return $null }
}

function Get-HealthShape([int]$Port) {
    # Returns @{ Keys = N; Gauges = M } or $null when /health cannot answer.
    if ($Port -le 0) { return $null }
    try {
        $h = Invoke-RestMethod -Uri ("http://localhost:{0}/health" -f $Port) -TimeoutSec 5
        $names = @($h.PSObject.Properties.Name)
        return @{
            Keys   = $names.Count
            Gauges = @($names | Where-Object { $_ -like 'eventLoop*' }).Count
        }
    } catch { return $null }
}

function Get-CommitCounts([string]$SinceIso, [string]$Repo) {
    # Two distances since the IMAGE was created: every commit under
    # packages/cli/src, and the CRITICAL subset - non-test sources. The
    # total says "stale", the critical count says "serves wrong behavior":
    # a sidecar behind on handlers/failover/relay code is the one that
    # mishandles a turn in AUTONOMOUS, and that is the number that decides
    # a recreate (file v26: commit distance alone does not say which ones
    # count). A zero is a measured zero; $null (git gave no signal) is
    # unknown at the caller.
    if (-not $SinceIso) { return $null }
    $total = & git -C $Repo log ("--since={0}" -f $SinceIso) --format=%H -- packages/cli/src 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $critical = & git -C $Repo log ("--since={0}" -f $SinceIso) --format=%H -- packages/cli/src ":(exclude)*.test.ts" ":(exclude)packages/cli/src/test-support" ":(exclude)packages/cli/src/test-fixtures" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return @{
        Total    = if ($null -eq $total) { 0 } else { @($total).Count }
        Critical = if ($null -eq $critical) { 0 } else { @($critical).Count }
    }
}

# --- docker signal -----------------------------------------------------------
# inspect answers $null BOTH when docker is dead AND when the name is absent -
# 2>$null swallows the error either way. An independent liveness probe
# (docker version) separates them: dead docker is UNKNOWN ('?'), an absent
# container is a measured state ("absent"). Without the probe the absent
# branch below is unreachable and an uninstalled sidecar reads as a dead
# docker - a finding about the instrument where the finding is the fleet.
$dockerAlive = (Get-DockerLines @('version', '--format', '{{.Server.Version}}') | Select-Object -First 1)

$imageId = (Get-DockerLines @('inspect', $Container, '--format', '{{.Image}}') | Select-Object -First 1)
$imageCreated = if ($imageId) {
    (Get-DockerLines @('image', 'inspect', $imageId, '--format', '{{.Created}}') | Select-Object -First 1)
} else { $null }

$hostPort = $null
$bindings = (Get-DockerLines @('inspect', $Container, '--format', '{{json .HostConfig.PortBindings}}') | Select-Object -First 1)
# The KEY is the container port; the host port lives in HostPort. Match
# HostPort first, else a 1:1 mapping silently reports the container port.
if ($bindings -match '"HostPort":"(\d+)"') { $hostPort = $Matches[1] }

$machine = ("MYIA-" + $env:COMPUTERNAME).ToUpper() -replace 'MYIA-MYIA-', 'MYIA-'

Write-Output "sidecar-vintage (read-only) - $machine"
Write-Output ("  container  : {0}" -f $Container)
Write-Output ("  repo       : {0}" -f $RepoPath)

if ($null -eq $dockerAlive) {
    # Docker gave NO signal: every docker-read cell is UNKNOWN.
    Write-Output ''
    Write-Output '| machine | container | image created (UTC) | /health keys | eventLoop gauges | commits behind (packages/cli/src) | critical behind (non-test) |'
    Write-Output '|---|---|---|---|---|---|---|'
    Write-Output "| $machine | $Container | ? | ? | ? | ? | ? |"
    exit 2
}

if (-not $imageId) {
    # inspect gave nothing for this name: a measured absence, not an unknown.
    Write-Output '  inspect    : container absent'
    Write-Output ''
    Write-Output '| machine | container | image created (UTC) | /health keys | eventLoop gauges | commits behind (packages/cli/src) | critical behind (non-test) |'
    Write-Output '|---|---|---|---|---|---|---|'
    Write-Output "| $machine | $Container | absent | - | - | - | - |"
    exit 0
}

# --- measured cells ----------------------------------------------------------
$unknown = $false

$createdCell = '?'
if ($imageCreated) { $createdCell = $imageCreated } else { $unknown = $true }

$port = if ($HealthPort -gt 0) { $HealthPort } elseif ($hostPort) { [int]$hostPort } else { 0 }
$shape = Get-HealthShape $port
$keysCell = '?'; $gaugesCell = '?'
if ($null -ne $shape) {
    $keysCell = "{0}" -f $shape.Keys
    if ($shape.Gauges -gt 0) { $gaugesCell = "yes ({0})" -f $shape.Gauges } else { $gaugesCell = 'no' }
} else { $unknown = $true }

$distance = Get-CommitCounts $imageCreated $RepoPath
$distanceCell = '?'; $criticalCell = '?'
if ($null -ne $distance) {
    $distanceCell = "{0}" -f $distance.Total
    $criticalCell = "{0}" -f $distance.Critical
} else { $unknown = $true }

Write-Output ("  image      : {0}" -f $imageId)
Write-Output ("  created    : {0}" -f $createdCell)
Write-Output ("  health     : {0}" -f ("http://localhost:{0}/health" -f $port))
if ($shape -and $shape.Gauges -eq 0) {
    Write-Output '  vintage    : no eventLoop gauges - image predates #615 (2026-10-24, 7f8c1b5f)'
}
Write-Output ''

Write-Output '| machine | container | image created (UTC) | /health keys | eventLoop gauges | commits behind (packages/cli/src) | critical behind (non-test) |'
Write-Output '|---|---|---|---|---|---|---|'
Write-Output ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |" -f $machine, $Container, $createdCell, $keysCell, $gaugesCell, $distanceCell, $criticalCell)
if ($unknown) { $script:VintageExitCode = 1 }
exit $script:VintageExitCode
