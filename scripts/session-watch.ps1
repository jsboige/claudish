<#
session-watch.ps1 — Session surveillance organ (detector-first, journal-only by default).

Background replacement for the interactive tripwire cron (#362-P4 reconciled; user 07/10:
surveillance "devrait etre l'objet d'un organe que tu lances en bg"). Scheduled task
ClaudishSessionWatch, non-elevated jsboi/Interactive/Limited, every 15 min — same class
as the failover/docker-events collectors (an instrument, NOT a schtasks worker).

Per tick:
  1. live-session-scan.py --hours 0.3 --json  (short-window tripwire, #362)
  2. OPENAI-SHAPED sessions:
       - remote machine         -> journal 'remote-openai'    (owning lane relays/acts)
       - CoursIA-2 workspace    -> journal 'exempt'           (user-authorized adjoint,
         cron coordinate-adjoint, principal gpt-6-sol declared — NEVER killed, NEVER
         posted; unconditional, dominance-independent — user arbitration 06/10 23:05)
       - local, sonnet-majority -> journal 'sonnet-majority'  (never killed)
       - local, sol > 50%       -> kill path, gated by consent file
         $ClaudishHome\session-watch.kill.enabled (ABSENT = detector only). Process
         bound by session-id substring in claude.exe CommandLine; no binding + capture
         < 2 min old -> 'no-binding-recent' (never conclude "already exited"); never
         kill a process not bound to the sid.
       - local, sol-minority    -> journal 'sol-minority'     (WARN-class at relay)
  3. MiniMax coding catalog watch: GET /v1/models (key read from the hub config.json,
     NEVER journaled, never printed); new/retired id vs baseline file -> journal
     'new-model' / 'model-gone' (e.g. a future M3.1 Flash appearing, or MiniMax-M3
     being retired — both change routing).
  4. split-brain-scan.ps1 hook: journaled digest when the script exists (PR #342
     pending merge at time of writing).

Journal: $ClaudishHome\session-watch.log — one NDJSON line per event
{ts(UTC), kind, sid, detail}. Relayed to the workspace dashboard by the /worker cycle
(watermark $ClaudishHome\session-watch-relay.ts), same pattern as model-version-events.log.
NEVER truncate the journal (durable trace, post-mortem evidence).

Exit code is always 0 — a crashed tick is worse than a skipped one; failures journal
kind='error'. Kill arming is a deliberate operator act: create the consent file only
after >=24h of clean journal (see SKILL.md relay notes).
#>

param(
    [string]$ClaudishHome = (Join-Path $env:USERPROFILE '.claudish'),
    [string]$ScanScript = '',
    [string]$PythonExe = "$env:USERPROFILE\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe",
    [string]$HubConfig = 'D:\claudish-shadow\config\config.json',
    [string]$RepoScripts = 'D:\dev\claudish\scripts',
    [double]$WindowHours = 0.3,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
if (-not $ScanScript) { $ScanScript = Join-Path $ClaudishHome 'live-session-scan.py' }
$JournalPath = Join-Path $ClaudishHome 'session-watch.log'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Journal {
    param([string]$Kind, [string]$Sid = '', [string]$Detail = '')
    $entry = [ordered]@{
        ts    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        kind  = $Kind
        sid   = $Sid
        detail = $Detail
    }
    # AppendAllText (no BOM, share-friendly) — Add-Content UTF8 would write a BOM on
    # file creation and poison the first JSON line at relay time.
    [System.IO.File]::AppendAllText($JournalPath, ($entry | ConvertTo-Json -Compress) + "`n", $Utf8NoBom)
}

# --- 1. Tripwire scan -----------------------------------------------------------
try {
    if (-not (Test-Path $PythonExe)) { throw "python not found: $PythonExe (Store-Python full path required, bare python = silent no-op)" }
    if (-not (Test-Path $ScanScript)) { throw "scan script not found: $ScanScript" }
    $raw = & $PythonExe $ScanScript --hours $WindowHours --top 12 --json 2>&1 | Out-String
    $data = $raw | ConvertFrom-Json
} catch {
    Write-Journal 'error' '' ("scan failed: " + $_.Exception.Message)
    $data = $null
}

$solId = 'gpt-6-sol'
$localMachine = $env:COMPUTERNAME.ToLower()
$projectsRoot = Join-Path $env:USERPROFILE '.claude\projects'

if ($data -and $data.sessions) {
    foreach ($s in @($data.sessions)) {
        if (@($s.flags) -notcontains 'OPENAI-SHAPED') { continue }
        $sid = [string]$s.session_id
        $sid8 = $sid.Substring(0, [Math]::Min(8, $sid.Length))

        if ([string]$s.machine -ne $localMachine) {
            Write-Journal 'remote-openai' $sid8 ("machine=" + $s.machine + " sol=" + $s.models.PSObject.Properties[$solId].Value + " total=" + $s.requests)
            continue
        }

        # Workspace resolution: the transcript lives under ~/.claude/projects/<project>/<sid8>*.jsonl
        $projectName = ''
        if (Test-Path $projectsRoot) {
            foreach ($d in (Get-ChildItem $projectsRoot -Directory -ErrorAction SilentlyContinue)) {
                if (Get-ChildItem -LiteralPath $d.FullName -Filter "$sid8*.jsonl" -ErrorAction SilentlyContinue) {
                    $projectName = $d.Name
                    break
                }
            }
        }

        if ($projectName -eq 'd--dev-CoursIA-2') {
            Write-Journal 'exempt' $sid8 'coursia-2 adjoint (user-authorized, principal gpt-6-sol declared)'
            continue
        }

        $sol = 0
        if ($s.models.PSObject.Properties[$solId]) { $sol = [int]$s.models.PSObject.Properties[$solId].Value }
        $total = [int]$s.requests
        $sonnet = 0
        foreach ($p in $s.models.PSObject.Properties) {
            if ($p.Name -like 'claude-sonnet*') { $sonnet += [int]$p.Value }
        }

        if ($sonnet -gt ($total / 2)) {
            Write-Journal 'sonnet-majority' $sid8 ("sonnet=$sonnet total=$total project=$projectName")
            continue
        }

        if ($sol -gt ($total / 2)) {
            $consentFile = Join-Path $ClaudishHome 'session-watch.kill.enabled'
            if (-not (Test-Path $consentFile)) {
                Write-Journal 'kill-blocked-no-consent' $sid8 ("sol=$sol total=$total project=$projectName (consent file absent — detector only)")
                continue
            }
            if ($DryRun) {
                Write-Journal 'dryrun-kill' $sid8 ("sol=$sol total=$total project=$projectName")
                continue
            }
            $bound = @()
            try {
                $bound = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($sid8)) })
            } catch { Write-Journal 'error' $sid8 ("process query failed: " + $_.Exception.Message) }
            if ($bound.Count -gt 0) {
                foreach ($p in $bound) {
                    try {
                        Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop
                        Write-Journal 'killed' $sid8 ("pid=" + $p.ProcessId + " sol=$sol total=$total project=$projectName")
                    } catch {
                        Write-Journal 'error' $sid8 ("kill failed pid=" + $p.ProcessId + ": " + $_.Exception.Message)
                    }
                }
            } else {
                $ageMin = ((Get-Date) - [datetime]$s.last).TotalMinutes
                if ($ageMin -lt 2) {
                    Write-Journal 'no-binding-recent' $sid8 ("last=" + $s.last + " (<2min — cannot conclude exited)")
                } else {
                    Write-Journal 'no-binding-stale' $sid8 ("last=" + $s.last + " (captures stopped, no process bound)")
                }
            }
        } else {
            Write-Journal 'sol-minority' $sid8 ("sol=$sol total=$total project=$projectName")
        }
    }
}

# --- 3. MiniMax coding catalog watch --------------------------------------------
try {
    $cfg = Get-Content $HubConfig -Raw -ErrorAction Stop | ConvertFrom-Json
    $apiKey = $cfg.apiKeys.MINIMAX_CODING_API_KEY
    if ($apiKey) {
        $resp = Invoke-RestMethod -Uri 'https://api.minimax.io/v1/models' -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 20 -ErrorAction Stop
        $ids = @($resp.data | ForEach-Object { $_.id } | Sort-Object)
        $baselineFile = Join-Path $ClaudishHome 'session-watch-models.baseline.json'
        if (Test-Path $baselineFile) {
            # PS 5.1 vs 7 divergence: under 5.1 ConvertFrom-Json emits a JSON array as ONE
            # pipeline object, so @() alone nests it (count=1, element=the array) and every
            # -notcontains misfires (measured 07/10: new-model x8 + model-gone x1 on an
            # UNCHANGED catalog). Piping through ForEach-Object unrolls in BOTH interpreters.
            $old = @((Get-Content $baselineFile -Raw -ErrorAction Stop | ConvertFrom-Json) | ForEach-Object { "$_" })
            foreach ($id in $ids) { if ($old -notcontains $id) { Write-Journal 'new-model' '' ("minimax-coding now offers: $id") } }
            foreach ($id in $old) { if ($ids -notcontains $id) { Write-Journal 'model-gone' '' ("minimax-coding retired: $id") } }
        }
        [System.IO.File]::WriteAllText($baselineFile, (ConvertTo-Json -InputObject @($ids)), $Utf8NoBom)
    } else {
        Write-Journal 'catalog-error' '' 'MINIMAX_CODING_API_KEY absent from hub config'
    }
} catch {
    Write-Journal 'catalog-error' '' ("catalog watch failed: " + $_.Exception.Message)
}

# --- 4. split-brain hook (activates when PR #342 merges) -------------------------
$splitBrain = Join-Path $RepoScripts 'split-brain-scan.ps1'
if (Test-Path $splitBrain) {
    try {
        $sbOut = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $splitBrain 2>&1 | Where-Object { $_ -and ("$_" -match '\S') })
        $digest = ($sbOut | Select-Object -Last 3) -join ' | '
        if ($digest) { Write-Journal 'split-brain' '' $digest }
    } catch {
        Write-Journal 'error' '' ("split-brain scan failed: " + $_.Exception.Message)
    }
}

exit 0
