#requires -Version 5.1
<#
    Runner-level seat-env hermeticity (#1166).

    With CLAUDISH_GDRIVE_ROOT armed, a script invoked WITHOUT -GDriveDir
    resolves its off-site dir to the REAL store (compress-captures.ps1:140-142)
    — measured by ai-01 on the #1160 replay (c.7083536044). Per-suite save/
    clear/restore (the exit/slot suites) covers the scripts THEY call; the
    runner reset (#1166) is the net for every future suite that forgets.

    Five pins (the fourth answers ai-01's file-23a addendum; the fifth answers
    the #1167 coordinator review, c.7093151774):
      1. the wrapper run-pester.ps1, executed under an ARMED sentinel root,
         leaves that sentinel EMPTY (child env form cleared) and RESTORES the
         seat env on exit;
      2. run-pester51.ps1 carries the same reset block (source-level pin —
         both entry points reach Invoke-Pester, the CI pwsh leg included);
      3. MUTATION PIN, red on its own premise: with an ARMED root and NO
         runner reset, the sentinel would receive a file — this is the same
         proof under which removing the wrapper's reset makes pin 1 fail;
      4. DATE-DEPENDENT PARAMETERS: -GDriveDir passed EXPLICITLY in a test
         also arms the local retention purge (KeepLocalDays=0 default,
         compress-captures.ps1:727-746): an archive older than the cutoff,
         confirmed off-site at the same size, is DELETED locally. The runner
         env reset cannot help there (the parameter is explicit): this pin
         measures the destructive premise, so a suite combining -GDriveDir
         with a REAL -ArchiveDir knows exactly what it arms. Sentinel dirs
         only; the fake off-site copy is planted byte-identical BY the test.
      5. BEHAVIOURAL pin for run-pester51.ps1 (pin 2 is source-only, and the
         review's mutation M2 — reset line removed from the 5.1 runner —
         SURVIVED it): a real powershell.exe child runs the 5.1 runner on a
         throwaway probe suite; the probe must see an EMPTY root and pattern,
         and the calling process must see the seat values RESTORED after the
         call (the CI leg dot-calls this file, so the finally restore must
         hold in-process).

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

    function New-ProbeSuite {
        # A throwaway Pester suite that dumps the env ITS Invoke-Pester
        # session actually sees. Shared by the 7.x wrapper pin (pin 1) and
        # the 5.1 behavioural pin (pin 5, #1167 review).
        param([string]$Dir, [string]$OutFile)
        $probe = Join-Path $Dir 'probe.Tests.ps1'
        $probeBody = @(
            "Describe 'env probe' {"
            "  It 'dumps env' {"
            "    @{ root = [Environment]::GetEnvironmentVariable('CLAUDISH_GDRIVE_ROOT'); watch = [Environment]::GetEnvironmentVariable('CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN') } | ConvertTo-Json | Set-Content -LiteralPath '$OutFile' -Encoding UTF8"
            "  }"
            "}"
        )
        [System.IO.File]::WriteAllLines($probe, $probeBody, [System.Text.Encoding]::UTF8)
        return $probe
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
            $outFile = Join-Path $sentinel 'child-env.json'
            New-ProbeSuite -Dir $emptyDir -OutFile $outFile | Out-Null
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

    It 'run-pester51.ps1 CLEARS the armed root in a real 5.1 child and RESTORES it (behavioural, #1167 review)' {
        # Coordinator CR c.7093151774: the source pin above lets a mutant
        # that NAMES the variables but no longer clears them pass (mutation
        # M2, reset line removed from the 5.1 runner, SURVIVED it). This pin
        # EXECUTES run-pester51.ps1 under a real powershell.exe child:
        #   - the probe suite (inside the child's Invoke-Pester) must see an
        #     EMPTY root and pattern => the reset really ran;
        #   - the calling 5.1 process must see the seat values AGAIN after
        #     the call => the finally restore holds in-process (the CI leg
        #     dot-calls this runner, a leak would outlive the run).
        if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
            Set-ItResult -Skipped -Because 'powershell.exe absent on this runner: the 5.1 lane cannot exist here'
            return
        }
        $sentinel = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-herm51-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $sentinel | Out-Null
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        $savedWatch = $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN
        try {
            $emptyDir = Join-Path $sentinel 'emptytests'
            New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
            $outFile = Join-Path $sentinel 'child-env51.json'
            New-ProbeSuite -Dir $emptyDir -OutFile $outFile | Out-Null
            $afterFile = Join-Path $sentinel 'after-env51.json'
            $env:CLAUDISH_GDRIVE_ROOT = $sentinel
            $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN = 'sentinel-pattern'
            # Single-quoted layout on purpose: $env: must reach the child
            # UNEXPANDED (double quotes would interpolate the parent's values
            # into the command text).
            $cmd = "& '{0}' -Path '{1}'; @{{ root = `$env:CLAUDISH_GDRIVE_ROOT; watch = `$env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN }} | ConvertTo-Json | Set-Content -LiteralPath '{2}' -Encoding UTF8" -f $script:Runner51, $emptyDir, $afterFile
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $cmd *> $null
            $childEnv = Get-Content -LiteralPath $outFile -Raw | ConvertFrom-Json
            $childEnv.root | Should -BeNullOrEmpty
            $childEnv.watch | Should -BeNullOrEmpty
            $afterEnv = Get-Content -LiteralPath $afterFile -Raw | ConvertFrom-Json
            $afterEnv.root | Should -Be $sentinel
            $afterEnv.watch | Should -Be 'sentinel-pattern'
        }
        finally {
            $env:CLAUDISH_GDRIVE_ROOT = $savedRoot
            $env:CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN = $savedWatch
            Remove-Item -Recurse -Force $sentinel -ErrorAction SilentlyContinue
        }
    }

    It 'DATE PARAMETERS: explicit -GDriveDir arms the local retention purge (KeepLocalDays=0 deletes off-site-confirmed archives)' {
        # ai-01 file 23a: the inventory must cover date-dependent PARAMETERS,
        # not only env vars. With -GDriveDir explicit, compress-captures.ps1
        # runs its retention purge (:727-746) with KeepLocalDays=0 by default:
        # cutoff = todayUTC, so ANY archive of a past day whose off-site copy
        # exists at the same size is deleted from -ArchiveDir. A suite passing
        # its REAL ArchiveDir next to a sentinel -GDriveDir would delete real
        # history. Everything below lives in sentinel temp dirs.
        $sentinel = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-herm-retent-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $sentinel | Out-Null
        $cap = Join-Path $sentinel 'captures'; $arch = Join-Path $sentinel 'arch'
        $gd = Join-Path $sentinel 'Backups-Cloud\claudish'
        New-Item -ItemType Directory -Force -Path $gd | Out-Null
        New-OldCapture -Dir $cap | Out-Null
        $fake7z = New-Fake7z -Dir $sentinel
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        Remove-Item Env:CLAUDISH_GDRIVE_ROOT -ErrorAction SilentlyContinue
        try {
            # Plant an old local archive AND its byte-identical off-site copy:
            # exactly the purge precondition of :738. 2026-11-01 is 22 days
            # old, strictly before the KeepLocalDays=0 cutoff (todayUTC).
            $oldName = 'captures-2026-11-01-testtag.7z'
            $oldArch = Join-Path $arch $oldName
            New-Item -ItemType Directory -Force -Path $arch | Out-Null
            [System.IO.File]::WriteAllText($oldArch, 'oldarchive', (New-Object System.Text.ASCIIEncoding))
            [System.IO.File]::WriteAllText((Join-Path $gd $oldName), 'oldarchive', (New-Object System.Text.ASCIIEncoding))
            $shell = (Get-Process -Id $PID).Path
            & $shell -NoProfile -ExecutionPolicy Bypass -File $script:Compaction `
                -CaptureDir $cap -ArchiveDir $arch -SevenZip $fake7z -GDriveDir $gd `
                -ProgressHeartbeatSec 0 -MachineTag 'testtag' 2>&1 | ForEach-Object { "$_" } | Out-Null
            # The destructive premise, measured: the old archive is GONE.
            (Test-Path -LiteralPath $oldArch) | Should -BeFalse
            # Its off-site copy survives (the purge never deletes off-site).
            (Test-Path -LiteralPath (Join-Path $gd $oldName)) | Should -BeTrue
        }
        finally {
            if ($null -ne $savedRoot) { $env:CLAUDISH_GDRIVE_ROOT = $savedRoot }
            Remove-Item -Recurse -Force $sentinel -ErrorAction SilentlyContinue
        }
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
