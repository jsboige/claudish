<#
    Pester 5 suite for claudish-drain.ps1 (#233).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    2026-09-23, hub: a `docker compose up` that failed or was interrupted left
    the old container STOPPED with no rename/start ever issued — two gaps
    (16 min + 11 min), fleet-wide AUTONOMOUS episodes, recovery by watchdog
    or by hand. The wrapper returned $false having stopped the hub itself.
    #233 adds: rollback start on compose failure (AC1), a leftover-twin
    preflight refuse (AC2), a terminal OUTCOME line on every exit plus
    PREVIOUS RUN INTERRUPTED detection (AC3).

    HOW THE DOCKER SHIM WORKS
    -------------------------
    A throwaway docker.cmd is prepended to PATH for the lifetime of this
    suite. Every invocation appends its arguments to docker-calls.log — that
    log IS the assertion surface for "zero stop calls" (a stop happens inside
    `compose`, so asserting no compose invocation asserts nothing was
    stopped). Responses are driven by fixture files in the shim dir:
      ps_out.txt        lines "name state" returned by `docker ps -a` (SPACE
                        separator: PowerShell does not quote a "|" argument
                        handed to a .cmd shim, and cmd re-parses it as a
                        pipe operator — the script's --format avoids "|" for
                        exactly that reason)
      inspect_out.txt   returned by every `docker inspect` (armed-env guard,
                        rollback State.Running probe — the tests choose values
                        that keep the two uses consistent)
      compose_exit.txt  exit code for `docker compose` (absent = 0)
      rm_exit.txt       exit code for `docker rm` (absent = 0)
    Like docker.exe, `start`, `rm` and `restart` echo the container name on
    stdout when they succeed. The first version of this shim stayed silent,
    and so could not see that an uncaptured `docker rm` put the twin's name
    into the function's return value: a failed deploy came back as
    @('<twin>', $false), which is truthy.
    The batch file uses labels instead of parenthesized blocks: `exit /b %CE%`
    inside an `if (...)` block would expand %CE% BEFORE `set /p` runs (classic
    delayed-expansion trap).
#>

BeforeAll {
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:DrainScript = Join-Path $script:ScriptsRoot 'claudish-drain.ps1'

    $script:TestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claudish-drain-tests-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:TestDir -Force | Out-Null
    $script:ShimDir = Join-Path $script:TestDir 'shim'
    New-Item -ItemType Directory -Path $script:ShimDir -Force | Out-Null
    $script:TestLog = Join-Path $script:TestDir 'drain.log'
    $script:CallsLog = Join-Path $script:TestDir 'docker-calls.log'
    $script:EnvFile = Join-Path $script:TestDir 'test.env'
    [System.IO.File]::WriteAllText($script:EnvFile, "CLAUDISH_FAILOVER_SONNET=example@model`n", (New-Object System.Text.UTF8Encoding($false)))

    $shim = @'
@echo off
if "%SHIM_LOG%"=="" exit /b 1
echo %* >> "%SHIM_LOG%"
if "%1"=="ps" goto :ps
if "%1"=="inspect" goto :inspect
if "%1"=="image" goto :image
if "%1"=="start" goto :start
if "%1"=="rm" goto :rm
if "%1"=="restart" goto :restart
if "%1"=="compose" goto :compose
exit /b 0

:ps
if exist "%SHIM_DIR%\ps_out.txt" type "%SHIM_DIR%\ps_out.txt"
exit /b 0

:inspect
if exist "%SHIM_DIR%\inspect_out.txt" (type "%SHIM_DIR%\inspect_out.txt") else (echo true)
exit /b 0

:image
if exist "%SHIM_DIR%\image_out.txt" (type "%SHIM_DIR%\image_out.txt") else (echo 2026-09-24T22:47:44.000000000Z)
exit /b 0

:start
if not exist "%SHIM_DIR%\start_exit.txt" goto :start_ok
set /p SE=<"%SHIM_DIR%\start_exit.txt"
exit /b %SE%
:start_ok
echo %2
exit /b 0

:rm
if not exist "%SHIM_DIR%\rm_exit.txt" goto :rm_ok
set /p RE=<"%SHIM_DIR%\rm_exit.txt"
exit /b %RE%
:rm_ok
echo %2
exit /b 0

:restart
echo %4
exit /b 0

:compose
echo compose-stopping-old-container >> "%SHIM_LOG%"
if exist "%SHIM_DIR%\compose_stderr.txt" type "%SHIM_DIR%\compose_stderr.txt" 1>&2
if not exist "%SHIM_DIR%\compose_exit.txt" exit /b 0
set /p CE=<"%SHIM_DIR%\compose_exit.txt"
exit /b %CE%
'@
    # A .cmd batch file MUST carry CRLF: cmd.exe's `goto :label` search fails
    # on LF-only files ("Le système ne trouve pas le nom de fichier de
    # commandes", exit 1) — measured 2026-09-24 on an `autocrlf=input` checkout
    # where the here-string's endings leak straight into docker.cmd and the
    # plain-restart test fails 1/15 while an `autocrlf=true` clone (po-2026)
    # passes 15/15. Normalizing here makes the suite independent of each
    # machine's git config.
    $shim = $shim -replace "`r?`n", "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'docker.cmd'), $shim, (New-Object System.Text.ASCIIEncoding))

    $env:SHIM_DIR = $script:ShimDir
    $env:SHIM_LOG = $script:CallsLog
    $script:OldPath = $env:Path
    $env:Path = "$script:ShimDir;$env:Path"

    # Prove the suite cannot reach the real docker CLI. If this assert fires,
    # every "zero docker calls" assertion below is testing the wrong binary —
    # and the suite may be mutating a live container.
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd -or $dockerCmd.Source -notlike "$script:ShimDir*") {
        throw "docker resolves to '$($dockerCmd.Source)' — expected the suite's shim in $script:ShimDir. Aborting before any test can touch a real container."
    }

    # Dot-source defines the functions only (standalone guard sees '.').
    # The script's param() then runs here with defaults — reassign the ones
    # the functions resolve dynamically so the suite never touches the real
    # ~/.claudish (same clobber the watchdog saves/restores around).
    . $script:DrainScript
    $LogPath = $script:TestLog

    function Reset-DrainFixture {
        Remove-Item -LiteralPath $script:CallsLog -Force -ErrorAction SilentlyContinue
        foreach ($f in 'ps_out.txt', 'inspect_out.txt', 'compose_exit.txt', 'compose_stderr.txt', 'image_out.txt', 'start_exit.txt', 'rm_exit.txt') {
            Remove-Item -LiteralPath (Join-Path $script:ShimDir $f) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $script:TestLog -Force -ErrorAction SilentlyContinue
    }

    function Get-DrainLogText {
        if (Test-Path -LiteralPath $script:TestLog) { return (Get-Content -LiteralPath $script:TestLog) -join "`n" }
        return ''
    }

    function Get-CallsText {
        if (Test-Path -LiteralPath $script:CallsLog) { return (Get-Content -LiteralPath $script:CallsLog) -join "`n" }
        return ''
    }
}

AfterAll {
    $env:Path = $script:OldPath
    Remove-Item -LiteralPath $script:TestDir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-ClaudishDrainedRestart — -Recreate guards (#233)' {
    It 'refuses -Recreate without -EnvFile and writes a terminal OUTCOME line' {
        Reset-DrainFixture
        $r = Invoke-ClaudishDrainedRestart -Reason 'guard-test' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Match 'OUTCOME refused'
        (Get-DrainLogText) | Should -Match 'requires -EnvFile'
        Get-CallsText | Should -Be ''   # nothing docker-shaped happened at all
    }

    It 'refuses when leftover twins exist — zero compose calls, exact removal command named' {
        Reset-DrainFixture
        # Target running + one Created twin. inspect answers PATH only, so the
        # armed-cascade guard sees 0 armed in the container and passes.
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123def456_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-refuse' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        $log = Get-DrainLogText
        $log | Should -Match "leftover twin 'abc123def456_claudish-proxy' \(state=created\)"
        $log | Should -Match 'docker rm abc123def456_claudish-proxy'
        $log | Should -Match 'OUTCOME refused'
        # AC2: refuse BEFORE stopping anything. compose is where the stop
        # happens; it must never have been invoked.
        $calls = Get-CallsText
        $calls | Should -Not -Match '(?m)^compose'
        $calls | Should -Not -Match '(?m)^rm'
    }

    It 'positive control: the shim actually captured the ps call (a silent shim would pass every zero-call assertion)' {
        $calls = Get-CallsText
        $calls | Should -Match 'ps -a --filter'
        $calls | Should -Match 'inspect'
    }

    It '-RemoveCreatedTwins removes Created twins and proceeds to the recreate' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123def456_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-autorm' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        $r | Should -BeTrue
        $calls = Get-CallsText
        $calls | Should -Match '(?m)^rm abc123def456_claudish-proxy'
        $calls | Should -Match '(?m)^compose'
        (Get-DrainLogText) | Should -Match "removed Created-state twin 'abc123def456_claudish-proxy'"
        (Get-DrainLogText) | Should -Match 'OUTCOME success'
    }

    It '-RemoveCreatedTwins still refuses when a non-Created twin is present' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`n0123456789ab_claudish-proxy created`nba9876543210_claudish-proxy exited", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-mixed' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        $r | Should -BeFalse
        $calls = Get-CallsText
        $calls | Should -Not -Match '(?m)^rm'
        $calls | Should -Not -Match '(?m)^compose'
        (Get-DrainLogText) | Should -Match 'only covers Created-state twins'
    }
}

Describe 'Invoke-ClaudishDrainedRestart — twin shape and return value (#233 review)' {
    It 'a container whose name merely CONTAINS the target is not a twin — never told to remove it' {
        Reset-DrainFixture
        # `docker ps --filter name=` is a substring match. Only compose's own
        # temporary shape, <12-hex id>_<name>, is a leftover twin; anything
        # else is somebody's container, and the refusal would print
        # `docker rm <it>` as the fix.
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nclaudish-proxy-e2e running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'substring' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        (Get-DrainLogText) | Should -Not -Match 'docker rm claudish-proxy-e2e'
        Get-CallsText | Should -Match '(?m)^compose'
    }

    It '-RemoveCreatedTwins refuses when docker rm fails — compose never runs on a twin still present' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123def456_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'rm_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'rm-fails' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        $r | Should -BeFalse
        Get-CallsText | Should -Not -Match '(?m)^compose'
        $log = Get-DrainLogText
        $log | Should -Match "could not remove twin 'abc123def456_claudish-proxy'"
        $log | Should -Not -Match 'removed Created-state twin'
        $log | Should -Match 'OUTCOME refused'
    }

    It '-RemoveCreatedTwins then a failed compose returns exactly one $false — the twin name must not leak into the result' {
        Reset-DrainFixture
        # The standalone form turns this value into the exit code, and AC4
        # sends agent callers down exactly that detached path.
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123def456_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "false", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'rm-then-fail' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        @($r).Count | Should -Be 1
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Match 'OUTCOME failed'
    }

    It 'the rollback verdict is a single string even though docker start echoes the name' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "false", (New-Object System.Text.ASCIIEncoding))
        $v = Invoke-DrainRollback -Reason 'shape' -Container 'claudish-proxy' -Url 'http://127.0.0.1:1'
        @($v).Count | Should -Be 1
        $v | Should -Be 'started'
    }

    It 'a plain (non-recreate) restart returns exactly one $true — docker restart echoes the name too' {
        Reset-DrainFixture
        $r = Invoke-ClaudishDrainedRestart -Reason 'plain' -Url 'http://127.0.0.1:1'
        @($r).Count | Should -Be 1
        $r | Should -BeTrue
        Get-CallsText | Should -Match '(?m)^restart -t 120 claudish-proxy'
    }
}

Describe 'Invoke-ClaudishDrainedRestart — rollback on compose failure (#233 AC1)' {
    It 'starts the stopped container again after compose fails — hub serving previous image' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "false", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'rollback' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        $calls = Get-CallsText
        $calls | Should -Match '(?m)^start claudish-proxy'
        $log = Get-DrainLogText
        $log | Should -Match 'ROLLBACK started claudish-proxy'
        $log | Should -Match 'OUTCOME failed'
        $log | Should -Match 'ROLLBACK started, hub serving previous image'
    }

    It 'does not start anything when compose failed but the container still runs' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "true", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'norollback' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        Get-CallsText | Should -Not -Match '(?m)^start'
        (Get-DrainLogText) | Should -Match 'still running'
    }
}

Describe 'Invoke-ClaudishDrainedRestart — terminal OUTCOME lines (#233 AC3)' {
    It 'success path writes OUTCOME success' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'happy' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        (Get-DrainLogText) | Should -Match 'OUTCOME success'
    }

    It 'a previous RECREATE with no OUTCOME after it logs PREVIOUS RUN INTERRUPTED' {
        Reset-DrainFixture
        # The 09:35Z shape: a RECREATE line (compose output carries the same
        # prefix) and then nothing.
        [System.IO.File]::WriteAllText($script:TestLog, "[2026-09-23 11:35:54] RECREATE (manual): compose-stopping-old-container`n", (New-Object System.Text.UTF8Encoding($false)))

        $r = Invoke-ClaudishDrainedRestart -Reason 'after-crash' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Match 'PREVIOUS RUN INTERRUPTED'
        (Get-DrainLogText) | Should -Match 'OUTCOME refused'
    }

    It 'previous-run detection stays silent when the last run reached an OUTCOME' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText($script:TestLog, "[2026-09-23 10:00:00] RECREATE (manual): started`n[2026-09-23 10:01:00] OUTCOME success (deploy)`n", (New-Object System.Text.UTF8Encoding($false)))

        $r = Invoke-ClaudishDrainedRestart -Reason 'after-clean' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Not -Match 'PREVIOUS RUN INTERRUPTED'
    }
}

Describe 'armed-cascade guard counts CASCADES, not knobs (#141 x #304)' {
    It 'refuses when the env file carries only #304 knobs while the container holds an armed cascade' {
        Reset-DrainFixture
        # The #304 trap made real: the knobs are injected since the fix, so a
        # file can hold three non-empty CLAUDISH_FAILOVER_*/native lines and
        # ZERO cascades. Under the pre-#304 any-FAILOVER-name pattern this
        # counted as armed (2) and the gut-guard let the recreate through,
        # wiping the container's cascade. Only the four <ROLE> cascade names
        # are an armed state; a knob is runtime policy, not a cascade.
        $saved = [System.IO.File]::ReadAllText($script:EnvFile)
        try {
            [System.IO.File]::WriteAllText($script:EnvFile, "CLAUDISH_FAILOVER_ARM_AFTER=2`nCLAUDISH_FAILOVER_SESSION_DWELL_MS=600000`nCLAUDISH_NATIVE_MODEL_PIN=1`n", (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
            [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin`nCLAUDISH_FAILOVER_SONNET=gc@glm-5.3`nCLAUDISH_FAILOVER_ARM_AFTER=2`n", (New-Object System.Text.ASCIIEncoding))

            $r = Invoke-ClaudishDrainedRestart -Reason 'knob-only' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
            $r | Should -BeFalse
            $log = Get-DrainLogText
            $log | Should -Match 'RECREATE REFUSED'
            $log | Should -Match 'carries no armed'
            $log | Should -Match 'OUTCOME refused'
            # Refused BEFORE stopping anything: compose is where the stop
            # happens and must never have been invoked.
            (Get-CallsText) | Should -Not -Match '(?m)^compose'
        } finally {
            [System.IO.File]::WriteAllText($script:EnvFile, $saved, (New-Object System.Text.UTF8Encoding($false)))
        }
    }

    It 'a cascade line in the env file keeps the guard open (no false refuse)' {
        Reset-DrainFixture
        # Mirror of the refuse above: same armed container, but the file now
        # carries the cascade itself — nothing to lose, no refuse. With clean
        # fixtures the run then proceeds all the way to OUTCOME success.
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin`nCLAUDISH_FAILOVER_SONNET=gc@glm-5.3`n", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'cascade-present' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        (Get-DrainLogText) | Should -Not -Match 'carries no armed'
        (Get-DrainLogText) | Should -Match 'OUTCOME success'
    }

    It 'drift pin: both scripts count armed with the same role-only pattern' {
        # Two copies of the armed-count exist (Get-ArmedCascadeCount in
        # install-sidecar.ps1, inline x2 in claudish-drain.ps1). Nothing
        # executes install-sidecar.ps1 in this suite, so the only pin against
        # the copies drifting apart is source-level: both must match this
        # exact role-only alternation, and neither may still count armed with
        # the pre-#304 any-FAILOVER-name pattern (Get-EnvLinesToPreserve's
        # broad carry-over pattern is a DIFFERENT, legitimate use and is
        # anchored on a bare `=` so it cannot match `.=`).
        $rolePattern = [regex]::Escape('^CLAUDISH_FAILOVER_(OPUS|SONNET|HAIKU|FABLE)=.+')
        $drainText = [System.IO.File]::ReadAllText($script:DrainScript)
        $installText = [System.IO.File]::ReadAllText((Join-Path $script:ScriptsRoot 'install-sidecar.ps1'))
        # (BeTrue rather than BeGreaterThanOrEqual: the numeric-operator
        # parameter set does not resolve under this suite's Pester binding.)
        (@([regex]::Matches($drainText, $rolePattern)).Count -ge 1) | Should -BeTrue
        (@([regex]::Matches($installText, $rolePattern)).Count -ge 1) | Should -BeTrue
        # Neither script may still count armed with the pre-#304 any-name
        # pattern — the exact text it used to carry, escaped. (The drain must
        # not count knobs as armed anymore; same for Get-ArmedCascadeCount.)
        $oldBroad = [regex]::Escape('^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+')
        $drainText | Should -Not -Match $oldBroad
        $installText | Should -Not -Match $oldBroad
    }
}

Describe 'Invoke-ClaudishDrainedRestart — compose stderr and deployed-image attestation (#257)' {
    It 'compose stderr under EAP Stop completes with OUTCOME success — no terminating RemoteException' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_stderr.txt'), "level=warning msg=a line compose writes to stderr", (New-Object System.Text.ASCIIEncoding))

        # Hub, twice on 2026-09-25: with EAP 'Stop' in scope, PS 5.1 turns the
        # 2>&1-redirected compose stderr into a terminating RemoteException
        # after a successful recreate — OUTCOME exception, /health attestation
        # lost. EAP here is the caller's scope, exactly as in production.
        $ErrorActionPreference = 'Stop'
        $r = Invoke-ClaudishDrainedRestart -Reason 'eap-stop' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        $log = Get-DrainLogText
        $log | Should -Match 'OUTCOME success'
        $log | Should -Not -Match 'OUTCOME exception'
        $log | Should -Match 'level=warning'   # logged as data, not swallowed
    }

    It 'the RECREATE log names the deployed image and its build timestamp' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "sha256:aaaabbbbccccdddd000011112222333344445555666677778888999aaabbbcccdd", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'image_out.txt'), "2026-09-24T22:47:44.000000000Z", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'image-log' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        (Get-DrainLogText) | Should -Match 'deployed image aaaabbbbcccc created 2026-09-24T22:47:44'
    }

    It 'never reads $LASTEXITCODE right after piping docker into Select-Object -First' {
        # Hub, 2026-09-25: under 5.1, `docker inspect … | Select-Object -First 1`
        # stops the pipeline early and kills the process, so $LASTEXITCODE reads
        # -1 (measured live: original -1, capture-then-select 0; pwsh 7 reports 0
        # for both). The exit-code guard therefore dropped the attestation on
        # every recreate. A .cmd shim exits before PS reads its line and cannot
        # reproduce the kill (a slow-shim variant passed on the mutant), so the
        # pin is structural. Mutation-proven: restoring the original two lines
        # makes this fail on them.
        $lines = Get-Content -LiteralPath $script:DrainScript
        $offenders = @()
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match 'docker\b.*\|\s*Select-Object\s+-First') {
                $next = ($lines[($i + 1)..([Math]::Min($i + 2, $lines.Count - 1))] -join "`n")
                if ($next -match '\$LASTEXITCODE') { $offenders += "line $($i + 1): $($lines[$i].Trim())" }
            }
        }
        $offenders | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-ClaudishDrainedRestart — admission freeze around the gesture (#306)' {
    # Review 03/10: the FREEZE window line must attest what the PROXY saw, not
    # what the drain wrote. A tiny HttpListener job stands in for the proxy's
    # /health and answers whatever admissionFreeze the case needs — the same
    # JSON shape proxy-server now publishes. The helpers live in BeforeAll, not
    # in the Describe body: Pester runs that body at DISCOVERY and a function
    # declared there is gone by the time an It runs (engine.Tests documents the
    # same trap).
    BeforeAll {
        # #351 — the fixture used to bind a FIXED port (19937) and treat "any
        # 200 on /health" as readiness. Two consequences: a listener could
        # outlive its job (measured after a #344 review run — 19937 still
        # served a healthy body after Stop-Job/Remove-Job), and that stale
        # server then satisfied the NEXT fixture's readiness probe, so a
        # NO-CONSENT case read the PREVIOUS run's admissionFreeze body. Three
        # structural answers, none of which has to trust Stop-Job's timing:
        #   1. an EPHEMERAL port per fixture — two fixtures cannot collide;
        #   2. a per-instance NONCE echoed in every /health body, awaited by
        #      the readiness probe — a foreign 200 can never pass for ours;
        #   3. a COOPERATIVE stop through the listener ITSELF: the job blocks
        #      in GetContext — measured, the Begin/End variant NEVER serves in
        #      PowerShell (the async wait times out under 5.1 AND 7.x while
        #      the socket never answers) — so the stop is one more request the
        #      job answers (`/__stop`), after which ITS OWN finally runs
        #      ($l.Stop()/$l.Close()) and frees the socket; the teardown then
        #      ASSERTS the port is free before returning.
        function Get-FreeLoopbackPort {
            # Bind :0, read the assignment, release — the standard way to get a
            # port nobody holds at this instant.
            $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
            $probe.Start()
            $port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
            $probe.Stop()
            return $port
        }

        function Wait-FakeProxyHealth {
            # Readiness that proves it reached ITS OWN server: a 200 is not
            # enough, the body must echo this instance's nonce (#351).
            param([string]$Url, [string]$Nonce, [int]$TimeoutSec = 10)
            $deadline = (Get-Date).AddSeconds($TimeoutSec)
            while ((Get-Date) -lt $deadline) {
                try {
                    $resp = Invoke-WebRequest -Uri "$Url/health" -TimeoutSec 2 -UseBasicParsing
                    # The nonce is guid 'N' format (hex only) — no regex escaping.
                    if ("$($resp.Content)" -match $Nonce) { return $true }
                } catch { }
                Start-Sleep -Milliseconds 200
            }
            throw "fake proxy /health on $Url did not answer with nonce $Nonce within ${TimeoutSec}s (#351)"
        }

        function Assert-PortClosed {
            # The next fixture's whole problem is this port being free; check
            # that exact condition instead of trusting the teardown sequence.
            param([int]$Port, [int]$TimeoutSec = 5)
            $deadline = (Get-Date).AddSeconds($TimeoutSec)
            while ((Get-Date) -lt $deadline) {
                $open = $false
                try {
                    $t = [System.Net.Sockets.TcpClient]::new()
                    $t.Connect('127.0.0.1', $Port)
                    $t.Close()
                    $open = $true
                } catch { $open = $false }
                if (-not $open) { return }
                Start-Sleep -Milliseconds 200
            }
            throw "port $Port still answers ${TimeoutSec}s after fixture teardown — the next fixture would read a stale server (#351)"
        }

        function New-FakeProxyHealth {
            # AdmissionFreeze 'omit' serves the /health of a PRE-#306 image:
            # JSON answers, but no admissionFreeze field at all — the shape the
            # first freeze-capable -Recreate probes on every machine (review D3).
            param([string]$AdmissionFreeze)
            # The discovered port can be taken between release and the job's
            # bind (a small race, and this machine runs other lanes' monitors):
            # retry with a fresh port rather than reporting an environment race
            # as a suite failure. The nonce probe is what makes each retry safe
            # — a stale or foreign listener can never answer OUR nonce.
            $attempts = 3
            for ($attempt = 1; $attempt -le $attempts; $attempt++) {
                $port = Get-FreeLoopbackPort
                $nonce = [guid]::NewGuid().ToString('N')
                $url = "http://127.0.0.1:$port"
                $job = Start-Job -ScriptBlock {
                    param($state, $port, $nonce)
                    $l = [System.Net.HttpListener]::new()
                    $l.Prefixes.Add("http://127.0.0.1:$port/")
                    try {
                        $l.Start()
                    } catch {
                        Write-Output ("BIND-ERR: " + $_.Exception.Message)
                        return
                    }
                    try {
                        while ($true) {
                            # Blocking GetContext on purpose: the Begin/End form
                            # never serves here (measured under 5.1 and 7.x).
                            $ctx = $l.GetContext()
                            $isStop = ($ctx.Request.Url.AbsolutePath -eq '/__stop')
                            $body = if ($isStop) {
                                '{"stopping":true}'
                            } elseif ($state -eq 'omit') {
                                '{"status":"ok","activeStreams":0,"nonce":"' + $nonce + '"}'
                            } else {
                                '{"status":"ok","activeStreams":0,"admissionFreeze":"' + $state + '","nonce":"' + $nonce + '"}'
                            }
                            $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
                            $ctx.Response.ContentType = 'application/json'
                            $ctx.Response.ContentLength64 = $buf.Length
                            $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
                            $ctx.Response.Close()
                            if ($isStop) { break }
                        }
                    } catch { } finally { try { $l.Stop(); $l.Close() } catch { } }
                } -ArgumentList $AdmissionFreeze, $port, $nonce
                try {
                    $null = Wait-FakeProxyHealth -Url $url -Nonce $nonce -TimeoutSec 10
                    return [pscustomobject]@{ Job = $job; Port = $port; Url = $url; Nonce = $nonce }
                } catch {
                    # Carry the job's own verdict into the failure: "no nonce"
                    # alone cannot distinguish a taken port from a dead job.
                    $jobSaid = @(Receive-Job -Job $job -ErrorAction SilentlyContinue 2>&1) -join ' | '
                    $state = $job.State
                    Stop-Job -Job $job -ErrorAction SilentlyContinue
                    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
                    if ($attempt -eq $attempts) {
                        throw "fake proxy /health on port $port did not answer with its nonce after $attempts attempts (job state=$state; job said: $jobSaid) (#351)"
                    }
                }
            }
        }

        function Remove-FakeProxyHealth($fake) {
            # Cooperative stop FIRST, through the listener itself: the job
            # answers /__stop, breaks out and runs its own finally. Stop-Job is
            # only the belt for a job that ignored it — never the primary
            # mechanism (#344 review measured Stop-Job returning while the
            # listener still answered).
            try { $null = Invoke-WebRequest -Uri "$($fake.Url)/__stop" -TimeoutSec 3 -UseBasicParsing } catch { }
            $null = Wait-Job -Job $fake.Job -Timeout 5
            Stop-Job -Job $fake.Job -ErrorAction SilentlyContinue
            Remove-Job -Job $fake.Job -Force -ErrorAction SilentlyContinue
            Assert-PortClosed -Port $fake.Port
        }
    }

    It 'with consent + proxy CONFIRMS (admissionFreeze=flag): armed line + window line + flag cleared' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", [System.Text.Encoding]::ASCII)
        $freezeHome = Join-Path $TestDrive 'freeze-home'
        New-Item -ItemType Directory -Path $freezeHome -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $freezeHome 'drain-freeze.enabled'), 'enabled', (New-Object System.Text.UTF8Encoding($false)))
        $fake = New-FakeProxyHealth -AdmissionFreeze 'flag'
        try {
            $r = Invoke-ClaudishDrainedRestart -Reason 'freeze-ok' -Url $fake.Url -FreezeClaudishHome $freezeHome
            $r | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $freezeHome 'drain-freeze') | Should -BeFalse
            $log = Get-DrainLogText
            $log | Should -Match 'FREEZE armed — proxy confirms'
            $log | Should -Match 'FREEZE \(freeze-ok\): admissions frozen .+ — flag cleared'
        } finally { Remove-FakeProxyHealth $fake }
    }

    It 'with consent but proxy reports NO-CONSENT (mount mismatch): NOT HONORED, no window line, gesture proceeds' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", [System.Text.Encoding]::ASCII)
        $freezeHome = Join-Path $TestDrive 'mismatch-home'
        New-Item -ItemType Directory -Path $freezeHome -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $freezeHome 'drain-freeze.enabled'), 'enabled', (New-Object System.Text.UTF8Encoding($false)))
        $fake = New-FakeProxyHealth -AdmissionFreeze 'no-consent'
        try {
            $r = Invoke-ClaudishDrainedRestart -Reason 'freeze-mismatch' -Url $fake.Url -FreezeClaudishHome $freezeHome
            $r | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $freezeHome 'drain-freeze') | Should -BeFalse
            $log = Get-DrainLogText
            $log | Should -Match 'FREEZE NOT HONORED \(proxy=no-consent\) — drain home and container mount differ\?'
            # The window line is reserved for a freeze the proxy confirmed —
            # the exact false-attestation the review rejected.
            $log | Should -Not -Match 'admissions frozen'
            $log | Should -Match 'OUTCOME success'
        } finally { Remove-FakeProxyHealth $fake }
    }

    It 'with consent but NO proxy answering (dead URL): NOT HONORED (no-signal), no window line' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", [System.Text.Encoding]::ASCII)
        $freezeHome = Join-Path $TestDrive 'deaf-home'
        New-Item -ItemType Directory -Path $freezeHome -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $freezeHome 'drain-freeze.enabled'), 'enabled', (New-Object System.Text.UTF8Encoding($false)))

        $r = Invoke-ClaudishDrainedRestart -Reason 'freeze-deaf' -Url 'http://127.0.0.1:1' -FreezeClaudishHome $freezeHome
        $r | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $freezeHome 'drain-freeze') | Should -BeFalse
        $log = Get-DrainLogText
        $log | Should -Match 'FREEZE NOT HONORED \(proxy=no-signal\)'
        $log | Should -Not -Match 'admissions frozen'
    }

    It 'proxy ANSWERS but carries no admissionFreeze field (pre-#306 image, first deploy): NOT HONORED (absent), no window line (review D3)' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", [System.Text.Encoding]::ASCII)
        $freezeHome = Join-Path $TestDrive 'absent-home'
        New-Item -ItemType Directory -Path $freezeHome -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $freezeHome 'drain-freeze.enabled'), 'enabled', (New-Object System.Text.UTF8Encoding($false)))
        $fake = New-FakeProxyHealth -AdmissionFreeze 'omit'
        try {
            # The shape every machine meets exactly once: the -Recreate that
            # deploys #306 probes the container it is about to replace —
            # pre-#306 by definition, so /health answers WITHOUT the field.
            # Reading that absence as "flag" (mutation D3) would re-arm the
            # false attestation on the very first run an operator reads.
            $r = Invoke-ClaudishDrainedRestart -Reason 'freeze-absent' -Url $fake.Url -FreezeClaudishHome $freezeHome
            $r | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $freezeHome 'drain-freeze') | Should -BeFalse
            $log = Get-DrainLogText
            $log | Should -Match 'FREEZE NOT HONORED \(proxy=absent\) — proxy predates #306 — freeze takes effect on the NEXT deploy'
            $log | Should -Not -Match 'FREEZE armed'
            $log | Should -Not -Match 'admissions frozen'
            $log | Should -Match 'OUTCOME success'
        } finally { Remove-FakeProxyHealth $fake }
    }

    It '#351: teardown ASSERTS the port is free — a still-open port makes it throw (mutation target: drop Assert-PortClosed)' {
        # Poisoned on purpose: a rogue listener holds the port, so the
        # teardown's contract is violated. Without Assert-PortClosed the
        # function returns silently and the next fixture would read the rogue
        # server — the exact #351 mechanism, caught here instead of one suite
        # run later.
        $rogue = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $rogue.Start()
        $port = ([System.Net.IPEndPoint]$rogue.LocalEndpoint).Port
        $dead = Start-Job -ScriptBlock { }
        $null = Wait-Job -Job $dead -Timeout 5
        try {
            $poisoned = [pscustomobject]@{ Job = $dead; Port = $port; Url = "http://127.0.0.1:$port" }
            { Remove-FakeProxyHealth $poisoned } | Should -Throw '*still answers*'
        } finally {
            $rogue.Stop()
            Remove-Job -Job $dead -Force -ErrorAction SilentlyContinue
        }
    }

    It '#351: readiness refuses a foreign server answering 200 without OUR nonce (mutation target: drop the nonce check)' {
        # The foreign server answers 200 on /health with a proxy-shaped body
        # carrying someone else's nonce. The pre-#351 probe ("any 200 is up")
        # accepted it — which is how a NO-CONSENT case read the PREVIOUS
        # fixture's admissionFreeze body.
        $port = Get-FreeLoopbackPort
        $rogue = Start-Job -ScriptBlock {
            param($port)
            $l = [System.Net.HttpListener]::new()
            $l.Prefixes.Add("http://127.0.0.1:$port/")
            $l.Start()
            try {
                $ctx = $l.GetContext()
                $buf = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok","activeStreams":0,"nonce":"someone-elses"}')
                $ctx.Response.ContentType = 'application/json'
                $ctx.Response.ContentLength64 = $buf.Length
                $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
                $ctx.Response.Close()
            } catch { } finally { try { $l.Stop(); $l.Close() } catch { } }
        } -ArgumentList $port
        try {
            { Wait-FakeProxyHealth -Url "http://127.0.0.1:$port" -Nonce 'my-own-nonce' -TimeoutSec 2 } | Should -Throw '*did not answer with nonce*'
        } finally {
            Stop-Job -Job $rogue -ErrorAction SilentlyContinue
            Remove-Job -Job $rogue -Force -ErrorAction SilentlyContinue
        }
    }

    It 'without consent (the default everywhere): no flag, no FREEZE line, restart unaffected' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", [System.Text.Encoding]::ASCII)
        $freezeHome = Join-Path $TestDrive 'noconsent-home'
        New-Item -ItemType Directory -Path $freezeHome -Force | Out-Null

        # Reason deliberately avoids the word "freeze": -Match is
        # case-insensitive, so a reason carrying it would self-match the
        # negative assertion below.
        $r = Invoke-ClaudishDrainedRestart -Reason 'plain-noconsent' -Url 'http://127.0.0.1:1' -FreezeClaudishHome $freezeHome
        $r | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $freezeHome 'drain-freeze') | Should -BeFalse
        $log = Get-DrainLogText
        $log | Should -Not -Match 'admissions frozen'
        $log | Should -Not -Match 'FREEZE armed'
        $log | Should -Not -Match 'FREEZE NOT HONORED'
        $log | Should -Match 'OUTCOME success'
    }
}

Describe 'drain -Detach — quoted detached launch (#312)' {
    BeforeAll {
        # Real powershell.exe children, zero docker anywhere (AC3: the child
        # command is injected — these fixtures, not the drain). Three shapes:
        #   child-ok.ps1     binds a spaced argument, writes it to the watch
        #                    log (the "first drain.log line" proxy)
        #   child-exit7.ps1  dies immediately with stderr noise (AC3c)
        #   child-bindfail   dies during PARAMETER BINDING — the AC2 evidence
        #                    class: nothing in the watch log, error in stderr
        $script:DetachDir = Join-Path $script:TestDir 'detach'
        New-Item -ItemType Directory -Path $script:DetachDir -Force | Out-Null
        $utf8 = New-Object System.Text.UTF8Encoding($false)

        # #338 review B2: the real child's contract is a `START pid <pid>`
        # handshake line BEFORE anything else — fixtures write it too, so the
        # alive path is proven through the pid match, not through any growth.
        $okBody = @'
param([string]$SpacedValue, [string]$WatchLog)
Add-Content -LiteralPath $WatchLog -Value ("START pid {0}" -f $PID)
Add-Content -LiteralPath $WatchLog -Value "bound:[$SpacedValue]"
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-ok.ps1'), $okBody, $utf8)

        # B3: binds the nastiest real-world values and reports what the
        # child's OWN parameter binding reassembled — the only oracle that
        # can see a broken quoting rule (a textual assert on the joined
        # string passes on both broken forms; review of #338).
        $dumpBody = @'
param([string]$Reason, [string]$EnvFile, [switch]$Recreate, [string]$HomeDir, [string]$WatchLog)
Add-Content -LiteralPath $WatchLog -Value ("START pid {0}" -f $PID)
Add-Content -LiteralPath $WatchLog -Value ("reason=[$Reason] env=[$EnvFile] recreate=[$Recreate] home=[$HomeDir]")
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-dump-params.ps1'), $dumpBody, $utf8)

        # B2: a child that stays alive but writes NOTHING — the review's
        # measured case (busy proxy: no drain.log line for the whole observe
        # window while the child works).
        $silentBody = @'
param([int]$SleepSec)
Start-Sleep -Seconds $SleepSec
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-silent.ps1'), $silentBody, $utf8)

        # B2: an unrelated drain.log writer — writes a START line for a pid
        # that is NOT the watched child (the 04:00 task / watchdog shape).
        $polluteBody = @'
param([string]$WatchLog)
Start-Sleep -Milliseconds 800
Add-Content -LiteralPath $WatchLog -Value "START pid 999999 — someone else entirely"
Start-Sleep -Seconds 20
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-pollute.ps1'), $polluteBody, $utf8)

        $exitBody = @'
param([string]$WatchLog)
Write-Error 'detach-child-boom'
exit 7
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-exit7.ps1'), $exitBody, $utf8)

        $bindBody = @'
param([int]$MustBeInt, [string]$WatchLog)
Add-Content -LiteralPath $WatchLog -Value "bound:[$MustBeInt]"
'@
        [System.IO.File]::WriteAllText((Join-Path $script:DetachDir 'child-bindfail.ps1'), $bindBody, $utf8)

        # The detach functions live in the dot-sourced drain script.
        function New-DetachArgumentString {
            param([string]$Fixture, [string[]]$ExtraArgs)
            $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Fixture) + $ExtraArgs
            Join-DrainDetachArguments $parts
        }

        # Write-friendly read for the e2e wait loops: a plain Get-Content -Raw
        # poll can hold the log in a state that makes the CHILD's Add-Content
        # fail once with a sharing violation (measured under 5.1: log ended on
        # RECREATE REFUSED, no OUTCOME, 20 s wait) — read with FileShare
        # Read|Write so the poller never blocks the writer.
        function Read-LenientRaw {
            param([string]$Path)
            if (-not (Test-Path -LiteralPath $Path)) { return $null }
            $fs = $null
            try {
                $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $sr = New-Object System.IO.StreamReader($fs)
                return $sr.ReadToEnd()
            } catch {
                return $null
            } finally {
                if ($fs) { $fs.Dispose() }
            }
        }
    }

    It 'a spaced argument binds through the detached path (AC1/AC3a)' {
        $watch = Join-Path $script:DetachDir 'watch-ok.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-ok.ps1') `
            -ExtraArgs @('-SpacedValue', 'a value with  spaces', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeTrue
        $r.Status | Should -Be 'alive'
        $r.ChildPid | Should -BeGreaterThan 0
        # Double space inside the value: a broken join cannot reassemble it.
        # NB the pattern is precomputed: a bare [regex]::Escape('…') as a
        # Should argument is parsed in ARGUMENT mode and splits at the spaces
        # inside the value — the suite then matches the literal text
        # "[regex]::Escape" (first run of this test, measured).
        $expectedSpaced = [regex]::Escape('a value with  spaces')
        (Get-Content -LiteralPath $watch -Raw) | Should -Match $expectedSpaced
        # B2: alive is proven by the pid handshake, and the pid in the file
        # IS the pid the parent reports — not just any growth.
        (Get-Content -LiteralPath $watch -Raw) | Should -Match ('START pid {0}\b' -f $r.ChildPid)
        # Evidence files exist under the Claudish home, per-run named (AC1).
        (Get-ChildItem -LiteralPath $script:DetachDir -Filter 'drain-detach-*.out.log' | Measure-Object).Count | Should -BeGreaterOrEqual 1
    }

    It 'a live but silent child is a bounded timeout, never a false alive (review B2)' {
        # The review's measured case: busy proxy, child alive and working,
        # no drain.log line for the whole observe window. The parent must
        # return timeout (not-Ok) WITH the pid — the caller is told the child
        # may still be running, and must not relaunch.
        $watch = Join-Path $script:DetachDir 'watch-silent.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-silent.ps1') `
            -ExtraArgs @('-SleepSec', '25')
        try {
            $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 3 -PollMs 200
            $r.Ok | Should -BeFalse
            $r.Status | Should -Be 'timeout'
            $r.ChildPid | Should -BeGreaterThan 0
            # The distinction the review asked for: timeout is NOT exited.
            $r.ExitCode | Should -BeNullOrEmpty
            Test-Path -LiteralPath $watch | Should -BeFalse
        } finally {
            if ($r -and $r.ChildPid) { Stop-Process -Id $r.ChildPid -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'a foreign drain.log writer is never taken for the child (review B2)' {
        # Another writer (04:00 task, watchdog) drops a START line for a
        # DIFFERENT pid inside the window while the watched child stays
        # silent: growth alone would read alive — the pid match must not.
        $watch = Join-Path $script:DetachDir 'watch-foreign.log'
        $polluter = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:DetachDir 'child-pollute.ps1'), '-WatchLog', $watch) `
            -WindowStyle Hidden -PassThru
        try {
            $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-silent.ps1') `
                -ExtraArgs @('-SleepSec', '25')
            $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 4 -PollMs 200
            $r.Ok | Should -BeFalse
            $r.Status | Should -Be 'timeout'
            # The foreign line IS in the file (growth happened) — proving the
            # red would fire on the old any-growth rule.
            (Get-Content -LiteralPath $watch -Raw) | Should -Match 'START pid 999999'
        } finally {
            if ($r -and $r.ChildPid) { Stop-Process -Id $r.ChildPid -Force -ErrorAction SilentlyContinue }
            if ($polluter) { Stop-Process -Id $polluter.Id -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'a trailing backslash before the closing quote survives the join (review B3)' {
        # Review's case 1: `-ClaudishHome '…\home sp\'` — the trailing
        # backslash merges with the closing quote, the child loses the NEXT
        # parameter. Real 5.1 child, oracle = the child's own binding.
        $watch = Join-Path $script:DetachDir 'watch-b3a.log'
        $homeVal = Join-Path $script:DetachDir 'home sp\'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-dump-params.ps1') `
            -ExtraArgs @('-Reason', 'b3a', '-EnvFile', 'D:\claudish shadow\.env', '-HomeDir', $homeVal, '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeTrue
        $raw = Get-Content -LiteralPath $watch -Raw
        # All four bound: the backslash case kills the parameters AFTER it.
        $raw | Should -Match ('home=\[{0}\]' -f [regex]::Escape($homeVal))
        $raw | Should -Match ([regex]::Escape('env=[D:\claudish shadow\.env]'))
    }

    It 'an embedded double quote in -Reason does not swallow the rest (review B3)' {
        # Review's case 2: `-Reason 'deploy "v2" now'` — the unescaped quote
        # made the child bind Recreate=false and a garbled ContainerName.
        # Real 5.1 child, oracle = the child's own binding.
        $watch = Join-Path $script:DetachDir 'watch-b3b.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-dump-params.ps1') `
            -ExtraArgs @('-Reason', 'deploy "v2" now', '-EnvFile', 'D:\claudish shadow\.env', '-Recreate', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeTrue
        $raw = Get-Content -LiteralPath $watch -Raw
        $raw | Should -Match ([regex]::Escape('reason=[deploy "v2" now]'))
        $raw | Should -Match ([regex]::Escape('env=[D:\claudish shadow\.env]'))
        $raw | Should -Match 'recreate=\[True\]'
    }

    It 'the real entry point: -Detach exits 0 with the child PID on the docker-free refuse path (review B1)' {
        # The functions were green while the entry block was broken (B1: the
        # $detach/[switch]$Detach collision made EVERY real launch exit 4).
        # This test goes through the actual operator entry point: -Recreate
        # without -EnvFile refuses BEFORE any docker call, so the run is
        # docker-free end to end, and the child's START handshake is the
        # proof the parent's exit 0 leans on.
        $e2eHome = Join-Path $script:DetachDir 'e2e-home'
        New-Item -ItemType Directory -Path $e2eHome -Force | Out-Null
        $log = Join-Path $e2eHome 'drain.log'
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File $script:DrainScript -Detach -Reason 'pester-e2e' `
            -ClaudishHome $e2eHome -LogPath $log -ProxyUrl 'http://127.0.0.1:59999' `
            -MaxWaitSec 5 -Recreate 2>&1
        $rc = $LASTEXITCODE
        $text = $out -join "`n"
        $rc | Should -Be 0
        $m = [regex]::Match($text, 'child PID (\d+) alive')
        $m.Success | Should -BeTrue
        # The parent returns on the START handshake while the detached child
        # is still running: the REFUSED/OUTCOME lines land AFTER the parent's
        # exit. Bounded wait before asserting them (the child refuses in
        # ~1.5 s, measured in review of #338).
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            if ((Read-LenientRaw -Path $log) -match 'OUTCOME ') { break }
            Start-Sleep -Milliseconds 250
        }
        $logRaw = Read-LenientRaw -Path $log
        # The alive claim is backed by THAT child's own START line.
        $logRaw | Should -Match ('START pid {0}\b' -f $m.Groups[1].Value)
        # The child really ran the refuse path (docker-free) and terminated.
        $logRaw | Should -Match 'RECREATE REFUSED'
        $logRaw | Should -Match 'OUTCOME '
    }

    It 'the real entry point: a child mute within the startup window returns exit 4 + PID + do-NOT-relaunch (re-review, bloquant 2)' {
        # The exit-4 contract existed only in prose: a mutation at the entry
        # block (timeout -> exit 3, PID and notice stripped) left the file at
        # 37/0. -DetachStartupTimeoutSec 0 gives a degenerate-but-
        # deterministic window: the loop never runs, the single post-loop
        # check fires within ~100 ms of the launch, and the child's
        # powershell.exe cold start cannot have written START yet.
        $e2eHome = Join-Path $script:DetachDir 'e2e-timeout-home'
        New-Item -ItemType Directory -Path $e2eHome -Force | Out-Null
        $log = Join-Path $e2eHome 'drain.log'
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File $script:DrainScript -Detach -Reason 'pester-e2e-to' `
            -ClaudishHome $e2eHome -LogPath $log -ProxyUrl 'http://127.0.0.1:59999' `
            -MaxWaitSec 5 -Recreate -DetachStartupTimeoutSec 0 2>&1
        $rc = $LASTEXITCODE
        $text = $out -join "`n"
        $rc | Should -Be 4
        $text | Should -Match 'do NOT relaunch'
        $text | Should -Match 'PID \d+ still running but wrote no START line'
        # Exit 4 means the child may STILL be running, and here it really is:
        # the same detached child eventually writes its own handshake and the
        # refuse-path OUTCOME — the caller was told to wait, not to relaunch.
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            if ((Read-LenientRaw -Path $log) -match 'OUTCOME ') { break }
            Start-Sleep -Milliseconds 250
        }
        (Read-LenientRaw -Path $log) | Should -Match 'OUTCOME '
    }

    It 'the handshake read matches only bytes appended after the offset (unit, fixed pid — re-review round 4)' {
        # Deterministic on any machine: no child, no pid lottery, no band
        # coverage question. A stale `START pid 4242` line sits ENTIRELY
        # before the offset; this is the pin that carries the bloquant-1
        # guard on every run, whatever pid space the host draws from
        # (Windows pids exceed 65535 — measured 69440…86348 on ai-01).
        $watch = Join-Path $script:DetachDir 'watch-unit-offset.log'
        Remove-Item -LiteralPath $watch -Force -ErrorAction SilentlyContinue
        '[2026-10-05 00:00:00] START pid 4242 — drained restart begins (reason: old run)' |
            Set-Content -LiteralPath $watch
        $offset = (Get-Item -LiteralPath $watch).Length
        # Nothing appended after the offset: the addition is empty — the
        # stale line naming the SAME pid is invisible. A whole-file read
        # (mutation M-C1) reddens HERE, every run, not by pid luck.
        (Get-WatchLogAddition -WatchLogPath $watch -OffsetBytes $offset) | Should -Be ''
        # Positive control: a line appended AFTER the offset IS the signal —
        # even when it names the same pid as the stale one.
        Add-Content -LiteralPath $watch -Value '[2026-10-06 00:00:00] START pid 4242 — drained restart begins (reason: this run)'
        $added = Get-WatchLogAddition -WatchLogPath $watch -OffsetBytes $offset
        $added | Should -Match 'START pid 4242'
        $added | Should -Not -Match 'reason: old run'
        # Documented truncation branch: a file SHORTER than the offset
        # (replaced/truncated watch log) is read from 0 — toward the signal.
        (Get-WatchLogAddition -WatchLogPath $watch -OffsetBytes ($offset + 4096)) | Should -Match 'reason: old run'
        # A missing file is '' — a pure read, never a throw.
        (Get-WatchLogAddition -WatchLogPath (Join-Path $script:DetachDir 'watch-no-such-file.log') -OffsetBytes 0) | Should -Be ''
        Remove-Item -LiteralPath $watch -Force -ErrorAction SilentlyContinue
    }

    It 'the offset is taken before the launch and every handshake read is offset-bounded (AST, bloquant 1)' {
        # Structural pin of Start-DrainDetached: whatever pid the host draws,
        # the SOURCE guarantees (a) $baseline is assigned BEFORE Start-Process
        # — the whole fix rests on the offset predating the child's first
        # possible byte; an offset taken after the launch reintroduces the
        # stale-line window (mutation M-D2 reddens here); (b) both handshake
        # reads (loop + post-loop re-check) go through Get-WatchLogAddition
        # with -OffsetBytes $baseline; (c) the watch log is never read whole.
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:DrainScript, [ref]$tokens, [ref]$errors)
        $fn = @($ast.FindAll({ param($n)
                    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-DrainDetached'
                }, $true))
        $fn.Count | Should -Be 1   # a filter matching nothing would prove nothing
        $text = $fn[0].Extent.Text
        # (a) ordering, by Extent position — drift-proof against line moves.
        $baselinePos = $text.IndexOf('$baseline')
        $launchPos = $text.IndexOf('Start-Process -FilePath')
        $baselinePos | Should -BeGreaterOrEqual 0
        $launchPos | Should -BeGreaterOrEqual 0
        $baselinePos | Should -BeLessThan $launchPos
        # (b) both reads are offset-bounded through the helper — no inline
        # re-implementation can slip in beside them.
        ([regex]::Matches($text, [regex]::Escape('Get-WatchLogAddition -WatchLogPath $WatchLogPath -OffsetBytes $baseline'))).Count | Should -Be 2
        # (c) no whole-file read of the WATCH log. Line-level conjunction: a
        # line reads the watch log AND uses Get-Content/ReadAll* — the
        # capture tails on $errPath/$outPath legitimately use Get-Content
        # and stay invisible to this guard.
        foreach ($line in ($text -split '\r?\n')) {
            if ($line -match 'Get-Content|ReadAll(Text|Lines|Bytes)') {
                $line | Should -Not -Match '\$WatchLogPath\b'
            }
        }
        # Positive controls — each primitive must be able to fire.
        $good = '$baseline = 1' + "`n" + 'Start-Process -FilePath x'
        $bad = 'Start-Process -FilePath x' + "`n" + '$baseline = 1'
        ($good.IndexOf('$baseline') -lt $good.IndexOf('Start-Process -FilePath')) | Should -BeTrue
        ($bad.IndexOf('$baseline') -lt $bad.IndexOf('Start-Process -FilePath')) | Should -BeFalse
        ([regex]::Matches('one Get-WatchLogAddition -WatchLogPath $WatchLogPath -OffsetBytes $baseline call', [regex]::Escape('Get-WatchLogAddition -WatchLogPath $WatchLogPath -OffsetBytes $baseline'))).Count | Should -Be 1
        'Get-Content -LiteralPath $WatchLogPath -Raw' | Should -Match 'Get-Content|ReadAll(Text|Lines|Bytes)'
        'Get-Content -LiteralPath $WatchLogPath -Raw' | Should -Match '\$WatchLogPath\b'
    }

    It 'an OLD START line naming the child pid cannot fake life (re-review, bloquant 1)' {
        # drain.log is never rotated and gains a START line per launch, and
        # Windows reuses pids: with a whole-file scan, an old line naming the
        # CURRENT child's pid reports a binding-death child as alive. The fix
        # reads only bytes appended after the launch. The pin needs the old
        # line to carry exactly the child's pid — unknowable before launch
        # and not derivable after — so pre-fill a pid BAND with stale lines.
        # The band covers 4..65535, but Windows pids are NOT bounded by 65535
        # (measured children at 69440…86348 on ai-01): when the child draws
        # outside the band this e2e proves nothing about the guard and says
        # so — Inconclusive, never a false verdict — while the unit pin
        # (offset read, fixed pid) and the AST pin (offset before launch)
        # carry the guarantee on every run. The child dies at binding; its
        # only trace is the binding error in stderr.
        $watch = Join-Path $script:DetachDir 'watch-collide.log'
        $band = for ($n = 4; $n -le 65535; $n++) {
            "[2026-10-05 00:00:00] START pid $n — drained restart begins (reason: old run)"
        }
        Set-Content -LiteralPath $watch -Value $band
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-bindfail.ps1') `
            -ExtraArgs @('-MustBeInt', 'not an int', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        # Coverage, not a lottery (re-review round 4): outside 4..65535 the
        # pre-filled band does not name the child and this e2e would prove
        # nothing — visible Inconclusive, never a false red or green.
        if ($r.ChildPid -lt 4 -or $r.ChildPid -gt 65535) {
            Remove-Item -LiteralPath $watch -Force -ErrorAction SilentlyContinue
            Set-ItResult -Inconclusive -Because ("child pid {0} fell outside the pre-filled 4..65535 band (Windows pids exceed 65535) — the unit and AST pins carry the guard" -f $r.ChildPid)
        }
        # With the offset-bounded read, the stale space is invisible and the
        # verdict is exited — never a falsified alive.
        $r.Ok | Should -BeFalse
        $r.Status | Should -Be 'exited'
        ($r.StderrTail -join "`n") | Should -Match 'ParameterArgumentTransformationError'
        Remove-Item -LiteralPath $watch -Force -ErrorAction SilentlyContinue
    }

    It 'a backslash run before an embedded quote round-trips exactly (re-review B3 residue)' {
        # The two-pass escape double-escaped `\"` (`a\\"b` became garbage or
        # a binding death): the one-pass rule must carry mixed
        # backslash+quote values through a REAL 5.1 child byte-for-byte.
        $watch = Join-Path $script:DetachDir 'watch-b3c.log'
        $reasonVal = 'a\\"b "still quoted"'      # 2-backslash run + quote, then a bare quote pair
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-dump-params.ps1') `
            -ExtraArgs @('-Reason', $reasonVal, '-EnvFile', 'D:\claudish shadow\.env', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeTrue
        $raw = Get-Content -LiteralPath $watch -Raw
        $raw | Should -Match ('reason=\[{0}\]' -f [regex]::Escape($reasonVal))
        $raw | Should -Match ([regex]::Escape('env=[D:\claudish shadow\.env]'))
    }

    It 'old drain-detach captures are pruned, fresh ones kept (review retention)' {
        $retHome = Join-Path $script:DetachDir 'retention'
        New-Item -ItemType Directory -Path $retHome -Force | Out-Null
        $oldOut = Join-Path $retHome 'drain-detach-20200101-000000-1.out.log'
        $oldErr = Join-Path $retHome 'drain-detach-20200101-000000-1.err.log'
        'x' | Set-Content -LiteralPath $oldOut
        'x' | Set-Content -LiteralPath $oldErr
        (Get-Item -LiteralPath $oldOut).LastWriteTime = (Get-Date).AddDays(-10)
        (Get-Item -LiteralPath $oldErr).LastWriteTime = (Get-Date).AddDays(-10)
        $watch = Join-Path $script:DetachDir 'watch-retention.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-ok.ps1') `
            -ExtraArgs @('-SpacedValue', 'v', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $retHome -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeTrue
        Test-Path -LiteralPath $oldOut | Should -BeFalse
        Test-Path -LiteralPath $oldErr | Should -BeFalse
        (Get-ChildItem -LiteralPath $retHome -Filter 'drain-detach-*.out.log' | Measure-Object).Count | Should -BeGreaterOrEqual 1
    }

    It 'an immediately-exiting child returns not-Ok with its stderr tail (AC1b/AC3c)' {
        $watch = Join-Path $script:DetachDir 'watch-exit.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-exit7.ps1') `
            -ExtraArgs @('-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeFalse
        $r.Status | Should -Be 'exited'
        $r.ExitCode | Should -Be 7
        ($r.StderrTail -join "`n") | Should -Match 'detach-child-boom'
        Test-Path -LiteralPath $r.StderrPath | Should -BeTrue
        # The child never wrote its line — the watch log must stay absent.
        Test-Path -LiteralPath $watch | Should -BeFalse
    }

    It 'a parameter-binding failure leaves its error in the stderr file (AC2)' {
        $watch = Join-Path $script:DetachDir 'watch-bind.log'
        $argStr = New-DetachArgumentString -Fixture (Join-Path $script:DetachDir 'child-bindfail.ps1') `
            -ExtraArgs @('-MustBeInt', 'not an int', '-WatchLog', $watch)
        $r = Start-DrainDetached -ArgumentString $argStr -ClaudishHomeDir $script:DetachDir -WatchLogPath $watch -TimeoutSec 25
        $r.Ok | Should -BeFalse
        # Binding dies BEFORE the script body: no watch-log line ever.
        Test-Path -LiteralPath $watch | Should -BeFalse
        # Locale-proof pin: the message text is localized (this machine's 5.1
        # says «Impossible de convertir…», not "Cannot convert") but the
        # FullyQualifiedErrorId is stable — it must appear in the evidence
        # file for the AC2 case to be tellable apart from a silent death.
        ($r.StderrTail -join "`n") | Should -Match 'ParameterArgumentTransformationError'
        Test-Path -LiteralPath $r.StderrPath | Should -BeTrue
    }

    It 'forwarded arguments are complete and the join quotes every element (AC1)' {
        $parts = Get-DrainDetachForwardedArguments -ScriptPath 'C:\some where\claudish-drain.ps1' `
            -Reason 'why not' -ContainerName 'claudish-proxy' -ProxyUrl 'http://localhost:3000' `
            -MaxWaitSec 600 -LogPath 'C:\logs with space\drain.log' -ClaudishHome 'C:\home dir' `
            -EnvFile 'D:\env dir\hub.env' -Recreate -RemoveCreatedTwins
        $parts[-1] | Should -Be '-RemoveCreatedTwins'
        $parts | Should -Not -Contain '-Detach'   # no recursion: the child is a plain drain run
        $joined = Join-DrainDetachArguments $parts
        # Every element — names AND values — carries its own quotes: the 5.1
        # -ArgumentList join adds none, so ours must be visible per element.
        foreach ($p in $parts) {
            $joined | Should -Match ('"' + [regex]::Escape($p) + '"')
        }
    }

    It 'zero-actuator: the detach functions AND entry branch launch no docker/Restart/Stop of their own (AC5 + review)' {
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:DrainScript, [ref]$tokens, [ref]$errors)
        $names = @('Join-DrainDetachArguments', 'Start-DrainDetached', 'Get-DrainDetachForwardedArguments', 'Get-WatchLogAddition')
        $bodies = @($ast.FindAll({ param($n)
                $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name
            }, $true))
        # A filter that matched nothing would prove nothing: all four must be found.
        $bodies.Count | Should -Be 4
        # Review of #338: \bdocker\b, not just docker stop|restart|kill — AC5
        # says NO container-engine call at all, of any verb.
        $forbidden = 'Restart-\w|Stop-\w|\bdocker\b|-Verb\s+RunAs'
        foreach ($b in $bodies) {
            $b.Extent.Text | Should -Not -Match $forbidden
        }
        # The operator-facing if ($Detach) branch too (review: the guard
        # covered only the functions, never the entry block). The branch is
        # delimited by markers; a missing marker fails the test rather than
        # silently scanning nothing.
        function Get-MarkedSliceText {
            # Same extraction the assertion uses, factored out so the
            # positive control exercises the EXTRACTION, not just the regex.
            param([string]$Text, [string]$BeginMarker, [string]$EndMarker)
            $b = $Text.IndexOf($BeginMarker)
            $e = $Text.IndexOf($EndMarker)
            if ($b -lt 0 -or $e -le $b) { return $null }
            return $Text.Substring($b, $e - $b)
        }
        $raw = [System.IO.File]::ReadAllText($script:DrainScript)
        $slice = Get-MarkedSliceText -Text $raw -BeginMarker '# <drain-detach-entry>' -EndMarker '# </drain-detach-entry>'
        $slice | Should -Not -BeNullOrEmpty   # markers missing -> guard scanned nothing
        $slice | Should -Not -Match $forbidden
        # Positive controls. The regex fires on actuators of every class —
        # and the EXTRACTION itself is proven by a doctored text: an actuator
        # INSIDE the markers must surface in the slice, one OUTSIDE must not
        # (the slice boundary is what the control checks).
        'function f { Stop-Service -Name x }' | Should -Match $forbidden
        'if ($Detach) { docker ps }' | Should -Match $forbidden
        $doctored = 'pre # <drain-detach-entry> harmless # </drain-detach-entry> post docker ps'
        $doctoredSlice = Get-MarkedSliceText -Text $doctored -BeginMarker '# <drain-detach-entry>' -EndMarker '# </drain-detach-entry>'
        $doctoredSlice | Should -Not -Match $forbidden                 # outside the slice -> invisible
        $doctored2 = 'pre # <drain-detach-entry> docker ps # </drain-detach-entry> post'
        (Get-MarkedSliceText -Text $doctored2 -BeginMarker '# <drain-detach-entry>' -EndMarker '# </drain-detach-entry>') | Should -Match $forbidden   # inside -> caught
    }
}
