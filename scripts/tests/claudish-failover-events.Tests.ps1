<#
    Pester 5/6 suite for the failover-events collector (jsboige/claudish#347).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    The hub's [Failover] markers (ARMED / DISARMED / walled / DWELL / CLOSED)
    die with the next recreate — docker log and process memory both. The
    collector persists them; these pins prove it can SEE them before its
    silence can mean anything, and prove the two properties that make the file
    trustworthy:

      - ALLOWLIST (the #192 lesson, applied BEFORE an incident this time): a
        docker-logs window contains request lines, body previews and
        Authorization-looking strings — none of it may ever reach the file;
      - WATERMARK HELD on a failed invocation (AC3): a collector that advances
        over a window it did not read silently writes off the unread range.

    The allowlist and watermark logic live as pure functions in
    scripts/lib/claudish-engine.psm1; the glue (docker call, state file,
    rotation) is failover-events-collect.ps1, guarded below by an AST walk
    with a positive control — collecting is not acting (#173).
#>

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Real shapes. The [Failover] lines are the hub's own markers (CLAUDE.md
    # failover section spells them); the nano timestamps are what
    # `docker logs --timestamps` prefixes.
    $script:FailoverArmed = '2026-10-05T19:20:31.123456789Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min'
    $script:FailoverDwell = '2026-10-05T19:21:02.987654321Z [Failover] DWELL sonnet session 8f2c…9a yielded — nominal recovered 74s ago'
    $script:RequestLine   = '2026-10-05T19:20:32.000000000Z [Request] pid=1 reqN=4188 model=glm-5.3 msgs=12 bytes=45678 ttft=812ms'
    $script:BodyPreview   = '2026-10-05T19:20:33.000000000Z [msg:0] "…user asks about D:\dev\claudish routing…"'
    $script:AuthLooking   = '2026-10-05T19:20:34.000000000Z authorization: Bearer sk-ant-api03-EXAMPLENOTAREALKEY0000000000000000'
    $script:DockerOwnErr  = 'Error response from daemon: No such container: claudish-proxy'
}

Describe 'ConvertFrom-DockerLogLine' {
    It 'splits a real --timestamps line into instant + text' {
        $e = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $e.Ts | Should -Be '2026-10-05T19:20:31.123456789Z'
        $e.Rest | Should -Be '[Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min'
    }

    It 'accepts second-resolution instants too (docker renders both)' {
        $e = ConvertFrom-DockerLogLine -Line '2026-10-05T19:20:31Z hello'
        $e.Ts | Should -Be '2026-10-05T19:20:31Z'
        $e.Rest | Should -Be 'hello'
    }

    It 'yields $null for docker-owned noise and blanks — never a sink candidate' {
        foreach ($bad in @($script:DockerOwnErr, '', '   ', 'no prefix at all')) {
            ConvertFrom-DockerLogLine -Line $bad | Should -BeNullOrEmpty
        }
    }
}

Describe 'Select-FailoverLines (allowlist sink guard)' {
    It 'keeps ONLY the [Failover] lines from a mixed window — the #192 property' {
        $mixed = @(
            (ConvertFrom-DockerLogLine -Line $script:FailoverArmed)
            (ConvertFrom-DockerLogLine -Line $script:RequestLine)
            (ConvertFrom-DockerLogLine -Line $script:BodyPreview)
            (ConvertFrom-DockerLogLine -Line $script:AuthLooking)
            (ConvertFrom-DockerLogLine -Line $script:FailoverDwell)
        )
        $sel = Select-FailoverLines -Events $mixed
        @($sel.Kept).Count | Should -Be 2
        $sel.Dropped | Should -Be 3
        # positive control: what is kept really is the marker pair, ts intact
        @($sel.Kept)[0].Ts | Should -Be '2026-10-05T19:20:31.123456789Z'
        (@($sel.Kept)[1].Rest -match '\[Failover\] DWELL') | Should -Be $true
    }

    It 'an Authorization-looking string NEVER reaches the kept set' {
        $sel = Select-FailoverLines -Events @((ConvertFrom-DockerLogLine -Line $script:AuthLooking))
        @($sel.Kept).Count | Should -Be 0
        $sel.Dropped | Should -Be 1
    }

    It 'a body preview mentioning [Failover] in QUOTED prose is kept only if the marker is in the line text itself — the allowlist is a token, not semantics' {
        # Documented edge: the token test is textual by design. A prose echo
        # that literally contains "[Failover]" would be kept — the marker is
        # greppable in conversation text. That is accepted and counted here,
        # because the alternative (semantic filtering) cannot be a pure
        # function; the Dropped counter keeps the ratio visible in the state.
        $echo = '2026-10-05T19:22:00.000000000Z [msg:3] "as the rule says, a [Failover] ARMED line names its bucket"'
        $sel = Select-FailoverLines -Events @((ConvertFrom-DockerLogLine -Line $echo))
        @($sel.Kept).Count | Should -Be 1
    }
}

Describe 'Select-NewFailoverLines (window-boundary dedup)' {
    It 'drops a line already seen in a previous overlapping window' {
        $a = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $first = Select-NewFailoverLines -Events @($a) -Seen @() -SeenCap 10
        @($first.Kept).Count | Should -Be 1
        # the SAME (ts, line) re-requested next window: skipped, not doubled
        $second = Select-NewFailoverLines -Events @($a) -Seen @($first.Seen) -SeenCap 10
        @($second.Kept).Count | Should -Be 0
        @($second.Skipped).Count | Should -Be 1
    }

    It 'keeps a DIFFERENT line at the same instant (fingerprint is ts AND line)' {
        $a = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $b = ConvertFrom-DockerLogLine -Line $script:FailoverDwell
        $r = Select-NewFailoverLines -Events @($a, $b) -Seen @() -SeenCap 10
        @($r.Kept).Count | Should -Be 2
    }

    It 'bounds the fingerprint ring it carries forward' {
        $events = @()
        for ($i = 0; $i -lt 12; $i++) {
            # 19:30:00..19:41:00 — VALID HH:MM:SS; a malformed instant parses
            # to $null and the binding would throw (the glue filters nulls).
            $events += ConvertFrom-DockerLogLine -Line ("2026-10-05T19:{0:d2}:00.000000000Z [Failover] DISARMED bucket glm-coding -> probing nominals, tick {1}" -f (30 + $i), $i)
        }
        $r = Select-NewFailoverLines -Events $events -Seen @() -SeenCap 5
        @($r.Seen).Count | Should -Be 5
        # and the newest fingerprints are the ones kept
        @($r.Seen)[-1] | Should -Match 'tick 11'
    }
}

Describe 'Get-FailoverNextSince (watermark)' {
    It 'a successful window advances to the WINDOW START, not a later instant' {
        # Regression for the live hole of 05/10: the watermark is the instant
        # the window was OPENED (before the docker call), because the call
        # snapshots the log at that moment but only RETURNS seconds later. A
        # return-instant watermark excludes every line written in between —
        # absent from this snapshot, earlier than the watermark: read by
        # neither window, ever (measured: 22 markers lost at 15:57:18-25Z).
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:30:00.000Z'
        $w.Reason | Should -Be 'window-start'
    }

    It 'AC3: a FAILED invocation HOLDS the watermark — the window stays unread' {
        $w = Get-FailoverNextSince -InvocationOk $false -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-not-measured'
    }

    It 'never moves backwards (clock skew between host and state writer)' {
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:10:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-never-backwards'
    }

    It 'a success with no window start holds (defensive)' {
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-no-window-start'
    }
}

Describe 'the collector contains no actuator' {
    # Same shape and reasoning as the docker-events guard (#192): collecting
    # is not acting (#173). Note: Remove-Item is deliberately NOT in the
    # forbidden set — rotation deletes the collector's OWN rotated files
    # (failover-events-*.log), filtered by name; that is housekeeping of its
    # own outputs, not an actuator.

    # Pester 6: a function defined in the Describe BODY dies at discovery
    # (each It runs in a new script scope) — define it in BeforeAll.
    BeforeAll {
        function Get-ActuatorOffenders([System.Management.Automation.Language.Ast]$Ast) {
            $offenders = @()
            foreach ($n in $Ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                $name = $n.GetCommandName()
                if ($name -match '^(Restart|Stop|Start|Register|Unregister|Set|Suspend|Disable)-') {
                    $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name)
                }
                if ($n.Extent.Text -match 'docker\s+(stop|restart|kill|rm|compose)\b') { $offenders += ('{0}: docker stop/restart/kill/rm/compose' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '\btaskkill\b') { $offenders += ('{0}: taskkill' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match 'schtasks\s+/(change|create|delete|end|run)') { $offenders += ('{0}: schtasks actuator' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '-Verb\s+RunAs') { $offenders += ('{0}: -Verb RunAs' -f $n.Extent.StartLineNumber) }
            }
            return $offenders
        }
    }

    It 'no Restart-*/Stop-*/Start-* cmdlet, no docker actuator, no -Verb RunAs' {
        $path = Join-Path $script:ScriptsRoot 'failover-events-collect.ps1'
        (Test-Path -LiteralPath $path) | Should -Be $true
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
        $errs.Count | Should -Be 0
        $offenders = Get-ActuatorOffenders $ast
        $offenders | Should -BeNullOrEmpty
    }

    It 'AC8: the collector parses under 5.1 — no ?? / ?. / ternary (a production-only parse failure)' {
        # The scheduled task runs Windows PowerShell 5.1, which cannot parse
        # `??`, `?.` or a ternary — under 5.1 the ParseFile above already fails
        # (errs.Count), but under pwsh 7 those forms parse fine and the guard
        # would be a green line. So scan the TOKENS here too: it bites in both
        # interpreter runs, which is what makes it a guard and not a decoration.
        $path = Join-Path $script:ScriptsRoot 'failover-events-collect.ps1'
        $tokens = $null; $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs) | Out-Null
        $errs.Count | Should -Be 0
        $bad = @($tokens | Where-Object {
                $_.Kind -in @('QuestionQuestion', 'QuestionDot') -or
                ($_.Kind -eq 'Question' -and $_.Text -eq '?')
            })
        $bad | Should -BeNullOrEmpty
    }

    It 'the actuator detector actually detects (positive control)' {
        $bad = @'
Restart-Service claudish
Stop-Process -Id 1
Start-Process powershell -Verb RunAs
Register-ScheduledTask evil
docker restart claudish-proxy
docker compose up -d
docker rm claudish-proxy
taskkill /pid 7
schtasks /run /tn X
'@
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $offenders = @(Get-ActuatorOffenders $ast)
        $offenders.Count | Should -BeGreaterOrEqual 9
        ($offenders -match 'docker stop/restart/kill/rm/compose').Count | Should -Be 3
        ($offenders -match 'schtasks actuator').Count | Should -Be 1
        ($offenders -match '-Verb RunAs').Count | Should -Be 1
    }
}
