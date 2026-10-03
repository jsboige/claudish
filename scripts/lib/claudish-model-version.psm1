# claudish-model-version.psm1 — model version watch (pure logic, no network, no docker)
#
# Mandate (user, 2026-10-02): an organ that watches the versions each provider
# actually offers, auto-repins ROUTING on MINOR bumps (same major), escalates
# MAJOR bumps for user arbitration, and notifies in every case.
#
# Scope, phase 1: the Codex/ChatGPT backend lane (the family where minor churn
# actually bites — gpt-6-sol -> gpt-6.1-sol measured 2026-10-02). The module's
# parsing/diff/edit logic is provider-agnostic; the runner adds providers as
# their /models surfaces are probed. Cascades (container env) and profiles are
# REPORT-ONLY here: repinning those needs a recreate and stays an operator act.
#
# Safety rules encoded (each one is load-bearing):
#   - Only the `routing` object of config.json is ever written; apiKeys and the
#     rest round-trip untouched, and a backup is taken before any write.
#   - A new id is repinned ONLY after an acceptance probe answered 200 — a
#     listed-but-unprobeable id never enters routing (deepseek lesson: probe
#     before trusting either direction).
#   - Unparseable config = refuse, never guess.
#   - Kill switch: <ClaudishHome>\model-version-watch.enabled must contain
#     'enabled' before anything runs (same consent-file discipline as
#     wedge-watch — a missing file means "do nothing", not "arm by default").
#
# Targets PowerShell 5.1 (scheduled tasks run powershell, not pwsh): no ??,
# no ?., no ternary.

Set-StrictMode -Version 2

# --- Id parsing -------------------------------------------------------------

function ConvertTo-ModelVersion {
    # 'gpt-6.1-sol' -> @{ Family='gpt-sol'; Major=6; Minor=1; Id='gpt-6.1-sol' }
    # 'gpt-6-sol'   -> gpt-sol 6.0   'glm-5.3' -> glm 5.3
    # 'deepseek-v4.1-flash' -> deepseek-flash 4.1   'qwen3.8-max' -> qwen-max 3.8
    # Non-versioned ids (gpt-reserve, MiniMax-M3, kimi-for-coding, mistral-
    # medium-latest, the rolling deepseek-flash alias) -> $null: no family, no
    # bump policy. A rolling alias is already "latest" by construction.
    param([Parameter(Mandatory = $true)][string]$Id)

    if ($Id -match '^(?<base>[a-z]+)-?v?(?<maj>\d+)(?:\.(?<min>\d+))?(?<suffix>-[a-z0-9.-]+)?$') {
        $family = $Matches['base']
        if ($Matches['suffix']) { $family = $family + $Matches['suffix'] }
        $minor = 0
        if ($Matches['min']) { $minor = [int]$Matches['min'] }
        return @{
            Family = $family
            Major  = [int]$Matches['maj']
            Minor  = $minor
            Id     = $Id
        }
    }
    return $null
}

function Get-LatestFamilyVersion {
    # Highest (Major, Minor) among the parseable ids of one family.
    # Returns the version object of the winner, or $null.
    param([Parameter(Mandatory = $true)][string]$Family, [string[]]$AvailableIds)

    $best = $null
    foreach ($id in $AvailableIds) {
        $v = ConvertTo-ModelVersion -Id $id
        if ($null -eq $v -or $v.Family -ne $Family) { continue }
        if ($null -eq $best -or $v.Major -gt $best.Major -or
            ($v.Major -eq $best.Major -and $v.Minor -gt $best.Minor)) {
            $best = $v
        }
    }
    return $best
}

# --- Routing diff -----------------------------------------------------------

function Compare-RoutingToFamilies {
    # One decision per (spelling, family) PAIR — never per family (review #307
    # D2/D3): a family-level decision keyed on the FIRST target seen made the
    # answer depend on key order (a-old/b-new both-repinned vs a-old-stuck
    # forever on the same two entries), and an older-major spelling masked the
    # minor bump of its newer sibling (5.6 pinned + 6.0 pinned + 6.1 available
    # => 'major', 6.0->6.1 never applied). Per spelling, each entry is compared
    # to the family latest on its own version: same major + lower minor =>
    # 'minor' (auto), older major => 'major' (ask), at or ahead of latest =>
    # 'current' (never downgrade). Order-independent by construction.
    #
    # Each decision also carries NewTarget (D1): the provider prefix is kept
    # ONLY from a value that actually contains '@' — deriving it from a bare
    # value fabricated 'gpt-6-sol@gpt-6.1-sol', an invalid target the
    # acceptance probe (which names only the id) cannot catch. A bare spelling
    # repins to the bare id.
    #   @{ Family; Spelling; CurrentId; Provider; LatestId; NewTarget; Action }
    # $Routing is the parsed routing object (requested-spelling -> target[]).
    param([Parameter(Mandatory = $true)]$Routing, [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$AvailableIds)

    $decisions = @()
    $latestCache = @{}
    foreach ($prop in $Routing.PSObject.Properties) {
        foreach ($target in @($prop.Value)) {
            $model = ($target -split '@')[-1]
            $v = ConvertTo-ModelVersion -Id $model
            if ($null -eq $v) { continue }
            if (-not $latestCache.ContainsKey($v.Family)) {
                $latestCache[$v.Family] = Get-LatestFamilyVersion -Family $v.Family -AvailableIds $AvailableIds
            }
            $latest = $latestCache[$v.Family]
            if ($null -eq $latest) { continue }
            $action = 'current'
            if ($latest.Major -gt $v.Major) { $action = 'major' }
            elseif ($latest.Major -eq $v.Major -and $latest.Minor -gt $v.Minor) { $action = 'minor' }
            $provider = ''
            $at = ([string]$target).IndexOf('@')
            if ($at -gt 0) { $provider = ([string]$target).Substring(0, $at + 1) }
            $decisions += @{
                Family    = $v.Family
                Spelling  = $prop.Name
                CurrentId = $model
                Provider  = $provider
                LatestId  = $latest.Id
                NewTarget = $provider + $latest.Id
                Action    = $action
            }
        }
    }
    return $decisions
}

# --- Config surgery ---------------------------------------------------------

function Edit-RoutingForMinor {
    # Repin ONE family in routing. $Repins maps each requested-spelling of that
    # family to its own new target (per-spelling, review #307: a bare spelling
    # repins bare, a provider-qualified one keeps its prefix — one uniform
    # $NewTarget fabricated 'gpt-6-sol@gpt-6.1-sol' for a bare entry). Surgical
    # per family: within a spelling that holds SEVERAL targets (multi-lane
    # routing entries), only the members whose model id parses to $Family move;
    # the other families' members are preserved in place — a whole-array
    # overwrite would silently drop them. The new id is registered as its own
    # spelling. One timestamped backup per call. Returns the backup path, or
    # $null on any refusal (parse failure, missing file, empty diff).
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$Family,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Repins,      # spelling -> new target
        [Parameter(Mandatory = $true)][string]$NewSpelling,                        # e.g. 'gpt-6.1-sol'
        [Parameter(Mandatory = $true)][string]$NewSpellingTarget                   # target for the new entry
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($ConfigPath)
    try { $config = $raw | ConvertFrom-Json } catch { return $null }
    if ($null -eq $config.routing) { return $null }

    $changed = $false
    foreach ($sp in @($Repins.Keys)) {
        if ($config.routing.PSObject.Properties.Name -notcontains $sp) { continue }
        $target = [string]$Repins[$sp]
        $vals = @($config.routing.$sp)
        for ($i = 0; $i -lt $vals.Count; $i++) {
            $memberFamily = ''
            $memberModel = (([string]$vals[$i]) -split '@')[-1]
            $mv = ConvertTo-ModelVersion -Id $memberModel
            if ($mv) { $memberFamily = $mv.Family }
            if ($memberFamily -eq $Family -and $vals[$i] -ne $target) {
                $vals[$i] = $target
                $changed = $true
            }
        }
        if ($vals.Count -eq 1 -and $vals[0] -eq $target) {
            $config.routing.$sp = $vals[0]   # keep single-entry spellings scalar
        } else {
            $config.routing.$sp = $vals
        }
    }
    if ($config.routing.PSObject.Properties.Name -contains $NewSpelling) {
        if ((@($config.routing.$NewSpelling) -join '|') -ne $NewSpellingTarget) {
            $config.routing.$NewSpelling = @($NewSpellingTarget)
            $changed = $true
        }
    } else {
        $config.routing | Add-Member -MemberType NoteProperty -Name $NewSpelling -Value @($NewSpellingTarget)
        $changed = $true
    }
    if (-not $changed) { return $null }

    $backup = "$ConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    $out = $config | ConvertTo-Json -Depth 64
    [System.IO.File]::WriteAllText($ConfigPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    return $backup
}

# --- Events & state ---------------------------------------------------------

function Write-VersionEvent {
    # NDJSON append, no BOM (5.1 Add-Content -Encoding UTF8 writes one).
    # Consumed by the worker cycle, which relays pending events to the
    # workspace dashboard — a scheduled task cannot call the MCP itself.
    param(
        [Parameter(Mandatory = $true)][string]$EventsPath,
        [Parameter(Mandatory = $true)][ValidateSet('minor-applied', 'major-ask', 'probe-fail', 'error', 'info')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Family,
        [string]$From = '',
        [string]$To = '',
        [string]$Detail = ''
    )
    $evt = @{
        ts      = (Get-Date).ToUniversalTime().ToString('o')
        kind    = $Kind
        family  = $Family
        from    = $From
        to      = $To
        detail  = $Detail
    } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($EventsPath, $evt + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Test-ClaudishOptIn {
    # Consent gate, shared semantics with wedge-watch: the file must exist and
    # contain 'enabled'. Anything else — missing, empty, wrong word — means
    # "do nothing". A guard that arms on accidental content is not a guard.
    param([Parameter(Mandatory = $true)][string]$ClaudishHome, [Parameter(Mandatory = $true)][string]$Token)
    $p = Join-Path $ClaudishHome 'model-version-watch.enabled'
    if (-not (Test-Path -LiteralPath $p)) { return $false }
    $content = ''
    try { $content = ([System.IO.File]::ReadAllText($p)).Trim() } catch { return $false }
    return ($content -eq $Token)
}

Export-ModuleMember -Function `
    ConvertTo-ModelVersion, Get-LatestFamilyVersion, Compare-RoutingToFamilies, `
    Edit-RoutingForMinor, Write-VersionEvent, Test-ClaudishOptIn
