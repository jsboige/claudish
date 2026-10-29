<#
.SYNOPSIS
Generate this machine's row of the #291 relay+sidecar control matrix, from
live objects only - never from intent, never from a hand-maintained table.

.DESCRIPTION
Issue #291's defect is not missing rows; it is that every row was hand-read
once and nothing regenerates it (po-2023's cadrage: "generate, don't
maintain"). This script emits one machine's row where EVERY cell is one
read-only command away, reusing the audit v2 skeleton (container state, env
BY VALUE, config-home provenance) and adding the two cells it lacks: the
client's live ANTHROPIC_BASE_URL and the container's live
CLAUDISH_RELAY_UPSTREAM.

Cells that cannot be measured render '?' - UNKNOWN is a first-class value
(a blank would read as "ok", the exact error the matrix exists to prevent).

Read-only: no container is touched, restarted or drained. URLs and counts
are printed; credential VALUES never are (key NAMES only where a cell needs
existence, and there is no such cell today).

.PARAMETER SettingsPath
The Claude Code settings file whose env.ANTHROPIC_BASE_URL is the client
cell. Default $env:USERPROFILE\.claude\settings.json.

.PARAMETER HealthPort
Port for the /health probe when it cannot be derived from the container's
published port map. Default: derived.

.OUTPUTS
A detail block then one markdown table row (the #291 shape, subset
measurable from this seat). Exit 0 on a fully measured row, 1 when at least
one cell read '?', 2 when docker is unreachable (the whole row is '?' then).

.EXAMPLE
pwsh -NoProfile -File scripts/fleet-matrix.ps1
#>
[CmdletBinding()]
param(
    [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.json'),
    [int]$HealthPort = 0
)

$ErrorActionPreference = 'Stop'
$script:MatrixExitCode = 0

function Get-DockerLines([string[]]$Arguments) {
    # Output-based, like the audit: $LASTEXITCODE is not set by Pester mocks.
    # No output = no signal: PowerShell delivers an empty pipeline to the
    # caller as $null - exactly the "docker unreachable" semantics we want,
    # for free (the same unrolling trap the comma-wrap in Get-ClaudishContainers
    # guards against, working FOR us here). A live container's ps/inspect/logs
    # never emit zero lines, so $null never masks a measured empty set.
    try { return @(& docker @Arguments 2>$null) } catch { return $null }
}

function Get-ClaudishContainers {
    # Names of every claudish container, running or not: a stopped sidecar is
    # a finding, not noise.
    $lines = Get-DockerLines @('ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}')
    if ($null -eq $lines) { return $null }
    # Comma-wrap the filtered result: a function that emits an EMPTY array
    # delivers $null to the caller (empty pipelines emit nothing), which made
    # a claud-less seat render as "docker unreachable" - a finding about the
    # instrument where the finding is about the fleet (caught by the "none"
    # pin). $null stays reserved for "docker gave no signal".
    return , @($lines | Where-Object { $_ -match 'claud' })
}

function Get-ContainerFacts([string]$Name) {
    # upstream, published host port, image created date, armed-by-value count,
    # role-cascade count - all from ONE inspect env dump + one created read.
    $env = Get-DockerLines @('inspect', $Name, '--format', '{{range .Config.Env}}{{println .}}{{end}}')
    if ($null -eq $env -or $env.Count -eq 0) { return $null }
    $upstream = $null
    foreach ($line in $env) {
        if ($line -like 'CLAUDISH_RELAY_UPSTREAM=*') { $upstream = $line.Substring('CLAUDISH_RELAY_UPSTREAM='.Length) }
    }
    # Armed BY VALUE, never by name: every container shows ~23+ failover NAMES
    # whether armed or not - the blindness this fleet keeps paying for (#711,
    # #730). A name with an empty value is NOT arming.
    $armedByValue = @($env | Where-Object { $_ -match '^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+' }).Count
    $roleCascades = @($env | Where-Object { $_ -match '^CLAUDISH_FAILOVER_(OPUS|SONNET|HAIKU|FABLE)=.+' }).Count
    $created = (Get-DockerLines @('inspect', $Name, '--format', '{{.Created}}') | Select-Object -First 1)
    $ports = (Get-DockerLines @('inspect', $Name, '--format', '{{json .HostConfig.PortBindings}}') | Select-Object -First 1)
    # JSON form: {"3000/tcp":[{"HostIp":"","HostPort":"3000"}]} - the KEY is
    # the container port; the host port lives in HostPort. Match HostPort
    # first, else a 1:1 mapping silently reports the container port as host.
    $hostPort = $null
    if ($ports -match '"HostPort":"(\d+)"') { $hostPort = $Matches[1] }
    [pscustomobject]@{
        Upstream      = $upstream
        ArmedByValue  = $armedByValue
        RoleCascades  = $roleCascades
        ImageCreated  = $created
        HostPort      = $hostPort
    }
}

function Get-HealthRole([int]$Port) {
    if ($Port -le 0) { return $null }
    try {
        $h = Invoke-RestMethod -Uri ("http://localhost:{0}/health" -f $Port) -TimeoutSec 5
        if ($h.role) { return "$($h.role)" }
        return 'reachable'
    } catch { return 'unreachable' }
}

function Get-ClientBaseUrl([string]$Path) {
    if (-not (Test-Path $Path)) { return '?' }
    try {
        $j = Get-Content -Raw $Path | ConvertFrom-Json
        $v = $j.env.ANTHROPIC_BASE_URL
        if ($v) { return "$v" }
        return '(unset)'
    } catch { return '?' }
}

function Get-RelayTransitions([string]$Name) {
    $logs = Get-DockerLines @('logs', $Name, '--tail', '800', '--timestamps')
    if ($null -eq $logs) { return $null }
    $t = @($logs | Where-Object { $_ -match '\[Relay\].*(AUTONOMOUS|NOMINAL)' })
    if ($t.Count -eq 0) { return '0 in tail' }
    $last = ($t[-1] -replace '^([0-9T:.Z-]+).*', '$1')
    return ("{0} in tail, last {1}" -f $t.Count, $last)
}

function Render-Row([string]$Machine, $Containers) {
    $cells = [System.Collections.Generic.List[string]]::new()
    $cells.Add($Machine)
    $client = Get-ClientBaseUrl $SettingsPath
    if ($client -eq '?') { $script:MatrixExitCode = [Math]::Max($script:MatrixExitCode, 1) }
    if ($null -eq $Containers) {
        # Docker gave NO signal: every docker-read cell is UNKNOWN and the
        # whole row is. The client cell does not depend on docker - it stays
        # measured (one honest cell beats a uniform '?').
        $cells.AddRange([string[]]@('?', '?', '?', '?', '?', $client, '?', '?'))
        $script:MatrixExitCode = 2
        return ($cells -join ' | ')
    }
    # Re-array at the boundary, AFTER the null check: @($null) is a ONE-element
    # array, so re-arming first would make the null branch unreachable and a
    # dead docker would render as a phantom container. PowerShell also unrolls
    # a one-element array on return, so a single-container seat arrives as a
    # STRING and $Containers[0] would index its first CHARACTER (measured:
    # name "c", every inspect cell "?").
    $Containers = @($Containers)
    if ($Containers.Count -eq 0) {
        # No claudish container: a real, sayable state - not a blank.
        $cells.AddRange([string[]]@('none', '-', '-', '-', '-', $client, '-', '-'))
        return ($cells -join ' | ')
    }
    $unknown = $false
    $cells.Add((@($Containers | ForEach-Object { ($_ -split '\|')[0] }) -join ' + '))
    # Bind the name FIRST: in argument mode `($x -split '\|')[0]` does not
    # index - the [0] would start a new token and the function would receive
    # garbage (measured: every inspect cell read '?').
    $firstName = ($Containers[0] -split '\|')[0]
    $facts0 = Get-ContainerFacts $firstName
    if ($null -eq $facts0) {
        # inspect gave nothing (container gone between ps and inspect): the
        # docker-derived cells are UNKNOWN, never blank - a blank reads "ok".
        $unknown = $true
        $cells.AddRange([string[]]@('?', '?', '?'))
    } else {
        if ($null -eq $facts0.HostPort) { $unknown = $true; $cells.Add('?') } else { $cells.Add($facts0.HostPort) }
        if ($facts0.ImageCreated) { $cells.Add(($facts0.ImageCreated -replace '^(\d{4}-\d{2}-\d{2}).*', '$1')) } else { $unknown = $true; $cells.Add('?') }
        # No upstream var = a measured HUB seat - a state, not an unknown.
        if ($null -eq $facts0.Upstream) { $cells.Add('(unset - local)') } else { $cells.Add($facts0.Upstream) }
    }
    $port = if ($HealthPort -gt 0) { $HealthPort } elseif ($null -ne $facts0 -and $null -ne $facts0.HostPort) { [int]$facts0.HostPort } else { 0 }
    $health = Get-HealthRole $port
    if ($null -eq $health) { $unknown = $true; $cells.Add('?') } else { $cells.Add($health) }
    $cells.Add($client)
    if ($null -eq $facts0) { $unknown = $true; $cells.Add('?') } else {
        $cells.Add(("{0} names / {1} role cascade(s)" -f $facts0.ArmedByValue, $facts0.RoleCascades))
    }
    $transitions = Get-RelayTransitions $firstName
    if ($null -eq $transitions) { $unknown = $true; $cells.Add('?') } else { $cells.Add($transitions) }
    if ($unknown) { $script:MatrixExitCode = [Math]::Max($script:MatrixExitCode, 1) }
    return ($cells -join ' | ')
}

$machine = ("MYIA-" + $env:COMPUTERNAME).ToUpper() -replace 'MYIA-MYIA-', 'MYIA-'
$containers = Get-ClaudishContainers
$containerSummary = 'docker unreachable'
if ($null -ne $containers) {
    if ($containers.Count -eq 0) { $containerSummary = 'none' }
    else { $containerSummary = ($containers -join ' ; ') }
}
Write-Output "fleet-matrix (read-only) - $machine"
Write-Output ("  containers : {0}" -f $containerSummary)
Write-Output ""
Write-Output "| machine | container(s) | host port | image | upstream (live) | /health role | client base_url (live) | cascade by value | relay transitions |"
Write-Output "|---|---|---|---|---|---|---|---|---|"
Write-Output ("| " + (Render-Row $machine $containers) + " |")
exit $script:MatrixExitCode
