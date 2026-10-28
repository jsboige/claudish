<#
    Pester 5/6 suite for scripts/seat-readiness-audit.ps1 (jsboige/claudish#730).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 - what the tasks run)

    WHY THIS EXISTS
    ---------------
    The 2026-10-27 hub reboot split the fleet three ways, and the split was
    INVISIBLE beforehand because cascades were counted by NAME (~32-36 names
    present on every seat, armed or not) while arming is a VALUE. Every pin
    below exists to keep that blindness from coming back:

      - presence-vs-arming: a fixture with N failover names and 0 values must
        read "0 ARMED BY VALUE" and NO-FUEL, never a coverage number;
      - the value firewall: fixtures carry DELIBERATELY FAKE secrets, and the
        suite asserts they never reach stdout - CLAUDISH_PROXY_KEY shares the
        container env with provider credentials, and an audit that leaks while
        auditing is worse than no audit;
      - the step-bucket rule (#275): a cascade whose rungs all sit in the
        nominal's provider bucket is fabric-less - the wall that exhausts the
        nominal exhausts the steps with it;
      - UNKNOWN is first-class: docker down and unreadable env are verdicts
        with a reason, not blanks.

    Mock mechanics: docker is mocked as a NATIVE command (the script's own
    functions would shadow a function mock), driven by a GLOBAL state bag -
    the same pattern as claudish-split-brain-scan.Tests.ps1. This file is pure
    ASCII on purpose.
#>

BeforeAll {
    $script:AuditPath = Join-Path $PSScriptRoot '..\seat-readiness-audit.ps1'
    (Test-Path -LiteralPath $script:AuditPath) | Should -Be $true

    $global:SRAState = @{
        DockerVersion = '24.0.7'
        PsLine        = 'claudish-sidecar|running'
        EnvLines      = @()
        MountLines    = @()
    }

    function Invoke-Audit {
        param(
            [string[]]$EnvLines = @(),
            [string]$PsLine = 'claudish-sidecar|running',
            [string]$DockerVersion = '24.0.7',
            [string]$NominalBucket,
            [hashtable]$ConfigApiKeys,
            # Mount table the mocked docker inspect returns. A config only
            # reachable through the mount is the point of the 2026-10-28 pin.
            [hashtable]$MountedConfigApiKeys,
            [switch]$NoExplicitHome,
            [string]$HostHomeFallback
        )
        $global:SRAState.DockerVersion = $DockerVersion
        $global:SRAState.PsLine = $PsLine
        $global:SRAState.EnvLines = $EnvLines
        # Always audit an ISOLATED mounted home. Without this, the config source
        # (added 28/10) would read the machine's real ~/.claudish/config.json and
        # every verdict below would depend on whose seat runs the suite - the
        # instrument-lying-about-the-machine failure this repo keeps paying for.
        # NOTE: not `$home` - that name IS $HOME in PowerShell and is read-only
        # (SessionStateUnauthorizedAccessException), measured twice in this repo.
        $auditHome = Join-Path $TestDrive ("home-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $auditHome -Force | Out-Null
        if ($ConfigApiKeys) {
            $json = @{ version = '1'; apiKeys = $ConfigApiKeys } | ConvertTo-Json -Depth 4
            [System.IO.File]::WriteAllText(
                (Join-Path $auditHome 'config.json'),
                $json,
                (New-Object System.Text.UTF8Encoding($false))
            )
        }
        if ($MountedConfigApiKeys) {
            $mountHome = Join-Path $TestDrive ("mount-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $mountHome -Force | Out-Null
            $mjson = @{ version = '1'; apiKeys = $MountedConfigApiKeys } | ConvertTo-Json -Depth 4
            [System.IO.File]::WriteAllText(
                (Join-Path $mountHome 'config.json'),
                $mjson,
                (New-Object System.Text.UTF8Encoding($false))
            )
            $global:SRAState.MountLines = @("$mountHome|/root/.claudish")
        }
        else {
            $global:SRAState.MountLines = @()
        }
        $callArgs = @{}
        if ($NoExplicitHome) {
            # The host fallback is ALWAYS redirected to a sandbox: a test that
            # let the audit reach $env:USERPROFILE\.claudish would read the real
            # seat and pass or fail by whose machine ran it.
            if (-not $HostHomeFallback) {
                $HostHomeFallback = Join-Path $TestDrive ("fallback-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $HostHomeFallback -Force | Out-Null
            }
            $callArgs['HostHomeFallback'] = $HostHomeFallback
        }
        else {
            $callArgs['ClaudishHome'] = $auditHome
        }
        if ($NominalBucket) { $callArgs['NominalBucket'] = $NominalBucket }
        $out = & $script:AuditPath @callArgs 2>&1 | Out-String
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }

    # A realistic seat env: many failover NAMES, few values, FAKE secrets on
    # purpose (see header). The three fakes are asserted absent from stdout.
    function New-SeatEnv([string]$SonnetCascade, [string]$Active = 'sonnet') {
        @(
            'PATH=/usr/local/sbin:/usr/local/bin',
            'CLAUDISH_PROXY_KEY=FAKE-CLUSTER-KEY-9f2',
            'ZAI_API_KEY=sk-FAKE-ZAI-77',
            'DEEPSEEK_API_KEY=sk-FAKE-DS-42',
            'CLAUDISH_RELAY_UPSTREAM=http://hub.lan:3000',
            'CLAUDISH_NO_ANTHROPIC=1',
            'CLAUDISH_FAILOVER_DIRECTION=provider',
            'CLAUDISH_FAILOVER_SESSION_DWELL_MS=600000',
            'CLAUDISH_FAILOVER_RECOVERY_GRACE_MS=120000',
            'CLAUDISH_FAILOVER_STEP_EXCLUDE=',
            "CLAUDISH_FAILOVER_SONNET=$SonnetCascade",
            "CLAUDISH_FAILOVER_ACTIVE=$Active",
            'CLAUDISH_FAILOVER_OPUS=',
            'CLAUDISH_FAILOVER_HAIKU=',
            'CLAUDISH_FAILOVER_FABLE=',
            'CLAUDISH_FAILOVER_ROLE_MODELS=',
            'CLAUDISH_FAILOVER_SONNET_RESET=',
            'CLAUDISH_FAILOVER_WALK_BUDGET_MS='
        )
    }

    Mock docker {
        $a = $args
        if ($a.Count -eq 0) { return $null }
        if ($a[0] -eq 'info') { return $global:SRAState.DockerVersion }
        if ($a[0] -eq 'ps') { return $global:SRAState.PsLine }
        if ($a[0] -eq 'inspect') {
            if (($a -join ' ') -match 'Mounts') { return $global:SRAState.MountLines }
            return $global:SRAState.EnvLines
        }
        return $null
    }

    # po-2023's measured container env (2026-10-28): NOT ONE provider credential
    # name - the fuel lives in the mounted config.json. Kept as a function so an
    # It body always gets a fresh copy and no Context-scope variable is involved.
    function New-NoProviderKeyEnv {
        @(
            'PATH=/usr/bin',
            'CLAUDISH_PROXY_KEY=FAKE-CLUSTER-KEY-9f2',
            'CLAUDISH_PROXY_KEY_PREVIOUS=FAKE-CLUSTER-KEY-OLD',
            'CLAUDISH_FAILOVER_SONNET=kc@k3',
            'CLAUDISH_FAILOVER_ACTIVE=sonnet'
        )
    }
    # No provider credential name in env, and the config is supplied only where
    # the caller points it: the 2026-10-28 mount-vs-host pin builds on this.
    function New-NoHomeKeyEnv {
        @(
            'PATH=/usr/bin',
            'CLAUDISH_PROXY_KEY=FAKE-CLUSTER-KEY-9f2',
            'CLAUDISH_FAILOVER_SONNET=ds@deepseek-flash',
            'CLAUDISH_FAILOVER_ACTIVE=sonnet'
        )
    }
}

Describe 'seat-readiness-audit' {

    AfterEach {
        $global:SRAState.DockerVersion = '24.0.7'
        $global:SRAState.PsLine = 'claudish-sidecar|running'
        $global:SRAState.EnvLines = @()
        $global:SRAState.MountLines = @()
    }

    Context 'READY - the full fabric' {
        It 'armed by value + a rung outside the nominal bucket with fuel' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash')
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'seat-readiness: READY'
            $r.Out | Should -Match 'ARMED BY VALUE'          # anti-vacuous: the count line exists
            $r.Out | Should -Match 'cascade sonnet\s*: 2 rung\(s\), buckets \[zai, deepseek\]'
            $r.Out | Should -Match "bucket 'deepseek' has env 'DEEPSEEK_API_KEY' set"
            $r.Out | Should -Match 'nominal bucket\s+: zai'
        }

        It 'states its nominal-bucket assumption out loud (never silently)' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash') -NominalBucket 'openrouter'
            $r.Out | Should -Match 'nominal bucket\s+: openrouter'
            $r.Out | Should -Match 'override with -NominalBucket'
        }
    }

    Context 'presence is not arming (the 2026-10-27 blindness)' {
        It 'a container with 12 failover NAMES, 3 tuning values and 0 role cascades reads NO-FUEL' {
            $env = New-SeatEnv '' ''
            $r = Invoke-Audit -EnvLines $env
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            # 12 names, 3 of them carry tuning values (DIRECTION, DWELL, GRACE)
            # - counted armed BY VALUE, yet NO fabric: only a ROLE cascade is fabric
            $r.Out | Should -Match ': 12 names, 3 ARMED BY VALUE'
            $r.Out | Should -Match 'no role cascade armed by value'
            $r.Out | Should -Match 'reason: no cascade armed BY VALUE'
            $r.Out | Should -Match 'parachute with no fabric'
        }

        It 'the mutation from #730: flipping the cascade to empty flips READY -> NO-FUEL' {
            $ready = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash')
            $ready.Code | Should -Be 0
            $flipped = Invoke-Audit -EnvLines (New-SeatEnv '')
            $flipped.Code | Should -Be 1
            $flipped.Out | Should -Match 'seat-readiness: NO-FUEL'
        }

        It 'ACTIVE armed without any cascade list is still NO-FUEL (a trigger with nothing to trigger)' {
            $env = New-SeatEnv '' 'sonnet'
            $r = Invoke-Audit -EnvLines $env
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
        }
    }

    Context 'the step-bucket rule (#275): same bucket as the nominal = no fabric' {
        It 'every rung in the nominal bucket reads NO-FUEL with the wall warning, even WITH fuel present' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>gc@glm-5.3')
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            $r.Out | Should -Match "every rung sits in the nominal bucket 'zai'"
            $r.Out | Should -Match 'cascade sonnet\s*: 2 rung\(s\), buckets \[zai\]'
        }

        It 'a role: delegation rung is delegated, not a bucket - it never counts as an escape from the wall' {
            # From a seat-local audit, role:<r> resolves on the TARGET's path,
            # not here: counting it as protection would be a hope, not a measure.
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>role:haiku')
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            $r.Out | Should -Match 'buckets \[zai, delegated\]'
        }

        It 'a bare-model rung reads bucket unknown and does not block a READY verdict from the other rung' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'glm-4.5-air>ds@deepseek-flash')
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'seat-readiness: READY'
            $r.Out | Should -Match 'buckets \[unknown, deepseek\]'
        }
    }

    Context 'fuel must RESOLVE, not exist in the abstract' {
        It 'a non-nominal rung bucket with no env name set reads NO-FUEL' {
            $env = @(
                'PATH=/usr/bin',
                'CLAUDISH_PROXY_KEY=FAKE-CLUSTER-KEY-9f2',
                'ZAI_API_KEY=sk-FAKE-ZAI-77',
                'CLAUDISH_FAILOVER_SONNET=ds@deepseek-flash',
                'CLAUDISH_FAILOVER_ACTIVE=sonnet'
            )
            $r = Invoke-Audit -EnvLines $env
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            $r.Out | Should -Match 'no credential resolvable in any non-nominal rung bucket'
        }
    }

    Context 'NO-PATH and UNKNOWN are first-class verdicts' {
        It 'no sidecar container reads NO-PATH (nothing serves without the hub)' {
            $r = Invoke-Audit -PsLine $null -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash')
            $r.Code | Should -Be 2
            $r.Out | Should -Match 'seat-readiness: NO-PATH'
            $r.Out | Should -Match 'Q-65'
        }

        It 'docker unreachable reads UNKNOWN with its reason' {
            $r = Invoke-Audit -DockerVersion $null -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash')
            $r.Code | Should -Be 3
            $r.Out | Should -Match 'seat-readiness: UNKNOWN'
            $r.Out | Should -Match 'docker is not reachable'
        }

        It 'container env unreadable reads UNKNOWN, never a guessed verdict' {
            $r = Invoke-Audit -EnvLines @()
            $r.Code | Should -Be 3
            $r.Out | Should -Match 'seat-readiness: UNKNOWN'
            $r.Out | Should -Match 'container env unreadable'
        }
    }

    Context 'a config-file apiKey is fuel too (the false NO-FUEL of 2026-10-28)' {
        # po-2023's measured shape: the container carries NO provider env name at
        # all (only CLAUDISH_PROXY_KEY and its previous), the eight keys live in
        # the mounted ~/.claudish/config.json -> apiKeys, and the same container
        # had served on k3 in AUTONOMOUS two nights earlier. An env-only audit
        # called that seat a parachute with no fabric.
        # The fixture is a FUNCTION, not a Context-level variable: a variable
        # declared here is not reliably visible inside It bodies, and the symptom
        # is a silent empty env (UNKNOWN), not an error.
        It 'env without provider names + a config apiKey reads READY and NAMES the source' {
            $r = Invoke-Audit -EnvLines (New-NoProviderKeyEnv) -ConfigApiKeys @{ KIMI_CODING_API_KEY = 'sk-FAKE-KIMI-11' }
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'seat-readiness: READY'
            $r.Out | Should -Match "bucket 'kimi' has config apiKey 'KIMI_CODING_API_KEY' set"
            $r.Out | Should -Match 'fuel sources\s+: env \+ config \(1 apiKey name\(s\)'
        }

        It 'THE PIN: the same env without the config file reads NO-FUEL - only the second source differs' {
            $r = Invoke-Audit -EnvLines (New-NoProviderKeyEnv)
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            $r.Out | Should -Match 'fuel sources\s+: env only'
        }

        It 'a custom endpoint bucket derives its credential name (custom:qwen-token-plan)' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'qwen-token-plan@deepseek-v4.1-flash') `
                -ConfigApiKeys @{ QWEN_TOKEN_PLAN_API_KEY = 'sk-FAKE-QWEN-3' }
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'buckets \[custom:qwen-token-plan\]'
            $r.Out | Should -Match "has config apiKey 'QWEN_TOKEN_PLAN_API_KEY' set"
        }

        It 'a *_CODING_API_KEY alias in ENV is recognised, not only the provider-default name' {
            $env = @(
                'PATH=/usr/bin',
                'CLAUDISH_PROXY_KEY=FAKE-CLUSTER-KEY-9f2',
                'GLM_CODING_API_KEY=sk-FAKE-GLM-5',
                'CLAUDISH_FAILOVER_SONNET=gc@glm-5.3',
                'CLAUDISH_FAILOVER_ACTIVE=sonnet'
            )
            $r = Invoke-Audit -EnvLines $env -NominalBucket 'deepseek'
            $r.Code | Should -Be 0
            $r.Out | Should -Match "bucket 'zai' has env 'GLM_CODING_API_KEY' set"
        }

        It 'the value firewall covers the config source too' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'kc@k3') -ConfigApiKeys @{ KIMI_CODING_API_KEY = 'sk-FAKE-KIMI-11' }
            $r.Out | Should -Not -Match 'sk-FAKE-KIMI-11'
            $r.Out | Should -Not -Match 'FAKE-CLUSTER-KEY-9f2'
        }
    }

    Context 'the value firewall: an audit must never leak what it reads' {
        It 'no FAKE secret value ever reaches stdout on the READY path' {
            $r = Invoke-Audit -EnvLines (New-SeatEnv 'zai@glm-4.5-air>ds@deepseek-flash')
            $r.Code | Should -Be 0
            $r.Out | Should -Not -Match 'FAKE-CLUSTER-KEY-9f2'
            $r.Out | Should -Not -Match 'sk-FAKE-ZAI-77'
            $r.Out | Should -Not -Match 'sk-FAKE-DS-42'
            # names and structure are the audit's output, values are not - not
            # even cascade rungs, which are not secrets but ARE env values
            $r.Out | Should -Match 'DEEPSEEK_API_KEY'
            $r.Out | Should -Not -Match 'glm-4\.5-air'
        }

        It 'no FAKE secret value ever reaches stdout on any verdict path (NO-FUEL, NO-PATH, UNKNOWN)' {
            foreach ($case in @(
                @{ Lines = (New-SeatEnv ''); Ps = 'claudish-sidecar|running'; Dv = '24.0.7' },
                @{ Lines = (New-SeatEnv 'zai@glm-4.5-air>gc@glm-5.3'); Ps = $null; Dv = '24.0.7' },
                @{ Lines = @(); Ps = 'claudish-sidecar|running'; Dv = $null }
            )) {
                $r = Invoke-Audit -EnvLines $case.Lines -PsLine $case.Ps -DockerVersion $case.Dv
                $r.Out | Should -Not -Match 'FAKE-CLUSTER-KEY-9f2'
                $r.Out | Should -Not -Match 'sk-FAKE-ZAI-77'
                $r.Out | Should -Not -Match 'sk-FAKE-DS-42'
            }
        }
    }

    Context 'WHICH home: the file the CONTAINER reads (third false NO-FUEL, 2026-10-28)' {
        # po-2025 measured 2026-10-28: the container mounts
        # D:\claudish-shadow\config on /root/.claudish, while the audit read the
        # HOST file $env:USERPROFILE\.claudish. The two differ by exactly the
        # three credentials the sonnet cascade needs, so a seat serving
        # deepseek-flash every minute audited NO-FUEL. Fuel present in one file
        # and absent in the other is the whole fixture.
        # (fixture helper New-NoHomeKeyEnv lives in BeforeAll: a function declared
        # in a Context is not reliably visible inside It bodies - same trap the
        # header documents for variables.)

        It 'a credential reachable only THROUGH the container mount reads READY' {
            $r = Invoke-Audit -EnvLines (New-NoHomeKeyEnv) -NoExplicitHome `
                -MountedConfigApiKeys @{ DEEPSEEK_API_KEY = 'sk-FAKE-DS-42' }
            $r.Code | Should -Be 0
            $r.Out | Should -Match 'seat-readiness: READY'
            $r.Out | Should -Match 'config home\s+: .*\(container mount -> '
            $r.Out | Should -Match "bucket 'deepseek' has config apiKey 'DEEPSEEK_API_KEY' set"
            $r.Out | Should -Not -Match 'sk-FAKE-DS-42'
        }

        It 'THE PIN: no mount + an empty host fallback -> NO-FUEL, marked INCONCLUSIVE (not a proof)' {
            $r = Invoke-Audit -EnvLines (New-NoHomeKeyEnv) -NoExplicitHome
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'seat-readiness: NO-FUEL'
            $r.Out | Should -Match 'config home\s+: .*\(host default'
            $r.Out | Should -Match 'INCONCLUSIVE'
            $r.Out | Should -Match 'NOT a proof'
        }

        It 'an explicit -ClaudishHome wins over the container mount (precedence, and it is proof-grade)' {
            # The explicit sandbox home is empty while the mount carries the key:
            # a READY here would mean the mount overrode the caller.
            $r = Invoke-Audit -EnvLines (New-NoHomeKeyEnv) `
                -MountedConfigApiKeys @{ DEEPSEEK_API_KEY = 'sk-FAKE-DS-42' }
            $r.Code | Should -Be 1
            $r.Out | Should -Match 'config home\s+: .*\(explicit -ClaudishHome\)'
            $r.Out | Should -Not -Match 'INCONCLUSIVE'
        }
    }
}
