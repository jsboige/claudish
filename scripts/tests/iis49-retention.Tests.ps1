# Pins for scripts/iis49-retention.ps1 — ACK ai-01 10/11 00:09Z (policy + cadence (a)).
# Guards: (1) today/yesterday never in the purge lot, by NAME; (2) 7z t failure refuses;
# (3) a drive copy that does not verify refuses; (4) a path outside W3SVC49 refuses;
# (5) per-file membership proof (CR #965) — a purged name missing from the drive
#     archive's `7z l -slt` listing, or archived at the wrong size, refuses the
#     ENTIRE purge (7z t + sha prove the archive is sound, not that it is complete).
# The script runs as a CHILD process (the repo pattern, see claudish-capture-archive.Tests.ps1);
# exit codes are asserted from the value Invoke-Retention RETURNS ($LASTEXITCODE does not
# survive the function boundary).
# 7z is stubbed with .cmd files — the stub finds its archive path as the ONE arg
# ending in ".7z". NOT "first non-dash arg": cmd's `for %%A in (%*)` splits on "="
# as a delimiter, so `-mx=5` yields a bare `5` token which would win that race
# (measured: stub built "5" as the archive path). a, t and l each pass exactly one .7z.

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\iis49-retention.ps1')).ProviderPath
    $script:Exe = (Get-Process -Id $PID).Path

    # a temp W3SVC49 with a deterministic file set, dates relative to today.
    # 8 dated files (today, yesterday, J-2, J-3, 33d, 35d, 40d, 40d_x) + 1 unparseable = 9.
    function New-FakeSite {
        $root = Join-Path ([System.IO.Path]::GetTempPath()) ("iis49-{0}" -f ([guid]::NewGuid().ToString('N')))
        $site = Join-Path $root 'W3SVC49'
        $drive = Join-Path $root 'drive'
        New-Item -ItemType Directory -Path $site, $drive -Force | Out-Null
        $today = [DateTime]::Now.Date
        $spec = @(0, 1, 2, 3, 33, 35, 40)
        $made = @{}
        foreach ($days in $spec) {
            $name = 'u_ex{0:yyMMdd}.log' -f $today.AddDays(-$days)
            $p = Join-Path $site $name
            [System.IO.File]::WriteAllText($p, ("log-body-" + $name + "`r`n") * 3)
            $made[$name] = $p
        }
        $xname = 'u_ex{0:yyMMdd}_x.log' -f $today.AddDays(-40)
        $xp = Join-Path $site $xname
        [System.IO.File]::WriteAllText($xp, ("log-body-" + $xname + "`r`n") * 3)
        $made[$xname] = $xp
        # unparseable by design: Feb 30 does not exist
        $weird = Join-Path $site 'u_ex260230.log'
        [System.IO.File]::WriteAllText($weird, "unparseable`r`n")
        $made['u_ex260230.log'] = $weird
        return @{ Site = $site; Drive = $drive; Files = $made; Root = $root }
    }

    function New-Stub7z {
        # HONEST stub (CR #965): `a` records `name|size` for every .log argument
        # (minus the optional omission/shrink), `l` renders them as 7z -slt
        # blocks, `t` keeps its three verdict modes. The archive file is plain
        # text — the script never opens it as real 7z, it reads the LISTING.
        param(
            [Parameter(Mandatory)][string]$Dir,
            [ValidateSet('ok','t-fails','t-mangles')][string]$Mode = 'ok',
            [string]$OmitName = '',      # a-mode skips this file (membership hole)
            [string]$ShrinkName = ''     # a-mode records size 1 for this file (size gap)
        )
        $stub = Join-Path $Dir 'stub-7z.cmd'
        $omit   = if ($OmitName)   { $OmitName }   else { '@@no-omit@@' }
        $shrink = if ($ShrinkName) { $ShrinkName } else { '@@no-shrink@@' }
        $body = @(
            '@echo off',
            'setlocal enabledelayedexpansion',
            'set verb=%1',
            'set arch=',
            'for %%A in (%*) do (',
            '  set "arg=%%A"',
            '  if "!arg:~-3!"==".7z" set "arch=!arg!"',
            ')',
            'if "%verb%"=="a" (',
            '  del "!arch!" 2>nul',
            '  for %%A in (%*) do (',
            '    set "arg=%%A"',
            '    if "!arg:~-4!"==".log" (',
            '      for %%Z in ("!arg!") do (',
            '        set "skip=0"',
            ('        if /I "%%~nxZ"=="' + $omit + '" set "skip=1"'),
            '        if "!skip!"=="0" (',
            ('          if /I "%%~nxZ"=="' + $shrink + '" (set "sz=1") else (set "sz=%%~zZ")'),
            '          echo %%~nxZ^|!sz!>> "!arch!"',
            '        )',
            '      )',
            '    )',
            '  )',
            '  exit /b 0',
            ')',
            'if "%verb%"=="l" (',
            '  for /f "usebackq delims=" %%L in ("!arch!") do (',
            '    for /f "tokens=1,2 delims=|" %%N in ("%%L") do (',
            '      echo Path = %%N',
            '      echo Size = %%O',
            '    )',
            '  )',
            '  exit /b 0',
            ')',
            'if "%verb%"=="t" ('
        )
        if ($Mode -eq 'ok')          { $body += '  exit /b 0' }
        elseif ($Mode -eq 't-fails') { $body += '  exit /b 2' }
        else                         { $body += @( '  echo MANGLED>> "!arch!"', '  exit /b 0' ) }
        $body += ')'
        $body += 'exit /b 0'
        [System.IO.File]::WriteAllText($stub, ($body -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
        return $stub
    }

    # returns the child's EXIT CODE; its output lands in $Out (array of lines)
    function Invoke-Retention {
        param([hashtable]$Params, [ref]$Out)
        $cli = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:ScriptPath)
        foreach ($k in @($Params.Keys)) {
            if ($k -eq 'WhatIf') { continue }
            $cli += @("-$k", "$($Params[$k])")
        }
        if ($Params.ContainsKey('WhatIf')) { $cli += '-WhatIf' }
        $o = & $script:Exe @cli 2>&1 | ForEach-Object { "$_" }
        if ($Out) { $Out.Value = @($o) }
        return $LASTEXITCODE
    }
}

Describe 'iis49-retention' {
    Context 'guard: selection by NAME (ACK G1)' {
        It 'lists exactly the four >30d files under -WhatIf and writes nothing' {
            $f = New-FakeSite
            $out = $null
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok'
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t1.7z'; WhatIf = $true
                } -Out ([ref]$out)
                $code | Should -Be 0
                $purgeLines = @()
                foreach ($l in $out) { if ($l -match 'WOULD PURGE (u_ex\S+\.log)') { $purgeLines += $Matches[1] } }
                @($purgeLines).Count | Should -Be 4                       # 33d, 35d, 40d, 40d_x
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date)
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-1))
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-2))
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-3))
                @($out | Where-Object { $_ -match 'ignored .unparseable name' }) | Should -Not -BeNullOrEmpty
                # writes NOTHING: no staging, no drive file, no manifest, no deletions
                Test-Path (Join-Path $f.Root 'stage') | Should -BeFalse
                @(Get-ChildItem -LiteralPath $f.Drive -File).Count | Should -Be 0
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'keeps today and yesterday out of the lot even with -CutoffDays 0 (the J-2 guard bites)' {
            $f = New-FakeSite
            $out = $null
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok'
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t2.7z'; CutoffDays = 0; WhatIf = $true
                } -Out ([ref]$out)
                $code | Should -Be 0
                $purgeLines = @()
                foreach ($l in $out) { if ($l -match 'WOULD PURGE (u_ex\S+\.log)') { $purgeLines += $Matches[1] } }
                @($purgeLines).Count | Should -Be 6                     # J-2..40d_x, everything but today/yesterday
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date)
                $purgeLines | Should -Not -Contain ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-1))
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'guard: 7z t failure refuses (ACK G2)' {
        It 'exits non-zero, purges nothing, writes no manifest' {
            $f = New-FakeSite
            $out = $null
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 't-fails'
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t3.7z'
                } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match '7z t failed'
                Test-Path (Join-Path $f.Drive 'iis49-sha256.jsonl') | Should -BeFalse
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'guard: drive copy that does not verify refuses (ACK G3)' {
        It 'refuses when the drive copy diverges from staging after the copy' {
            $f = New-FakeSite
            $out = $null
            try {
                # the t stub mangles the DRIVE copy (t runs on the drive copy, after the copy)
                $stub = New-Stub7z -Dir $f.Root -Mode 't-mangles'
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t4.7z'
                } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match 'does not verify'
                Test-Path (Join-Path $f.Drive 'iis49-sha256.jsonl') | Should -BeFalse
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'the comparator itself: mismatched pair -> false, identical pair -> true' {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("iis49-cmp-{0}" -f ([guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path $tmp -Force | Out-Null
            try {
                $a = Join-Path $tmp 'a.bin'; $b = Join-Path $tmp 'b.bin'; $c = Join-Path $tmp 'c.bin'
                [System.IO.File]::WriteAllText($a, 'AAAA'); [System.IO.File]::WriteAllText($b, 'BBBB'); [System.IO.File]::WriteAllText($c, 'AAAA')
                # define ONLY the comparator from the script text (the pipeline must not run)
                $src = Get-Content -LiteralPath $script:ScriptPath -Raw
                $fn = $src.Substring($src.IndexOf('function Confirm-Iis49Copy'), $src.IndexOf('# --- guard A') - $src.IndexOf('function Confirm-Iis49Copy'))
                Invoke-Expression $fn
                Confirm-Iis49Copy -StagingPath $a -DrivePath $b | Should -BeFalse
                Confirm-Iis49Copy -StagingPath $a -DrivePath $c | Should -BeTrue
            } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'guard: path outside W3SVC49 refuses (ACK G4)' {
        It 'refuses a same-shaped directory that is not W3SVC49' {
            $root = Join-Path ([System.IO.Path]::GetTempPath()) ("iis49-g4-{0}" -f ([guid]::NewGuid().ToString('N')))
            $site = Join-Path $root 'W3SVC42'
            New-Item -ItemType Directory -Path $site -Force | Out-Null
            $out = $null
            try {
                $code = Invoke-Retention @{ SourceDir = $site; DriveDir = (Join-Path $root 'd'); SevenZip = 'nowhere.exe' } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match 'not a W3SVC49'
            } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'happy path (stub 7z) and re-run safety' {
        It 'archives to the drive, appends a provenance manifest line, purges exactly the lot' {
            $f = New-FakeSite
            $out = $null
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok'
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t5.7z'
                } -Out ([ref]$out)
                $code | Should -Be 0
                (@($out) -join "`n") | Should -Match 'DONE archive='
                Test-Path (Join-Path $f.Drive 'iis49-t5.7z') | Should -BeTrue
                $m = Join-Path $f.Drive 'iis49-sha256.jsonl'
                Test-Path $m | Should -BeTrue
                $line = $null
                foreach ($l in @(Get-Content -LiteralPath $m)) { if ($l -match 'iis49-t5') { $line = $l; break } }
                $line | Should -Not -BeNullOrEmpty
                $rec = $line | ConvertFrom-Json
                $rec.source | Should -Be 'iis49-retention'
                $rec.source_files | Should -Be 4
                $rec.oldest | Should -Be ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-40))
                # exactly the four old files purged; today/yesterday/J-2/J-3/unparseable intact
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 5
                Test-Path (Join-Path $f.Site ('u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-33))) | Should -BeFalse
                Test-Path (Join-Path $f.Site ('u_ex{0:yyMMdd}_x.log' -f [DateTime]::Now.Date.AddDays(-40))) | Should -BeFalse
                Test-Path (Join-Path $f.Site 'u_ex260230.log') | Should -BeTrue
                # staging cleanup (CR #965, non-blocking): the drive copy is the
                # artifact of record, the staging archive is gone by explicit name.
                Test-Path (Join-Path $f.Root 'stage\iis49-t5.7z') | Should -BeFalse
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'never overwrites an existing drive archive (re-run safety)' {
            $f = New-FakeSite
            $out = $null
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok'
                $pre = Join-Path $f.Drive 'iis49-t6.7z'
                [System.IO.File]::WriteAllText($pre, 'PRE-EXISTING')
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t6.7z'
                } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match 'already exists'
                [System.IO.File]::ReadAllText($pre) | Should -Be 'PRE-EXISTING'
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'guard: per-file membership proof refuses before purge (CR #965)' {
        It 'a purged file MISSING from the drive archive listing refuses the entire purge, naming it' {
            $f = New-FakeSite
            $out = $null
            $omitted = 'u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-35)
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok' -OmitName $omitted
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t7.7z'
                } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match ('drive archive is MISSING ' + [regex]::Escape($omitted))
                # evidence kept, sources kept, nothing recorded, nothing purged
                Test-Path (Join-Path $f.Drive 'iis49-t7.7z') | Should -BeTrue
                Test-Path (Join-Path $f.Drive 'iis49-sha256.jsonl') | Should -BeFalse
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a purged file archived at the WRONG SIZE refuses the entire purge' {
            $f = New-FakeSite
            $out = $null
            $shrunk = 'u_ex{0:yyMMdd}.log' -f [DateTime]::Now.Date.AddDays(-33)
            try {
                $stub = New-Stub7z -Dir $f.Root -Mode 'ok' -ShrinkName $shrunk
                $code = Invoke-Retention @{
                    SourceDir = $f.Site; DriveDir = $f.Drive; StagingDir = (Join-Path $f.Root 'stage')
                    SevenZip = $stub; ArchiveName = 'iis49-t8.7z'
                } -Out ([ref]$out)
                $code | Should -Not -Be 0
                (@($out) -join "`n") | Should -Match 'archived at 1 bytes but the source holds'
                Test-Path (Join-Path $f.Drive 'iis49-t8.7z') | Should -BeTrue
                Test-Path (Join-Path $f.Drive 'iis49-sha256.jsonl') | Should -BeFalse
                @(Get-ChildItem -LiteralPath $f.Site -File -Filter '*.log').Count | Should -Be 9
            } finally { Remove-Item -LiteralPath $f.Root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}
