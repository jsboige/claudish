#requires -Version 5.1
<#
    Runner-level seat-env hermeticity (#1166).

    With CLAUDISH_GDRIVE_ROOT armed, a script invoked WITHOUT -GDriveDir
    resolves its off-site dir to the REAL store (compress-captures.ps1:140-142)
    — measured by ai-01 on the #1160 replay (c.7083536044). Per-suite save/
    clear/restore (the exit/slot suites) covers the scripts THEY call; the
    runner reset (#1166) is the net for every future suite that forgets.

    Three pins:
      1. the wrapper run-pester.ps1, executed under an ARMED sentinel root,
         leaves that sentinel EMPTY (child env form cleared) and RESTORES the
         seat env on exit;
      2. run-pester51.ps1 carries the same reset block (source-level pin —
         both entry points reach Invoke-Pester, the CI pwsh leg included);
      3. MUTATION PIN, red on its own premise: with an ARMED root and NO
         runner reset, the sentinel would receive a file — this is the same
         proof under which removing the wrapper's reset makes pin 1 fail.

    Everything runs in temp dirs; the sentinel is NOT the seat's real store.
#>
BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Wrapper = Join-Path $PSScriptRoot 'run-pester.ps1'
    $script:Runner51 = Join-Path $PSScriptRoot 'run-pester51.ps1'
    $script:Compaction = Join-Path $script:RepoRoot 'scripts\compress-captures.ps1'

    function New-Fake7z {
        # Verbatim the fake-7z harness of compress-captures-slot.Tests.ps1
        # (#1160): the real 7z argument contract (TARGET = the .7z arg,
        # @listfile existence checks, t answers from existence).
        param([string]$Dir)
        $p = Join-Path $Dir 'fake7z.cmd'
        $body = @(
            '@echo off'
            'setlocal EnableDelayedExpansion'
            'set "MODE=%~1"'
            'set "TARGET="'
            'set "LAST="'
            'for %%F in (%*) do ('
            '  if /i "%%~xF"==".7z" set "TARGET=%%~fF"'
            '  set "LAST=%%~F"'
            ')'
            'set "AT=!LAST:~0,1!"'
            'if "!AT!"=="@" ('
            '  set "LF=!LAST:~1!"'
            '  if not exist "!LF!" exit /b 3'
            '  for /f "usebackq delims=" %%N in ("!LF!") do ('
            '    if not exist "%%~N" exit /b 2'
            '  )'
            ')'
            'if /i "!MODE!"=="a" goto add'
            'if /i "!MODE!"=="t" goto test'
            'exit /b 1'
            ':add'
            'if not defined TARGET exit /b 1'
            'echo fake> "!TARGET!"'
            'exit /b 0'
            ':test'
            'if not defined TARGET exit /b 2'
            'if not exist "!TARGET!" exit /b 2'
            'exit /b 0'
            ''
        ) -join "`r`n"
        [System.IO.File]::WriteAllText($p, $body, (New-Object System.Text.ASCIIEncoding))
        return $p
    }

    function Invoke-CompactionUnpinned {
        # The unpinned form: -GDriveDir is NOT passed, exactly what the slot
        # suite did before its own save/clear/restore (review c.7083536044).
        param([string]$CapDir, [string]$ArchDir, [string]$SevenZip)
        $shell = (Get-Process -Id $PID).Path
        & $shell -NoProfile -ExecutionPolicy Bypass -File $script:Compaction `
            -CaptureDir $CapDir -ArchiveDir $ArchDir -SevenZip $SevenZip `
            -ProgressHeartbeatSec 0 -MachineTag 'testtag' 2>&1 | ForEach-Object { "$_" }
    }

    function New-OldCapture {
        param([string]$Dir)
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        $p = Join-Path $Dir 'req-1-1-2026-11-20T10-00-00-direct.json'
        [System.IO.File]::WriteAllText($p, '{"stub":true}', (New-Object System.Text.UTF8Encoding($false)))
        (Get-Item -LiteralPath $p).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)
        return $p
    }
}

Describe 'runner hermeticity (#1166)' {

    It 'run-pester.ps1 clears the armed root for the child and restores the seat env' {
        $sentinel = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-herm-sentinel-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $sentinel | Out-Null
        $cap = Join-Path $sentinel 'captures'; $arch = Join-Path $sentinel 'arch'
        New-OldCapture -Dir $cap | Out-Null
        $fake7z = New-Fake7z -Dir $sentinel
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        $savedWatch = $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN
        $env:CLAUDISH_GDRIVE_ROOT = $sentinel
        try {
            # A probe suite in a scratch dir dumps the env the wrapper's
            # Invoke-Pester session actually sees (pointing -Path at THIS
            # file's dir would recurse into ourselves).
            $emptyDir = Join-Path $sentinel 'emptytests'
            New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
            $probe = Join-Path $emptyDir 'probe.Tests.ps1'
            $outFile = Join-Path $sentinel 'child-env.json'
            $probeBody = @(
                "Describe 'env probe' {"
                "  It 'dumps env' {"
                "    @{ root = [Environment]::GetEnvironmentVariable('CLAUDISH_GDRIVE_ROOT'); watch = [Environment]::GetEnvironmentVariable('CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN') } | ConvertTo-Json | Set-Content -LiteralPath '$outFile' -Encoding UTF8"
                "  }"
                "}"
            )
            [System.IO.File]::WriteAllLines($probe, $probeBody, [System.Text.Encoding]::UTF8)
            $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN = 'sentinel-pattern'
            & $script:Wrapper -Path $emptyDir *> $null
            $childEnv = Get-Content -LiteralPath $outFile -Raw | ConvertFrom-Json
            $childEnv.root | Should -BeNullOrEmpty
            $childEnv.watch | Should -BeNullOrEmpty
            # Restore contract: the seat's armed values are back after the run.
            $env:CLAUDISH_GDRIVE_ROOT | Should -Be $sentinel
            $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN | Should -Be 'sentinel-pattern'
        }
        finally {
            $env:CLAUDISH_GDRIVE_ROOT = $savedRoot
            $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN = $savedWatch
            Remove-Item -Recurse -Force $sentinel -ErrorAction SilentlyContinue
        }
    }

    It 'run-pester51.ps1 carries the same reset block (source pin)' {
        $src = Get-Content -LiteralPath $script:Runner51 -Raw
        $src | Should -Match 'CLAUDISH_GDRIVE_ROOT'
        $src | Should -Match 'CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN'
        $src | Should -Match 'finally'
    }

    It 'MUTATION PREMISE: armed root + NO reset = an off-site deposit (red if the underlying behavior changed)' {
        $sentinel = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-herm-armed-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $sentinel | Out-Null
        $cap = Join-Path $sentinel 'captures'; $arch = Join-Path $sentinel 'arch'
        New-OldCapture -Dir $cap | Out-Null
        $fake7z = New-Fake7z -Dir $sentinel
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        $env:CLAUDISH_GDRIVE_ROOT = $sentinel
        try {
            # The off-site dir must EXIST: an unmounted/uncreated root defers
            # the copy (compress-captures.ps1's mounted check) — on ai-01 the
            # REAL store dir exists, so the deposit lands. Pre-create it.
            New-Item -ItemType Directory -Force -Path (Join-Path $sentinel 'Backups-Cloud\claudish') | Out-Null
            Invoke-CompactionUnpinned -CapDir $cap -ArchDir $arch -SevenZip $fake7z | Out-Null
            $gd = Join-Path $sentinel 'Backups-Cloud\claudish'
            $deposits = @(Get-ChildItem -Recurse -File -LiteralPath $gd -ErrorAction SilentlyContinue)
            # The off-site store received files = the deposit the runner reset
            # exists to prevent. If this assertion ever fails, compress-captures
            # stopped resolving the env fallback and pin 1 needs a new target.
            $deposits.Count | Should -BeGreaterThan 0
        }
        finally {
            $env:CLAUDISH_GDRIVE_ROOT = $savedRoot
            Remove-Item -Recurse -Force $sentinel -ErrorAction SilentlyContinue
        }
    }
}
