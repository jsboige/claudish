# Requires -Modules Pester
<#
sidecar-vintage tests (file v25 grain 1, born from #805). Same discipline
as fleet-matrix: docker is faked by a FUNCTION in a child pwsh (Pester
cannot mock across the process boundary and the script ends in `exit N`),
answers come from FM_* env vars, and the child's `exit N` is the verdict.

Invoke-RestMethod is faked the same way (functions shadow cmdlets at the
call site) and honors FM_HEALTH ONLY on FM_HEALTH_PORT - so a test whose
row shows a measured key count proves the script probed the right port,
and one that shows '?' proves it probed the wrong one (or none).

The commit-distance cell is pinned against a THROWAWAY git repo built in
BeforeAll with dated commits (GIT_AUTHOR_DATE/GIT_COMMITTER_DATE): one
commit before the fake image date on packages/cli/src, one after, one now
on README only. Distance must be exactly 1 - the image's date filters, the
path filters, and a bare git count would read 3.
#>

BeforeAll {
    $script:TargetPath = (Resolve-Path (Join-Path $PSScriptRoot '..\sidecar-vintage.ps1')).Path
    $script:Drive = $TestDrive
    $script:WrapperPath = Join-Path $script:Drive 'sv-wrapper.ps1'
    $wrapper = @'
# Answers from FM_* env vars, then run the real script.
function script:docker {
    param([Parameter(ValueFromRemainingArguments = $true)]$DockerArgs)
    $a = @($DockerArgs) -join ' '
    if ($env:FM_DOCKER_DOWN) { $global:LASTEXITCODE = 1; return @() }
    if ($a -match '^version\b') { return @('27.0.3-fake') }
    if ($a -match '^image\b') {
        if (-not $env:FM_IMAGE_CREATED) { return @() }
        return @($env:FM_IMAGE_CREATED)
    }
    if ($a -match '^inspect\b') {
        if ($env:FM_ABSENT) { return @() }
        if ($a -match '\.Image') { return @('sha256:2fb5991380c746d584f02c852cf737eef0021b1e984ee385307550db222c0f77') }
        if ($a -match 'PortBindings') { if (-not $env:FM_PORTS) { return @() }; return @($env:FM_PORTS) }
        return @()
    }
    return @()
}
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    # Honor the fake health payload ONLY on the port the test declares:
    # a measured key count in the row is the proof the probe used that port.
    if ($env:FM_HEALTH -and $Uri -match (':' + $env:FM_HEALTH_PORT + '/health$')) {
        return ($env:FM_HEALTH | ConvertFrom-Json)
    }
    throw ('no listener at ' + $Uri)
}
if ($env:FM_REPO) { & $env:FM_TARGET -RepoPath $env:FM_REPO -HealthPort 0 }
else { & $env:FM_TARGET -HealthPort 0 }
exit $LASTEXITCODE
'@
    [System.IO.File]::WriteAllText($script:WrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

    # Throwaway repo: distance 1 is the deterministic answer (before-image
    # cli commit, after-image cli commit, now README-only commit).
    $script:VRepo = Join-Path $script:Drive 'vrepo'
    New-Item -ItemType Directory -Path (Join-Path $script:VRepo 'packages\cli\src') -Force | Out-Null
    git -C $script:VRepo init -q
    Set-Content (Join-Path $script:VRepo 'packages\cli\src\a.ts') -Value 'before'
    Set-Content (Join-Path $script:VRepo 'README.md') -Value 'readme'
    git -C $script:VRepo add .
    $env:GIT_AUTHOR_DATE = '2026-10-20T12:00:00'; $env:GIT_COMMITTER_DATE = '2026-10-20T12:00:00'
    git -C $script:VRepo -c user.email=vintage@test -c user.name=vintage commit -qm 'before the image, cli path'
    Set-Content (Join-Path $script:VRepo 'packages\cli\src\b.ts') -Value 'after'
    git -C $script:VRepo add .
    $env:GIT_AUTHOR_DATE = '2026-10-28T12:00:00'; $env:GIT_COMMITTER_DATE = '2026-10-28T12:00:00'
    git -C $script:VRepo -c user.email=vintage@test -c user.name=vintage commit -qm 'after the image, cli path'
    Add-Content (Join-Path $script:VRepo 'README.md') -Value 'now'
    git -C $script:VRepo add .
    Remove-Item Env:GIT_AUTHOR_DATE, Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
    git -C $script:VRepo -c user.email=vintage@test -c user.name=vintage commit -qm 'now, outside cli path'

    $script:Health14 = @{
        instanceId = 'fake'; status = 'ok'; role = 'relay-nominal'; upstream = 'https://hub'
        uptimeSec = 100; activeStreams = 0; pendingRequests = 0; msSinceProgress = 0
        stallThresholdMs = 90000; admissionFreeze = $false; selfLoop = $false
        eventLoopBlockedMs5m = 0; eventLoopMax60sMs = 0; eventLoopMaxMs = 0
    } | ConvertTo-Json
    $script:Health11 = @{
        instanceId = 'fake'; status = 'ok'; role = 'relay-nominal'; upstream = 'https://hub'
        uptimeSec = 100; activeStreams = 0; pendingRequests = 0; msSinceProgress = 0
        stallThresholdMs = 90000; admissionFreeze = $false; selfLoop = $false
    } | ConvertTo-Json

    # Defined in BeforeAll: Pester 6 runs each It in a fresh script scope.
    function Invoke-Vintage {
        param(
            [string]$HealthJson = $script:Health14,
            [string]$HealthPort = '3000',
            [string]$Ports = '{"3000/tcp":[{"HostIp":"","HostPort":"3000"}]}',
            [string]$ImageCreated = '2026-10-27T17:49:13.123456789Z',
            [switch]$DockerDown,
            [switch]$Absent,
            [string]$Repo
        )
        $env:FM_TARGET = $script:TargetPath
        $env:FM_HEALTH = $HealthJson
        $env:FM_HEALTH_PORT = $HealthPort
        $env:FM_PORTS = $Ports
        $env:FM_IMAGE_CREATED = $ImageCreated
        $env:FM_DOCKER_DOWN = if ($DockerDown) { '1' } else { '' }
        $env:FM_ABSENT = if ($Absent) { '1' } else { '' }
        # ContainsKey, not truthiness: -Repo '' is the DEFAULT-repo test.
        $env:FM_REPO = if ($PSBoundParameters.ContainsKey('Repo')) { $Repo } else { $script:VRepo }
        $out = & pwsh -NoProfile -File $script:WrapperPath 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }
}

Describe 'sidecar-vintage' {
    AfterAll {
        # git writes its objects read-only; Pester's TestDrive removal then
        # dies with "Access denied" and the whole container reads red even
        # with every test green (measured 01/11). Clear the bit first - best
        # effort, TestDrive is a temp dir anyway.
        if ($script:VRepo -and (Test-Path $script:VRepo)) {
            Get-ChildItem -LiteralPath $script:VRepo -Recurse -Force -File |
                ForEach-Object { try { $_.IsReadOnly = $false } catch {} }
        }
    }

    AfterEach {
        Remove-Item Env:FM_TARGET, Env:FM_HEALTH, Env:FM_HEALTH_PORT, Env:FM_PORTS,
            Env:FM_IMAGE_CREATED, Env:FM_DOCKER_DOWN, Env:FM_ABSENT, Env:FM_REPO -ErrorAction SilentlyContinue
    }

    It 'renders a fully measured row and exits 0' {
        $r = Invoke-Vintage
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\| 2026-10-27T17:49:13\.123456789Z \| 14 \| yes \(3\) \| 1 \|'
    }

    It 'counts only packages/cli/src commits newer than the IMAGE, never everything' {
        # Fixture holds 3 commits total; the row must say 1 (the after-image
        # cli commit). A bare count would read 3, a container-date keying
        # would read 2.
        $r = Invoke-Vintage
        # \r?$ : Out-String keeps the CRLF, and a bare $ does not match
        # before the \r (the row itself is correct - an anchor artifact).
        $r.Out | Should -Match '\| 14 \| yes \(3\) \| 1 \|\r?$'
    }

    It 'a zero distance is a measured zero, never ?' {
        $r = Invoke-Vintage -ImageCreated '2030-01-01T00:00:00Z'
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\| 14 \| yes \(3\) \| 0 \|\r?$'
    }

    It 'a pre-#615 /health shape renders no gauges and says so' {
        $r = Invoke-Vintage -HealthJson $script:Health11
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\| 11 \| no \| 1 \|'
        $r.Out | Should -Match 'predates #615'
    }

    It 'dead docker renders ? everywhere and exits 2, never absent' {
        $r = Invoke-Vintage -DockerDown
        $r.Code | Should -Be 2
        $r.Out | Should -Match '\| \? \| \? \| \? \| \? \|'
        $r.Out | Should -Not -Match 'absent'
    }

    It 'an absent container is a measured state, not an instrument failure' {
        $r = Invoke-Vintage -Absent
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\| absent \| - \| - \| - \|'
    }

    It 'unreachable /health is ? (unknown), exit 1 - never a blank that reads ok' {
        $r = Invoke-Vintage -HealthJson ''
        $r.Code | Should -Be 1
        $r.Out | Should -Match '\| \? \| \? \| 1 \|'
    }

    It 'probes the HOST port from HostPort, not the container port key' {
        # Bindings publish container 9000 on host 3210; the fake answers
        # ONLY on 3210. A measured 14 in the row proves the probe used the
        # host port - probing 9000 would render '?'.
        $r = Invoke-Vintage -Ports '{"9000/tcp":[{"HostIp":"","HostPort":"3210"}]}' -HealthPort '3210'
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\| 14 \| yes \(3\) \|'
    }

    It 'the default -RepoPath resolves to a checkout that HAS packages/cli/src' {
        # -Repo '' exercises the script's own default - the ONLY test that
        # does; every other test passes -RepoPath. Measured 01/11: a double
        # Split-Path landed on the checkout's PARENT, git exited 128 and the
        # distance cell read '?' - a path bug dressed as an unknown. The pin
        # is semantic (the resolved path must contain the cli tree) so it
        # holds on any machine, and the distance must render a number.
        $r = Invoke-Vintage -Repo ''
        if ($r.Out -notmatch 'repo\s+:\s+(\S+)') { throw 'no repo line rendered' }
        Test-Path (Join-Path $Matches[1] 'packages\cli\src') | Should -BeTrue
        $r.Out | Should -Match '\| \d+ \|\r?$'
    }
}
