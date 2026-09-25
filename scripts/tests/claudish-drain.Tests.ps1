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
}
