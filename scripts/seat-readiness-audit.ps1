<#
.SYNOPSIS
  One-seat hub-death readiness audit: local path, ARMED cascade, resolvable fuel.

.DESCRIPTION
  jsboige/claudish#730. On 2026-10-27 the hub's machine rebooted and the fleet
  split three ways; a seat survived if and only if it carried, LOCALLY: a
  sidecar (a local path), an armed cascade IN THAT CONTAINER (in AUTONOMOUS a
  sidecar runs its own cascade, never the hub's), and a resolvable credential
  for at least one rung. This script answers, read-only, for THE SEAT IT RUNS
  ON: "would this seat survive the hub dying right now?"

  Verdicts (one line, plus the evidence behind each):
    READY     sidecar present, >=1 cascade armed BY VALUE, >=1 credentialed
              rung in a bucket OTHER than the nominal's.
    NO-FUEL   armed but every rung sits in the nominal's provider bucket (the
              wall that killed the nominal already killed them), or no
              credential resolves for any rung bucket. A parachute with no
              fabric: it flips, and it falls.
    NO-PATH   no sidecar container: nothing can serve without the hub.
    UNKNOWN   a source this audit needs is unreadable (docker down, container
              env missing). First-class verdict, never a blank: three seats
              were never measured and an audit that renders them "ok" is worse
              than none.

  HARD RULES (the exact errors that hid the 2026-10-27 split):
  - Presence is not arming. CLAUDISH_FAILOVER_* is counted BY VALUE
    (non-empty), never by name: a container shows ~32-36 names armed or not.
  - Never print a value. Env names, counts and booleans only:
    CLAUDISH_PROXY_KEY shares the container env with provider credentials.
  - The step-bucket rule: a cascade whose every rung shares the nominal's
    provider bucket protects nothing - budget walls key by bucket (#275), so
    the wall that exhausts the nominal exhausts the steps with it. Distinct
    rungs in distinct buckets are the point of the fabric.

  The nominal bucket is an ASSUMPTION this audit states out loud (default
  'zai', the fleet's sonnet nominal as of 2026-10-28); override with
  -NominalBucket when that changes. An audit with a silent assumption is a
  fleet manifest that drifts.

.PARAMETER ContainerName
  The sidecar container to inspect. Default claudish-sidecar.

.PARAMETER NominalBucket
  Provider bucket of the role's nominal on this seat, for the step-bucket
  rule. Default 'zai' (fleet sonnet nominal, 2026-10-28).

.OUTPUTS
  Human-readable block on stdout. Exit codes: 0 READY, 1 NO-FUEL, 2 NO-PATH,
  3 UNKNOWN, 4 usage/internal error.

.EXAMPLE
  powershell -NoProfile -File scripts/seat-readiness-audit.ps1

.EXAMPLE
  pwsh -NoProfile -File scripts/seat-readiness-audit.ps1 -NominalBucket zai
#>
[CmdletBinding()]
param(
    [string]$ContainerName = "claudish-sidecar",
    [string]$NominalBucket = "zai"
)

$ErrorActionPreference = "Stop"

# --- docker access, isolated so tests can mock it --------------------------

function Get-DockerAvailable {
    # Output-based probe, not $LASTEXITCODE-based: under Pester native-command
    # mocks $LASTEXITCODE is not set by the shim, and a docker-down seat must
    # still read UNKNOWN rather than hang on stale state.
    try {
        $v = & docker info --format "{{.ServerVersion}}" 2>$null
        return (-not [string]::IsNullOrWhiteSpace([string]$v))
    }
    catch { return $false }
}

function Get-ContainerState([string]$Name) {
    # 'absent', 'running', 'exited', or 'other'
    $line = & docker ps -a --filter "name=^/$Name$" --format "{{.Names}}|{{.State}}" 2>$null
    if (-not $line) { return "absent" }
    return ($line -split '\|')[1]
}

function Get-ContainerEnvRaw([string]$Name) {
    # Raw "NAME=value" lines, one per line. The CALLER is responsible for never
    # printing them: CLAUDISH_PROXY_KEY and provider credentials share this env.
    return @(& docker inspect $Name --format "{{range .Config.Env}}{{println .}}{{end}}" 2>$null)
}

function Get-ContainerEnvNamesAndClassifiedValues([string]$Name) {
    # Returns a helper object that NEVER exposes raw values to the caller:
    # names, per-name HasValue booleans, and classified cascade structure.
    $raw = Get-ContainerEnvRaw $Name
    $names = [System.Collections.Generic.List[string]]::new()
    $hasValue = @{}
    foreach ($entry in @($raw)) {
        if (-not $entry) { continue }
        $idx = $entry.IndexOf('=')
        if ($idx -lt 1) { continue }
        $n = $entry.Substring(0, $idx)
        $v = $entry.Substring($idx + 1)
        $names.Add($n)
        $hasValue[$n] = ($v.Trim().Length -gt 0)
    }
    return [pscustomobject]@{ Names = $names; HasValue = $hasValue }
}

# --- bucket vocabulary ------------------------------------------------------

# Provider shortcut -> budget bucket. The bucket is what a budget wall keys on
# (#275): same account family, same wall. 'unknown' is a first-class answer.
$script:BucketAliases = @{
    'zai' = 'zai'; 'z' = 'zai'; 'zhipu' = 'zai'; 'gc' = 'zai'; 'glm' = 'zai'
    'or' = 'openrouter'; 'openrouter' = 'openrouter'
    'ds' = 'deepseek'; 'deepseek' = 'deepseek'
    'kc' = 'kimi'; 'kimi' = 'kimi'; 'moon' = 'kimi'; 'moonshot' = 'kimi'
    'mm' = 'minimax'; 'mmax' = 'minimax'; 'mmc' = 'minimax'; 'minimax' = 'minimax'
    'g' = 'google'; 'google' = 'google'; 'cx' = 'google'; 'gemini' = 'google'
    'oai' = 'openai'; 'openai' = 'openai'
    'litellm' = 'litellm'; 'ollama' = 'local'; 'llama' = 'local'; 'll' = 'local'
    'lmstudio' = 'local'
}

function Get-BucketOfRung([string]$Rung) {
    # A rung is '<provider>@<model>' (explicit) or a bare model id (bare names
    # resolve per catalog; bucket unknown to a seat-local audit).
    $t = $Rung.Trim()
    if ($t -match '^role:') { return "delegated" }   # role delegation: target's own path
    if ($t -match '^([^@]+)@') {
        $pfx = $Matches[1].ToLowerInvariant()
        if ($script:BucketAliases.ContainsKey($pfx)) { return $script:BucketAliases[$pfx] }
        return "custom:$pfx"
    }
    if ($t -match '^claude-') { return "anthropic-native" }
    return "unknown"
}

# Which env NAME proves fuel for a bucket. Presence of the name with a value,
# never the value itself.
$script:FuelEnvByBucket = @{
    'zai' = @('ZAI_API_KEY', 'ZAI_API_KEY2', 'ZAI_API_KEY_2')
    'openrouter' = @('OPENROUTER_API_KEY')
    'deepseek' = @('DEEPSEEK_API_KEY')
    'kimi' = @('KIMI_API_KEY', 'MOONSHOT_API_KEY')
    'minimax' = @('MINIMAX_API_KEY', 'MINIMAX_GROUP_ID')
    'google' = @('GOOGLE_API_KEY', 'GEMINI_API_KEY')
    'openai' = @('OPENAI_API_KEY')
    'anthropic-native' = @('ANTHROPIC_API_KEY')
}

# --- the audit --------------------------------------------------------------

function Invoke-SeatAudit {
    $report = [ordered]@{
        seat_context = $env:COMPUTERNAME
        container = $ContainerName
        nominal_bucket = $NominalBucket
        nominal_bucket_source = 'assumed (override with -NominalBucket when the nominal changes)'
    }

    if (-not (Get-DockerAvailable)) {
        Write-Output "seat-readiness: UNKNOWN"
        Write-Output "  reason: docker is not reachable from this seat - nothing can be measured"
        $script:AuditExitCode = 3
        return
    }
    $state = Get-ContainerState $ContainerName
    $report['container_state'] = $state
    if ($state -eq 'absent') {
        Write-Output "seat-readiness: NO-PATH"
        Write-Output "  container : $ContainerName absent - no sidecar, nothing serves without the hub (Q-65 class)"
        $script:AuditExitCode = 2
        return
    }

    $envInfo = Get-ContainerEnvNamesAndClassifiedValues $ContainerName
    if ($envInfo.Names.Count -eq 0) {
        Write-Output "seat-readiness: UNKNOWN"
        Write-Output "  reason: container env unreadable (inspect returned nothing)"
        $script:AuditExitCode = 3
        return
    }

    # --- armed BY VALUE, never by name -------------------------------------
    $foNames = @($envInfo.Names | Where-Object { $_ -match '^CLAUDISH_FAILOVER_[A-Z0-9_]+$' })
    $armed = [System.Collections.Generic.List[string]]::new()
    foreach ($n in $foNames) { if ($envInfo.HasValue[$n]) { $armed.Add($n) } }
    $cascadeRoles = [ordered]@{}
    foreach ($n in $armed) {
        if ($n -match '^CLAUDISH_FAILOVER_(SONNET|OPUS|HAIKU|FABLE)$') {
            $cascadeRoles[$Matches[1]] = $n
        }
    }
    $report['failover_names_total'] = $foNames.Count
    $report['failover_armed_by_value'] = $armed.Count
    $report['cascade_roles_armed'] = @($cascadeRoles.Keys) -join ','
    $report['active_flag'] = ($armed -contains 'CLAUDISH_FAILOVER_ACTIVE')

    # bucket structure per armed cascade: names of buckets only
    $rungBucketsByRole = @{}
    $rungCountByRole = @{}
    foreach ($role in $cascadeRoles.Keys) {
        # read the actual value to classify, expose ONLY derived structure
        $raw = Get-ContainerEnvRaw $ContainerName
        $value = $null
        foreach ($entry in @($raw)) {
            if ($entry -like "$($cascadeRoles[$role])=*") { $value = $entry.Substring($entry.IndexOf('=') + 1) }
        }
        $rungs = @($value -split '>' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $rungCountByRole[$role] = $rungs.Count
        $rungBucketsByRole[$role] = @($rungs | ForEach-Object { Get-BucketOfRung $_ } | Select-Object -Unique)
    }

    # --- fuel: does any NON-nominal rung bucket have a resolvable credential?
    Write-Output "seat-readiness audit (read-only) - seat $($report['seat_context'])"
    Write-Output ("  container        : {0} ({1})" -f $ContainerName, $report['container_state'])
    Write-Output ("  failover env     : {0} names, {1} ARMED BY VALUE" -f $report['failover_names_total'], $report['failover_armed_by_value'])
    if ($cascadeRoles.Count -gt 0) {
        foreach ($role in $cascadeRoles.Keys) {
            $buckets = $rungBucketsByRole[$role]
            Write-Output ("  cascade {0,-8}: {1} rung(s), buckets [{2}]" -f $role, $rungCountByRole[$role], ($buckets -join ', '))
        }
    } else {
        # armed>0 here can still be tuning values (DIRECTION, DWELL_MS...):
        # presence of VALUES is not presence of FABRIC. Only a role cascade is.
        Write-Output "  cascade          : no role cascade armed by value (an empty cascade is a parachute with no fabric)"
    }
    Write-Output ("  nominal bucket   : {0} ({1})" -f $NominalBucket, $report['nominal_bucket_source'])

    if ($armed.Count -eq 0 -or $cascadeRoles.Count -eq 0) {
        Write-Output "seat-readiness: NO-FUEL"
        Write-Output "  reason: no cascade armed BY VALUE in this container (in AUTONOMOUS the sidecar runs its own cascade, never the hub's)"
        $script:AuditExitCode = 1
        return
    }

    $credentialedNonNominal = $false
    $monobucketRoles = @()
    foreach ($role in $cascadeRoles.Keys) {
        $buckets = $rungBucketsByRole[$role]
        $nonNominal = @($buckets | Where-Object { $_ -ne $NominalBucket -and $_ -ne 'delegated' -and $_ -ne 'unknown' })
        if ($nonNominal.Count -eq 0) {
            $monobucketRoles += $role
            continue
        }
        foreach ($b in $nonNominal) {
            $fuelNames = @()
            if ($script:FuelEnvByBucket.ContainsKey($b)) { $fuelNames = $script:FuelEnvByBucket[$b] }
            foreach ($fn in $fuelNames) {
                if ($envInfo.HasValue[$fn]) {
                    $credentialedNonNominal = $true
                    Write-Output ("  fuel             : bucket '{0}' has env '{1}' set (value never printed)" -f $b, $fn)
                    break
                }
            }
        }
    }
    foreach ($role in $monobucketRoles) {
        Write-Output ("  WARNING          : cascade {0}: every rung sits in the nominal bucket '{1}' - the wall that kills the nominal kills them with it (#275)" -f $role, $NominalBucket)
    }

    if ($credentialedNonNominal) {
        Write-Output "seat-readiness: READY"
        Write-Output "  (armed by value + a rung outside the nominal bucket with resolvable fuel)"
        $script:AuditExitCode = 0
        return
    }
    Write-Output "seat-readiness: NO-FUEL"
    if ($monobucketRoles.Count -eq $cascadeRoles.Count) {
        Write-Output "  reason: every armed cascade is monobucket-vs-nominal - no rung outside the wall"
    } else {
        Write-Output "  reason: no credential resolvable in any non-nominal rung bucket (env names checked by presence only)"
    }
    $script:AuditExitCode = 1
    return
}

$script:AuditExitCode = 4   # internal error unless the audit says otherwise
Invoke-SeatAudit
exit $script:AuditExitCode
