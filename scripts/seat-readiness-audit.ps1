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

  TWO FUEL SOURCES, and neither may be silent (measured 2026-10-28).
  Provider credentials reach the proxy by two routes. The obvious one is the
  container env. The other is the mounted claudish home - `config.json` ->
  `apiKeys.*`, which the proxy reads at runtime. Reading only the env produced
  a FALSE NO-FUEL on po-2023: its container carries no provider env name at
  all (only CLAUDISH_PROXY_KEY and its previous), yet that config holds eight
  apiKeys, and the same container had provably served on k3 in AUTONOMOUS two
  nights earlier (2026-10-27 17:25:06Z, logged [ttft] model=k3). A parachute
  marked fabric-less one day after it opened is the audit crying wolf, and a
  false NO-FUEL triggers a remediation nobody needs. Both sources are read;
  the output names WHICH one fuelled each rung, and says so when the second is
  unreadable - a silent fallback would hide the same class of error.

  The config read follows the same firewall as the env read: NAMES and
  presence only, values never leave the function.

  A THIRD fuel source exists, and it is the one that was invisible (measured
  2026-10-30 on the hub, po-2025): the Codex OAuth BIND FILE,
  `codex-oauth.json`, in the same claudish home. `cx@` (openai-codex:
  gpt-6-sol, gpt-6-astra) authenticates with that file and with NOTHING else
  - there is no OPENAI_CODEX_API_KEY, and GOOGLE_API_KEY / GEMINI_API_KEY
  (the two names the 'google' bucket looks for) have nothing to do with it. An
  audit that knows only env + apiKeys map sees that rung as FUEL-LESS, and a
  reader who trusts it may pull `cx@` out of the canon - which is exactly the
  cliff the coordinator flagged on 2026-10-29 (barreau 0 of the OPUS and
  FABLE roles, token expiring 2026-11-02T09:21Z). The bind is therefore
  consulted PER RUNG (it fuels a cx@ rung and nothing else - a google-bucket
  gemini@ rung is still fabric-less), and only presence booleans and the
  EXPIRY DATE leave it.

  WHICH HOME, though - and this is where source two went wrong next
  (2026-10-28, third false NO-FUEL of the day). The audit used to read
  `$env:USERPROFILE\.claudish`, a HOST path. The path the proxy actually reads
  is whatever the container mounts on its own `~/.claudish`, and on po-2025
  that is `D:\claudish-shadow\config` - a DIFFERENT file, carrying
  MISTRAL_API_KEY, DEEPSEEK_API_KEY and QWEN_TOKEN_PLAN_API_KEY that the host
  copy does not have. The audit read six names from the wrong file and called a
  READY seat NO-FUEL while the hub was serving deepseek-flash every minute.
  Precedence, stated in the output: explicit -ClaudishHome, else the
  container's own mount (resolved by docker inspect), else the host default -
  and a NO-FUEL rendered from that last fallback is marked INCONCLUSIVE, never
  a proof. Same doctrine as above, one layer down: a source consulted against
  the wrong path lies silently.

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
    [string]$NominalBucket = "zai",
    # Empty means "resolve it": the container's own mount wins over the host
    # default, because the host default is not the file the proxy reads on any
    # seat that mounts a shadow config (po-2025). Pass a value to pin the path,
    # which is also what the test suite does to stay off the real machine.
    [string]$ClaudishHome = "",
    # The path used when neither -ClaudishHome nor a container mount resolves.
    # Empty means $env:USERPROFILE\.claudish. Exposed so the suite can stay off
    # the running machine's real home (a verdict that depends on whose seat runs
    # the tests is the failure mode this repo keeps paying for).
    [string]$HostHomeFallback = ""
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
    'g' = 'google'; 'google' = 'google'; 'gemini' = 'google'
    # 'cx' is NOT google: the proxy resolves the shortcut to openai-codex and
    # walls that bucket separately (parseModelSpec -> classifyNominalBucket,
    # failover.ts #275). Mapping it to google made a cascade carrying both
    # 'g@...' and 'cx@...' count ONE bucket where the proxy walls TWO, and a
    # google-nominal seat read its cx@ rung as same-bucket (false NO-FUEL).
    'cx' = 'openai-codex'; 'openai-codex' = 'openai-codex'
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

# Which NAME proves fuel for a bucket. Presence of the name WITH a value, never
# the value itself. The *_CODING_API_KEY aliases are not decoration: the fleet's
# own config (po-2023, 2026-10-28) stores GLM_CODING_API_KEY,
# KIMI_CODING_API_KEY, MINIMAX_CODING_API_KEY and QWEN_TOKEN_PLAN_API_KEY -
# names an env-only map built from provider defaults would miss even on a seat
# that DOES put them in env.
$script:FuelEnvByBucket = @{
    'zai' = @('ZAI_API_KEY', 'ZAI_API_KEY2', 'ZAI_API_KEY_2', 'GLM_CODING_API_KEY')
    'openrouter' = @('OPENROUTER_API_KEY')
    'deepseek' = @('DEEPSEEK_API_KEY')
    'kimi' = @('KIMI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_CODING_API_KEY')
    'minimax' = @('MINIMAX_API_KEY', 'MINIMAX_GROUP_ID', 'MINIMAX_CODING_API_KEY')
    'google' = @('GOOGLE_API_KEY', 'GEMINI_API_KEY')
    # Empty on purpose: NO env name proves fuel for the codex bucket - the
    # OAuth bind file is its only credential (see Get-OAuthBindFuel).
    'openai-codex' = @()
    'openai' = @('OPENAI_API_KEY')
    'anthropic-native' = @('ANTHROPIC_API_KEY')
    'qwen-token-plan' = @('QWEN_TOKEN_PLAN_API_KEY')
    'mistral' = @('MISTRAL_API_KEY')
}

function Get-FuelNamesForBucket([string]$Bucket) {
    # Known buckets use the table. A custom endpoint bucket ('custom:<prefix>',
    # from a 'provider@model' rung whose prefix is not a fleet alias) derives
    # its name mechanically: custom:qwen-token-plan -> QWEN_TOKEN_PLAN_API_KEY.
    # Without this, every custom endpoint reads fabric-less no matter how much
    # fuel it carries - the same false negative, one layer down.
    $names = [System.Collections.Generic.List[string]]::new()
    if ($script:FuelEnvByBucket.ContainsKey($Bucket)) {
        foreach ($n in $script:FuelEnvByBucket[$Bucket]) { $names.Add($n) }
    }
    if ($Bucket -match '^custom:(.+)$') {
        $derived = (($Matches[1] -replace '[^A-Za-z0-9]', '_').ToUpperInvariant()) + '_API_KEY'
        if (-not $names.Contains($derived)) { $names.Add($derived) }
    }
    return $names.ToArray()
}

function Get-OAuthBindFuel([string]$HomePath) {
    # The THIRD fuel source (measured 2026-10-30 on the hub, po-2025).
    #
    # `cx@` (openai-codex: gpt-6-sol, gpt-6-astra) authenticates with a BIND
    # FILE in the claudish home - `codex-oauth.json` - and with NOTHING else:
    # there is no OPENAI_CODEX_API_KEY, and GOOGLE_API_KEY / GEMINI_API_KEY
    # (the two names the 'google' bucket looks for) have nothing to do with it.
    # An audit that knows only env + apiKeys map therefore sees that rung as
    # FUEL-LESS, and a reader who trusts it may pull `cx@` out of the canon -
    # which is exactly the cliff the coordinator flagged on 2026-10-29
    # (barreau 0 of the OPUS and FABLE roles, token expiring 2026-11-02).
    #
    # Firewall: presence booleans and the EXPIRY DATE only. No token, no
    # account id, no token length - nothing that can be replayed.
    $path = Join-Path $HomePath 'codex-oauth.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $b = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        # A file that EXISTS but does not parse (a half-written refresh leaves
        # exactly this) is NOT the same as no bind. Returning $null here made
        # the audit print 'absent' - the silent-source failure family this
        # whole script exists to kill. Present, unreadable, not counted as
        # fuel: the reader gets the third state and decides.
        return [pscustomobject]@{
            Present         = $true
            Readable        = $false
            HasAccessToken  = $false
            HasRefreshToken = $false
            ExpiresAtUtc    = $null
        }
    }
    $expires = $null
    try {
        if ($null -ne $b.expires_at) {
            $expires = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$b.expires_at).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
    }
    catch { $expires = $null }
    return [pscustomobject]@{
        Present         = $true
        Readable        = $true
        HasAccessToken  = ($null -ne $b.access_token -and ([string]$b.access_token).Trim().Length -gt 0)
        HasRefreshToken = ($null -ne $b.refresh_token -and ([string]$b.refresh_token).Trim().Length -gt 0)
        ExpiresAtUtc   = $expires
    }
}

function Get-ConfigApiKeyNames([string]$HomePath) {
    # The second fuel source: the claudish home the container mounts read-only
    # (config.json -> apiKeys.*), read by the proxy at runtime. Returns a
    # name -> hasValue map, or $null when the file cannot be read - the caller
    # SAYS SO rather than silently auditing one source.
    #
    # Firewall: only property NAMES and a presence boolean ever leave here.
    $path = Join-Path $HomePath 'config.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $cfg = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    }
    catch { return $null }
    $map = @{}
    if ($null -ne $cfg -and $cfg.PSObject.Properties.Name -contains 'apiKeys' -and $cfg.apiKeys) {
        foreach ($p in $cfg.apiKeys.PSObject.Properties) {
            $v = $p.Value
            $map[$p.Name] = ($null -ne $v -and ([string]$v).Trim().Length -gt 0)
        }
    }
    return $map
}

function Get-ContainerConfigHome([string]$Name) {
    # The claudish home the CONTAINER reads, not the one the host happens to
    # have: config.json -> apiKeys reaches the proxy through the mount whose
    # destination is the container's ~/.claudish. Returns that host path, or
    # $null when the container publishes no such mount (then the caller falls
    # back and SAYS SO - the fallback is where the third false NO-FUEL came
    # from, 2026-10-28).
    #
    # Paths only: a mount table carries no credential, but it is still read
    # through the same isolated wrapper so the tests can mock docker as native.
    try {
        $lines = @(& docker inspect $Name --format "{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}" 2>$null)
    }
    catch { return $null }
    $fallback = $null
    foreach ($line in $lines) {
        if (-not $line) { continue }
        $parts = @($line.Trim() -split '\|')
        if ($parts.Count -lt 2) { continue }
        $src = $parts[0].Trim()
        $dest = $parts[1].Trim()
        if (-not $src) { continue }
        # Exact destination wins: it is the one ~/.claudish the proxy resolves.
        if ($dest -eq '/root/.claudish' -or $dest -eq '/home/claudish/.claudish') { return $src }
        if ($dest -match '(^|/)\.claudish/?$') { if (-not $fallback) { $fallback = $src } }
    }
    return $fallback
}

function ConvertTo-AuditHostPath([string]$ContainerMountSource) {
    # Docker Desktop records a Windows bind mount with the path its Linux VM
    # sees: `/run/desktop/mnt/host/d/claudish-shadow/config`. That string is a
    # faithful `.Source`, and it does not exist on the Windows host - so the
    # audit read nothing and called a serving seat NO-FUEL (FOURTH false
    # NO-FUEL of 2026-10-28, measured on po-2025: the hub's own container
    # reports that path while the file sits at D:\claudish-shadow\config).
    #
    # Translation is applied ONLY when the raw path is unreadable here, and the
    # caller NAMES it in the source string: which file was read is part of the
    # measurement, and a silent rewrite would be the same error one layer down.
    if ([string]::IsNullOrWhiteSpace($ContainerMountSource)) { return $null }
    if (Test-Path -LiteralPath $ContainerMountSource) { return $null }
    if ($ContainerMountSource -match '^(?:/run/desktop/mnt/host|/mnt)/([a-zA-Z])/(.+)$') {
        $drive = $Matches[1].ToUpperInvariant()
        $rest = $Matches[2]
        $candidate = "${drive}:/" + $rest
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-ConfigHomeResolution([string]$Name, [string]$ExplicitHome, [string]$HostFallback) {
    # Precedence, each branch named in the output: an explicit -ClaudishHome
    # (the test suite pins this to stay off the real machine), else the
    # container's own mount, else the host default.
    if (-not [string]::IsNullOrWhiteSpace($ExplicitHome)) {
        return [pscustomobject]@{
            Path = $ExplicitHome
            Source = 'explicit -ClaudishHome'
            IsContainerMount = $false
            IsProofGrade = $true
        }
    }
    $mounted = Get-ContainerConfigHome $Name
    if ($mounted) {
        $translated = ConvertTo-AuditHostPath $mounted
        if ($translated) {
            return [pscustomobject]@{
                Path = $translated
                Source = "container mount -> ${translated} (translated from ${mounted}, unreadable on this host)"
                IsContainerMount = $true
                IsProofGrade = $true
            }
        }
        return [pscustomobject]@{
            Path = $mounted
            Source = 'container mount -> ' + $mounted
            IsContainerMount = $true
            IsProofGrade = $true
        }
    }
    $hostHome = $HostFallback
    if ([string]::IsNullOrWhiteSpace($hostHome)) { $hostHome = Join-Path $env:USERPROFILE '.claudish' }
    return [pscustomobject]@{
        Path = $hostHome
        Source = 'host default (no container mount of ~/.claudish found)'
        IsContainerMount = $false
        IsProofGrade = $false
    }
}

# --- the audit --------------------------------------------------------------

function Invoke-SeatAudit {
    $report = [ordered]@{
        seat_context = $env:COMPUTERNAME
        container = $ContainerName
        nominal_bucket = $NominalBucket
        nominal_bucket_source = 'assumed (override with -NominalBucket when the nominal changes)'
    }

    # WHICH home this audit consults is part of the measurement, so it is
    # resolved ONCE, before any early return, and printed on EVERY verdict path.
    # The three false NO-FUELs of 2026-10-28 were all a home line the reader
    # could not see; a NO-PATH or a docker-UNKNOWN without one is exactly as
    # unfalsifiable (#730).
    $configHome = Get-ConfigHomeResolution -Name $ContainerName -ExplicitHome $ClaudishHome -HostFallback $HostHomeFallback
    $report['config_home'] = $configHome.Path
    $report['config_home_source'] = $configHome.Source
    $homeLine = "  config home      : {0} ({1})" -f $configHome.Path, $configHome.Source

    if (-not (Get-DockerAvailable)) {
        Write-Output "seat-readiness: UNKNOWN"
        Write-Output "  reason: docker is not reachable from this seat - nothing can be measured"
        Write-Output $homeLine
        $script:AuditExitCode = 3
        return
    }
    $state = Get-ContainerState $ContainerName
    $report['container_state'] = $state
    if ($state -eq 'absent') {
        Write-Output "seat-readiness: NO-PATH"
        Write-Output "  container : $ContainerName absent - no sidecar, nothing serves without the hub (Q-65 class)"
        Write-Output $homeLine
        $script:AuditExitCode = 2
        return
    }

    $envInfo = Get-ContainerEnvNamesAndClassifiedValues $ContainerName
    if ($envInfo.Names.Count -eq 0) {
        Write-Output "seat-readiness: UNKNOWN"
        Write-Output "  reason: container env unreadable (inspect returned nothing)"
        Write-Output $homeLine
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
    $rungsByRole = @{}
    foreach ($role in $cascadeRoles.Keys) {
        # read the actual value to classify, expose ONLY derived structure
        $raw = Get-ContainerEnvRaw $ContainerName
        $value = $null
        foreach ($entry in @($raw)) {
            if ($entry -like "$($cascadeRoles[$role])=*") { $value = $entry.Substring($entry.IndexOf('=') + 1) }
        }
        $rungs = @($value -split '>' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $rungCountByRole[$role] = $rungs.Count
        $rungsByRole[$role] = $rungs
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
    # Config home resolved and printed BEFORE any verdict branch, fabric gate
    # included: WHICH file a fuel read would consult is part of the measurement
    # even when the fabric is missing (fleet rule, ai-01 2026-10-28: a verdict
    # is only readable next to the file it read - po-2027's fabric-less NO-FUEL
    # printed no line at all before this hoist).
    $configHome = Get-ConfigHomeResolution -Name $ContainerName -ExplicitHome $ClaudishHome -HostFallback $HostHomeFallback
    $report['config_home'] = $configHome.Path
    $report['config_home_source'] = $configHome.Source
    Write-Output ("  config home      : {0} ({1})" -f $configHome.Path, $configHome.Source)

    if ($armed.Count -eq 0 -or $cascadeRoles.Count -eq 0) {
        Write-Output "seat-readiness: NO-FUEL"
        Write-Output "  reason: no cascade armed BY VALUE in this container (in AUTONOMOUS the sidecar runs its own cascade, never the hub's)"
        if (-not $configHome.IsProofGrade) {
            # Same guard as the late NO-FUEL below: a verdict read from the host
            # default proves nothing about a container that mounts another home.
            Write-Output ("  INCONCLUSIVE     : config source was '{0}' - not the container's mount, so this NO-FUEL is NOT a proof; re-run with -ClaudishHome <mounted path>" -f $configHome.Path)
        }
        $script:AuditExitCode = 1
        return
    }

    $credentialedNonNominal = $false
    $monobucketRoles = @()
    $reportedBuckets = @{}
    # Second fuel source, read once. Stated in the output whether it worked or
    # not: a source consulted silently is how the false NO-FUEL of 2026-10-28
    # happened in the first place.
    $configKeys = Get-ConfigApiKeyNames $configHome.Path
    # THIRD fuel source: the Codex OAuth bind (codex-oauth.json). Read once, and
    # STATED whether it is there or not - a source consulted silently is how the
    # false NO-FUEL of 2026-10-28 happened in the first place.
    $oauthBind = Get-OAuthBindFuel $configHome.Path
    $bindState = 'absent'
    if ($null -ne $oauthBind) {
        $bindState = 'present'
        if (-not $oauthBind.Readable) { $bindState = 'present, unreadable - not counted as fuel' }
    }
    if ($null -eq $configKeys) {
        Write-Output ("  fuel sources     : env only - config unreadable at {0}\apiKeys (a seat whose keys live only there reads NO-FUEL on this source's silence); Codex OAuth bind: {1}" -f $configHome.Path, $bindState)
    }
    else {
        Write-Output ("  fuel sources     : env + config ({0} apiKey name(s) in the mounted home; values never read out); Codex OAuth bind: {1}" -f $configKeys.Count, $bindState)
    }
    foreach ($role in $cascadeRoles.Keys) {
        # Third source, as a BUCKET rule: the OAuth bind fuels the
        # 'openai-codex' bucket and nothing else (any rung spelling that
        # resolves there - cx@..., openai-codex@...). A seat whose only
        # non-nominal rung is cx@ is READY when the bind is there - and
        # NO-FUEL when it is not. Checked BEFORE the monobucket bail-out
        # below: a role whose other rungs all sit in the nominal bucket can
        # still escape the wall through a cx@ rung. The generic loop below
        # finds no env name for this bucket (the table entry is empty), so
        # the bind is its only route to fuel.
        foreach ($rung in @($rungsByRole[$role])) {
            $rbucket = Get-BucketOfRung $rung
            if ($rbucket -ne 'openai-codex') { continue }
            if ($rbucket -eq $NominalBucket) { continue }
            if ($null -ne $oauthBind -and $oauthBind.Readable -and $oauthBind.HasAccessToken) {
                $credentialedNonNominal = $true
                if (-not $reportedBuckets.ContainsKey('oauth-bind')) {
                    $reportedBuckets['oauth-bind'] = $true
                    Write-Output ("  fuel             : bucket '{0}' has the Codex OAuth bind codex-oauth.json (access={1}, refresh={2}, expires {3}; values never printed)" -f $rbucket, $oauthBind.HasAccessToken, $oauthBind.HasRefreshToken, $oauthBind.ExpiresAtUtc)
                }
            }
        }
        $buckets = $rungBucketsByRole[$role]
        $nonNominal = @($buckets | Where-Object { $_ -ne $NominalBucket -and $_ -ne 'delegated' -and $_ -ne 'unknown' })
        if ($nonNominal.Count -eq 0) {
            $monobucketRoles += $role
            continue
        }
        foreach ($b in $nonNominal) {
            # One line per BUCKET, not per (role, bucket) pair: four roles sharing
            # 'deepseek' is one fact, and a report that says it four times hides
            # the roster it is supposed to show.
            if ($reportedBuckets.ContainsKey($b)) { $credentialedNonNominal = $true; continue }
            foreach ($fn in @(Get-FuelNamesForBucket $b)) {
                if ($envInfo.HasValue[$fn]) {
                    $credentialedNonNominal = $true
                    $reportedBuckets[$b] = $true
                    Write-Output ("  fuel             : bucket '{0}' has env '{1}' set (value never printed)" -f $b, $fn)
                    break
                }
                if ($null -ne $configKeys -and $configKeys.ContainsKey($fn) -and $configKeys[$fn]) {
                    $credentialedNonNominal = $true
                    $reportedBuckets[$b] = $true
                    Write-Output ("  fuel             : bucket '{0}' has config apiKey '{1}' set (value never printed)" -f $b, $fn)
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
        if (-not $configHome.IsProofGrade) {
            # A NO-FUEL is only ever as good as the file it read. From the host
            # default on a seat that mounts a shadow home, it proves nothing.
            Write-Output ("  INCONCLUSIVE     : config source was '{0}' - not the container's mount, so this NO-FUEL is NOT a proof; re-run with -ClaudishHome <mounted path>" -f $configHome.Path)
        }
    }
    $script:AuditExitCode = 1
    return
}

$script:AuditExitCode = 4   # internal error unless the audit says otherwise
Invoke-SeatAudit
exit $script:AuditExitCode
