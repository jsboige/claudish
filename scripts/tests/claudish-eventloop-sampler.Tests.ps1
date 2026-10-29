<#
    Pester 5/6 suite for the event-loop sampler (jsboige/claudish#739 item b).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    The sampler exists because the probe's numbers can only CONFIRM a gap when
    read once per cycle: `eventLoopMaxMs` is a high-water mark pinned forever by
    one GC pause, and `eventLoopMax60sMs` retires before anyone looks. These pins
    prove the three properties that make the written series usable:

      - MISSING IS NOT ZERO: a field the proxy did not publish is recorded as
        null, never 0 — 0 reads as "perfectly healthy" and would silence the
        exact episode the series exists to date;
      - A FAILED PROBE IS A RECORD, not a skipped tick: otherwise an empty
        series cannot distinguish a calm proxy from a dead sampler;
      - NO BOM: a BOM in front of the first `{` makes the first line
        unparseable (the failover collector's state-file defect, measured).

    The script's own pure functions are exercised through its -LibraryOnly seam;
    the tick glue is guarded below by an AST walk with a positive control —
    collecting is not acting (#173).
#>

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\eventloop-sampler.ps1')).Path
    . $script:ScriptPath -LibraryOnly
}

Describe 'ConvertTo-LagSample — shaping' {
    BeforeAll {
        $script:Health = [pscustomobject]@{
            status                 = 'ok'
            role                   = 'hub'
            instanceId             = 'a4f70b6c-ee45-44da-a330-55057c08076b'
            uptimeSec              = 25102
            activeStreams          = 6
            eventLoopMax60sMs      = 57.44
            eventLoopBlockedMs5m   = 823.61
            eventLoopMaxMs         = 3830.1
            proxyKeyPreviousHits   = @{ ZooCode = 93 }
            admissionFreeze        = 'no-consent'
        }
        $script:At = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:05:00'), [System.DateTimeKind]::Utc)
    }

    It 'carries the lag fields, rounded to 0.1 ms' {
        $s = ConvertTo-LagSample -Health $script:Health -AtUtc $script:At
        $s.probe | Should -Be 'ok'
        $s.max60sMs | Should -Be 57.4
        $s.blocked5mMs | Should -Be 823.6
        $s.maxCumulativeMs | Should -Be 3830.1
        $s.instanceId | Should -Be 'a4f70b6c-ee45-44da-a330-55057c08076b'
        $s.ts | Should -Be '2026-10-29T13:05:00.000Z'
    }

    It 'drops fields that are not part of the series (allowlist, not a copy)' {
        $s = ConvertTo-LagSample -Health $script:Health -AtUtc $script:At
        ($s.PSObject.Properties.Name -contains 'proxyKeyPreviousHits') | Should -BeFalse
        ($s.PSObject.Properties.Name -contains 'admissionFreeze') | Should -BeFalse
    }

    It 'records an unpublished numeric field as null, NEVER 0' {
        $h = [pscustomobject]@{ status = 'ok'; instanceId = 'x'; uptimeSec = 10 }
        $s = ConvertTo-LagSample -Health $h -AtUtc $script:At
        $null -eq $s.max60sMs | Should -BeTrue
        $null -eq $s.blocked5mMs | Should -BeTrue
        $null -eq $s.maxCumulativeMs | Should -BeTrue
        # ...while the published one still lands.
        $s.uptimeSec | Should -Be 10
    }

    It 'honours a non-US locale on the numbers (no culture round-trip)' {
        # Number parsing is InvariantCulture: a comma-decimal seat must not turn
        # 57.4 into 574.
        $h = [pscustomobject]@{ status = 'ok'; eventLoopMax60sMs = '57.4' }
        $s = ConvertTo-LagSample -Health $h -AtUtc $script:At
        $s.max60sMs | Should -Be 57.4
    }
}

Describe 'ConvertTo-LagSample — probe failure' {
    It 'records a fail line instead of throwing (the path that must never throw)' {
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:06:00'), [System.DateTimeKind]::Utc)
        $s = ConvertTo-LagSample -Health $null -AtUtc $at -ErrorText 'WebException: timed out'
        $s.probe | Should -Be 'fail'
        $s.error | Should -Be 'WebException: timed out'
        $s.ts | Should -Be '2026-10-29T13:06:00.000Z'
    }

    It 'names the failure even with no error text' {
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:07:00'), [System.DateTimeKind]::Utc)
        (ConvertTo-LagSample -Health $null -AtUtc $at).error | Should -Be 'unreachable'
    }
}

Describe 'Rotation' {
    BeforeAll {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("el-rot-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:Root -Force | Out-Null
        $script:Log = Join-Path $script:Root 'eventloop-blocked.log'
    }
    AfterAll {
        if (Test-Path -LiteralPath $script:Root) { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'is due exactly at the limit' {
        Test-RotationDue -CurrentBytes 10 -LimitBytes 10 | Should -BeTrue
        Test-RotationDue -CurrentBytes 9 -LimitBytes 10 | Should -BeFalse
    }

    It 'writes no BOM on file creation' {
        Add-SamplerLine -Path $script:Log -Line '{"a":1}' -MaxLogBytes 100000 -KeepRotated 2
        $bytes = [System.IO.File]::ReadAllBytes($script:Log)
        $bytes[0] | Should -Be ([byte][char]'{')
        $bytes[1] | Should -Be ([byte][char]'"')
    }

    It 'rotates over the limit and keeps at most KeepRotated files' {
        $log = Join-Path $script:Root 'rot.log'
        # The limit is deliberately SMALLER than one line ('{"n":0}' + CRLF = 9 B)
        # so the file is always over the limit at the next write and every write
        # rotates: the retained counts are then exact, not a function of how many
        # 9-byte lines happen to fit under the threshold.
        for ($i = 0; $i -lt 6; $i++) {
            Add-SamplerLine -Path $log -Line ('{"n":' + $i + '}') -MaxLogBytes 5 -KeepRotated 2
        }
        (Get-Content -LiteralPath $log).Count | Should -Be 1
        (Get-Content -LiteralPath "$log.1").Count | Should -Be 1
        (Get-Content -LiteralPath "$log.2").Count | Should -Be 1
        (Test-Path -LiteralPath "$log.3") | Should -BeFalse
    }
}

Describe 'Get-HealthPayload — real HTTP (the #760 CR defects, exercised on the wire)' {
    <#
      Two listeners, a refused port and a malformed body — the four wire states
      the probe actually meets. HttpListener on 127.0.0.1 needs no elevation;
      each mode runs in its own job so the suite never depends on the proxy.
    #>
    BeforeAll {
        function New-MockHealthServer {
            param([ValidateSet('ok', 'stalled', 'garbage')] [string]$Mode)
            foreach ($try in 1..3) {
                $port = Get-Random -Minimum 22000 -Maximum 39000
                $job = Start-Job -ScriptBlock {
                    param($Port, $Mode)
                    $l = [System.Net.HttpListener]::new()
                    $l.Prefixes.Add("http://127.0.0.1:$Port/")
                    try { $l.Start() } catch { return }
                    # Serve EXACTLY ONE request, then exit: each It makes a single
                    # probe, and a job left waiting in GetContext() for a second
                    # request never returns — Remove-Job -Force then hangs the
                    # suite at teardown (measured: the first pwsh 7 run never
                    # reached the SUMMARY line). ONE BeginGetContext, armed once:
                    # arming a second while the first is pending makes the
                    # listener never accept anything (measured — the whole suite
                    # timed out at the probe), so the deadline is enforced on the
                    # SAME handle instead of re-arming.
                    $t = $l.BeginGetContext($null, $null)
                    $ctx = $null
                    $deadline = [DateTime]::UtcNow.AddSeconds(15)
                    while ($null -eq $ctx -and [DateTime]::UtcNow -lt $deadline) {
                        if ($t.AsyncWaitHandle.WaitOne(1000)) { $ctx = $l.EndGetContext($t) }
                    }
                    if ($null -eq $ctx) { $l.Stop(); return }
                    if ($Mode -eq 'ok') {
                        $code = 200
                        $body = '{"status":"ok","role":"hub","instanceId":"11111111-aaaa","uptimeSec":10,"activeStreams":2,"eventLoopMax60sMs":42.5,"eventLoopBlockedMs5m":100.0,"eventLoopMaxMs":300.0}'
                    } elseif ($Mode -eq 'stalled') {
                        $code = 503
                        $body = '{"status":"stalled","role":"hub","instanceId":"11111111-aaaa","uptimeSec":10,"activeStreams":2,"eventLoopMax60sMs":1900.7,"eventLoopBlockedMs5m":8800.2,"eventLoopMaxMs":2100.0}'
                    } else {
                        $code = 503
                        $body = '<html>unavailable</html>'
                    }
                    $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
                    $ctx.Response.StatusCode = $code
                    $ctx.Response.ContentType = 'application/json'
                    $ctx.Response.ContentLength64 = $buf.Length
                    $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
                    $ctx.Response.Close()
                    $l.Stop()
                } -ArgumentList $port, $Mode
                Start-Sleep -Milliseconds 700
                if ($job.State -eq 'Running') { return @{ Url = "http://127.0.0.1:$port/health"; Job = $job } }
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
            }
            return $null
        }
        $script:SrvOk = New-MockHealthServer -Mode 'ok'
        $script:SrvStalled = New-MockHealthServer -Mode 'stalled'
        $script:SrvGarbage = New-MockHealthServer -Mode 'garbage'
        # A port that is CLOSED: bind, read the port, release.
        $tl = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $tl.Start()
        $script:DeadPort = ($tl.LocalEndpoint).Port
        $tl.Stop()
    }
    AfterAll {
        foreach ($s in @($script:SrvOk, $script:SrvStalled, $script:SrvGarbage)) {
            if ($s) { Remove-Job -Job $s.Job -Force -ErrorAction SilentlyContinue }
        }
    }

    It '200: parses the body and carries the status' {
        $p = Get-HealthPayload -Url $script:SrvOk.Url -TimeoutSec 5
        $p.Http | Should -Be 200
        $p.Health.status | Should -Be 'ok'
        $p.Health.instanceId | Should -Be '11111111-aaaa'
        $p.Error | Should -Be ''
    }

    It '503 WITH a JSON body: the body SURVIVES the throw (CR defect 1) — the stall tick is a sample, not an error' {
        $p = Get-HealthPayload -Url $script:SrvStalled.Url -TimeoutSec 5
        $p.Http | Should -Be 503
        $p.Health | Should -Not -BeNullOrEmpty
        $p.Health.status | Should -Be 'stalled'
        $p.Health.eventLoopMax60sMs | Should -Be 1900.7
        $p.Error | Should -Be ''
        # And the sample it produces is an ok line that SAYS it came from a 503.
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:10:00'), [System.DateTimeKind]::Utc)
        $s = ConvertTo-LagSample -Health $p.Health -AtUtc $at -Http ([int]$p.Http)
        $s.probe | Should -Be 'ok'
        $s.status | Should -Be 'stalled'
        $s.http | Should -Be 503
        $s.max60sMs | Should -Be 1900.7
    }

    It '503 with an unparseable body: fail line that still names the 503' {
        $p = Get-HealthPayload -Url $script:SrvGarbage.Url -TimeoutSec 5
        $p.Http | Should -Be 503
        $p.Health | Should -BeNullOrEmpty
        $p.Error | Should -Not -BeNullOrEmpty
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:11:00'), [System.DateTimeKind]::Utc)
        $s = ConvertTo-LagSample -Health $null -AtUtc $at -ErrorText $p.Error -Http ([int]$p.Http)
        $s.probe | Should -Be 'fail'
        $s.http | Should -Be 503
    }

    It 'refused connection: no Http, no Health, an error that names the exception type' {
        $p = Get-HealthPayload -Url "http://127.0.0.1:$($script:DeadPort)/health" -TimeoutSec 5
        $p.Http | Should -BeNullOrEmpty
        $p.Health | Should -BeNullOrEmpty
        $p.Error | Should -Not -BeNullOrEmpty
    }
}

Describe 'ConvertTo-LagSample — http field' {
    It 'omits http (null) when no response status is known' {
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:12:00'), [System.DateTimeKind]::Utc)
        $h = [pscustomobject]@{ status = 'ok'; instanceId = 'x' }
        $s = ConvertTo-LagSample -Health $h -AtUtc $at
        $null -eq $s.http | Should -BeTrue
    }

    It 'keeps http on a fail line (a 503 without a body is still a 503)' {
        $at = [datetime]::SpecifyKind([datetime]::Parse('2026-10-29T13:13:00'), [System.DateTimeKind]::Utc)
        $s = ConvertTo-LagSample -Health $null -AtUtc $at -ErrorText 'WebException: x' -Http 503
        $s.probe | Should -Be 'fail'
        $s.http | Should -Be 503
    }
}

Describe 'No actuator (#173)' {
    It 'contains no restart/stop/docker verb' {
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:ScriptPath, [ref]$null, [ref]$null)
        $verbs = $ast.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -match '^(Restart|Stop|Start)-|^docker$|^schtasks$|^Remove-Item$'
            }, $true)
        $verbs.Count | Should -Be 0
    }

    It 'positive control — the same walk DOES see a docker command' {
        $ast = [System.Management.Automation.Language.Parser]::ParseInput('docker restart claudish-proxy', [ref]$null, [ref]$null)
        $hits = $ast.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -match '^(Restart|Stop|Start)-|^docker$|^schtasks$|^Remove-Item$'
            }, $true)
        $hits.Count | Should -BeGreaterThan 0
    }
}
