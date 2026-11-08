<#
    Pester 5/6 suite for scripts/relay-guard.ps1 + scripts/install-relay-autostart.ps1
    (Q65, user GO 2026-11-01 option b: the HKCU\Run pipe launcher becomes a
    startup task with a guard).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 - what the task runs)

    WHY THIS EXISTS
    ---------------
    The guard is what keeps the FLEET-FACING entry alive across a reboot without
    an opened session (models.myia.io -> IIS 49 -> :18182 -> hub). Three
    properties carry that value and none of them is visible to a reader:

      1. IDEMPOTENT: a live pipe is never touched. Start a second node next to a
         listening one and the entry becomes a coin flip between two processes,
         one of which died at bind time. The "port busy" pin holds a REAL
         listener open and asserts no process was spawned.
      2. A MISSING PIECE IS A LOUD EXIT, NOT A SILENT ONE: relay.js gone or node
         missing must log an ERROR and exit 1. A guard that exits 0 when it
         cannot start anything reads exactly like a healthy one.
      3. THE DRY-RUN WRITES NOTHING. The UAC discipline requires the dry-run
         output to be posted BEFORE the elevation window; a dry-run that copies
         the guard would already be the gesture.

    Fixture mechanics: each test gets its own directory under TestDrive (this
    machine's Pester does not clean TestDrive between tests), the guard runs as a
    CHILD Windows PowerShell (it calls exit, which would kill the test process),
    and the fake node is a .cmd that records its argument, so "was it started"
    is a file, not an interpretation. Pure ASCII on purpose.
#>

BeforeAll {
    $script:GuardPath = Join-Path $PSScriptRoot '..\relay-guard.ps1'
    $script:InstallPath = Join-Path $PSScriptRoot '..\install-relay-autostart.ps1'
    (Test-Path -LiteralPath $script:GuardPath) | Should -Be $true
    (Test-Path -LiteralPath $script:InstallPath) | Should -Be $true

    $script:PS51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    (Test-Path -LiteralPath $script:PS51) | Should -Be $true

    function script:New-RelayFixture {
        param([string]$Name, [switch]$WithRelayJs, [switch]$WithFakeNode)
        # unique per It: this machine's Pester does not clean TestDrive between
        # tests, and a leftover marker from a mutated run would pass a pin that
        # the restored code should still be able to earn.
        $dir = Join-Path $TestDrive ("{0}-{1}" -f $Name, [Guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        if ($WithRelayJs) {
            Set-Content -LiteralPath (Join-Path $dir 'relay.js') -Value '// fixture pipe' -Encoding ASCII
        }
        if ($WithFakeNode) {
            Set-Content -LiteralPath (Join-Path $dir 'fake-node.cmd') -Value '@echo started %1> started.txt' -Encoding ASCII
        }
        return $dir
    }

    function script:Invoke-Guard {
        param([string]$RelayDir, [int]$Port, [string]$NodeExe)
        $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:GuardPath,
               '-RelayDir', $RelayDir, '-Port', [string]$Port)
        if ($NodeExe) { $a += @('-NodeExe', $NodeExe) }
        $out = & $script:PS51 @a 2>&1 | Out-String
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
    }

    function script:Get-FreePort {
        # NOT New TcpListener(...,0): that hands out a port from Windows' ephemeral
        # range (49152+), which any outgoing connection can occupy between the pick
        # and the guard's probe -- measured flaky on 2026-11-01 (the guard read
        # "pipe up" and the marker never appeared). Below that range the window is
        # a bind test, not a race with the ephemeral allocator.
        $base = 21000 + (Get-Random -Maximum 4000)
        for ($i = 0; $i -lt 50; $i++) {
            $p = $base + $i
            $l = $null
            try {
                $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
                $l.Start()
                $l.Stop()
                return $p
            } catch {
                if ($l) { try { $l.Stop() } catch { } }
            }
        }
        throw 'no free port found in the fixture range 21000-25049'
    }
}

Describe 'relay-guard.ps1' {

    It 'AC1: a live pipe is never duplicated - real listener, no child start, no log noise' {
        $dir = New-RelayFixture -Name 'busy' -WithRelayJs -WithFakeNode
        $port = Get-FreePort
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
        try {
            $r = Invoke-Guard -RelayDir $dir -Port $port -NodeExe (Join-Path $dir 'fake-node.cmd')
        } finally {
            $listener.Stop()
        }
        $r.ExitCode | Should -Be 0
        Test-Path -LiteralPath (Join-Path $dir 'started.txt') | Should -Be $false
        Test-Path -LiteralPath (Join-Path $dir 'guard.log') | Should -Be $false
    }

    It 'AC2: a dead pipe is started exactly once and the action is logged' {
        $dir = New-RelayFixture -Name 'start' -WithRelayJs -WithFakeNode
        $port = Get-FreePort
        # Pre-check: a stray listener would make the guard correctly do NOTHING,
        # and the pin would read as a guard bug. Cheap, removes the ambiguity.
        $stray = $null
        $pipeWasUp = $false
        try {
            $stray = New-Object System.Net.Sockets.TcpClient
            $stray.Connect('127.0.0.1', $port)
            $pipeWasUp = $true
        } catch { $pipeWasUp = $false } finally { if ($stray) { $stray.Close() } }
        $pipeWasUp | Should -Be $false

        $r = Invoke-Guard -RelayDir $dir -Port $port -NodeExe (Join-Path $dir 'fake-node.cmd')
        $r.ExitCode | Should -Be 0

        # Start-Process returns BEFORE the child runs: the guard's contract is
        # "launched", not "finished", so poll instead of assuming the write beat us.
        $marker = Join-Path $dir 'started.txt'
        $deadline = (Get-Date).AddSeconds(5)
        while (-not (Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        (Test-Path -LiteralPath $marker) | Should -Be $true
        (Get-Content -LiteralPath $marker -Raw) | Should -Match 'relay\.js'
        (Get-Content -LiteralPath (Join-Path $dir 'guard.log') -Raw) | Should -Match 'START pipe down on'
    }

    It 'AC3: a missing relay.js is a loud failure, not a silent exit 0' {
        $dir = New-RelayFixture -Name 'norelay' -WithFakeNode
        $r = Invoke-Guard -RelayDir $dir -Port (Get-FreePort) -NodeExe (Join-Path $dir 'fake-node.cmd')
        $r.ExitCode | Should -Be 1
        (Get-Content -LiteralPath (Join-Path $dir 'guard.log') -Raw) | Should -Match 'ERROR relay\.js missing'
        Test-Path -LiteralPath (Join-Path $dir 'started.txt') | Should -Be $false
    }

    It 'AC4: a missing node.exe is a loud failure too' {
        $dir = New-RelayFixture -Name 'nonode' -WithRelayJs
        $r = Invoke-Guard -RelayDir $dir -Port (Get-FreePort) -NodeExe (Join-Path $dir 'does-not-exist.exe')
        $r.ExitCode | Should -Be 1
        (Get-Content -LiteralPath (Join-Path $dir 'guard.log') -Raw) | Should -Match 'ERROR node\.exe missing'
    }

    It 'AC5: guard.log lines are UTC-stamped ASCII, one per real action' {
        $dir = New-RelayFixture -Name 'stamp' -WithRelayJs -WithFakeNode
        Invoke-Guard -RelayDir $dir -Port (Get-FreePort) -NodeExe (Join-Path $dir 'fake-node.cmd') | Out-Null
        $lines = @(Get-Content -LiteralPath (Join-Path $dir 'guard.log'))
        $lines.Count | Should -Be 1
        $lines[0] | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z '
    }
}

Describe 'install-relay-autostart.ps1' {

    It 'AC6: -DryRun prints the plan, writes NOTHING and registers NOTHING' {
        $dir = New-RelayFixture -Name 'dry' -WithRelayJs
        $out = & $script:PS51 -NoProfile -ExecutionPolicy Bypass -File $script:InstallPath `
                   -RelayDir $dir -GuardSource $script:GuardPath -DryRun 2>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $out | Should -Match 'DRY-RUN'
        $out | Should -Match 'empty = indefinite'
        # the gesture of the dry-run would be the copy: it must not have happened
        Test-Path -LiteralPath (Join-Path $dir 'relay-guard.ps1') | Should -Be $false
    }

    It 'AC7: preflight fails BEFORE anything when relay.js is absent (no elevation consumed)' {
        $dir = New-RelayFixture -Name 'preflight'
        $out = & $script:PS51 -NoProfile -ExecutionPolicy Bypass -File $script:InstallPath `
                   -RelayDir $dir -GuardSource $script:GuardPath -DryRun 2>&1 | Out-String
        $LASTEXITCODE | Should -Not -Be 0
        $out | Should -Match 'relay\.js not found'
        Test-Path -LiteralPath (Join-Path $dir 'relay-guard.ps1') | Should -Be $false
    }
}
