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
        # map: pool name -> value to echo. Two sentinels:
        #   '__FAIL__'      -> exit 1 and a stderr line (a real read failure)
        #   (name absent)   -> exit 0 with EMPTY output (a pool name that does not resolve)
        param(
            [Parameter(Mandatory)][string]$Dir,
            [Parameter(Mandatory)][hashtable]$Map
        )
        $mapFile = Join-Path $Dir 'map.txt'
        $lines = @()
        foreach ($k in @($Map.Keys)) { $lines += ('{0}|{1}' -f $k, $Map[$k]) }
        [System.IO.File]::WriteAllText($mapFile, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)

        $stub = Join-Path $Dir 'stub-appcmd.cmd'
        # Measured 2026-11-26: `exit /b 1` nested inside the `for /f (...) do ( ... )` body
        # does NOT propagate - the stub answered rc 0 and the guard read the failure text as
        # a DRIFT. The lookup and the exit are therefore kept OUTSIDE the loop body.
        $body = @(
            '@echo off',
            'setlocal enabledelayedexpansion',
            'set "pool=%~3"',
            'set "val="',
            'for /f "usebackq tokens=1,2 delims=|" %%A in ("%~dp0map.txt") do (',
            '  if /I "%%A"=="!pool!" set "val=%%B"',
            ')',
            'if not defined val exit /b 0',
            'if "!val!"=="__FAIL__" (',
            '  echo The specified application pool does not exist 1>&2',
            '  exit /b 1',
            ')',
            'echo !val!',
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
