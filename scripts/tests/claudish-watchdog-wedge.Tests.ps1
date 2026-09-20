<#
    Integration tests for the wedge glue inside claudish-watchdog.ps1.

    The library suite proves the decision table. This one proves the WIRING: that
    the watchdog reads its state, calls the right probes, logs, persists the
    counter, and — above all — does not reach the engine unless every gate has
    opened. The previous attempt at this feature had no seam of any kind: the
    only way to execute its logic was to install it on the production hub and
    wait for a real wedge, which is how a teardown with a broken rebuild path
    reached a live machine.

    The watchdog is dot-sourced, so its main cycle does not run; the probes and
    the recovery action are injected, so nothing here touches Docker, WSL, the
    scheduled tasks or the network.
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-watchdog.ps1')).Path
}

Describe 'Invoke-LoopbackWedgeWatch (wiring)' {
    BeforeEach {
        # A fresh sandbox home per test: the watchdog writes its log and state
        # there, and a shared one would let a counter leak between cases.
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null

        # Dot-source INTO this scope with the sandbox home. The guard added for
        # this purpose makes the load a no-op beyond defining functions.
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        $script:Recovered = $false
        $script:RecoverStub = { $script:Recovered = $true }
        $script:DeadLoopback = { param($u) $false }
        $script:LiveLoopback = { param($u) $true }
        $script:Listening = { param($p) $true }
        $script:NotListening = { param($p) $false }
    }

    It 'stays silent and resets when the loopback is healthy' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $LiveLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub

        (Get-State).consecutiveWedge | Should -Be 0
        $Recovered | Should -BeFalse
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'LOOPBACK-WEDGE'
    }

    It 'arms on the first sighting, persists the counter, and does not act' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub

        (Get-State).consecutiveWedge | Should -Be 1
        $Recovered | Should -BeFalse
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match '1/2'
    }

    It 'escalates on the second sighting and still does not act (no opt-in)' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub

        (Get-State).consecutiveWedge | Should -Be 2
        $Recovered | Should -BeFalse
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'NOT opted in'
    }

    It 'CORE GUARD: opted in, wedge confirmed, but the preflight fails -> no teardown' {
        # This is the 13:18 scenario end to end. The machine has opted in, the
        # wedge is real and confirmed, and the rebuild path cannot be proven
        # (unelevated here, exactly as it was for the shell that ran it). The
        # only correct outcome is a loud log and an untouched host.
        Set-Content -Path (Join-Path $SandboxHome (Get-ClaudishOptInFileName)) -Value 'enabled'

        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub

        $Recovered | Should -BeFalse
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match 'refusing to tear down|relaunch path'
    }

    It 'clears the counter once the loopback comes back' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub
        (Get-State).consecutiveWedge | Should -Be 1

        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $LiveLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub
        (Get-State).consecutiveWedge | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match 'cleared'
    }

    It 'does nothing when no [::1] listener is visible (mirrored fail-safe)' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $NotListening -RecoveryAction $RecoverStub

        (Get-State).consecutiveWedge | Should -Be 0
        $Recovered | Should -BeFalse
    }

    It 'never throws, even when a probe does' {
        # It runs on the success path of a healthy cycle. A watchdog that turns
        # a healthy cycle into a crash is worse than one that misses a wedge.
        { Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe { throw 'boom' } `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub } | Should -Not -Throw
        $Recovered | Should -BeFalse
    }

    It 'REGRESSION: the wedge counter survives a hang-counter write' {
        # Set-State used to replace the whole state object with a single field,
        # so writing one counter erased the other and a confirmation counter
        # could never reach 2.
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $DeadLoopback `
            -ListenerProbe $Listening -RecoveryAction $RecoverStub
        Set-State -ConsecutiveHangs 0
        (Get-State).consecutiveWedge | Should -Be 1
    }
}

Describe 'Watchdog sandboxing' {
    It 'REGRESSION: -ClaudishHome redirects the LOG, not just the state file' {
        # Dot-sourcing claudish-drain.ps1 executes its param() defaults in this
        # scope, clobbering $ClaudishHome. Measured 2026-09-20: the state file
        # honoured the sandbox (computed before the dot-source) while two log
        # lines went to the PRODUCTION log (computed after) — a sandboxed run
        # that was not sandboxed, which is how a test lies about its blast radius.
        $sandbox = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

        . $script:WatchdogPath -ClaudishHome $sandbox
        Write-Log 'sandbox probe line'

        (Join-Path $sandbox 'watchdog.log') | Should -Exist
        (Get-Content (Join-Path $sandbox 'watchdog.log') -Raw) | Should -Match 'sandbox probe line'
        $LogPath | Should -BeLike "$sandbox*"
        $StateFile | Should -BeLike "$sandbox*"
    }
}
