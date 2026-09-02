# Claudish Watchdog — detects tool-call stream hangs and auto-restarts
#
# The proxy hangs on tool_call paths (WebSearch, GLM tool_use), not simple text.
# This watchdog tests the EXACT code path that degrades:
#   1. A streaming request WITH tools defined (triggers tool_use in the model)
#   2. Checks that the stream completes within timeout
#   3. Also checks container uptime — proactive restart at 11h before degradation
#
# Install (run as admin):
#   schtasks /create /tn "ClaudishWatchdog" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\claudish\scripts\claudish-watchdog.ps1" /sc minute /mo 15 /ru SYSTEM /rl HIGHEST /f
#
# Logs to: C:\Users\jsboi\.claudish\watchdog.log

$ErrorActionPreference = "Stop"
# Absolute paths: the scheduled task runs as SYSTEM, whose $env:USERPROFILE is
# the system profile — the user's .claudish dir would not exist there.
$LogPath = "C:\Users\jsboi\.claudish\watchdog.log"
$ProxyUrl = "http://localhost:3000"
$ContainerName = "claudish-proxy"
$StreamTimeoutSec = 90
$ProactiveRestartHours = 11
# A restart kills every in-flight SSE stream mid-body; the client reports
# "Connection lost mid-response" and the agent turn is lost. So: drain first,
# never restart for a cause a restart cannot fix, and confirm before acting.
# Two budgets, because the two restarts are not the same situation. A proactive
# restart is elective: it can afford to hunt for a quiet moment. A hang recovery
# is not — the proxy is already serving nobody, so waiting only extends the
# outage.
$DrainMaxWaitProactiveSec = 300
$DrainMaxWaitHangSec = 120
$StateFile = "C:\Users\jsboi\.claudish\watchdog-state.json"
$QuietHourStart = 3             # local hour; proactive restarts only in [start,end)
$QuietHourEnd = 6

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-ProxyWithTools {
    param([string]$Url, [int]$TimeoutSec)

    # This payload mimics a real Claude Code request WITH tools.
    # GLM will respond with tool_use or text — either way the stream must complete.
    # This exercises the exact code path (openai-sse tool_call handling) that hangs.
    $body = @{
        model = "glm-5.2"
        max_tokens = 100
        stream = $true
        tools = @(
            @{
                name = "Bash"
                description = "Run a bash command"
                input_schema = @{
                    type = "object"
                    properties = @{
                        command = @{ type = "string"; description = "The command" }
                    }
                    required = @("command")
                }
            },
            @{
                name = "Read"
                description = "Read a file"
                input_schema = @{
                    type = "object"
                    properties = @{
                        file_path = @{ type = "string"; description = "Path" }
                    }
                    required = @("file_path")
                }
            }
        )
        messages = @(
            @{
                role = "user"
                content = "List the current directory using Bash. Do it now."
            }
        )
    } | ConvertTo-Json -Depth 10

    # The hub authenticates /v1/messages with the cluster proxy key. Read it at
    # runtime from the deployment .env — never hardcode it here (the script is
    # committed). Absolute path: the scheduled task runs as SYSTEM, where
    # $env:USERPROFILE points at the wrong profile.
    $proxyKey = $null
    try {
        $envLine = Select-String -Path "D:\Dev\claudish\.env" -Pattern '^\s*CLAUDISH_PROXY_KEY\s*=\s*(.+)\s*$' | Select-Object -First 1
        if ($envLine) { $proxyKey = $envLine.Matches[0].Groups[1].Value.Trim('"', "'") }
    } catch {}
    $headers = @{}
    if ($proxyKey) { $headers["x-proxy-key"] = $proxyKey }

    # Wall-clock bound — and why this is NOT `Invoke-WebRequest -TimeoutSec`.
    # That parameter bounds only *establishing* the response; it does not bound
    # reading a streaming body. The proxy sends headers immediately and then
    # streams, so against a wedged pipeline the cmdlet blocks in the body read
    # with no timer running at all. On 2026-09-02 that is exactly what happened:
    # ten consecutive 15-minute probes entered here and none ever returned, so
    # the HANG SIGNAL 1/2 -> HANG CONFIRMED 2/2 -> restart path was never reached
    # during a 2h27 fleet-wide outage. A watchdog that cannot conclude is not a
    # watchdog.
    #
    # HttpClient.Timeout covers the whole operation, content read included
    # (SendAsync defaults to HttpCompletionOption.ResponseContentRead), and the
    # hard Wait() ceiling below guarantees this function returns even if that
    # timer itself fails to fire.
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $client = $null
    try {
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)

        $req = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post, "$Url/v1/messages")
        $req.Content = [System.Net.Http.StringContent]::new(
            $body, [System.Text.Encoding]::UTF8, "application/json")
        foreach ($k in $headers.Keys) {
            [void]$req.Headers.TryAddWithoutValidation($k, $headers[$k])
        }

        $sendTask = $client.SendAsync($req)
        if (-not $sendTask.Wait(($TimeoutSec + 15) * 1000)) {
            # The ceiling fired, so the client's own timer did not. Reporting a
            # hang beats blocking here forever, which is the failure being fixed.
            return @{ Ok = $false; Hang = $true; Detail = "TIMEOUT after ${TimeoutSec}s (hard ceiling) - stream hung" }
        }
        $response = $sendTask.Result
        $status = [int]$response.StatusCode

        # HttpClient does not throw on a non-2xx (Invoke-WebRequest did), so the
        # wall/wiring verdicts are decided inline instead of in a catch. Same
        # verdicts, same reasoning: when every cascade step is walled the proxy
        # correctly answers 429/402, and GLM walls ~2x/day (median 57 min).
        # Restarting the container cannot lift an upstream quota wall - it only
        # drops every agent mid-stream.
        if ($status -ge 400) {
            if ($status -eq 402 -or $status -eq 429 -or $status -eq 529) {
                return @{ Ok = $false; Hang = $false; Detail = "upstream wall HTTP $status - not a hang, no restart" }
            }
            if ($status -lt 500) {
                return @{ Ok = $false; Hang = $false; Detail = "client/wiring error HTTP $status - a restart would not fix it" }
            }
            return @{ Ok = $false; Hang = $true; Detail = "HTTP error $status" }
        }

        # Already fully buffered by ResponseContentRead, so this does not block.
        $content = $response.Content.ReadAsStringAsync().Result
        if ($null -eq $content) { $content = "" }

        # Stream must contain a terminal event
        if ($content -match "message_stop") {
            $hasToolUse = $content -match "tool_use"
            $type = if ($hasToolUse) { "tool_use+end" } else { "text+end" }
            return @{ Ok = $true; Hang = $false; Detail = "stream OK ($type, $($content.Length) bytes)" }
        } elseif ($content.Length -gt 100) {
            # Got data but no message_stop - suspicious but not fatal
            return @{ Ok = $false; Hang = $true; Detail = "stream incomplete ($($content.Length) bytes, no message_stop)" }
        } elseif ($content.Length -gt 0) {
            return @{ Ok = $false; Hang = $true; Detail = "short response ($($content.Length) bytes): $($content.Substring(0, [Math]::Min(200, $content.Length)))" }
        } else {
            return @{ Ok = $false; Hang = $true; Detail = "EMPTY response - stream hung" }
        }
    }
    catch {
        # The real cause is buried: PS wraps a failing .Wait()/.Result in a
        # MethodInvocationException, around an AggregateException, around the
        # TaskCanceledException a timeout actually raises. So walk the whole
        # chain, and decide on the TYPE - the message is localized (PS 5.1 on a
        # French host says "Une ou plusieurs erreurs se sont produites") and
        # would never match an English "timeout".
        $chain = @()
        $ex = $_.Exception
        while ($ex -and $chain.Count -lt 10) {
            $chain += $ex
            if ($ex -is [System.AggregateException] -and $ex.InnerExceptions.Count -ge 1) {
                $ex = $ex.InnerExceptions[0]
            } else {
                $ex = $ex.InnerException
            }
        }
        $timedOut = $false
        foreach ($e in $chain) { if ($e -is [System.OperationCanceledException]) { $timedOut = $true } }
        $msg = $chain[$chain.Count - 1].Message   # innermost: the informative one
        if ($timedOut -or $msg -match "timed? ?out" -or $msg -match "timeout") {
            return @{ Ok = $false; Hang = $true; Detail = "TIMEOUT after ${TimeoutSec}s - stream hung" }
        }
        # Connection refused / socket reset land here: the proxy is not answering
        # at all, which a restart CAN fix.
        return @{ Ok = $false; Hang = $true; Detail = "error: $msg" }
    }
    finally {
        if ($client) { $client.Dispose() }
    }
}

# The drain logic is shared with any other scheduled restart (ClaudishDailyRestart
# calls the same file standalone), so it lives in one place rather than being
# copied here.
. "$PSScriptRoot\claudish-drain.ps1"

# Dot-sourcing executes drain.ps1's param() DEFAULTS in this scope, which
# reassigns $LogPath to ...\.claudish\drain.log — silently misdirecting this
# script's log when run as the user, and fatally (missing dir + Stop) when run
# by the SYSTEM scheduled task (2026-08-30: exit 1, no log). Re-pin it.
$LogPath = "C:\Users\jsboi\.claudish\watchdog.log"

function Get-State {
    if (Test-Path $StateFile) {
        try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch {}
    }
    return [PSCustomObject]@{ consecutiveHangs = 0 }
}

function Set-State {
    param([int]$ConsecutiveHangs)
    $dir = Split-Path $StateFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    @{ consecutiveHangs = $ConsecutiveHangs } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

# --- Main ---

Write-Log "=== Watchdog check ==="

# Step 0: Engine recovery. After a reboot the Docker Desktop backend can die
# outright ("backend process exited") — docker CLI then fails with rc 28/125 and
# `docker start` is useless. Observed 2026-08-29: the first reboot of the hub
# machine came back with no container for exactly this reason, and a human had
# to reboot a second time. Start the service, then launch Docker Desktop in the
# interactive user session via a helper task (SYSTEM cannot own the GUI app),
# then wait, bounded, for the engine to answer.
function Test-DockerEngine {
    docker version *> $null
    return ($LASTEXITCODE -eq 0)
}

function Start-DockerEngine {
    if (Test-DockerEngine) { return $true }
    Write-Log "ENGINE-DOWN: docker CLI cannot reach the engine — recovering"
    try { Start-Service com.docker.service -ErrorAction SilentlyContinue } catch {}
    if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
        try {
            $helper = "ClaudishDockerDesktopStart"
            $action = New-ScheduledTaskAction -Execute "C:\Program Files\Docker\Docker\Docker Desktop.exe"
            Register-ScheduledTask -TaskName $helper -Action $action `
                -User "$env:COMPUTERNAME\jsboige" -LogonType Interactive -RunLevel Highest -Force | Out-Null
            Start-ScheduledTask -TaskName $helper
            Write-Log "ENGINE: Docker Desktop launch requested in user session"
        } catch {
            Write-Log "ENGINE: could not launch Docker Desktop ($($_.Exception.Message))"
        }
    }
    for ($i = 1; $i -le 12; $i++) {
        Start-Sleep -Seconds 10
        if (Test-DockerEngine) {
            Write-Log "ENGINE: recovered after $($i * 10)s"
            return $true
        }
    }
    Write-Log "ENGINE: still down after 120s — FATAL this cycle (next run retries)"
    return $false
}

# Step 1: Container running?
$containerStatus = docker inspect $ContainerName --format "{{.State.Status}}" 2>$null
if ($LASTEXITCODE -ne 0 -or $containerStatus -ne "running") {
    if ($LASTEXITCODE -ne 0) {
        # CLI itself failed — engine down, not just the container.
        if (-not (Start-DockerEngine)) { exit 1 }
    }
    Write-Log "CRITICAL: Container not running (status=$containerStatus). Starting..."
    docker start $ContainerName 2>$null
    Start-Sleep -Seconds 15
    $recheck = docker inspect $ContainerName --format "{{.State.Status}}" 2>$null
    if ($recheck -eq "running") {
        Write-Log "RECOVERED: Container started"
    } else {
        Write-Log "FATAL: Container won't start (status=$recheck)"
        exit 1
    }
    exit 0
}

# Step 2: Uptime check
$startedAt = docker inspect $ContainerName --format "{{.State.StartedAt}}" 2>$null
$startTime = [DateTimeOffset]::Parse($startedAt)
$uptime = [DateTimeOffset]::UtcNow - $startTime
$uptimeHours = [Math]::Round($uptime.TotalHours, 1)

# Step 3: Proactive restart if uptime > threshold (prevent degradation BEFORE it happens)
# An uptime THRESHOLD drifts through the clock: an 11h period restarts at 09:00,
# then 20:00, then 07:00... landing mid-workday roughly every other time. Gate it
# on a quiet local window instead, so the one unavoidable daily restart never
# happens while the fleet is working.
$nowHour = (Get-Date).Hour
$inQuietWindow = ($nowHour -ge $QuietHourStart -and $nowHour -lt $QuietHourEnd)
if ($uptimeHours -ge $ProactiveRestartHours) {
    if (-not $inQuietWindow) {
        Write-Log "PROACTIVE: uptime ${uptimeHours}h >= ${ProactiveRestartHours}h but outside the quiet window ${QuietHourStart}h-${QuietHourEnd}h — deferring (a healthy proxy is not an emergency)"
    } else {
        Write-Log "PROACTIVE: uptime ${uptimeHours}h >= ${ProactiveRestartHours}h, quiet window — draining then restarting..."
        Invoke-ClaudishDrainedRestart -Reason "proactive uptime ${uptimeHours}h" -Container $ContainerName -Url $ProxyUrl -MaxWait $DrainMaxWaitProactiveSec
        $result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
        Write-Log "After proactive restart: $($result.Detail)"
        Set-State -ConsecutiveHangs 0
        exit $(if ($result.Ok) { 0 } else { 1 })
    }
}

# Step 4: Real tool-call streaming test
$result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec $StreamTimeoutSec

$state = Get-State
$consecutive = [int]$state.consecutiveHangs

if ($result.Ok) {
    Write-Log "OK (uptime=${uptimeHours}h). $($result.Detail)"
    Set-State -ConsecutiveHangs 0
    exit 0
}

if (-not $result.Hang) {
    # Real failure, wrong remedy. Log it loudly and leave the container alone.
    Write-Log "DEGRADED (uptime=${uptimeHours}h): $($result.Detail) — NO restart (a restart cannot fix this)"
    Set-State -ConsecutiveHangs 0
    exit 0
}

# Hang signal. One failed 90s probe is not proof: the proxy may simply be under
# load. Require two consecutive cycles (~15 min apart), mirroring the relay's own
# failover hysteresis, before paying the cost of dropping every live stream.
$consecutive = $consecutive + 1
if ($consecutive -lt 2) {
    Write-Log "HANG SIGNAL 1/2 (uptime=${uptimeHours}h): $($result.Detail) — waiting for confirmation next cycle, NO restart"
    Set-State -ConsecutiveHangs $consecutive
    exit 0
}

Write-Log "HANG CONFIRMED 2/2 (uptime=${uptimeHours}h): $($result.Detail)"
Invoke-ClaudishDrainedRestart -Reason "confirmed hang" -Container $ContainerName -Url $ProxyUrl -MaxWait $DrainMaxWaitHangSec
Set-State -ConsecutiveHangs 0

$result2 = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
if ($result2.Ok) {
    Write-Log "RECOVERED: $($result2.Detail)"
} else {
    Write-Log "CRITICAL: Still broken after restart: $($result2.Detail)"
    exit 1
}
