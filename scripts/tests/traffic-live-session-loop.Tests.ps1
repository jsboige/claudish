# Requires -Modules Pester
<#
traffic-live.ps1 Session Loop Check on a NOMINAL relay sidecar (25/11, #1194).

Founder: the relay branch returns before logRequest, so nothing advances the
per-process request counter and EVERY relayed [ttft] line carried the same
frozen reqN. Measured on po-2024's sidecar (NOMINAL, 6 h): 2 311 [ttft] lines
under one reqN. The Session Loop Check reads a reqN repeated >= 6 as a stuck
loop, so on any image predating the 25/11 fix it rendered a FALSE loop verdict
for a perfectly healthy relay seat, and an operator chasing it would find
nothing. The fix (PR #1194) gives each relayed request its own number; until
every seat runs that image, the CHECK itself must name what it is looking at.

Mechanics: same discipline as fleet-matrix.Tests.ps1 - docker is faked by a
FUNCTION in a wrapper script (Pester cannot mock across a process boundary)
and the real script runs in a child pwsh, because the script under test ends
in `exit N` on two paths and would otherwise end the test run with it.

Three shapes, one per branch of the check:
- relay, frozen counter (0 [Request] lines, one reqN on every [ttft]) -> the
  FROZEN reading, never "review for loop";
- locally served loop (a [Request] corpus with the same reqN repeated) -> the
  loop verdict stays;
- fixed relay image (0 [Request] lines, distinct reqN per [ttft]) -> no
  suspects at all.
#>

BeforeAll {
    $script:TrafficLive = (Resolve-Path (Join-Path $PSScriptRoot '..\traffic-live.ps1')).Path
    $script:WrapperPath = Join-Path $TestDrive 'tl-wrapper.ps1'
    $wrapper = @'
# Generic scaffold: log lines come from TL_LOGS (@@-separated), then the real
# script runs. The stub sets LASTEXITCODE explicitly - the script gates on it.
function script:docker {
    param([Parameter(ValueFromRemainingArguments = $true)]$DockerArgs)
    $a = @($DockerArgs) -join ' '
    $global:LASTEXITCODE = 0
    if ($a -match '^logs\b') { if (-not $env:TL_LOGS) { return @() }; return @($env:TL_LOGS -split '@@') }
    return @()
}
$global:LASTEXITCODE = 0
& $env:TL_TARGET -Hours 6 -Container fake-container
exit $LASTEXITCODE
'@
    [System.IO.File]::WriteAllText($script:WrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

    # Defined in BeforeAll: Pester runs each It in a fresh script scope.
    function Invoke-TrafficLive {
        param([string[]]$Logs)
        $env:TL_TARGET = $script:TrafficLive
        $env:TL_LOGS = ($Logs -join '@@')
        $out = & pwsh -NoProfile -File $script:WrapperPath 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }

    # One line shape per branch. The script only keeps lines matching an ISO
    # timestamp prefix, so every synthetic line carries one.
    function New-Line {
        param([int]$Hour, [string]$Body)
        "2026-11-25T0{0}:00:00.000000000Z {1}" -f $Hour, $Body
    }
}

Describe 'traffic-live Session Loop Check - relay sidecar vs locally served' {
    AfterEach {
        Remove-Item Env:TL_TARGET, Env:TL_LOGS -ErrorAction SilentlyContinue
    }

    It 'names the FROZEN counter instead of a loop when the window has zero [Request] lines' {
        $logs = @(1..8 | ForEach-Object { New-Line -Hour ($_ - 1) -Body '[ttft] model=claude-sonnet-5-5 reqN=74 pid=1' })
        $r = Invoke-TrafficLive -Logs $logs
        $r.Code | Should -Be 0
        $r.Out | Should -Match 'FROZEN request counter, NOT a loop'
        $r.Out | Should -Match '8 relayed \[ttft\] lines'
        $r.Out | Should -Not -Match 'review for loop'
    }

    It 'keeps the loop verdict when requests were served locally (a [Request] corpus)' {
        $logs = @(1..8 | ForEach-Object { New-Line -Hour ($_ - 1) -Body '[Request] model=gpt-4o reqN=42 pid=1' })
        $r = Invoke-TrafficLive -Logs $logs
        $r.Code | Should -Be 0
        $r.Out | Should -Match 'review for loop'
        $r.Out | Should -Not -Match 'FROZEN'
    }

    It 'reports no loop pattern on a fixed relay image (distinct reqN per relayed line)' {
        $logs = @(1..8 | ForEach-Object { New-Line -Hour ($_ - 1) -Body ('[ttft] model=claude-sonnet-5-5 reqN={0} pid=1' -f $_) })
        $r = Invoke-TrafficLive -Logs $logs
        $r.Code | Should -Be 0
        $r.Out | Should -Match 'No reqN repeated'
        $r.Out | Should -Not -Match 'FROZEN'
    }
}