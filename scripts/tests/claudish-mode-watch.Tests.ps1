<#
    Pester 5/6 suite for scripts/claudish-mode-watch.ps1 (jsboige/claudish#347 class,
    grain 7 of the v8 file; blocking review ai-01 2026-10-28, PR #733).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 - what the tasks run)

    WHY THIS EXISTS
    ---------------
    The watcher is the only durable trace of a NOMINAL <-> AUTONOMOUS switch: the
    docker log dies at the next recreate, so the ledger is what any later question
    about a flap must be answered from. Its value rests on three properties that
    are invisible to a reader of the script:

      1. A SAMPLE PER TICK, NOT PER CHANGE. Writing only on change makes "no
         transition happened" and "the watcher is dead" the same file contents,
         and every future reading of the ledger becomes a guess. The append test
         and the -Report gap test are the PINS: revert the tick to write-on-change
         and both go red (samples drops to 1, the role series loses its cadence).
      2. A FAILED /health IS A LINE, NOT AN EXCEPTION. A watcher that dies when
         the proxy is unreachable is absent exactly when it is most needed.
      3. THE LEDGER IS APPEND-ONLY, UTF-8 WITHOUT BOM, LF-TERMINATED, and every
         write the script performs derives from -LogPath. A BOM here would
         corrupt the first line of every fresh file (global rule: UTF-8 BOM
         breaks parsers), and a write outside the ledger would turn the
         instrument into an actor.

    Fixture mechanics: Pester runs each It in a NEW script scope, so state rides a
    GLOBAL bag read by the BeforeAll-defined mock - the same shape measured in
    claudish-split-brain-scan.Tests.ps1. Ledgers live in unique temp dirs removed
    in AfterEach; this machine's Pester does not clean TestDrive between tests.
    This file is pure ASCII on purpose (encoding-bom.Tests.ps1 exempts ASCII).
#>

BeforeAll {
    $script:WatchPath = Join-Path $PSScriptRoot '..\claudish-mode-watch.ps1'
    (Test-Path -LiteralPath $script:WatchPath) | Should -Be $true

    # Shared state bag - see header. The mock reads it at call time.
    $global:MWState = @{ Health = $null; Error = $null; Roots = @() }

    function New-LedgerRoot {
        $dir = Join-Path $env:TEMP ('mode-watch-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $global:MWState.Roots += $dir
        return $dir
    }

    # One tick (-Once) or one report, always against an explicit -LogPath: the
    # script's param() default points at the real %USERPROFILE%\.claudish ledger
    # and no test may touch it.
    function Invoke-Watch {
        param(
            [string]$Ledger,
            [switch]$Report,
            [int]$IntervalSec = 60,
            [int]$MaxBytes = 1048576
        )
        $callArgs = @{ LogPath = $Ledger; IntervalSec = $IntervalSec; MaxBytes = $MaxBytes }
        if ($Report) { $callArgs['Report'] = $true } else { $callArgs['Once'] = $true }
        $out = & $script:WatchPath @callArgs 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }

    function New-Health([string]$role, [string]$instance, [int]$up, [int]$streams) {
        [pscustomobject]@{ role = $role; instanceId = $instance; uptimeSec = $up; activeStreams = $streams }
    }

    function Write-Ledger([string]$Path, [string[]]$Lines) {
        [System.IO.File]::WriteAllText(
            $Path,
            (($Lines -join "`n") + "`n"),
            (New-Object System.Text.UTF8Encoding($false))
        )
    }

    function Read-LedgerLines([string]$Path) {
        $raw = [System.IO.File]::ReadAllLines($Path, (New-Object System.Text.UTF8Encoding($false)))
        return @($raw | Where-Object { $null -ne $_ -and $_.Trim().Length -gt 0 })
    }

    Mock Invoke-RestMethod {
        if ($global:MWState.Error) { throw $global:MWState.Error }
        $global:MWState.Health
    }
}

Describe 'claudish-mode-watch' {

    BeforeEach {
        $global:MWState.Health = New-Health 'relay-nominal' '66c786a1b2c3d4e5' 22089 1
        $global:MWState.Error = $null
    }

    AfterEach {
        foreach ($root in @($global:MWState.Roots)) {
            if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
        }
        $global:MWState.Roots = @()
    }

    Context 'one sample (the -Once tick)' {
        It 'writes one line with role, instance truncated to 8 chars, up and streams' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            $r = Invoke-Watch -Ledger $ledger

            $r.Code | Should -Be 0
            # the whole payload in one assertion: a field renamed or an instance
            # left at 32 chars both show up here
            $r.Out | Should -Match 'role=relay-nominal instance=66c786a1 up=22089 streams=1'
            $r.Out | Should -Not -Match '66c786a1b2c3d4e5'
            # ISO-8601 UTC with a Z suffix: a local-time stamp would make two
            # seats' ledgers incomparable
            $r.Out | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z '
            (Test-Path -LiteralPath $ledger) | Should -Be $true
            (Read-LedgerLines $ledger).Count | Should -Be 1
        }

        It 'appends UTF-8 WITHOUT BOM, LF-terminated (a BOM corrupts the first line of every fresh file)' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            Invoke-Watch -Ledger $ledger | Out-Null
            Invoke-Watch -Ledger $ledger | Out-Null

            $bytes = [System.IO.File]::ReadAllBytes($ledger)
            $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
            $hasBom | Should -Be $false
            # no CR anywhere: the repo's parsers and every awk/jq reader assume LF
            @($bytes | Where-Object { $_ -eq 0x0D }).Count | Should -Be 0
            # exactly two terminators for two samples
            @($bytes | Where-Object { $_ -eq 0x0A }).Count | Should -Be 2
            $bytes[$bytes.Length - 1] | Should -Be 0x0A
        }

        It 'creates the ledger directory when it does not exist yet' {
            $root = New-LedgerRoot
            $ledger = Join-Path (Join-Path $root 'nested\deeper') 'ledger.log'

            $r = Invoke-Watch -Ledger $ledger

            $r.Code | Should -Be 0
            (Test-Path -LiteralPath $ledger) | Should -Be $true
            (Read-LedgerLines $ledger).Count | Should -Be 1
        }
    }

    Context 'append per tick, not per change (PIN)' {
        It 'three ticks with an UNCHANGED role write THREE lines, and the report sees three samples' {
            # This is the pin review ai-01 asked for. Revert the tick to
            # "write only when role changed" and this It fails at the first
            # assertion (1 line instead of 3) - the ledger would then be unable
            # to distinguish a quiet night from a dead watcher.
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            Invoke-Watch -Ledger $ledger | Out-Null
            Invoke-Watch -Ledger $ledger | Out-Null
            Invoke-Watch -Ledger $ledger | Out-Null

            (Read-LedgerLines $ledger).Count | Should -Be 3

            $r = Invoke-Watch -Ledger $ledger -Report
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'samples\s+: 3\s+\('
            $r.Out | Should -Match 'relay-nominal\s+3'
            $r.Out | Should -Match 'transitions\s+: 0'
            # three ticks inside one second: no gap may be claimed
            $r.Out | Should -Match 'gaps >180s\s+: 0'
        }
    }

    Context 'a failed /health is a LINE, not an exception' {
        It 'writes role=UNAVAILABLE reason=timeout on a timeout and still exits 0' {
            $global:MWState.Error = 'The operation has timed out.'
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            $r = Invoke-Watch -Ledger $ledger

            $r.Code | Should -Be 0
            $r.Out | Should -Match 'role=UNAVAILABLE reason=timeout'
            (Read-LedgerLines $ledger).Count | Should -Be 1
            @(Read-LedgerLines $ledger)[0] | Should -Match 'reason=timeout'
        }

        It 'writes reason=error on any other failure (connection refused)' {
            $global:MWState.Error = 'No connection could be made because the target machine actively refused it.'
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            $r = Invoke-Watch -Ledger $ledger

            $r.Code | Should -Be 0
            $r.Out | Should -Match 'role=UNAVAILABLE reason=error'
            $r.Out | Should -Not -Match 'reason=timeout'
        }

        It 'keeps sampling after an outage: UNAVAILABLE then NOMINAL in the same ledger' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            $global:MWState.Error = 'The operation has timed out.'
            Invoke-Watch -Ledger $ledger | Out-Null
            $global:MWState.Error = $null
            Invoke-Watch -Ledger $ledger | Out-Null

            $lines = Read-LedgerLines $ledger
            $lines.Count | Should -Be 2
            $lines[0] | Should -Match 'role=UNAVAILABLE'
            $lines[1] | Should -Match 'role=relay-nominal'

            $r = Invoke-Watch -Ledger $ledger -Report
            $r.Out | Should -Match 'transitions\s+: 1'
            $r.Out | Should -Match 'UNAVAILABLE -> relay-nominal'
        }

        It 'health answering with no role reads role=unknown rather than printing an empty field' {
            $global:MWState.Health = [pscustomobject]@{ uptimeSec = 12; activeStreams = 0 }
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'

            $r = Invoke-Watch -Ledger $ledger

            $r.Out | Should -Match 'role=unknown'
            $r.Out | Should -Match 'instance=none'
        }
    }

    Context 'rotation at MaxBytes (single generation)' {
        It 'moves the live file to .1 at the threshold and continues in a fresh file' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            $old = @()
            1..8 | ForEach-Object { $old += ('2026-10-27T23:0{0}:00Z role=relay-nominal instance=aaaa1111 up={1} streams=0' -f $_, (100 + $_)) }
            Write-Ledger $ledger $old
            (Get-Item -LiteralPath $ledger).Length | Should -BeGreaterThan 300

            $r = Invoke-Watch -Ledger $ledger -MaxBytes 100

            $r.Code | Should -Be 0
            (Test-Path -LiteralPath "$ledger.1") | Should -Be $true
            # the archived generation holds EXACTLY the previous content
            $archived = Read-LedgerLines "$ledger.1"
            $archived.Count | Should -Be 8
            $archived[0] | Should -Match 'up=101'
            $archived[7] | Should -Match 'up=108'
            # and the live file restarts at one line
            (Read-LedgerLines $ledger).Count | Should -Be 1
        }

        It 'replaces a previous .1 instead of accumulating generations' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger "$ledger.1" @('2026-10-01T00:00:00Z role=ANCIENT-LINE')
            Write-Ledger $ledger @('2026-10-27T23:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0',
                                   '2026-10-27T23:01:00Z role=relay-nominal instance=aaaa1111 up=160 streams=0',
                                   '2026-10-27T23:02:00Z role=relay-nominal instance=aaaa1111 up=220 streams=0')

            Invoke-Watch -Ledger $ledger -MaxBytes 100 | Out-Null

            $archived = Read-LedgerLines "$ledger.1"
            $archived.Count | Should -Be 3
            ($archived -join "`n") | Should -Not -Match 'ANCIENT-LINE'
            (Test-Path -LiteralPath "$ledger.2") | Should -Be $false
        }

        It 'does NOT rotate a ledger under the threshold' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @('2026-10-27T23:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0')

            Invoke-Watch -Ledger $ledger | Out-Null

            (Test-Path -LiteralPath "$ledger.1") | Should -Be $false
            (Read-LedgerLines $ledger).Count | Should -Be 2
        }
    }

    Context '-Report: transitions, restarts, gaps' {
        It 'counts every role transition with its timestamp, and nothing else' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @(
                '2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0',
                '2026-10-28T00:01:00Z role=relay-nominal instance=aaaa1111 up=160 streams=0',
                '2026-10-28T00:02:00Z role=UNAVAILABLE reason=timeout',
                '2026-10-28T00:03:00Z role=autonomous instance=bbbb2222 up=5 streams=0'
            )

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Code | Should -Be 0
            $r.Out | Should -Match 'samples\s+: 4'
            $r.Out | Should -Match 'transitions\s+: 2'
            $r.Out | Should -Match '2026-10-28T00:02:00Z\s+relay-nominal -> UNAVAILABLE'
            $r.Out | Should -Match '2026-10-28T00:03:00Z\s+UNAVAILABLE -> autonomous'
            # a transition is not a restart: only the instance change is
            $r.Out | Should -Match 'restarts\s+: 1'
            $r.Out | Should -Match '00:03:00Z\s+instance aaaa1111 -> bbbb2222, up 160 -> 5'
        }

        It 'detects a restart from an uptime regression alone (same instance, new process)' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            # instanceId survives a recreate in this shape on purpose: uptime is
            # the second, independent signature and must not need the first
            Write-Ledger $ledger @(
                '2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=90000 streams=0',
                '2026-10-28T00:01:00Z role=relay-nominal instance=aaaa1111 up=40 streams=0'
            )

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Out | Should -Match 'restarts\s+: 1'
            $r.Out | Should -Match 'up 90000 -> 40'
            $r.Out | Should -Match 'transitions\s+: 0'
        }

        It 'does NOT call an uptime increase or a stable role a restart' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @(
                '2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0',
                '2026-10-28T00:01:00Z role=relay-nominal instance=aaaa1111 up=160 streams=0',
                '2026-10-28T00:02:00Z role=relay-nominal instance=aaaa1111 up=220 streams=0'
            )

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Out | Should -Match 'restarts\s+: 0'
            $r.Out | Should -Match 'transitions\s+: 0'
        }

        It 'reports a gap longer than 3 intervals as unobserved time (PIN)' {
            # The honesty check on the instrument itself: a hole in the ledger is
            # the only evidence that the watcher stopped. Remove gap detection
            # and a dead watcher becomes indistinguishable from a calm night.
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @(
                '2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0',
                '2026-10-28T00:01:00Z role=relay-nominal instance=aaaa1111 up=160 streams=0',
                '2026-10-28T00:06:00Z role=relay-nominal instance=aaaa1111 up=200 streams=0',
                '2026-10-28T00:07:00Z role=relay-nominal instance=aaaa1111 up=260 streams=0'
            )

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Out | Should -Match 'gaps >180s\s+: 1'
            $r.Out | Should -Match '2026-10-28T00:06:00Z\s+300s unobserved \(watcher not running\)'
            # the other three spacings are 60s and must not be reported
            ([regex]::Matches($r.Out, 'unobserved \(watcher not running\)')).Count | Should -Be 1
        }

        It 'honours -IntervalSec when deciding what a gap is (30s ticks: 120s is a gap)' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @(
                '2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0',
                '2026-10-28T00:00:30Z role=relay-nominal instance=aaaa1111 up=130 streams=0',
                '2026-10-28T00:02:30Z role=relay-nominal instance=aaaa1111 up=160 streams=0'
            )

            $r = Invoke-Watch -Ledger $ledger -Report -IntervalSec 30

            $r.Out | Should -Match 'gaps >90s\s+: 1'
            $r.Out | Should -Match '120s unobserved'
        }

        It 'echoes the ledger path it read (the blast radius is the path you passed)' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @('2026-10-28T00:00:00Z role=relay-nominal instance=aaaa1111 up=100 streams=0')

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Out | Should -Match ('ledger\s+: ' + [regex]::Escape($ledger))
        }

        It 'exits 1 on a missing ledger, an empty ledger, or lines it cannot parse' {
            $root = New-LedgerRoot

            $missing = Invoke-Watch -Ledger (Join-Path $root 'nope.log') -Report
            $missing.Code | Should -Be 1
            $missing.Out | Should -Match 'no ledger at'

            $emptyPath = Join-Path $root 'empty.log'
            [System.IO.File]::WriteAllText($emptyPath, '', (New-Object System.Text.UTF8Encoding($false)))
            $empty = Invoke-Watch -Ledger $emptyPath -Report
            $empty.Code | Should -Be 1
            $empty.Out | Should -Match 'never completed a sample'

            # a ledger whose first token is blank on every line: nothing parses
            $blankPath = Join-Path $root 'blank.log'
            Write-Ledger $blankPath @('   ', '   ')
            $blank = Invoke-Watch -Ledger $blankPath -Report
            $blank.Code | Should -Be 1
        }

        It 'a lone UNAVAILABLE is a sample, not an empty ledger' {
            $root = New-LedgerRoot
            $ledger = Join-Path $root 'ledger.log'
            Write-Ledger $ledger @('2026-10-28T00:00:00Z role=UNAVAILABLE reason=timeout')

            $r = Invoke-Watch -Ledger $ledger -Report

            $r.Code | Should -Be 0
            $r.Out | Should -Match 'samples\s+: 1'
            $r.Out | Should -Match 'UNAVAILABLE\s+1'
        }
    }
}

Describe 'the watcher stays read-only' {
    # Decision ai-01, 2026-10-27 22:15Z: read-only /health, one local file, no
    # container write, no scheduled task, no UAC. Detecting is not acting - the
    # same reasoning as the docker-events collector guard (#192) and the
    # split-brain scanner's no-actuator block (#341).
    BeforeAll {
        # Read at CALL time, not in BeforeAll: Pester 6 gives each It its own
        # script scope, and a $script: snapshot taken in the container scope is
        # not something an It may rely on (measured in the split-brain suite).
        function Get-WatchSource {
            return (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\claudish-mode-watch.ps1') -Raw)
        }

        function Get-ModeWatchOffenders([System.Management.Automation.Language.Ast]$Ast) {
            $offenders = @()
            foreach ($n in $Ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                $name = $n.GetCommandName()
                if ($name -match '^(docker|docker-compose|taskkill|schtasks)$') {
                    $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name)
                }
                if ($name -match '^(Stop-Process|Restart-Service|Start-Service|Stop-Service|Set-Service|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|Disable-ScheduledTask|Enable-ScheduledTask)$') {
                    $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name)
                }
                if ($n.Extent.Text -match '-Verb\s+RunAs') {
                    $offenders += ('{0}: -Verb RunAs' -f $n.Extent.StartLineNumber)
                }
                if ($name -match '^Invoke-(RestMethod|WebRequest)$') {
                    $m = [regex]::Match($n.Extent.Text, '-Method\s+(\w+)')
                    if (-not $m.Success -or $m.Groups[1].Value -notmatch '^Get$') {
                        $offenders += ('{0}: {1} without -Method Get' -f $n.Extent.StartLineNumber, $name)
                    }
                }
            }
            return $offenders
        }
    }

    It 'contains no container, scheduler or elevation actuator' {
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\claudish-mode-watch.ps1')) | Should -Be $true
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot '..\claudish-mode-watch.ps1'), [ref]$tokens, [ref]$errs)
        $errs.Count | Should -Be 0
        $offenders = Get-ModeWatchOffenders $ast
        $offenders | Should -BeNullOrEmpty
    }

    It 'the actuator detector actually detects (positive control)' {
        $bad = @'
docker restart claudish-sidecar
docker-compose up -d
schtasks /create /tn X /ru SYSTEM
Register-ScheduledTask -TaskName evil
Stop-Process -Id 4242
Start-Process powershell -Verb RunAs
Invoke-RestMethod -Uri http://localhost:3000/v1/messages -Method Post
'@
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $offenders = @(Get-ModeWatchOffenders $ast)
        # docker, docker-compose, schtasks, Register-ScheduledTask,
        # Stop-Process, -Verb RunAs, POST
        @($offenders).Count | Should -BeGreaterOrEqual 7
        ($offenders -match 'docker$').Count | Should -Be 1
        ($offenders -match 'schtasks').Count | Should -Be 1
        ($offenders -match 'POST|without -Method Get').Count | Should -Be 1
    }

    It 'reads exactly one endpoint, GET /health, and nothing else' {
        $src = Get-WatchSource
        ([regex]::Matches($src, 'Invoke-RestMethod')).Count | Should -Be 1
        $src | Should -Match '\$BaseUrl/health'
        # a POST/PUT/DELETE anywhere would be a proxy write, not a sample
        @([regex]::Matches($src, '-Method\s+(\w+)') | Where-Object { $_.Groups[1].Value -ne 'Get' }).Count | Should -Be 0
    }

    It 'every write it performs is confined to the -LogPath family' {
        # Rotation legitimately moves/removes files; what must never appear is a
        # write whose target is not derived from -LogPath (a capture tree, a
        # container path, another seat's ledger).
        $src = Get-WatchSource
        $writeLines = @($src -split "`n" | Where-Object {
            $_.Trim() -notmatch '^#' -and $_ -match '\b(Set-Content|Add-Content|Out-File|AppendAllText|Move-Item|Remove-Item|Copy-Item|New-Item)\b'
        })
        $writeLines.Count | Should -BeGreaterThan 0   # anti-vacuous: the scan sees the writes
        $unconfined = @($writeLines | Where-Object { $_ -notmatch '\$LogPath|\$archived|\$dir' })
        $unconfined | Should -BeNullOrEmpty
    }
}
