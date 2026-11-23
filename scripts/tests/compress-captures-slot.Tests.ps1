#requires -Version 5.1
<#
    compress-captures.ps1 slot mode (#1152 c — rolling loose window).

    Pins the four behaviours the coordinator's decision (c.7076270061) makes
    contractual, end to end on the REAL script with a FAKE 7z (the harness
    pattern of compress-captures-exit.Tests.ps1):

      1. part naming  — a slot run packs into captures-<day>-p<HHMM>[-<tag>].7z
                        (day = the FILE's day, HHMM = the pass's UTC time);
      2. W window     — a capture younger than -RollingWindowHours stays loose;
      3. mtime guard  — a capture whose mtime is younger than -MinLooseAgeMinutes
                        is NEVER packed, whatever its filename says;
      4. verify-before-delete — a part whose 7z test FAILS leaves the loose
                        originals on disk (nothing is ever deleted unverified);
      5. default unchanged    — the same old capture is NOT packed by a run
                        without -SlotMode (nightly keeps completed days only).

    The fake 7z behaves like the real one where these pins bite: on `a` it
    reads the @listfile, checks every listed BARE name in its working
    directory, writes the archive, exits 0; on `t` it answers from existence.
    A second variant always FAILS `t` (exit 2) for pin 4.
#>

BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:CompactionScript = Join-Path $script:RepoRoot 'scripts\compress-captures.ps1'
    Import-Module (Join-Path $script:RepoRoot 'scripts\lib\claudish-engine.psm1') -Force -DisableNameChecking

    # Helpers live HERE, not at file top level: a Pester v6 container runs
    # Its in a script scope that does not see the file's top-level functions
    # (measured trap, scripts/tests memory pester-traps).
    function Invoke-SlotRun {
        param(
            [string]$CapDir, [string]$ArchDir,
            [string]$GdDir,
            [string]$SevenZip,
            [switch]$SlotMode,
            [int]$W = 6,
            [int]$MinAge = 30
        )
        $shell = (Get-Process -Id $PID).Path
        $args_ = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:CompactionScript,
                   '-CaptureDir', $CapDir, '-ArchiveDir', $ArchDir,
                   '-SevenZip', $SevenZip, '-ProgressHeartbeatSec', 0,
                   '-MachineTag', 'testtag',
                   '-GDriveDir', $GdDir,
                   # Retention never purges a fixture (CR c.7088215899): -GDriveDir
                   # arms the local purge, default KeepLocalDays=0 cuts at today
                   # 00:00Z, and a now-10h fixture lands on the previous day --
                   # pin 1 goes red every day between 00:00Z and ~10:00Z, CI
                   # included. Negative = purge disabled (compress-captures.ps1:727).
                   '-KeepLocalDays', '-1')
        if ($SlotMode) {
            $args_ += @('-SlotMode', '-RollingWindowHours', $W, '-MinLooseAgeMinutes', $MinAge)
        }
        # Hermetic (review c.7083536044): without BOTH the explicit -GDriveDir
        # and a cleared root, a seat where CLAUDISH_GDRIVE_ROOT is set resolves
        # GDriveDir to the REAL off-site store (compress-captures.ps1:170-171)
        # and the test deposits there -- measured on ai-01, 3 stray files and
        # pin 3 red under both interpreters (the quarantine purge then sees
        # off-site canonicals). Same save/clear/restore as the exit suite.
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        $env:CLAUDISH_GDRIVE_ROOT = $null
        try {
            & $shell @args_ 2>&1 | ForEach-Object { "$_" }
        }
        finally {
            $env:CLAUDISH_GDRIVE_ROOT = $savedRoot
        }
    }

    function New-CaptureFixture {
        param([string]$Dir, [string]$Ts, [switch]$FreshMtime)
        $fn = "req-1-1-$Ts-direct.json"
        $p = Join-Path $Dir $fn
        [System.IO.File]::WriteAllText($p, '{"stub":true}', (New-Object System.Text.UTF8Encoding($false)))
        if (-not $FreshMtime) {
            # The slot mtime guard would otherwise exclude EVERY fixture the test
            # just created: a packed-eligible capture needs an mtime older than
            # the guard window. Age it by 2 hours (guard default 30 min).
            (Get-Item -LiteralPath $p).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)
        }
        return $p
    }

    # --- the good fake (pack ok, test ok) ------------------------------------
    $script:FakeDir = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("cc-slot-" + [guid]::NewGuid().ToString('N')))
    $script:Fake7z = Join-Path $script:FakeDir 'fake7z.cmd'
    $fakeBody = @(
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
    [System.IO.File]::WriteAllText($script:Fake7z, $fakeBody, (New-Object System.Text.ASCIIEncoding))

    # --- the failing-test variant (pack ok, test ALWAYS rc=2) ----------------
    $script:Fake7zFailTest = Join-Path $script:FakeDir 'fake7z-failtest.cmd'
    $failBody = @(
        '@echo off'
        'if /i "%~1"=="t" exit /b 2'
        'call "' + $script:Fake7z + '" %*'
        'exit /b %ERRORLEVEL%'
        ''
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($script:Fake7zFailTest, $failBody, (New-Object System.Text.ASCIIEncoding))
}
AfterAll {
    Remove-Item -Recurse -Force $script:FakeDir -ErrorAction SilentlyContinue
}

Describe 'compress-captures slot mode (#1152 c)' {
    BeforeEach {
        $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("cc-slot-run-" + [guid]::NewGuid().ToString('N')))
        $script:Cap = Join-Path $tmp 'captures'; $script:Arch = Join-Path $tmp 'arch'; $script:Gd = Join-Path $tmp 'gdrive'
        New-Item -ItemType Directory -Force -Path $script:Cap, $script:Arch, $script:Gd | Out-Null
        # A "now" anchored INSIDE the test: every fixture ts derives from it,
        # so the W window (6 h) has deterministic young/old sides.
        $script:NowUtc = (Get-Date).ToUniversalTime()
    }
    AfterEach {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    It 'packs the old slice into a day part named for the pass, keeps the W-young capture loose' {
        # Old: 10 h before now — eligible. Young: 1 h before now — inside W.
        $oldTs = $script:NowUtc.AddHours(-10).ToString('yyyy-MM-ddTHH-mm-ss-000Z')
        $youngTs = $script:NowUtc.AddHours(-1).ToString('yyyy-MM-ddTHH-mm-ss-000Z')
        $oldFn = (New-CaptureFixture -Dir $script:Cap -Ts $oldTs | Split-Path -Leaf)
        $youngFn = (New-CaptureFixture -Dir $script:Cap -Ts $youngTs | Split-Path -Leaf)
        $day = $oldTs.Substring(0, 10)

        $null = Invoke-SlotRun -CapDir $script:Cap -ArchDir $script:Arch -GdDir $script:Gd -SevenZip $script:Fake7z -SlotMode

        $parts = @(Get-ChildItem -LiteralPath $script:Arch -Filter "captures-$day-p*.7z" -File)
        $parts.Count | Should -Be 1
        $parts[0].Name | Should -Match "^captures-$day-p\d{4}-testtag\.7z$"
        # The part belongs to the FILE's day (not the pass's day), and its
        # slot/tag round-trip through the lib parsers.
        $info = Get-CapturePartInfo -Name $parts[0].Name
        $info.Day | Should -Be $day
        $info.Tag | Should -Be 'testtag'
        (Get-CaptureArchiveDay -Name $parts[0].Name) | Should -BeNullOrEmpty   # a part is NOT the day archive
        # Loose originals: old removed, young kept.
        (Test-Path -LiteralPath (Join-Path $script:Cap $oldFn)) | Should -BeFalse
        (Test-Path -LiteralPath (Join-Path $script:Cap $youngFn)) | Should -BeTrue
        # Hermeticity pinned (review c.7083536044): the off-site deposit lands
        # in the TEST's gdrive dir -- the part and its sha256 manifest, nothing
        # else -- so a future edit dropping -GDriveDir or the cleared root turns
        # THIS red (the deposit goes missing or picks up strangers) instead of
        # leaking silently into the real store.
        $gdFiles = @(Get-ChildItem -LiteralPath $script:Gd -Recurse -File)
        $gdFiles.Count | Should -Be 2
        ($gdFiles | Where-Object { $_.Name -match '^captures-.+-p\d{4}-testtag\.7z$' }).Count | Should -Be 1
        ($gdFiles | Where-Object { $_.Name -eq 'captures-sha256-testtag.jsonl' }).Count | Should -Be 1
    }

    It 'never packs a capture whose mtime is younger than the guard, whatever its filename says' {
        # Filename says 10 h ago; mtime says "just written" — a resp still open.
        $oldTs = $script:NowUtc.AddHours(-10).ToString('yyyy-MM-ddTHH-mm-ss-000Z')
        $fn = (New-CaptureFixture -Dir $script:Cap -Ts $oldTs -FreshMtime | Split-Path -Leaf)

        $null = Invoke-SlotRun -CapDir $script:Cap -ArchDir $script:Arch -GdDir $script:Gd -SevenZip $script:Fake7z -SlotMode

        @(Get-ChildItem -LiteralPath $script:Arch -Filter 'captures-*-p*.7z' -File).Count | Should -Be 0
        (Test-Path -LiteralPath (Join-Path $script:Cap $fn)) | Should -BeTrue
    }

    It 'keeps the loose originals when the part fails its 7z test (verify before delete)' {
        $oldTs = $script:NowUtc.AddHours(-10).ToString('yyyy-MM-ddTHH-mm-ss-000Z')
        $fn = (New-CaptureFixture -Dir $script:Cap -Ts $oldTs | Split-Path -Leaf)

        $out = Invoke-SlotRun -CapDir $script:Cap -ArchDir $script:Arch -GdDir $script:Gd -SevenZip $script:Fake7zFailTest -SlotMode

        ($out -join "`n") | Should -Match 'KEEPING loose files'
        (Test-Path -LiteralPath (Join-Path $script:Cap $fn)) | Should -BeTrue
        # The failed part was quarantined out of the canonical part name.
        @(Get-ChildItem -LiteralPath $script:Arch -Filter 'captures-*-p*.7z' -File).Count | Should -Be 0
        @(Get-ChildItem -LiteralPath $script:Arch -Filter 'captures-*-p*.7z.partial-*' -File).Count | Should -Be 1
    }

    It 'without -SlotMode a same-day capture is NOT packed (nightly keeps completed days only)' {
        # Ts at TODAY's midnight: old enough that the W window would take it
        # (the slot pins above), but its DAY is not completed, so the nightly
        # path must leave it loose. Anchoring on today 00:00 (never a past
        # day, whatever the wall clock is at run time) is what makes the pin
        # deterministic across the midnight boundary.
        $todayTs = $script:NowUtc.Date.ToString('yyyy-MM-ddT00-00-00-000Z')
        $fn = (New-CaptureFixture -Dir $script:Cap -Ts $todayTs | Split-Path -Leaf)

        $null = Invoke-SlotRun -CapDir $script:Cap -ArchDir $script:Arch -GdDir $script:Gd -SevenZip $script:Fake7z

        @(Get-ChildItem -LiteralPath $script:Arch -Filter 'captures-*.7z' -File).Count | Should -Be 0
        (Test-Path -LiteralPath (Join-Path $script:Cap $fn)) | Should -BeTrue
    }
}
