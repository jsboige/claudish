<#
    Gap 2 of jsboige/claudish#530: consecutive FATALs escalate instead of
    scrolling past in watchdog.log.

    On 2026-10-18 the hub's engine was down for 73 minutes. The watchdog logged
    four FATALs, one per cycle, and exited 1 each time: no seat-side signal,
    no marker, nothing a later organ could read. The fleet learned the hub was
    dead from relay heartbeats before the hub seat said anything.

    The watchdog cannot open a network channel from a SYSTEM scheduled task, so
    the escalation is a MARKER JOURNAL under ~/.claudish/ — the shape the
    worker cycle already relays with watermark discipline. Two invariants carry
    the value and are pinned here:

      1. one line per CROSSING, never per cycle (a stuck engine must not rewrite
         the journal every 15 minutes, or the relay reports one crossing for
         ever and the operator cannot tell a new outage from an old one),
      2. recovery CLEARS the marker, or a healthy fleet keeps reading an outage
         that ended hours ago.

    Every case dot-sources the real watchdog into a sandbox -ClaudishHome and
    asserts on the SANDBOX log path: a sandboxed run that logs to production is
    lying about its blast radius (measured 2026-09-20, the drain dot-source
    lesson).
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-watchdog.ps1')).Path
    Import-Module (Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1') -Force
}

Describe 'Get-EngineFatalStreakDecision (#530 gap 2: pure crossing rule)' {
    It 'stays quiet below the threshold and writes no marker' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 0
        $d.Action | Should -Be 'arm'
        $d.Streak | Should -Be 1
        $d.WriteMarker | Should -BeFalse
    }

    It 'escalates exactly at the threshold and marks that crossing' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 1
        $d.Action | Should -Be 'escalate'
        $d.Streak | Should -Be 2
        $d.WriteMarker | Should -BeTrue
    }

    It 'stays escalated ABOVE the threshold but marks nothing further' {
        # The measured failure this prevents: one outage, thirty cycles, thirty
        # journal lines — indistinguishable from thirty outages.
        foreach ($prev in 2, 3, 17) {
            $d = Get-EngineFatalStreakDecision -ConsecutiveFatal $prev
            $d.Action | Should -Be 'escalate'
            $d.Streak | Should -Be ($prev + 1)
            $d.WriteMarker | Should -BeFalse
        }
    }

    It 'honours an explicit threshold (the knob is real, not decorative)' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 2 -Threshold 4
        $d.Action | Should -Be 'arm'
        $d.WriteMarker | Should -BeFalse
    }
}

Describe 'Register-EngineFatal / Reset-EngineFatalStreak (#530 gap 2: the watchdog half)' {
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome
        $script:StatePath = Join-Path $script:SandboxHome 'watchdog-state.json'
        $script:MarkerPath = Join-Path $script:SandboxHome (Get-EngineFatalStreakMarkerName)
        $script:WatchdogLog = Join-Path $script:SandboxHome 'watchdog.log'
    }

    It 'the sandbox is real: log, state and marker all land under the sandbox home' {
        # Without this, every assertion below could be reading production.
        # $LogPath is the dot-sourced script's own variable (unscoped, like the
        # existing relaunch suite); a $script:-scoped copy would be a different variable.
        $LogPath | Should -Be (Join-Path $script:SandboxHome 'watchdog.log')
        Register-EngineFatal 'unit probe'
        Test-Path $script:StatePath | Should -BeTrue
        (Join-Path $script:SandboxHome 'watchdog.log') | Should -Exist
    }

    It 'cycle 1: counts the streak, writes no marker, claims no escalation' {
        Register-EngineFatal 'engine did not recover'

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 1
        Test-Path $script:MarkerPath | Should -BeFalse

        $log = Get-Content $script:WatchdogLog -Raw
        $log | Should -Match 'ENGINE-FATAL-STREAK: 1 consecutive FATAL'
        $log | Should -Not -Match 'ENGINE-FATAL-ESCALATE'
    }

    It 'cycle 2: crosses the threshold, writes the marker ONCE' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 2
        Test-Path $script:MarkerPath | Should -BeTrue
        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        (Get-Content $script:MarkerPath -Raw) | Should -Match 'streak=2'
        (Get-Content $script:WatchdogLog -Raw) | Should -Match 'ENGINE-FATAL-ESCALATE'
    }

    It 'cycle 3+: stays escalated but does NOT rewrite the journal' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        $before = Get-Content $script:MarkerPath -Raw

        Register-EngineFatal 'third'
        Register-EngineFatal 'fourth'

        (Get-Content $script:MarkerPath -Raw) | Should -Be $before
        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 4
    }

    It 'the marker carries no BOM (Windows PowerShell 5.1 writes one by default)' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        $bytes = [System.IO.File]::ReadAllBytes($script:MarkerPath)
        # EF BB BF would make a naive downstream parser treat the first
        # timestamp as part of a key.
        ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should -BeFalse
    }

    It 'recovery resets the counter AND clears the marker' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        Test-Path $script:MarkerPath | Should -BeTrue

        Reset-EngineFatalStreak

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 0
        Test-Path $script:MarkerPath | Should -BeFalse
        (Get-Content $script:WatchdogLog -Raw) | Should -Match 'reset after an engine-healthy cycle \(was 2\)'
    }

    It 'a reset with nothing to reset is silent (no line per healthy cycle)' {
        Reset-EngineFatalStreak
        $log = if (Test-Path $script:WatchdogLog) { Get-Content $script:WatchdogLog -Raw } else { '' }
        $log | Should -Not -Match 'ENGINE-FATAL-STREAK: reset'
    }

    It 'a second crossing after a recovery journals again (new outage, new line)' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        Reset-EngineFatalStreak
        Register-EngineFatal 'third'
        Register-EngineFatal 'fourth'

        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        (Get-Content $script:MarkerPath -Raw) | Should -Match 'reason=fourth'
    }

    It 'never throws: an unwritable marker degrades to a log line' {
        # The FATAL exit belongs to the call site; the escalation helper must
        # not turn a diagnosable outage into an unhandled exception.
        { Register-EngineFatal 'first'; Register-EngineFatal 'second' } | Should -Not -Throw
    }
}
