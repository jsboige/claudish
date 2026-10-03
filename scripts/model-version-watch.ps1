# claudish — model version watch (runner)
#
# Watches the model versions the providers actually offer and keeps the hub's
# ROUTING on the latest MINOR of each family, automatically:
#   - minor bump available + acceptance probe (200 AND a terminal
#     'response.completed' in the body — a 200 alone can carry an in-stream
#     failure, #65 class) -> repin routing (config.json), per spelling.
#   - reload: DEFERRED to the daily drained restart while the old id still
#     serves; immediate detached drained restart only when the old id fails
#     its own probe (the minor was retired upstream — every request on the
#     in-memory config fails until reload). The minor-applied event names
#     which of the two happened.
#   - major bump available -> NO edit; event 'major-ask' (worker relays ASK on
#     the dashboard + registers the user question — the user arbitrates).
#   - nothing new -> one info line, zero writes.
#
# Phase 1 provider: Codex / ChatGPT backend (where minor churn bites — the
# 2026-10-02 gpt-6-sol -> gpt-6.1-sol bump, applied by hand, is the driver).
# Additional providers join as their /models surfaces are probed; the diff and
# edit logic is provider-agnostic (scripts/lib/claudish-model-version.psm1).
#
# Cascades (CLAUDISH_FAILOVER_*, container env) and profiles are NOT touched:
# they need a recreate and stay operator acts — the events name them so the
# worker's report can say "cascade still on the old minor, deliberate".
#
# Gated OFF by default: <ClaudishHome>\model-version-watch.enabled must contain
# 'enabled' (Test-ClaudishOptIn). Every unknown fails safe: no file, no probe,
# no edit, no restart.
#
# Usage (scheduled task, every 6h):
#   powershell -ExecutionPolicy Bypass -File scripts\model-version-watch.ps1
# Optional: -DryRun (print decisions, write nothing) · -ConfigPath · -ClaudishHome
#
# Targets PowerShell 5.1.

param(
    [string]$ConfigPath = 'D:\claudish-shadow\config\config.json',
    [string]$ClaudishHome = 'C:\Users\jsboi\.claudish',
    [string]$OAuthPath = 'D:\claudish-shadow\config\codex-oauth.json',
    [string]$DrainScript = 'D:\dev\claudish\scripts\claudish-drain.ps1',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$logTs = { param($m) Write-Output ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
$eventsPath = Join-Path $ClaudishHome 'model-version-events.log'

try {
    Import-Module (Join-Path $PSScriptRoot 'lib\claudish-model-version.psm1') -Force
} catch {
    & $logTs "FATAL module load: $($_.Exception.Message)"
    exit 1
}

if (-not (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -Token 'enabled')) {
    & $logTs "opt-in file absent/disabled — doing nothing (expected on machines that never enrolled)"
    exit 0
}

# --- 1. Available versions (Codex backend, OAuth; token never logged) -------

if (-not (Test-Path -LiteralPath $OAuthPath)) {
    & $logTs "no OAuth file at $OAuthPath — provider skipped, nothing to compare"
    exit 0
}
try { $oauth = [System.IO.File]::ReadAllText($OAuthPath) | ConvertFrom-Json } catch {
    & $logTs "FATAL oauth parse: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "oauth parse failed"
    exit 1
}
$token = $null; $accountId = $null
if ($oauth.tokens -and $oauth.tokens.access_token) { $token = $oauth.tokens.access_token }
elseif ($oauth.access_token) { $token = $oauth.access_token }
if ($oauth.account_id) { $accountId = $oauth.account_id }
elseif ($oauth.tokens -and $oauth.tokens.account_id) { $accountId = $oauth.tokens.account_id }
if (-not $token) {
    & $logTs "oauth file holds no access_token (keys: $($oauth.PSObject.Properties.Name -join ','))"
    exit 0
}

$headers = @{ Authorization = "Bearer $token" }
if ($accountId) { $headers['chatgpt-account-id'] = $accountId }

try {
    $resp = Invoke-RestMethod -Uri 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0' `
        -Headers $headers -Method Get -TimeoutSec 30
} catch {
    & $logTs "models list failed: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "models list: $($_.Exception.Message)"
    exit 0   # a failed watch is a no-op, never an incident
}
# Unwrap the listing (measured shape: a wrapper object — unwrap .data/.models
# like the live bun probe does — never enumerate the wrapper itself, which
# yields zero ids and a silent no-op).
$list = $resp
if ($resp -is [pscustomobject] -and $resp.PSObject.Properties['data']) { $list = $resp.data }
elseif ($resp -is [pscustomobject] -and $resp.PSObject.Properties['models']) { $list = $resp.models }
$available = @($list | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_.id) { $_.id } elseif ($_.slug) { $_.slug } })
if ($available.Count -eq 0) {
    & $logTs "models listing parsed to 0 ids — treating as no-signal, no-op"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "models listing parsed to 0 ids (shape drifted?)"
    exit 0
}
& $logTs "provider lists $($available.Count) ids: $($available -join ', ')"

# --- 2. Diff against routing ------------------------------------------------

if (-not (Test-Path -LiteralPath $ConfigPath)) { & $logTs "no config at $ConfigPath"; exit 0 }
try { $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch {
    & $logTs "FATAL config parse: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family config -Detail "config parse failed — refusing to touch anything"
    exit 1
}

$decisions = Compare-RoutingToFamilies -Routing $config.routing -AvailableIds $available
$pending = @($decisions | Where-Object { $_.Action -ne 'current' })
& $logTs ("decisions: " + (($decisions | ForEach-Object { "$($_.Family)/$($_.Action)[$($_.Spelling): $($_.CurrentId)->$($_.LatestId)]" }) -join ' ; '))

if ($pending.Count -eq 0) { exit 0 }

# --- 3. Apply policy ---------------------------------------------------------
#
# Decisions are PER SPELLING (review #307 D2/D3): a family whose spellings sit
# on different majors yields minor for the on-latest-major spelling AND
# major-ask for the older one, in the same pass. Applied per FAMILY: one
# acceptance probe per family (all minor spellings of a family share the same
# LatestId), then one surgical edit carrying every spelling's own target.

function Test-ModelServes {
    # Acceptance probe, used for BOTH the new id (before any edit) and the old
    # id (reload decision, D4). A 200 alone is NOT acceptance (review #307 D5):
    # this wire can answer 200 with an in-stream error body (#65 class) — the
    # probe accepts only when the accumulated body carries a terminal
    # 'response.completed' event. Probe constraints measured 2026-10-02:
    # stream must be true, max_output_tokens must be absent.
    param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)]$Headers)
    try {
        $body = @{
            model = $Id
            instructions = 'Reply with exactly: ok'
            input = @(@{ role = 'user'; content = @(@{ type = 'input_text'; text = 'say ok' }) })
            stream = $true
            store = $false
        } | ConvertTo-Json -Depth 8
        $resp = Invoke-WebRequest -Uri 'https://chatgpt.com/backend-api/codex/responses' `
            -Headers $Headers -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 90
        if ($resp.StatusCode -ne 200) { return $false }
        if ($resp.Content -notmatch 'response\.completed') { return $false }
        return $true
    } catch {
        return $false
    }
}

$majors = @($pending | Where-Object Action -eq 'major')
foreach ($fam in @($majors | Group-Object Family)) {
    $d0 = @($fam.Group)[0]
    $fromIds = @($fam.Group | ForEach-Object { "$($_.Spelling)=$($_.CurrentId)" }) -join ','
    & $logTs "MAJOR available: $($fam.Name) $($fromIds) -> $($d0.LatestId) — NOT applied, user arbitrates"
    if (-not $DryRun) {
        Write-VersionEvent -EventsPath $eventsPath -Kind major-ask -Family $fam.Name `
            -From (@($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique) -join ',') `
            -To $d0.LatestId -Detail "spellings: $fromIds"
    }
}

$restartNow = $false
$restartWhy = @()
$minors = @($pending | Where-Object Action -eq 'minor')
foreach ($fam in @($minors | Group-Object Family)) {
    $latestId = @($fam.Group)[0].LatestId
    $fromIds = (@($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique) -join ',')

    # Acceptance probe BEFORE any edit — a listed id that does not serve never
    # enters routing (deepseek lesson: probe before trusting either direction).
    if (-not (Test-ModelServes -Id $latestId -Headers $headers)) {
        & $logTs "probe REFUSED for $latestId — no edit (listed but not serving, or probe shape drifted)"
        if (-not $DryRun) {
            Write-VersionEvent -EventsPath $eventsPath -Kind probe-fail -Family $fam.Name -To $latestId `
                -Detail "acceptance probe did not complete 'response.completed' — listed but not serving"
        }
        continue
    }

    $repins = @{}
    foreach ($d in $fam.Group) { $repins[$d.Spelling] = $d.NewTarget }
    # The new spelling takes a provider-qualified target when any spelling of
    # the family carries one; bare spellings repin bare (per-spelling, D1).
    $newTarget = ''
    foreach ($d in $fam.Group) { if ($d.Provider) { $newTarget = $d.NewTarget } }
    if (-not $newTarget) { $newTarget = $latestId }

    if ($DryRun) {
        & $logTs "DRYRUN would repin $($fam.Name): $(@($repins.GetEnumerator() | ForEach-Object { "$($_.Key) -> $($_.Value)" }) -join '; ') + register $latestId -> $newTarget"
        continue
    }
    $backup = Edit-RoutingForMinor -ConfigPath $ConfigPath -Family $fam.Name -Repins $repins `
        -NewSpelling $latestId -NewSpellingTarget $newTarget
    if (-not $backup) {
        & $logTs "edit REFUSED for $($fam.Name) (parse/empty diff) — no restart"
        Write-VersionEvent -EventsPath $eventsPath -Kind error -Family $fam.Name -Detail "Edit-RoutingForMinor refused"
        continue
    }

    # Reload decision (D4): the config on disk has moved; whether the hub
    # reloads NOW or at the daily drained restart depends on whether the OLD
    # id still serves. All old ids still answering = nothing is broken by
    # serving from the in-memory config one more day — defer. An old id that
    # fails its own probe = the minor was retired upstream = every request
    # routed to it fails until reload — restart now, detached, drained.
    $reloadMode = 'deferred-to-daily-restart'
    $deadOld = @()
    foreach ($oldId in @($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique)) {
        if (-not (Test-ModelServes -Id $oldId -Headers $headers)) { $deadOld += $oldId }
    }
    if ($deadOld.Count -gt 0) {
        $restartNow = $true
        $restartWhy += "$($fam.Name): old id(s) retired: $($deadOld -join ',')"
        $reloadMode = "restart-now (old id(s) $($deadOld -join ',') no longer serve)"
    }

    Write-VersionEvent -EventsPath $eventsPath -Kind minor-applied -Family $fam.Name -From $fromIds -To $latestId `
        -Detail "spellings repinned: $(@($repins.Keys) -join ','); reload: $reloadMode; backup: $backup; cascades/profiles untouched (operator act)"
    & $logTs "MINOR applied: $($fam.Name) $fromIds -> $latestId (reload: $reloadMode; backup $backup)"
}

# --- 4. Reload (config.json is bind-mounted: a drained docker RESTART re-reads
#        it; env is preserved, so cascades are safe — measured 2026-09-15) ----

if (-not $DryRun -and $restartNow) {
    if (-not (Test-Path -LiteralPath $DrainScript)) {
        & $logTs "old id retired but drain script not found at $DrainScript — reload deferred, escalate"
        Write-VersionEvent -EventsPath $eventsPath -Kind error -Family reload `
            -Detail "restart-now decided ($($restartWhy -join '; ')) but drain script absent — routing repinned, hub still on old id"
    } else {
        & $logTs "launching detached drained restart (reload mode: $($restartWhy -join '; '))"
        Start-Process powershell -WindowStyle Hidden -ArgumentList `
            '-ExecutionPolicy', 'Bypass', '-File', $DrainScript, '-Reason', 'model-version-watch minor repin (old id retired)'
    }
}
exit 0
