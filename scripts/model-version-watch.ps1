# claudish — model version watch (runner)
#
# Watches the model versions the providers actually offer and keeps the hub's
# ROUTING on the latest MINOR of each family, automatically:
#   - minor bump available + acceptance probe 200 -> repin routing (config.json)
#     + detached drained restart + event 'minor-applied' (worker relays INFO).
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
& $logTs ("decisions: " + (($decisions | ForEach-Object { "$($_.Family)=$($_.Action)($($_.CurrentId)->$($_.LatestId))" }) -join ' ; '))

if ($pending.Count -eq 0) { exit 0 }

# --- 3. Apply policy ---------------------------------------------------------

foreach ($d in $pending) {
    if ($d.Action -eq 'major') {
        & $logTs "MAJOR available: $($d.Family) $($d.CurrentId) -> $($d.LatestId) — NOT applied, user arbitrates"
        if (-not $DryRun) {
            Write-VersionEvent -EventsPath $eventsPath -Kind major-ask -Family $d.Family -From $d.CurrentId -To $d.LatestId `
                -Detail "spellings: $($d.Spellings -join ',')"
        }
        continue
    }

    # minor: acceptance probe BEFORE any edit — a listed id that does not serve
    # never enters routing (Invoke-WebRequest: 200 = accepted, anything else or
    # a timeout = refuse). Probe constraints measured 2026-10-02: stream must
    # be true, max_output_tokens must be absent.
    $provider = ''
    foreach ($prop in $config.routing.PSObject.Properties) {
        if ($d.Spellings -contains $prop.Name) { $provider = ((@($prop.Value)[0]) -split '@')[0]; break }
    }
    $newTarget = if ($provider) { "$provider@$($d.LatestId)" } else { $d.LatestId }
    $probeOk = $false
    try {
        $body = @{
            model = $d.LatestId
            instructions = 'Reply with exactly: ok'
            input = @(@{ role = 'user'; content = @(@{ type = 'input_text'; text = 'say ok' }) })
            stream = $true
            store = $false
        } | ConvertTo-Json -Depth 8
        $null = Invoke-WebRequest -Uri 'https://chatgpt.com/backend-api/codex/responses' `
            -Headers $headers -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 90
        $probeOk = $true
    } catch {
        $status = ''
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        & $logTs "probe REFUSED for $($d.LatestId) (HTTP $status $($_.Exception.Message)) — no edit"
        if (-not $DryRun) {
            Write-VersionEvent -EventsPath $eventsPath -Kind probe-fail -Family $d.Family -To $d.LatestId `
                -Detail "probe HTTP $status — listed but not serving (or probe shape drifted)"
        }
    }
    if (-not $probeOk) { continue }

    if ($DryRun) {
        & $logTs "DRYRUN would repin $($d.Family): $($d.Spellings -join ',') -> $newTarget"
        continue
    }
    $backup = Edit-RoutingForMinor -ConfigPath $ConfigPath -Spellings $d.Spellings -NewTarget $newTarget
    if (-not $backup) {
        & $logTs "edit REFUSED for $($d.Family) (parse/empty diff) — no restart"
        Write-VersionEvent -EventsPath $eventsPath -Kind error -Family $d.Family -Detail "Edit-RoutingForMinor refused"
        continue
    }
    Write-VersionEvent -EventsPath $eventsPath -Kind minor-applied -Family $d.Family -From $d.CurrentId -To $d.LatestId `
        -Detail "spellings repinned: $($d.Spellings -join ','); backup: $backup; cascades/profiles untouched (operator act)"
    & $logTs "MINOR applied: $($d.Family) $($d.CurrentId) -> $($d.LatestId) (backup $backup)"
}

# --- 4. Reload (config.json is bind-mounted: a drained docker RESTART re-reads
#        it; env is preserved, so cascades are safe — measured 2026-09-15) ----

$applied = @($decisions | Where-Object { $_.Action -eq 'minor' })
$anyApplied = $false
if (-not $DryRun -and $applied.Count -gt 0) {
    # Re-read: only restart if the config on disk actually moved this run.
    $after = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    foreach ($d in $applied) {
        $sp = $d.Spellings | Select-Object -First 1
        if ($after.routing.$sp -and ((@($after.routing.$sp)[0]) -split '@')[-1] -eq $d.LatestId) { $anyApplied = $true }
    }
}
if ($anyApplied) {
    if (-not (Test-Path -LiteralPath $DrainScript)) {
        & $logTs "config repinned but drain script not found at $DrainScript — reload deferred to next restart"
        Write-VersionEvent -EventsPath $eventsPath -Kind info -Family reload -Detail "reload deferred: drain script absent"
    } else {
        & $logTs "launching detached drained restart (config reload)"
        Start-Process powershell -WindowStyle Hidden -ArgumentList `
            '-ExecutionPolicy', 'Bypass', '-File', $DrainScript, '-Reason', 'model-version-watch minor repin'
    }
}
exit 0
