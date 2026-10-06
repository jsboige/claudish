<#
    Pester 5/6 suite for the split-brain / ghost-session scanner (jsboige/claudish#41, review #342).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    The scanner is a READ-ONLY detector: it must be shown able to SEE each
    signature it claims to detect before its silence can mean anything, and it
    must never mistake an unreadable source for a clean machine (exit 2,
    INCOMPLETE). Every flag below is exercised against a fixture that carries
    exactly that signature, and every benign shape (0x800710E0 / 0x41301,
    sub-threshold spawn clusters, multi-trigger single launchers) is pinned so
    the scan does not cry wolf on a healthy host.

    Fixture mechanics (Pester 6 runs each It in a NEW script scope, measured
    here 2026-10-05 — twice): fixtures ride a GLOBAL reference bag read by the
    BeforeAll-defined mocks. Both a bare `$script:X = ...` inside an It AND a
    `$script:SharedBag.Prop = ...` write failed to reach the mocks — the It's
    script scope is isolated from the BeforeAll's, so the mock read a stale
    slot both times. Transcript roots are unique temp dirs removed in
    AfterEach — this machine's Pester 6.1 does NOT clean TestDrive between
    tests, and the previous test's files leaked into the next one's session
    count (first red run).
#>

BeforeAll {
    $script:ScanPath = Join-Path $PSScriptRoot '..\split-brain-scan.ps1'
    (Test-Path -LiteralPath $script:ScanPath) | Should -Be $true

    # Shared state bag — see header. Mocks read it at call time.
    $global:SBScanState = @{ Procs = @(); Tasks = @(); Results = @{}; Roots = @() }

    function New-ScanRoot {
        # Unique temp root per test (never TestDrive — no cross-test cleanup here)
        $dir = Join-Path $env:TEMP ("sb-scan-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory (Join-Path $dir 'projects') -Force | Out-Null
        $global:SBScanState.Roots += $dir
        return (Join-Path $dir 'projects')
    }

    function Invoke-Scan([string]$ProjectsRoot, [int]$ActiveMinutes = 30) {
        $out = & $script:ScanPath -ProjectsRoot $ProjectsRoot -ActiveMinutes $ActiveMinutes 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }

    function New-Proc([int]$procId, [int]$parentId, [string]$name, [datetime]$created, [string]$cmd = '') {
        if (-not $cmd) { $cmd = $name }
        [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $parentId; Name = $name; CreationDate = $created; CommandLine = $cmd }
    }

    function New-Action([string]$execute, [string]$arguments, [string]$workdir = '') {
        [pscustomobject]@{ Execute = $execute; Arguments = $arguments; WorkingDirectory = $workdir }
    }

    function New-Task([string]$name, [string]$path, [string]$state, [int]$triggerCount, [object[]]$actions, [uint32]$lastResult = 0) {
        $global:SBScanState.Results[($path + $name)] = $lastResult
        [pscustomobject]@{
            TaskName = $name; TaskPath = $path; State = $state
            Triggers = @(1..[Math]::Max(1, $triggerCount) | ForEach-Object { , @{} })
            Actions  = $actions
        }
    }

    # A healthy process tree reused by several tests: explorer(900) <- Code(901)
    # <- node children spread over minutes (no burst).
    function New-HealthyTree([datetime]$base) {
        @(
            (New-Proc 900 899 'explorer.exe' $base.AddHours(-6))
            (New-Proc 901 900 'Code.exe' $base.AddHours(-3))
            (New-Proc 1101 901 'node.exe' $base.AddMinutes(-60))
            (New-Proc 1102 901 'node.exe' $base.AddMinutes(-59))
            (New-Proc 1103 901 'node.exe' $base.AddMinutes(-58))
        )
    }

    Mock Get-CimInstance {
        # The scan must walk ONE unfiltered snapshot. A -Filter reaching this
        # mock is the per-process-query regression review #342 removed.
        if ($Filter) { throw 'REGRESSION: per-process Win32_Process query — the scan must use the single snapshot' }
        $global:SBScanState.Procs
    }
    Mock Get-ScheduledTask { $global:SBScanState.Tasks }
    Mock Get-ScheduledTaskInfo {
        param($TaskName, $TaskPath)
        [pscustomobject]@{ LastTaskResult = $global:SBScanState.Results[($TaskPath + $TaskName)] }
    }
}

Describe 'split-brain-scan' {

    BeforeEach {
        $global:SBScanState.Procs = @()
        $global:SBScanState.Tasks = @()
        $global:SBScanState.Results = @{}
    }

    AfterEach {
        foreach ($root in @($global:SBScanState.Roots)) {
            if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
        }
        $global:SBScanState.Roots = @()
    }

    Context 'sessions (transcripts)' {
        It 'lists a live session and exits 0 on a healthy host' {
            $root = New-ScanRoot
            New-Item -ItemType Directory (Join-Path $root 'proj-a'), (Join-Path $root 'proj-b') -Force | Out-Null
            Set-Content (Join-Path $root 'proj-a\sess-one.jsonl') 'x'
            Set-Content (Join-Path $root 'proj-b\sess-two.jsonl') 'x'
            foreach ($f in @('proj-a\sess-one.jsonl', 'proj-b\sess-two.jsonl')) {
                (Get-Item (Join-Path $root $f)).LastWriteTime = (Get-Date).AddMinutes(-5)
            }
            $global:SBScanState.Procs = New-HealthyTree (Get-Date)

            $r = Invoke-Scan $root
            $r.Out | Should -Match 'sess-one'
            $r.Out | Should -Match 'live sessions: 2\s+distinct ids: 2'
            # anti-vacuous: the process section must have SEEN its fixture
            # (3 of the tree's 5 processes are family: explorer/Code are filtered)
            $r.Out | Should -Match 'total: 3'
            $r.Out | Should -Match 'OK - none of the checked signatures'
            $r.Code | Should -Be 0
        }

        It 'flags DUPLICATE-SESSION: one id live in two transcript files, exit 1' {
            $root = New-ScanRoot
            New-Item -ItemType Directory (Join-Path $root 'proj-a'), (Join-Path $root 'proj-b') -Force | Out-Null
            Set-Content (Join-Path $root 'proj-a\same-id.jsonl') 'x'
            Set-Content (Join-Path $root 'proj-b\same-id.jsonl') 'x'
            foreach ($f in @('proj-a\same-id.jsonl', 'proj-b\same-id.jsonl')) {
                (Get-Item (Join-Path $root $f)).LastWriteTime = (Get-Date).AddMinutes(-5)
            }
            $r = Invoke-Scan $root
            $r.Out | Should -Match 'DUPLICATE-SESSION: session same-id is live in 2 transcript files: proj-a, proj-b'
            $r.Code | Should -Be 1
        }

        It 'ignores transcripts older than the window' {
            $root = New-ScanRoot
            New-Item -ItemType Directory (Join-Path $root 'proj-a') -Force | Out-Null
            Set-Content (Join-Path $root 'proj-a\stale.jsonl') 'x'
            (Get-Item (Join-Path $root 'proj-a\stale.jsonl')).LastWriteTime = (Get-Date).AddHours(-2)
            $r = Invoke-Scan $root
            $r.Out | Should -Match 'live sessions: 0\s+distinct ids: 0'
            $r.Out | Should -Not -Match 'DUPLICATE-SESSION'
            $r.Code | Should -Be 0
        }
    }

    Context 'process bursts (double-fire signature)' {
        It 'flags PROCESS-BURST on TWO identical commands in the window, arguments kept in the flag' {
            $base = (Get-Date).AddMinutes(-1)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $base.AddHours(-6) 'explorer')
                (New-Proc 901 900 'claude.exe' $base.AddSeconds(-60) 'claude.exe --resume sess-1 --print')
                (New-Proc 902 900 'claude.exe' $base.AddSeconds(-59.5) 'claude.exe --resume sess-1 --print')
            )
            $r = Invoke-Scan (New-ScanRoot)

            $r.Out | Should -Match 'PROCESS-BURST: 2 x identical claude\.exe command born within 3s'
            # ISO 8601 UTC (review #342): machine-local drift must not survive into the flag
            $r.Out | Should -Match 'PROCESS-BURST: .*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z'
            # arguments kept in output, as DIRECT does (review #342): the command
            # line IS the evidence a double-fire needs
            $r.Out | Should -Match ([regex]::Escape('claude.exe --resume sess-1 --print'))
            $r.Code | Should -Be 1
        }

        It 'does NOT flag a normal session start: 6 node.exe with DISTINCT commands in the window (ai-01 live shape, review #342)' {
            # Measured live 2026-10-05 21:06:27Z on ai-01: ONE Claude Code session
            # launching three MCP servers, launcher+server node.exe each — under the
            # OLD signature (same name, one root, threshold) this was a permanent
            # rc=1 alarm on a healthy machine. Distinct commands = no double-fire.
            $base = (Get-Date).AddMinutes(-1)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $base.AddHours(-6) 'explorer')
                (New-Proc 901 900 'Code.exe' $base.AddHours(-3) 'Code.exe')
                (New-Proc 1101 901 'node.exe' $base.AddSeconds(-60.0) 'node roo-state-manager\mcp-wrapper.cjs')
                (New-Proc 1102 901 'node.exe' $base.AddSeconds(-59.9) 'node roo-state-manager\build\index.js')
                (New-Proc 1103 901 'node.exe' $base.AddSeconds(-59.8) 'npx -y @playwright/mcp')
                (New-Proc 1104 901 'node.exe' $base.AddSeconds(-59.7) 'node @playwright\mcp\cli.js')
                (New-Proc 1105 901 'node.exe' $base.AddSeconds(-59.6) 'npx -y mcp-searxng')
                (New-Proc 1106 901 'node.exe' $base.AddSeconds(-59.5) 'node mcp-searxng\dist\index.js')
            )
            $r = Invoke-Scan (New-ScanRoot)
            # anti-vacuous: all 6 family processes must have been SEEN
            $r.Out | Should -Match 'total: 6'
            $r.Out | Should -Match 'machine-wide max co-births within 3s \(all roots\): 6'
            $r.Out | Should -Not -Match 'PROCESS-BURST'
            $r.Code | Should -Be 0
        }

        It 'flags two identical commands under DIFFERENT roots (double-fire needs no common ancestor)' {
            # review #342: grouping by root ancestor was the defect — a double-fire
            # landing under two different roots must flag just the same.
            $t = (Get-Date).AddMinutes(-2)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $t.AddHours(-6) 'explorer')
                (New-Proc 800 799 'svchost.exe' $t.AddHours(-6) 'svchost -k netsvcs')
                (New-Proc 1101 900 'claude.exe' $t 'claude.exe -p --resume same-uuid')
                (New-Proc 1102 800 'claude.exe' $t.AddSeconds(1.5) 'claude.exe -p --resume same-uuid')
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 2'   # anti-vacuous
            $r.Out | Should -Match 'PROCESS-BURST: 2 x identical claude\.exe'
            $r.Code | Should -Be 1
        }

        It 'does NOT flag two identical commands OUTSIDE the window' {
            $t = (Get-Date).AddMinutes(-2)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $t.AddHours(-6) 'explorer')
                (New-Proc 1101 900 'claude.exe' $t 'claude.exe -p --resume same-uuid')
                (New-Proc 1102 900 'claude.exe' $t.AddSeconds(7) 'claude.exe -p --resume same-uuid')
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 2'   # anti-vacuous
            $r.Out | Should -Not -Match 'PROCESS-BURST'
            $r.Code | Should -Be 0
        }

        It 'flags THREE identical commands as ONE burst, not three' {
            $t = (Get-Date).AddMinutes(-2)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $t.AddHours(-6) 'explorer')
                (New-Proc 1101 900 'claude.exe' $t 'claude.exe -p --resume triple')
                (New-Proc 1102 900 'claude.exe' $t.AddSeconds(1) 'claude.exe -p --resume triple')
                (New-Proc 1103 900 'claude.exe' $t.AddSeconds(2) 'claude.exe -p --resume triple')
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 3'   # anti-vacuous
            $r.Out | Should -Match 'PROCESS-BURST: 3 x identical claude\.exe'
            ([regex]::Matches($r.Out, 'PROCESS-BURST')).Count | Should -Be 1
            $r.Code | Should -Be 1
        }

        It 'does NOT flag a routine VS Code load (3 children in 1s, distinct commands)' {
            $t = (Get-Date).AddSeconds(-30)
            $global:SBScanState.Procs = @(
                (New-Proc 900 899 'explorer.exe' $t.AddHours(-6) 'explorer')
                (New-Proc 901 900 'Code.exe' $t.AddHours(-3) 'Code.exe')
                (New-Proc 1101 901 'node.exe' $t 'node extension-host\main.js')
                (New-Proc 1102 901 'node.exe' $t.AddMilliseconds(200) 'node utility\search.js')
                (New-Proc 1103 901 'node.exe' $t.AddMilliseconds(400) 'node watcher.js')
            )
            $r = Invoke-Scan (New-ScanRoot)
            # anti-vacuous: the fixture must have been visible at all
            $r.Out | Should -Match 'total: 3'
            $r.Out | Should -Not -Match 'PROCESS-BURST'
            $r.Out | Should -Match 'machine-wide max co-births within 3s \(all roots\): 3'
            $r.Code | Should -Be 0
        }

        It 'names the topmost reachable ancestor when the parent is gone from the snapshot' {
            $t = (Get-Date).AddMinutes(-5)
            $global:SBScanState.Procs = @(
                (New-Proc 500 499 'node.exe' $t)   # parent 499 absent: gone or protected
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 1'      # anti-vacuous
            $r.Out | Should -Match 'node\.exe\(500\)'
            $r.Code | Should -Be 0
        }

        It 'terminates on a parent cycle instead of looping' {
            $t = (Get-Date).AddMinutes(-5)
            $global:SBScanState.Procs = @(
                # distinct commands: the pin exercises the CYCLE, not the burst —
                # the double-fire signature would (correctly) flag two identical
                # bare command lines
                (New-Proc 1 2 'node.exe' $t 'node loop-a.js')
                (New-Proc 2 1 'node.exe' $t 'node loop-b.js')
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 2'      # anti-vacuous
            $r.Out | Should -Match '\(cycle:'
            $r.Code | Should -Be 0
        }

        It 'uses ONE unfiltered Win32_Process snapshot (no per-process queries)' {
            # The Get-CimInstance mock throws on any -Filter call; a regression
            # to per-process parent lookups surfaces as a failed invocation.
            $global:SBScanState.Procs = New-HealthyTree (Get-Date)
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'total: 3'      # anti-vacuous: snapshot really read (family-filtered)
            $r.Out | Should -Not -Match 'per-process Win32_Process query'
            $r.Code | Should -Be 0
        }
    }

    Context 'scheduled task launchers' {
        It 'flags DUPLICATE-TASK: two tasks sharing one action target' {
            $global:SBScanState.Tasks = @(
                (New-Task 'launcher-a' '\Claudish\' 'Ready' 1 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')))
                (New-Task 'launcher-b' '\Claudish\' 'Ready' 1 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')))
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'launcher-shaped actions visible: 2'   # anti-vacuous
            $r.Out | Should -Match 'DUPLICATE-TASK: 2 actions share one target'
            $r.Out | Should -Match 'launcher-a \| .*launcher-b'   # names carry their full \Claudish\ path
            $r.Code | Should -Be 1
        }

        It 'does NOT count triggers as duplicates (one task, three triggers, one action)' {
            $global:SBScanState.Tasks = @(
                (New-Task 'multi-trigger' '\Claudish\' 'Ready' 3 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')))
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'launcher-shaped actions visible: 1'   # anti-vacuous
            $r.Out | Should -Not -Match 'DUPLICATE-TASK'
            $r.Code | Should -Be 0
        }

        It 'flags DIRECT-CLAUDE-TASK hidden as action #2 (every action inspected) and never echoes arguments' {
            $global:SBScanState.Tasks = @(
                (New-Task 'innocent-first' '\Claudish\' 'Ready' 1 @(
                    (New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"'),
                    (New-Action 'C:\Users\jsboi\.local\bin\claude.exe' '-p --model opus --api-key SECRETARG')
                ))
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'launcher-shaped actions visible: 2'   # both actions inspected
            $r.Out | Should -Match ('DIRECT-CLAUDE-TASK: ' + [regex]::Escape('\Claudish\innocent-first') + ' launches the claude binary')
            $r.Out | Should -Match ([regex]::Escape('C:\Users\jsboi\.local\bin\claude.exe'))
            # credential-echo guard (review #342, the #192 healthcheck class):
            # the executable path identifies the repointing; arguments never print
            $r.Out | Should -Not -Match 'SECRETARG'
            $r.Code | Should -Be 1
        }

        It 'interprets 0x800710E0 (IgnoreNew refusal) and 0x41301 (still running) as benign' {
            $global:SBScanState.Tasks = @(
                (New-Task 'collector' '\Claudish\' 'Running' 1 @((New-Action 'wscript.exe' '"D:\ops\compress-captures.vbs"')) 2147946720)
                (New-Task 'longtick' '\Claudish\' 'Running' 1 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')) 267009)
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'launcher-shaped actions visible: 2'   # anti-vacuous
            $r.Out | Should -Not -Match 'TASK-NONZERO-RESULT'
            $r.Code | Should -Be 0
        }

        It 'flags a FAILING LastTaskResult even outside State=Running (ghost cron dying every tick)' {
            $global:SBScanState.Tasks = @(
                (New-Task 'zombie-tick' '\Claudish\' 'Ready' 1 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')) 1)
            )
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match ('TASK-NONZERO-RESULT: ' + [regex]::Escape('\Claudish\zombie-tick') + ' State=Ready LastTaskResult=1 \(0x00000001\)')
            $r.Code | Should -Be 1
        }
    }

    Context 'INCOMPLETE verdict (exit 2) — an unread source is a non-verdict' {
        It 'exit 2 when ProjectsRoot does not exist' {
            $global:SBScanState.Procs = New-HealthyTree (Get-Date)
            $r = Invoke-Scan (Join-Path (New-ScanRoot) 'no-such-root')
            $r.Out | Should -Match 'INCOMPLETE SOURCE\s+transcripts \(no ProjectsRoot'
            $r.Code | Should -Be 2
        }

        It 'exit 2 when the Win32_Process query fails' {
            Mock Get-CimInstance { throw 'rpc server unavailable' }
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'Win32_Process query failed'
            $r.Out | Should -Match 'INCOMPLETE SOURCE\s+Win32_Process'
            $r.Code | Should -Be 2
        }

        It 'exit 2 when Get-ScheduledTask fails' {
            Mock Get-ScheduledTask { throw 'access denied' }
            $global:SBScanState.Procs = New-HealthyTree (Get-Date)
            $r = Invoke-Scan (New-ScanRoot)
            $r.Out | Should -Match 'Get-ScheduledTask failed'
            $r.Out | Should -Match 'INCOMPLETE SOURCE\s+Get-ScheduledTask'
            $r.Code | Should -Be 2
        }

        It 'exit 2 outranks exit 1: flags still print, but blindness is the verdict' {
            # absent root (incomplete) + a failing launcher task (flag)
            $global:SBScanState.Tasks = @(
                (New-Task 'zombie-tick' '\Claudish\' 'Ready' 1 @((New-Action 'wscript.exe' '"D:\ops\claude-hidden-launchers.vbs"')) 1)
            )
            $r = Invoke-Scan (Join-Path (New-ScanRoot) 'no-such-root')
            $r.Out | Should -Match 'TASK-NONZERO-RESULT'
            $r.Out | Should -Match 'INCOMPLETE SOURCE'
            $r.Code | Should -Be 2
        }
    }
}

Describe 'the scanner contains no actuator' {
    # Same shape and reasoning as the docker-events collector's guard (#192):
    # detecting is not acting. A scanner that "helpfully" kills the ghost it
    # finds is the #173 teardown-without-rebuild shape.
    BeforeAll {
        function Get-ActuatorOffenders([System.Management.Automation.Language.Ast]$Ast) {
            $offenders = @()
            foreach ($n in $Ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                $name = $n.GetCommandName()
                if ($name -match '^(Restart|Stop|Start|Remove|Register|Unregister|Set|Suspend|Disable)-') {
                    $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name)
                }
                if ($n.Extent.Text -match 'docker\s+(stop|restart|kill|rm)\b') { $offenders += ('{0}: docker stop/restart/kill/rm' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '\btaskkill\b') { $offenders += ('{0}: taskkill' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match 'schtasks\s+/(change|create|delete|end|run)') { $offenders += ('{0}: schtasks actuator' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '-Verb\s+RunAs') { $offenders += ('{0}: -Verb RunAs' -f $n.Extent.StartLineNumber) }
            }
            return $offenders
        }
    }

    It 'no Restart-*/Stop-*/Remove-* cmdlet, no docker/taskkill/schtasks actuator, no -Verb RunAs' {
        $path = Join-Path $PSScriptRoot '..\split-brain-scan.ps1'
        (Test-Path -LiteralPath $path) | Should -Be $true
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
        $errs.Count | Should -Be 0
        $offenders = Get-ActuatorOffenders $ast
        $offenders | Should -BeNullOrEmpty
    }

    It 'the actuator detector actually detects (positive control)' {
        $bad = @'
Restart-Service claudish
Stop-Process -Id 1234
Start-Process powershell -Verb RunAs
Remove-Item D:\claudish-captures -Recurse
Register-ScheduledTask evil
docker restart claudish-proxy
docker stop claudish-proxy
taskkill /pid 500
schtasks /change /tn X /ru SYSTEM
'@
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $offenders = @(Get-ActuatorOffenders $ast)
        # one per offending line: Restart-Service, Stop-Process, Start-Process
        # (x2: cmdlet + RunAs), Remove-Item, Register-ScheduledTask,
        # docker restart, docker stop, taskkill, schtasks
        $offenders.Count | Should -BeGreaterOrEqual 9
        ($offenders -match 'Restart-Service').Count | Should -Be 1
        ($offenders -match 'taskkill').Count | Should -Be 1
        ($offenders -match 'schtasks actuator').Count | Should -Be 1
    }
}
