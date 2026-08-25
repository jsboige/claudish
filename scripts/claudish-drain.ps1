# Claudish — drain-then-restart (shared)
#
# A bare `docker restart` kills every in-flight SSE stream mid-body. Each client
# then reports:
#
#     API Error: Connection lost mid-response. The response above may be incomplete.
#
# and that agent turn is lost. The proxy never breaks a stream itself (there is
# no controller.error() in the codebase; every terminating path emits
# message_stop), so a client-visible mid-response drop means the process went
# away under it. Restarts are the main way that happens.
#
# Measured on the hub over 53,959 samples spanning 33.8 continuous hours:
# mean 3.6, p50 3, p90 6, max 15. The hub DOES fall idle — 4.6% of samples are
# at zero, in 772 distinct episodes, one every ~2.6 min, median 2s and p90 11s
# (longest 188s). So a restart usually costs turns; the question is how many.
#
# Since PR #37 the proxy reports the count:
#     GET /health -> {"status":"ok","activeStreams":8,"uptimeSec":1132}
# which lets a restart pick its moment instead of guessing. Waiting for silence
# is a far better bet than two earlier versions of this comment claimed: a 300s
# window reaches a zero about half the time, not 1 time in 18, and not never.
# The episodes are brief but frequent, and PollSec=2 is short enough to see
# them — polling at the 2s cadence loses almost nothing (49.8% vs 50.5%).
#
# TWO WAYS TO USE IT
#
# 1. Standalone — replace `docker restart claudish-proxy` in a scheduled task:
#      powershell -ExecutionPolicy Bypass -File scripts\claudish-drain.ps1 -Reason "daily 04:00"
#
# 2. Dot-sourced — reuse the functions from another script:
#      . "$PSScriptRoot\claudish-drain.ps1"
#      Invoke-ClaudishDrainedRestart -Reason "confirmed hang"
#
# Targets PowerShell 5.1: scheduled tasks run `powershell`, not `pwsh`.

param(
    [string]$ContainerName = "claudish-proxy",
    [string]$ProxyUrl = "http://localhost:3000",
    [int]$MaxWaitSec = 300,
    [string]$Reason = "manual",
    [string]$LogPath = "$env:USERPROFILE\.claudish\drain.log"
)

function Write-DrainLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-ClaudishActiveStreams {
    <#
        Returns the number of SSE responses currently streaming, or $null when
        the proxy cannot answer or predates PR #37. $null means "no signal" —
        callers must degrade to an undrained restart rather than block on a
        number that will never arrive.
    #>
    param([string]$Url = $ProxyUrl)
    try {
        $r = Invoke-WebRequest -Uri "$Url/health" -TimeoutSec 5 -UseBasicParsing
        $j = $r.Content | ConvertFrom-Json
        if ($null -eq $j.activeStreams) { return $null }
        return [int]$j.activeStreams
    } catch {
        return $null
    }
}

function Invoke-ClaudishDrainedRestart {
    <#
        Restarts the container at the quietest moment it can find.

        NOT "waits for zero" — though zero happens far more often than the
        first two versions of this docstring believed. Measured over 53,959
        samples spanning 33.8 continuous hours: mean 3.6, p50 3, p90 6, max 15,
        with 4.6% of samples at zero across 772 episodes (one every ~2.6 min,
        median 2s, p90 11s). A drain that waits only for 0 reaches one about
        half the time — but when it misses it times out and restarts at an
        arbitrary moment, which is why its tail is the worst of the three.

        So the target is relative, not absolute. We watch for $ObserveSec to
        learn what "quiet" means for this hub right now, then fire on the first
        sample at or below that observed minimum. Each subsequent miss relaxes
        the target by one, which bounds the wait without a timeout deciding for
        us: the restart lands at a below-average moment instead of a random one.

        Replaying all 53,959 real samples through each version, per restart:

                                  mean   p90   worst   restarts cutting nobody
            blind restart         3.61     6      13              4.8%
            wait-for-zero drain   2.36     6      15             49.1%
            this function         2.00     4       8             23.9%

        Read that table by the mean, not by the last column. Wait-for-zero
        cuts nobody twice as often, and still loses MORE turns overall (2.36
        vs 2.00) because its misses land at an arbitrary moment. A hybrid that
        holds out for a zero and only falls back to the relative target in the
        last 60s was tried on the same samples: 1.93 mean / 44.7% harmless but
        worst 15 — and 2.00 vs 1.93 is inside the noise, since 300s windows
        starting 5s apart share nearly all their samples (~405 independent
        windows in 33.8h, not 9,610). Not a real improvement; not adopted.

        The defaults are the knee of that curve. A longer cap buys nothing
        (600s scored identically to 300s), and relaxing the target faster
        undoes the whole gain — at one step per poll the target outruns the
        hub and the mean goes back to 4.67.

        This shaves the cost; it does not remove it. Even at its best it cuts
        three agent turns per restart, so the real mitigation is restarting
        less often, not draining better.
    #>
    param(
        [string]$Reason = "unspecified",
        [string]$Container = $ContainerName,
        [string]$Url = $ProxyUrl,
        [int]$MaxWait = $MaxWaitSec,
        [int]$ObserveSec = 60,
        [int]$RelaxSec = 30,
        [int]$PollSec = 2
    )

    $active = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $active) {
        Write-DrainLog "RESTART ($Reason): no activeStreams signal from $Url/health (proxy down, or image predates #37) — restarting without drain"
    } else {
        $initial = $active
        $waited = 0
        $seenMin = $active
        # -1 = still observing. Once set, it is the count we are willing to cut.
        $target = -1
        $sinceRelax = 0
        while ($waited -lt $MaxWait) {
            if ($active -le 0) { break }
            if ($target -ge 0 -and $active -le $target) { break }

            Start-Sleep -Seconds $PollSec
            $waited += $PollSec
            $sinceRelax += $PollSec
            $active = Get-ClaudishActiveStreams -Url $Url
            if ($null -eq $active) {
                Write-DrainLog "RESTART ($Reason): lost the activeStreams signal after ${waited}s — proceeding"
                break
            }
            if ($active -lt $seenMin) { $seenMin = $active }

            if ($target -lt 0) {
                if ($waited -ge $ObserveSec) {
                    $target = $seenMin
                    $sinceRelax = 0
                    Write-DrainLog "RESTART ($Reason): observed ${ObserveSec}s, quietest was $seenMin stream(s) — waiting for a moment at or below that"
                }
            } elseif ($sinceRelax -ge $RelaxSec) {
                # Missed it. Relax by one so the wait ends on a chosen moment
                # rather than on the cap. Relaxing slowly is what pays: at one
                # step per poll the target outran the hub and the gain vanished
                # (4.67 vs 3.65 mean, replaying the 906 real samples).
                $target++
                $sinceRelax = 0
            }
        }
        if ($null -eq $active) {
            # signal lost mid-drain; already logged
        } elseif ($active -gt 0) {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, restarting at $active in flight (quietest seen: $seenMin). Those $active clients will see 'Connection lost mid-response'."
        } else {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, 0 in flight — no client interrupted"
        }
    }

    docker restart $Container 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-DrainLog "RESTART ($Reason): docker restart $Container FAILED (exit $LASTEXITCODE)"
        return $false
    }
    Start-Sleep -Seconds 20

    $after = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $after) {
        Write-DrainLog "RESTART ($Reason): container restarted, but /health not answering yet after 20s"
    } else {
        Write-DrainLog "RESTART ($Reason): container restarted, /health answering (activeStreams=$after)"
    }
    return $true
}

# Standalone mode: run the restart. Dot-sourced, define the functions only.
if ($MyInvocation.InvocationName -ne '.') {
    $ok = Invoke-ClaudishDrainedRestart -Reason $Reason
    exit $(if ($ok) { 0 } else { 1 })
}
