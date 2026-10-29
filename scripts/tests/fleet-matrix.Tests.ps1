# Requires -Modules Pester
<#
fleet-matrix tests (#291 implementation). Discipline shared with the seat
audit suite: no credential value ever enters an assertion (FAKE names on
purpose), and docker is faked by a FUNCTION - Pester cannot mock across the
process boundary, and the script under test ends in `exit N`, so it must run
in a child pwsh for its exit code to be observable at all.

Mechanics: BeforeAll writes a generic wrapper to TestDrive. The wrapper
defines `function docker` (functions shadow native commands at the `& docker`
call site) whose answers come from FM_* env vars, then invokes the real
script. The child inherits FM_* from the test process; the script's `exit N`
terminates the child, so $LASTEXITCODE in the test IS the script's verdict.

The suite pins the three classes this fleet keeps paying for:
- arming counted BY VALUE, never by name (every container shows ~23 failover
  names whether armed or not - #711/#730);
- single-container seats (PowerShell unrolls one-element arrays: the measured
  "name [c], every cell ?" regression);
- UNKNOWN rendered as '?', never as a blank that reads as "ok" - including
  the docker-unreachable row, which must NOT render as "no container".
#>

BeforeAll {
    $script:MatrixPath = (Resolve-Path (Join-Path $PSScriptRoot '..\fleet-matrix.ps1')).Path
    $script:Drive = $TestDrive
    $script:WrapperPath = Join-Path $script:Drive 'fm-wrapper.ps1'
    $wrapper = @'
# Generic scaffold: answers from FM_* env vars, then run the real script.
# -HealthPort 1 keeps /health deterministic (nothing listens there -> the
# cell under test is the RENDERING, not this machine's live sidecar).
function script:docker {
    param([Parameter(ValueFromRemainingArguments = $true)]$DockerArgs)
    $a = @($DockerArgs) -join ' '
    if ($env:FM_DOCKER_DOWN) { $global:LASTEXITCODE = 1; return @() }
    if ($a -match '^ps\b') {
        if (-not $env:FM_PS) { return @() }
        return @($env:FM_PS -split '@@')
    }
    if ($a -match '^image\b') {
        # The image-created pin: distinct from the container's own Created.
        # Falls back to FM_CREATED so every pre-existing pin keeps its date.
        if ($env:FM_IMAGE_CREATED) { return @($env:FM_IMAGE_CREATED) }
        if (-not $env:FM_CREATED) { return @() }
        return @($env:FM_CREATED)
    }
    if ($a -match '^inspect\b') {
        if ($a -match 'Config\.Env') { if (-not $env:FM_ENV) { return @() }; return @($env:FM_ENV -split '@@') }
        if ($a -match '\.Image') { return @('sha256:9e280fb3a939a37d829c5363fa561be4fdc3d4990c063ed8581bbc4066f7c92c') }
        if ($a -match '\.Created') { if (-not $env:FM_CREATED) { return @() }; return @($env:FM_CREATED) }
        if ($a -match 'PortBindings') { if (-not $env:FM_PORTS) { return @() }; return @($env:FM_PORTS) }
        return @()
    }
    if ($a -match '^logs\b') {
        if (-not $env:FM_LOGS) { return @() }
        return @($env:FM_LOGS -split '@@')
    }
    return @()
}
& $env:FM_TARGET -SettingsPath $env:FM_SETTINGS_PATH -HealthPort 1
# The script's `exit N` ends only the SCRIPT when it is &-invoked from here -
# without this line the wrapper would finish normally and the child would
# always report 0 (measured: every exit-code pin vacuously green).
exit $LASTEXITCODE
'@
    [System.IO.File]::WriteAllText($script:WrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

    # Defined in BeforeAll: Pester 6 runs each It in a fresh script scope, so
    # a root-level helper is invisible to the tests (measured: CommandNotFound
    # on every It).
    function Invoke-Matrix {
        param(
            # Defaults model a REAL container: env always carries at least PATH
            # and logs always carry something. An empty dump is "no signal" to
            # the script (by design), so scenarios that WANT that pass
            # -EnvLines @() explicitly.
            [string]$Ps = 'claudish-sidecar|claudish-claudish-proxy|Up 2 hours (healthy)',
            [string[]]$EnvLines = @('PATH=/usr/bin'),
            [string]$Created = '2026-10-27T17:49:52.123456789Z',
            [string]$ImageCreated = '',
            [string]$Ports = '{"3000/tcp":[{"HostIp":"","HostPort":"3000"}]}',
            [string[]]$Logs = @('2026-10-28T23:09:14.145886697Z [Relay] NOMINAL after 3 OK heartbeats'),
            [switch]$NoSettings
        )
        $env:FM_TARGET = $script:MatrixPath
        $env:FM_PS = $Ps
        $env:FM_ENV = ($EnvLines -join '@@')
        $env:FM_CREATED = $Created
        $env:FM_IMAGE_CREATED = $ImageCreated
        $env:FM_PORTS = $Ports
        $env:FM_LOGS = ($Logs -join '@@')
        $env:FM_DOCKER_DOWN = ''
        $settingsPath = Join-Path $script:Drive ('settings-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
        if ($NoSettings) {
            $settingsPath = Join-Path $script:Drive 'definitely-absent-settings.json'
        } else {
            $json = @{ env = @{ ANTHROPIC_BASE_URL = 'http://localhost:3000' } } | ConvertTo-Json -Depth 4
            [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        }
        $env:FM_SETTINGS_PATH = $settingsPath
        $out = & pwsh -NoProfile -File $script:WrapperPath 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }
}

Describe 'fleet-matrix' {
    AfterEach {
        # Pester 6 refuses ROOT-level teardowns, so the FM_* scaffold env vars
        # are cleared here, inside the Describe.
        Remove-Item Env:FM_PS, Env:FM_ENV, Env:FM_CREATED, Env:FM_IMAGE_CREATED, Env:FM_PORTS,
            Env:FM_LOGS, Env:FM_DOCKER_DOWN, Env:FM_SETTINGS_PATH, Env:FM_TARGET -ErrorAction SilentlyContinue
    }

    Context 'the full row, measured from live objects' {
        It 'renders every cell and exits 0 on a fully measured row' {
            $r = Invoke-Matrix -EnvLines @(
                'PATH=/usr/bin',
                'CLAUDISH_RELAY_UPSTREAM=https://models.myia.io',
                'CLAUDISH_FAILOVER_SONNET=zai@glm-4.5-air>ds@fake-payg',
                'CLAUDISH_FAILOVER_ACTIVE=sonnet',
                'CLAUDISH_FAILOVER_HAIKU='
            ) -Logs @('2026-10-28T23:09:14.145886697Z [Relay] NOMINAL after 3 OK heartbeats')
            # ACTIVE carries a value too - the fleet regex counts it, on purpose.
            $r.Out | Should -Match '\| MYIA-[A-Z0-9-]+ \| claudish-sidecar \| 3000 \| 2026-10-27 \| https://models\.myia\.io \| unreachable \| http://localhost:3000 \| 2 names / 1 role cascade\(s\) \| 1 in tail, last 2026-10-28T23:09:14\.145886697Z \|'
            $r.Code | Should -Be 0
        }

        It 'renders a HUB seat (no upstream var) as a measured state, not an unknown' {
            $r = Invoke-Matrix -EnvLines @('PATH=/usr/bin')
            $r.Out | Should -Match '\(unset - local\)'
            $r.Code | Should -Be 0
        }

        It 'prints the IMAGE created date, never the container one (measured 29/10 po-2023)' {
            # Live defect this pins: a seat recreated this morning read
            # "2026-10-29" while serving an image built 2026-10-10, because the
            # cell took the container's {{.Created}}. Fix reads {{.Image}} then
            # the image's own Created; the two must be observably distinct here.
            $r = Invoke-Matrix -Created '2026-10-29T09:01:00.000000000Z' -ImageCreated '2026-10-10T15:54:25.145147155Z'
            $r.Out | Should -Match '\| 2026-10-10 \|'
            $r.Out | Should -Not -Match '\| 2026-10-29 \|'
            $r.Code | Should -Be 0
        }
    }

    Context 'armed by VALUE, never by name (#711/#730)' {
        It 'counts zero armed when every failover NAME is present but empty' {
            $r = Invoke-Matrix -EnvLines @(
                'CLAUDISH_FAILOVER_OPUS=',
                'CLAUDISH_FAILOVER_SONNET=',
                'CLAUDISH_FAILOVER_HAIKU=',
                'CLAUDISH_FAILOVER_FABLE=',
                'CLAUDISH_FAILOVER_ACTIVE=',
                'CLAUDISH_FAILOVER_DIRECTION=',
                'PATH=/usr/bin'
            )
            $r.Out | Should -Match '0 names / 0 role cascade\(s\)'
        }

        It 'counts only the non-empty values when names and values are mixed' {
            $r = Invoke-Matrix -EnvLines @(
                'CLAUDISH_FAILOVER_OPUS=',
                'CLAUDISH_FAILOVER_HAIKU=',
                'CLAUDISH_FAILOVER_HAIKU_LABEL=',
                'CLAUDISH_FAILOVER_SONNET=zai@glm-4.5-air',
                'PATH=/usr/bin'
            )
            $r.Out | Should -Match '1 names / 1 role cascade\(s\)'
        }
    }

    Context 'single-container seats (the PS unrolling regression)' {
        It 'renders the whole container name, not its first character' {
            $r = Invoke-Matrix
            $r.Out | Should -Match '\| claudish-sidecar \| 3000 \|'
            $r.Out | Should -Not -Match '\| c \||\| claudish \|'
            $r.Code | Should -Be 0
        }

        It 'joins multiple containers with +' {
            $r = Invoke-Matrix -Ps 'claudish-sidecar|claudish-claudish-proxy|Up 2 hours@@claudish-hub|claudish-claudish-proxy|Up 3 weeks'
            $r.Out | Should -Match 'claudish-sidecar \+ claudish-hub'
        }
    }

    Context 'UNKNOWN is a first-class value' {
        It 'renders the docker-unreachable row as ?, not as "no container"' {
            $env:FM_TARGET = $script:MatrixPath
            $env:FM_PS = ''; $env:FM_ENV = ''; $env:FM_CREATED = ''; $env:FM_PORTS = ''; $env:FM_LOGS = ''
            $env:FM_DOCKER_DOWN = '1'
            $settingsPath = Join-Path $script:Drive 's-down.json'
            $json = @{ env = @{ ANTHROPIC_BASE_URL = 'http://localhost:3000' } } | ConvertTo-Json -Depth 4
            [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
            $env:FM_SETTINGS_PATH = $settingsPath
            $out = & pwsh -NoProfile -File $script:WrapperPath 2>&1 | Out-String
            $out | Should -Match '\| \? \| \? \| \? \| \? \| \? \| http://localhost:3000 \| \? \| \? \|'
            $out | Should -Match 'docker unreachable'
            $LASTEXITCODE | Should -Be 2
            Remove-Item Env:FM_PS, Env:FM_ENV, Env:FM_CREATED, Env:FM_PORTS, Env:FM_LOGS,
                Env:FM_DOCKER_DOWN, Env:FM_SETTINGS_PATH, Env:FM_TARGET -ErrorAction SilentlyContinue
        }

        It 'renders "none" when docker is up but holds no claudish container' {
            $r = Invoke-Matrix -Ps 'nginx|nginx:latest|Up 3 days'
            $r.Out | Should -Match '\| none \| - \| - \| - \| - \| http://localhost:3000 \| - \| - \|'
            $r.Code | Should -Be 0
        }

        It 'flags exit 1 when the client settings file is unreadable (client cell ?)' {
            $r = Invoke-Matrix -NoSettings
            $r.Out | Should -Match '\| unreachable \| \? \| 0 names / 0 role cascade\(s\) \|'
            $r.Code | Should -Be 1
        }

        It 'flags exit 1 when inspect finds nothing for the first container' {
            # ps lists a container, inspect answers nothing: cells read ?, not blank.
            # /health stays measured (-HealthPort 1 is operator input, not docker).
            $r = Invoke-Matrix -EnvLines @() -Created '' -Ports ''
            $r.Out | Should -Match '\| claudish-sidecar \| \? \| \? \| \? \| unreachable \| http://localhost:3000 \| \? \| 1 in tail'
            $r.Code | Should -Be 1
        }
    }
}
