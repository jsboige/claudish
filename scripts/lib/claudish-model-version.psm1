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
    # For every routing TARGET whose model id parses to a known family, decide
    # whether the provider's latest for that family is a MINOR bump (auto), a
    # MAJOR bump (ask), or current. Returns decision objects:
    #   @{ Family; CurrentId; LatestId; Action='minor'|'major'|'current' }
    # $Routing is the parsed routing object (requested-spelling -> target[]).
    # Explicit provider@model targets and bare spellings are both read through
    # their model part; the requested-spelling KEYS of one family are returned
    # together so a repin moves every alias of the family in one gesture
    # (gpt-5.6-sol followed gpt-6-sol to 6-sol; same precedent).
    param([Parameter(Mandatory = $true)]$Routing, [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$AvailableIds)

    $decisions = @()
    $byFamily = @{}
    foreach ($prop in $Routing.PSObject.Properties) {
        foreach ($target in @($prop.Value)) {
            $model = ($target -split '@')[-1]
            $v = ConvertTo-ModelVersion -Id $model
            if ($null -eq $v) { continue }
            if (-not $byFamily.ContainsKey($v.Family)) {
                $byFamily[$v.Family] = @{
                    CurrentId  = $model
                    Spellings  = @()
                }
            }
            if ($byFamily[$v.Family].Spellings -notcontains $prop.Name) {
                $byFamily[$v.Family].Spellings += $prop.Name
            }
        }
    }
    foreach ($family in $byFamily.Keys) {
        $entry = $byFamily[$family]
        $latest = Get-LatestFamilyVersion -Family $family -AvailableIds $AvailableIds
        if ($null -eq $latest) { continue }
        $current = ConvertTo-ModelVersion -Id $entry.CurrentId
        $action = 'current'
        if ($latest.Major -gt $current.Major) { $action = 'major' }
        elseif ($latest.Major -eq $current.Major -and $latest.Minor -gt $current.Minor) { $action = 'minor' }
        $decisions += @{
            Family    = $family
            CurrentId = $entry.CurrentId
            LatestId  = $latest.Id
            Spellings = $entry.Spellings
            Action    = $action
        }
    }
    return $decisions
}

# --- Config surgery ---------------------------------------------------------

function Edit-RoutingForMinor {
    # Repin every spelling of ONE family to provider@<LatestId> and register the
    # new spelling as its own entry. Surgical: loads config.json, touches ONLY
    # $Routing keys named in $Spellings (plus the new spelling), saves with a
    # timestamped backup. Returns the backup path, or $null on any refusal
    # (parse failure, missing file, empty diff).
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string[]]$Spellings,
        [Parameter(Mandatory = $true)][string]$NewTarget   # e.g. 'cx@gpt-6.1-sol'
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($ConfigPath)
    try { $config = $raw | ConvertFrom-Json } catch { return $null }
    if ($null -eq $config.routing) { return $null }

    $changed = $false
    foreach ($sp in $Spellings) {
        if ($config.routing.PSObject.Properties.Name -contains $sp) {
            if ((@($config.routing.$sp) -join '|') -ne $NewTarget) {
                $config.routing.$sp = @($NewTarget)
                $changed = $true
            }
        }
    }
    $newSpelling = ($NewTarget -split '@')[-1]
    if ($config.routing.PSObject.Properties.Name -contains $newSpelling) {
        if ((@($config.routing.$newSpelling) -join '|') -ne $NewTarget) {
            $config.routing.$newSpelling = @($NewTarget)
            $changed = $true
        }
    } else {
        $config.routing | Add-Member -MemberType NoteProperty -Name $newSpelling -Value @($NewTarget)
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
