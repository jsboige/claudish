# Pins for scripts/iis-pool-recycle-guard.ps1 (#1156: the periodic recycle had no instrument).
# The script runs as a CHILD process (the repo pattern, see iis49-retention.Tests.ps1) because
# exit codes must come from the value the wrapper returns - $LASTEXITCODE does not survive a
# function boundary.
# appcmd is stubbed with a .cmd + a pipe-delimited map, so the read really crosses a process
# boundary: the stub answers by POOL NAME, and its three modes are the three outcomes the
# guard must keep distinct - a value, a drift, and a dead read.
# The last Context is a static guard: this script is a MEASUREMENT, so no write, no recycle
# and no elevation may ever appear in its source.

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\iis-pool-recycle-guard.ps1')).ProviderPath
    $script:Exe = (Get-Process -Id $PID).Path

    function New-StubAppCmd {
        # map: pool name -> '<time>' or '<time>;<schedule entry>[;<entry>...]'. Sentinels:
        #   '__FAIL__'      on the time field     -> exit 1 and a stderr line (a real read failure)
        #   '__NOSCHED__'   on the schedule field -> the [schedule] header is NOT printed
        #   (name absent)                         -> exit 0 with EMPTY output (a name that does not resolve)
        # -SeenOverride makes the stub PRINT another pool's name in APPPOOL.NAME: that is the shape
        # measured on this seat for `appcmd list apppool "<name>" /config` (no object name, and an
        # empty <schedule> where the real one has an entry). The guard must refuse such a read.
        param(
            [Parameter(Mandatory)][string]$Dir,
            [Parameter(Mandatory)][hashtable]$Map,
            [string]$SeenOverride = ''
        )
        $mapFile = Join-Path $Dir 'map.txt'
        $lines = @()
        foreach ($k in @($Map.Keys)) {
            $parts = "$($Map[$k])" -split ';', 2
            $sched = ''
            if ($parts.Count -gt 1) { $sched = ($parts[1] -replace ';', ' ') }
            $lines += ('{0}|{1}|{2}' -f $k, $parts[0], $sched)
        }
        [System.IO.File]::WriteAllText($mapFile, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
        if ($SeenOverride) {
            [System.IO.File]::WriteAllText((Join-Path $Dir 'seen.txt'), $SeenOverride, [System.Text.Encoding]::ASCII)
        }

        $stub = Join-Path $Dir 'stub-appcmd.cmd'
        # Measured 2026-11-26: `exit /b 1` nested inside the `for /f (...) do ( ... )` body does
        # NOT propagate - the stub answered rc 0 and the guard read the failure text as
        # a DRIFT. The lookup and the exit are therefore kept OUTSIDE the loop body.
        # Measured 2026-11-27: the guard reads ONE form, `list apppool <name> /text:*`, and the
        # block below is the shape appcmd really prints (APPPOOL.NAME first, [periodicRestart],
        # [schedule], then [failure] at a shallower indent); the single-value form is kept.
        $body = @(
            '@echo off',
            'setlocal enabledelayedexpansion',
            'set "pool=%~3"',
            'set "form=%~4"',
            'set "val="',
            'set "sched="',
            'for /f "usebackq tokens=1,2,3 delims=|" %%A in ("%~dp0map.txt") do (',
            '  if /I "%%A"=="!pool!" (',
            '    set "val=%%B"',
            '    set "sched=%%C"',
            '  )',
            ')',
            'if not defined val exit /b 0',
            'if "!val!"=="__FAIL__" (',
            '  echo The specified application pool does not exist 1>&2',
            '  exit /b 1',
            ')',
            'if /I not "!form!"=="/text:*" (',
            '  echo !val!',
            '  exit /b 0',
            ')',
            'set "seen=!pool!"',
            'if exist "%~dp0seen.txt" set /p seen=<"%~dp0seen.txt"',
            'echo   APPPOOL.NAME:"!seen!"',
            'echo       [periodicRestart] ',
            'echo         time:"!val!" ',
            'if /I "!sched!"=="__NOSCHED__" goto tail',
            'echo         [schedule] ',
            'if defined sched (',
            # MEASURED 2026-11-27: `for %%S in (!sched:;= !)` does NOT substitute - cmd hands the
            # literal token `!sched:` to the loop and the guard read the entry as "sched:", so the
            # pin went red for a stub artefact. The field is therefore written SPACE-separated
            # (the map keeps ';' for readability) and the loop is a plain `!sched!` expansion.
            '  for %%S in (!sched!) do (',
            '    echo           [add] ',
            '    echo             value:"%%S" ',
            '  )',
            ')',
            ':tail',
            'echo     [failure] ',
            'exit /b 0'
        )
        [System.IO.File]::WriteAllText($stub, (($body -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
        return $stub
    }

    function New-TempDir {
        $d = Join-Path ([System.IO.Path]::GetTempPath()) ('iispool-{0}' -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        return $d
    }

    # returns the child's EXIT CODE; its output lands in $Out (array of lines)
    function Invoke-Guard {
        param([hashtable]$Params, [ref]$Out)
        $cli = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:ScriptPath)
        foreach ($k in @($Params.Keys)) {
            if ($k -eq 'Json') { $cli += '-Json'; continue }
            $cli += @("-$k", "$($Params[$k])")
        }
        # 5.1 GOTCHA (#1096): under $ErrorActionPreference='Stop' the `2>&1` merge turns the
        # child's FIRST stderr line into a terminating NativeCommandError on 5.1, before any
        # output is read. The capture runs under 'Continue', restored even on throw.
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $o = & $script:Exe @cli 2>&1 | ForEach-Object { "$_" }
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevEap
        }
        if ($Out) { $Out.Value = @($o) }
        return $code
    }
}

Describe 'iis-pool-recycle-guard' {
    Context 'reading the value' {
        It 'exits 0 and reports OK for every pool at the expected value' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00'; 'embeddings.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io,embeddings.myia.io' } -Out ([ref]$out)
                $code | Should -Be 0
                $text = ($out -join "`n")
                $text | Should -Match 'POOL models\.myia\.io value=\[00:00:00\] expected=\[00:00:00\] verdict=OK'
                $text | Should -Match 'POOL embeddings\.myia\.io value=\[00:00:00\] expected=\[00:00:00\] verdict=OK'
                $text | Should -Match 'GUARD pools=2 drift=0 unreadable=0'
                $text | Should -Match 'VERDICT OK'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'exits 2 and names the observed value when a pool drifted' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '01:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 2
                $text = ($out -join "`n")
                $text | Should -Match 'POOL models\.myia\.io value=\[01:00:00\] expected=\[00:00:00\] verdict=DRIFT'
                $text | Should -Match 'VERDICT DRIFT'
                # the repair is never attempted here: the message points at a separate gesture
                $text | Should -Match 'PROPOSAL'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'honours -Expected, so a pool that legitimately keeps 01:00:00 reads OK' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'embeddings.myia.io' = '01:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'embeddings.myia.io'; Expected = '01:00:00' } -Out ([ref]$out)
                $code | Should -Be 0
                (($out -join "`n")) | Should -Match 'verdict=OK'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'a dead read is not a drift and not a pass' {
        It 'an empty output with exit 0 is UNREADABLE and exits 1' {
            $d = New-TempDir
            $out = $null
            try {
                # the pool name is absent from the map: the stub answers rc 0 with no body
                $stub = New-StubAppCmd -Dir $d -Map @{ 'other.pool' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'verdict=UNREADABLE \(empty output\)'
                $text | Should -Match 'VERDICT INSTRUMENT'
                $text | Should -Not -Match 'verdict=DRIFT'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a non-zero exit with stderr is UNREADABLE, reported as such, and the run survives' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '__FAIL__' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'verdict=UNREADABLE \(exit=1\)'
                # the stderr of the child is captured, never turned into a terminating error
                $text | Should -Match 'does not exist'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a -Pools list that normalises to nothing is refused, and no pool is read at all' {
            # Review 2026-11-26 (c.7184045326): '-Pools ,' used to answer exit 0 with pools=[] -
            # a collector read a success while nothing had been checked. The stub below WOULD
            # answer OK; the absence of any POOL line is the proof it was never consulted.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = ',' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'GUARD pools=0 drift=0 unreadable=1'
                $text | Should -Match 'VERDICT INSTRUMENT'
                $text | Should -Match 'leaves no pool name'
                # no per-pool line was produced: -match is case-insensitive, so pin the LINE shape
                $text | Should -Not -Match 'POOL \S+ value=\['
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a -Pools entry made only of blanks is refused too, not read as an empty success' {
            # Review 2026-11-26 (second pass): `-Pools ' '` still answered exit 0 with pools=[] and
            # unreadable=0 - and in TEXT form `VERDICT OK`, the worst shape of the same false pass.
            # The trim used to run after the emptiness test, so the blank became "" and was counted.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = ' ' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'GUARD pools=0 drift=0 unreadable=1'
                $text | Should -Match 'VERDICT INSTRUMENT'
                $text | Should -Match 'leaves no pool name'
                $text | Should -Match 'blank'
                # the false pass itself: the old head printed this line for the same input
                $text | Should -Not -Match 'VERDICT OK'
                $text | Should -Not -Match 'POOL \S+ value=\['
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a blank entry next to a real pool does not hide the real pool' {
            # the other side of the fix: dropping blanks must not empty a list that HAS a name.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = ' , models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 0
                $text = ($out -join "`n")
                $text | Should -Match 'POOL models\.myia\.io value=\[00:00:00\] expected=\[00:00:00\] verdict=OK'
                $text | Should -Match 'GUARD pools=1 drift=0 unreadable=0'
                $text | Should -Match 'VERDICT OK'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a read failure OUTRANKS a drift in the exit code, and both are printed' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '01:00:00'; 'blind.pool' = '__FAIL__' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io,blind.pool' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'verdict=DRIFT'
                $text | Should -Match 'verdict=UNREADABLE'
                $text | Should -Match 'GUARD pools=2 drift=1 unreadable=1'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'machine-readable form' {
        It 'a -Pools list that normalises to nothing is a JSON diagnostic, not an empty success' {
            # Same review finding, JSON form: a collector must be able to tell "read nothing"
            # from "read everything and it is fine". exit 1 and a body that names the cause.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = ','; Json = $true } -Out ([ref]$out)
                $code | Should -Be 1
                $obj = (($out -join '') | ConvertFrom-Json)
                @($obj.pools).Count | Should -Be 0
                $obj.unreadable | Should -Be 1
                $obj.drift | Should -Be 0
                $obj.verdict | Should -Be 'INSTRUMENT'
                $obj.detail | Should -Match 'leaves no pool name'
                # presence, not shape: PS 7's ConvertFrom-Json turns the string into a DateTime
                # while 5.1 keeps it a string - asserting the format would pin the interpreter
                @($obj.PSObject.Properties.Name) | Should -Contain 'checkedAtUtc'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a -Pools entry made only of blanks is a JSON diagnostic carrying the raw input' {
            # same second-pass finding in the machine-readable form; `given` stays the exact
            # string received (a blank), which is what a collector needs to diagnose it.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = ' '; Json = $true } -Out ([ref]$out)
                $code | Should -Be 1
                $obj = (($out -join '') | ConvertFrom-Json)
                @($obj.pools).Count | Should -Be 0
                $obj.unreadable | Should -Be 1
                $obj.drift | Should -Be 0
                $obj.verdict | Should -Be 'INSTRUMENT'
                $obj.given | Should -Be ' '
                $obj.detail | Should -Match 'leaves no pool name'
                $obj.detail | Should -Match 'blank'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'emits one JSON object carrying every pool and both counters' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00'; 'mini.myia.io' = '01:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io,mini.myia.io'; Json = $true } -Out ([ref]$out)
                $code | Should -Be 2
                $obj = (($out -join '') | ConvertFrom-Json)
                @($obj.pools).Count | Should -Be 2
                $obj.drift | Should -Be 1
                $obj.unreadable | Should -Be 0
                $obj.expected | Should -Be '00:00:00'
                @($obj.pools | Where-Object { $_.verdict -eq 'DRIFT' }).Count | Should -Be 1
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'a clock recycle is a drift, and the read proves its own object' {
        # Measured 2026-11-27 on the front: 44 pools keep periodicRestart.time = 00:00:00 AND carry
        # one [schedule] entry (mcp-tools.myia.io at 04:38:00 local, confirmed by 3 x event 5076 in
        # 72 h). Reading `time` alone called every one of them healthy.
        It 'a non-empty [schedule] is a DRIFT and exits 2, naming the entry' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00;04:38:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 2
                $text = ($out -join "`n")
                $text | Should -Match 'POOL models\.myia\.io value=\[00:00:00\] expected=\[00:00:00\] verdict=DRIFT \(schedule=\[04:38:00\]\) schedule=\[04:38:00\]'
                $text | Should -Match '\(schedule=\[04:38:00\]\)'
                $text | Should -Match 'VERDICT DRIFT'
                # the value itself is in spec: the drift comes from the schedule alone
                $text | Should -Not -Match 'VERDICT OK'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'lists every [schedule] entry, not just the first' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00;04:38:00;06:00:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 2
                (($out -join "`n")) | Should -Match 'schedule=\[04:38:00,06:00:00\]'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'carries the schedule in JSON and counts the pool as one drift' {
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00'; 'mcp-tools.myia.io' = '00:00:00;04:38:00' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io,mcp-tools.myia.io'; Json = $true } -Out ([ref]$out)
                $code | Should -Be 2
                $obj = (($out -join '') | ConvertFrom-Json)
                $obj.drift | Should -Be 1
                $obj.unreadable | Should -Be 0
                $sched = @($obj.pools | Where-Object { $_.pool -eq 'mcp-tools.myia.io' })[0].schedule
                @($sched).Count | Should -Be 1
                @($sched)[0] | Should -Be '04:38:00'
                # the healthy pool keeps an empty list, not a missing field
                $empty = @($obj.pools | Where-Object { $_.pool -eq 'models.myia.io' })[0]
                $empty.verdict | Should -Be 'OK'
                @($empty.schedule).Count | Should -Be 0
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'a block that names ANOTHER pool is UNREADABLE, never a pass' {
            # measured 2026-11-27: an EMPTY pool name makes appcmd list ALL pools (3572 lines,
            # "DefaultAppPool" first) with rc 0; `/config` printed no object name at all and
            # rendered an empty <schedule> for mcp-tools.myia.io. The identity is the proof.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00' } -SeenOverride 'DefaultAppPool'
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'verdict=UNREADABLE \(identity=DefaultAppPool\) schedule=\[\]'
                $text | Should -Match 'VERDICT INSTRUMENT'
                $text | Should -Not -Match 'VERDICT OK'
                $text | Should -Not -Match 'verdict=DRIFT'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }

        It 'an absent [schedule] section is UNREADABLE, not an empty schedule' {
            # absence is not emptiness: without the section nothing proves the pool has no entry.
            $d = New-TempDir
            $out = $null
            try {
                $stub = New-StubAppCmd -Dir $d -Map @{ 'models.myia.io' = '00:00:00;__NOSCHED__' }
                $code = Invoke-Guard -Params @{ AppCmd = $stub; Pools = 'models.myia.io' } -Out ([ref]$out)
                $code | Should -Be 1
                $text = ($out -join "`n")
                $text | Should -Match 'verdict=UNREADABLE \(schedule absent\) schedule=\[\]'
                $text | Should -Match 'VERDICT INSTRUMENT'
                $text | Should -Not -Match 'VERDICT OK'
            } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Context 'static guard: a measurement never acts' {
        It 'carries no write, recycle or elevation verb' {
            $src = Get-Content -LiteralPath $script:ScriptPath -Raw
            # IIS writes, pool actuation, and elevation - the families a guard must never own.
            # NB: the bare word "recycle" is legitimate here (it names the setting being read),
            # so only the ACTUATORS are denied.
            foreach ($forbidden in @('Set-WebConfiguration', 'Set-ItemProperty', 'Start-WebAppPool', 'Stop-WebAppPool',
                                     'Restart-WebAppPool', 'webapppool/start', 'webapppool/stop',
                                     'Start-Process', '-Verb RunAs',
                                     'Remove-Item', 'Stop-Service', 'Restart-Service')) {
                $src | Should -Not -Match ([regex]::Escape($forbidden))
            }
        }
    }
}
