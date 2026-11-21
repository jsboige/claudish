<#
    Seam pins for the PURE rung R0 of the sidecar host watchdog
    (Get-ContainerRelaunchDecision in scripts/lib/claudish-engine.psm1) and the
    container half of the state codec.

    WHY R0 (#2767, decision 20/11; blind spot measured 14/11 on myia-po-2028):
    a neighbour lane's `docker stop claudish-proxy` (roo-extensions #2767
    kill-test, no finally) left the container EXITED ~70 min with engine=up and
    BOTH loopbacks dead. The host watchdog logged LOOPBACK_DEAD the whole time
    and did NOTHING: R1 needs IPv4 alive, R2/R3 need the ENGINE down — a merely
    STOPPED container on a healthy engine was a blind spot. R0's only actuator
    is `docker start claudish-proxy`, whose rebuild half (the container's own
    start) is proven — unlike R2's distro teardown (#172 AC4).

    Acceptance evidence #1 of the 20/11 decision: Pester covers the trigger
    (fires after 2 ticks on exited + engine=up), the no-fire cases (drain in
    flight, one tick only, engine down, container absent -> escalation line),
    and once-per-episode (no second start after a re-exit).

    Run under BOTH interpreters (bun run test:scripts / test:scripts:win51) —
    the datetime Kind break the codec guards against is 5.1-specific.
#>

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force

    # Fixed clock: the decision takes NowUtc injected, so every branch is
    # reachable without sleeping.
    $script:Now = [DateTimeOffset]::Parse('2026-11-20T14:00:00.0000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    # 60-min-old stamp: the 30-min cooldown is elapsed for any call that uses it.
    $script:StampAgo60 = [DateTimeOffset]::Parse('2026-11-20T13:00:00.0000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime

    function New-CState {
        param([int]$Fails = 0, [int]$SinceDown = 0, [datetime]$Stamp = [datetime]::MinValue)
        return @{
            ContainerStoppedFailures   = $Fails
            LastContainerActionUtc     = $Stamp
            ContainerRelaunchSinceDown = $SinceDown
        }
    }
    function Invoke-R0 {
        param(
            [hashtable]$State,
            [string]$Loopback = 'LOOPBACK_DEAD',
            [string]$Engine = 'up',
            [string]$Container = 'exited',
            [bool]$Drain = $false,
            [datetime]$NowUtc = $script:Now,
            [int]$Threshold = 2,
            [int]$CooldownMin = 30,
            [switch]$DryRun
        )
        return Get-ContainerRelaunchDecision -State $State -LoopbackVerdict $Loopback `
            -EngineVerdict $Engine -ContainerState $Container -DrainInFlight $Drain `
            -NowUtc $NowUtc -ConsecutiveStoppedFailures $Threshold `
            -RelaunchCooldownMin $CooldownMin -DryRun:$DryRun
    }
}

Describe 'R0 container-relaunch ladder (the 14/11 kill-test blind spot)' {

    It 'fires r0_start after 2 consecutive stopped sightings on exited + engine up + full dead' {
        $s = New-CState
        $t1 = Invoke-R0 -State $s
        $t1.Action | Should -Be 'pending'
        $t1.NextState.ContainerStoppedFailures | Should -Be 1
        $t2 = Invoke-R0 -State $t1.NextState
        $t2.Action | Should -Be 'r0_start'
        $t2.NextState.ContainerRelaunchSinceDown | Should -Be 1
    }

    It 'one tick only stays pending (never acts on a single sighting)' {
        $t = Invoke-R0 -State (New-CState)
        $t.Action | Should -Be 'pending'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'guard_drain: a drain owns the lifecycle, no start, no increment' {
        $s = New-CState -Fails 1
        $t = Invoke-R0 -State $s -Drain $true
        $t.Action | Should -Be 'guard_drain'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'engine down is NOT R0 class (R2/R3 owns it)' {
        $t = Invoke-R0 -State (New-CState) -Engine 'down'
        $t.Action | Should -Be 'not_this_class'
        $t.NextState.ContainerStoppedFailures | Should -Be 0
    }

    It 'engine hang/unknown is NOT R0 class (never start on an unprobeable engine)' {
        (Invoke-R0 -State (New-CState) -Engine 'hang').Action    | Should -Be 'not_this_class'
        (Invoke-R0 -State (New-CState) -Engine 'unknown').Action | Should -Be 'not_this_class'
    }

    It 'only one loopback leg dead is NOT R0 class (R1/R1B owns it)' {
        (Invoke-R0 -State (New-CState) -Loopback 'LOOPBACK4_DOWN' -Container 'running').Action | Should -Be 'not_this_class'
        (Invoke-R0 -State (New-CState) -Loopback 'LOOPBACK6_DOWN' -Container 'running').Action | Should -Be 'not_this_class'
        (Invoke-R0 -State (New-CState) -Loopback 'HEALTHY'       -Container 'running').Action | Should -Be 'not_this_class'
    }

    It 'container RUNNING is NOT R0 class even on full dead (a wedge, not a stop)' {
        $t = Invoke-R0 -State (New-CState) -Container 'running'
        $t.Action | Should -Be 'not_this_class'
    }

    It 'container ABSENT after 2 ticks escalates, never tries to start' {
        $s = New-CState -Fails 1
        $t = Invoke-R0 -State $s -Container 'absent'
        $t.Action | Should -Be 'container_absent'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'absent INSIDE the cooldown gives guard_cooldown (the cooldown bounds absent repeats too)' {
        # Review #1126: absent tested BEFORE the cooldown stamped the clock,
        # reset the counter, then re-escalated every 2 ticks (~10 min at the
        # /5 min cadence) for as long as the container stayed absent. The
        # cooldown comes first; absent is still terminal once it can speak.
        $s = New-CState -Fails 1 -Stamp $script:Now
        $t = Invoke-R0 -State $s -Container 'absent'
        $t.Action | Should -Be 'guard_cooldown'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'container UNKNOWN (unprobeable daemon) is NOT absent - never a phantom escalate' {
        $t = Invoke-R0 -State (New-CState) -Container 'unknown'
        $t.Action | Should -Be 'not_this_class'
    }

    It 'once per episode: already relaunched then re-exited escalates (re_exited_after_start)' {
        $s = New-CState -Fails 1 -SinceDown 1 -Stamp $script:StampAgo60
        $t = Invoke-R0 -State $s
        $t.Action | Should -Be 'r0_after_relaunch'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 1
    }

    It 'guard_cooldown: a fresh R0 action younger than the cooldown blocks a re-fire' {
        $s = New-CState -Fails 1 -Stamp $script:Now
        $t = Invoke-R0 -State $s
        $t.Action | Should -Be 'guard_cooldown'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'created state is a valid start target (like exited)' {
        $s = New-CState -Fails 1
        $t = Invoke-R0 -State $s -Container 'created'
        $t.Action | Should -Be 'r0_start'
    }

    It 'a healthy running container CLOSES the episode (relaunch budget restored)' {
        $s = New-CState -SinceDown 1 -Stamp $script:StampAgo60
        $t = Invoke-R0 -State $s -Loopback 'HEALTHY' -Container 'running'
        $t.Action | Should -Be 'not_this_class'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
    }

    It 'dry-run computes r0_start but returns the state UNCHANGED' {
        $s = New-CState -Fails 1
        $t = Invoke-R0 -State $s -DryRun
        $t.Action | Should -Be 'r0_start'
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
        $t.NextState.ContainerStoppedFailures   | Should -Be 1
    }

    It 'terminal rungs stamp the cooldown clock and reset the consecutive counter' {
        $s = New-CState -Fails 1
        $t = Invoke-R0 -State $s
        $t.Action | Should -Be 'r0_start'
        $t.NextState.ContainerStoppedFailures | Should -Be 0
        $t.NextState.LastContainerActionUtc   | Should -Be $script:Now
    }
}

Describe 'R0 state codec round-trip (container fields)' {

    It 'container fields survive a write->read round-trip' {
        $state = @{
            EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0
            ContainerStoppedFailures = 1
            LastContainerActionUtc = $script:StampAgo60
            ContainerRelaunchSinceDown = 1
        }
        $json = ConvertTo-WatchdogStateJson -State $state
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $back.ContainerStoppedFailures   | Should -Be 1
        $back.ContainerRelaunchSinceDown | Should -Be 1
        $back.LastContainerActionUtc     | Should -Be $script:StampAgo60
    }

    It 'a PRE-R0 state file (no container keys) decodes to never-acted, no throw' {
        $legacy = '{"engineFailures":2,"lastEngineActionUtc":null,"engineActionsSinceDown":0}'
        $back = ConvertFrom-WatchdogStateJson -Json $legacy
        $back.ContainerStoppedFailures   | Should -Be 0
        $back.ContainerRelaunchSinceDown | Should -Be 0
        $back.LastContainerActionUtc     | Should -Be ([datetime]::MinValue)
        $back.EngineFailures             | Should -Be 2
    }

    It 'a MinValue container stamp serializes as null and round-trips to MinValue' {
        $state = @{
            EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0
            ContainerStoppedFailures = 0; LastContainerActionUtc = [datetime]::MinValue; ContainerRelaunchSinceDown = 0
        }
        $json = ConvertTo-WatchdogStateJson -State $state
        ($json | ConvertFrom-Json).lastContainerActionUtc | Should -BeNullOrEmpty
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $back.LastContainerActionUtc | Should -Be ([datetime]::MinValue)
    }
}

Describe 'R0 -ContainerName wiring (the sidecar is not claudish-proxy everywhere)' {
    # Review #1126 blocking 2: the probe and the start hard-coded
    # 'claudish-proxy', but the container is 'claudish-sidecar' on ai-01,
    # po-2024 and po-2027 — on those seats R0 would escalate a phantom
    # container_absent instead of starting the container that is right there.
    # Source-level pins: the script's main body is not callable from Pester
    # (it probes the host), so we pin the wiring where it is written.

    BeforeAll {
        $script:WatchdogPath = Join-Path $PSScriptRoot '..\claudish-sidecar-host-watchdog.ps1'
        $script:Source = Get-Content $script:WatchdogPath -Raw
    }

    It 'the script exposes -ContainerName with the claudish-proxy default' {
        $script:Source | Should -Match '(?m)^\s*\[string\]\$ContainerName = ''claudish-proxy'',\r?$'
    }

    It 'the PROBE uses the parameter, not a hard-coded name' {
        $script:Source | Should -Match 'inspect -f \{\{\.State\.Status\}\} \$ContainerName'
        $script:Source | Should -Match 'Get-ClaudishContainerState -ContainerName \$ContainerName'
        # No functional hard-code left: the only remaining literal mentions
        # are the param default, its doc, the function's own default and the
        # historical narrative of the 14/11 incident.
        $functional = ($script:Source -split "`n") | Where-Object {
            $_ -match 'claudish-proxy' -and $_ -notmatch 'ContainerName' -and
            $_ -notmatch 'po-2028 name|ai-01|# |kill-test|`docker'
        }
        $functional | Should -BeNullOrEmpty
    }

    It 'the START actuator uses the parameter' {
        $script:Source | Should -Match ([regex]::Escape("@('start', `$ContainerName)"))
    }

    It 'the R0 log lines name the container' {
        $script:Source | Should -Match 'R0_DOCKER_START_CONTAINER_BEGIN container=\$containerState name=\$ContainerName'
    }
}

Describe 'R0 deployment half: stale module and legacy state must never be silent' {
    # 2026-11-20 kill-test on po-2028 (#1126 proof #3): the .ps1 was deployed
    # but the MODULE copy under $HOME\.claudish\bin\lib\ was not — every tick
    # paid a CommandNotFoundException, $r0 stayed null and R0 was inert for 24
    # consecutive LOOPBACK_DEAD ticks with no line to show for it. Two pins:
    # the presence guard exists in the script, and a legacy state hashtable
    # (no Container* keys) drives the decision without throwing.
    BeforeAll {
        $script:WatchdogPath2 = Join-Path $PSScriptRoot '..\claudish-sidecar-host-watchdog.ps1'
        $script:Source2 = Get-Content $script:WatchdogPath2 -Raw
    }

    It 'the R0 decision call is guarded by a presence check with an explicit escalation line' {
        $script:Source2 | Should -Match 'Get-Command Get-ContainerRelaunchDecision -ErrorAction SilentlyContinue'
        $script:Source2 | Should -Match 'R0_UNAVAILABLE_MODULE_STALE deploy=copy scripts\\lib\\claudish-engine\.psm1'
    }

    It 'a legacy state hashtable (no Container* keys) counts a first sighting instead of throwing' {
        $t = Invoke-R0 -State @{}
        $t.Action | Should -Be 'pending'
        $t.NextState.ContainerStoppedFailures | Should -Be 1
        $t.NextState.ContainerRelaunchSinceDown | Should -Be 0
        $t2 = Invoke-R0 -State $t.NextState
        $t2.Action | Should -Be 'r0_start'
    }
}

Describe 'R0 pipeline seam: the engine rung feeds the R0 rung (kill-test 21/11)' {
    <#
        The 21/11 kill-test on myia-po-2028 (docker stop 17:11:44Z): the host
        watchdog REPLACES its whole state with the engine rung's NextState,
        then calls R0 on the result. The engine NextState carried ONLY the
        Engine* keys, so ContainerStoppedFailures was erased in flight every
        tick — R0 re-counted the stop from zero forever (R0_PENDING 1/2 at
        17:15, 17:20 and 17:25, state file pinned at 1) and the outage went
        17 minutes unrelaunched until a manual docker start. The engine rung's
        NextState must carry the container keys through; R0 owns them
        downstream.
    #>

    It 'a full state through the ENGINE rung keeps its container keys - R0 fires on the second sighting' {
        $s = @{
            EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0
            ContainerStoppedFailures = 1; LastContainerActionUtc = $script:StampAgo60; ContainerRelaunchSinceDown = 0
        }
        $eng = Get-EngineWatchdogDecision -State $s -EngineVerdict 'up' -NowUtc $script:Now -DrainInFlight $false -BackendPresent $true -WslVerdict 'ok' -HostWatchdogPresent $false
        $eng.Action | Should -Be 'reset'
        $r0 = Invoke-R0 -State ([hashtable]$eng.NextState)
        $r0.Action | Should -Be 'r0_start' -Because 'the second sighting must arm, not re-count from zero'
    }

    It 'the engine DRY-RUN next state is the input state unchanged INCLUDING the container keys' {
        $s = @{
            EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0
            ContainerStoppedFailures = 1; LastContainerActionUtc = $script:StampAgo60; ContainerRelaunchSinceDown = 2
        }
        $eng = Get-EngineWatchdogDecision -State $s -EngineVerdict 'down' -NowUtc $script:Now -DrainInFlight $false -BackendPresent $true -WslVerdict 'ok' -HostWatchdogPresent $false -DryRun
        $eng.NextState.ContainerStoppedFailures   | Should -Be 1
        $eng.NextState.ContainerRelaunchSinceDown | Should -Be 2
    }

    It 'the episode marker survives the engine rung - a re-exited container escalates instead of re-arming' {
        $s = @{
            EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0
            ContainerStoppedFailures = 1; LastContainerActionUtc = $script:StampAgo60; ContainerRelaunchSinceDown = 1
        }
        $eng = Get-EngineWatchdogDecision -State $s -EngineVerdict 'up' -NowUtc $script:Now -DrainInFlight $false -BackendPresent $true -WslVerdict 'ok' -HostWatchdogPresent $false
        $r0 = Invoke-R0 -State ([hashtable]$eng.NextState)
        $r0.Action | Should -Be 'r0_after_relaunch' -Because 'the once-per-episode marker must not be erased in flight'
    }
}
