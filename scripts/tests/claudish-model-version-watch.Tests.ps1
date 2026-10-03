# claudish-model-version-watch.Tests.ps1 — pins for the version-watch organ
#
# Run under BOTH interpreters (bun run test:scripts / test:scripts:win51) —
# production runs 5.1. Pure logic: no network, no docker, no scheduled task.
# The networked runner is exercised by its -DryRun mode + the live arming
# procedure, not by this suite.
#
# Pester 5/6 structure: fixtures live in BeforeAll ($script: scope) — a
# Describe-level plain variable is NOT visible inside It blocks, which is
# exactly the failure shape the first draft had (empty $ids -> "expected X,
# got $null" everywhere while the functions were correct).

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\lib\claudish-model-version.psm1') -Force
}

Describe 'ConvertTo-ModelVersion parsing' {
    It 'parses minor-versioned family ids' {
        $v = ConvertTo-ModelVersion -Id 'gpt-6.1-sol'
        $v.Family | Should -Be 'gpt-sol'
        $v.Major | Should -Be 6
        $v.Minor | Should -Be 1
    }
    It 'treats a version without minor as .0' {
        $v = ConvertTo-ModelVersion -Id 'gpt-6-sol'
        $v.Family | Should -Be 'gpt-sol'
        $v.Minor | Should -Be 0
    }
    It 'keeps older-major spellings in the same family (alias precedent)' {
        (ConvertTo-ModelVersion -Id 'gpt-5.6-sol').Family | Should -Be 'gpt-sol'
    }
    It 'parses v-prefixed and suffix families' {
        $v = ConvertTo-ModelVersion -Id 'deepseek-v4.1-flash'
        $v.Family | Should -Be 'deepseek-flash'
        $v.Major | Should -Be 4
        $v.Minor | Should -Be 1
    }
    It 'parses dashless version schemes (qwen3.8-max)' {
        $v = ConvertTo-ModelVersion -Id 'qwen3.8-max'
        $v.Family | Should -Be 'qwen-max'
        $v.Major | Should -Be 3
        $v.Minor | Should -Be 8
    }
    It 'parses bare versioned families (glm-5.3)' {
        $v = ConvertTo-ModelVersion -Id 'glm-5.3'
        $v.Family | Should -Be 'glm'
        $v.Major | Should -Be 5
        $v.Minor | Should -Be 3
    }
    It 'returns null for rolling/unversioned ids' {
        foreach ($id in @('gpt-reserve', 'MiniMax-M3', 'kimi-for-coding', 'mistral-medium-latest', 'deepseek-flash', 'codex-auto-review')) {
            (ConvertTo-ModelVersion -Id $id) | Should -BeNullOrEmpty
        }
    }
    It 'treats a second variant as a DIFFERENT family (astra is not sol)' {
        (ConvertTo-ModelVersion -Id 'gpt-6-astra').Family | Should -Be 'gpt-astra'
    }
}

Describe 'Get-LatestFamilyVersion' {
    BeforeAll {
        $script:ids = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-reserve')
    }
    It 'picks the highest minor within one family' {
        (Get-LatestFamilyVersion -Family 'gpt-sol' -AvailableIds $script:ids).Id | Should -Be 'gpt-6.1-sol'
    }
    It 'ignores other families and unparseable ids' {
        (Get-LatestFamilyVersion -Family 'gpt-luna' -AvailableIds $script:ids).Id | Should -Be 'gpt-6-luna'
        (Get-LatestFamilyVersion -Family 'gpt-terra' -AvailableIds $script:ids) | Should -BeNullOrEmpty
    }
}

Describe 'Compare-RoutingToFamilies decisions' {
    BeforeAll {
        $script:routing = [pscustomobject]@{
            'gpt-6-sol'   = @('cx@gpt-6-sol')
            'gpt-5.6-sol' = @('cx@gpt-5.6-sol')
            'gpt-6.1-sol' = @('cx@gpt-6.1-sol')
            'gpt-6-astra' = @('cx@gpt-6-astra')
            'glm-5.3'     = @('gc@glm-5.3')
        }
        $script:available = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'glm-5.3')
    }
    It 'yields ONE decision PER SPELLING, each judged on its own version' {
        $d = @(Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available)
        $sol = @($d | Where-Object Family -eq 'gpt-sol')
        $sol.Count | Should -Be 3   # three spellings, three decisions — not one per family
        (@($sol | Where-Object Spelling -eq 'gpt-6-sol')[0].Action) | Should -Be 'minor'     # 6.0 -> 6.1
        (@($sol | Where-Object Spelling -eq 'gpt-5.6-sol')[0].Action) | Should -Be 'major'   # 5.6 -> 6
        (@($sol | Where-Object Spelling -eq 'gpt-6.1-sol')[0].Action) | Should -Be 'current'
    }
    It 'is order-independent: same entries in any key order give the same decision set (D2)' {
        $a = [pscustomobject][ordered]@{ 'stale' = @('cx@gpt-6-sol'); 'fresh' = @('cx@gpt-6.1-sol') }
        $b = [pscustomobject][ordered]@{ 'fresh' = @('cx@gpt-6.1-sol'); 'stale' = @('cx@gpt-6-sol') }
        $avail = @('gpt-6.1-sol', 'gpt-6-sol')
        # Compare as spelling->action maps, never as ordered lists: the test
        # must be order-agnostic by construction. (A first draft compared
        # Sort-Object output — under 5.1 Sort-Object does not see hashtable
        # properties, sorted on a null key and flipped one of the two orders.)
        $mapA = @{}; foreach ($d in @(Compare-RoutingToFamilies -Routing $a -AvailableIds $avail)) { $mapA[$d.Spelling] = $d.Action }
        $mapB = @{}; foreach ($d in @(Compare-RoutingToFamilies -Routing $b -AvailableIds $avail)) { $mapB[$d.Spelling] = $d.Action }
        $mapA.Count | Should -Be 2
        $mapB.Count | Should -Be 2
        # The defect this pins: first-seen-family keyed 'fresh' as stale when
        # 'stale' came first — 'fresh' must be CURRENT in BOTH orders.
        $mapA['fresh'] | Should -Be 'current'
        $mapB['fresh'] | Should -Be 'current'
        $mapA['stale'] | Should -Be 'minor'
        $mapB['stale'] | Should -Be 'minor'
    }
    It 'mixed majors in one family: minor for the on-major spelling, major for the older (D3)' {
        $r = [pscustomobject]@{ 'a' = @('cx@gpt-6-sol'); 'b' = @('cx@gpt-5.6-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol')
        (@($d | Where-Object Spelling -eq 'a')[0].Action) | Should -Be 'minor'
        (@($d | Where-Object Spelling -eq 'b')[0].Action) | Should -Be 'major'
    }
    It 'keeps the provider prefix ONLY from a value that has one (D1)' {
        $r = [pscustomobject]@{ 'qualified' = @('cx@gpt-6-sol'); 'bare' = @('gpt-6-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol', 'gpt-6-sol')
        (@($d | Where-Object Spelling -eq 'qualified')[0].NewTarget) | Should -Be 'cx@gpt-6.1-sol'
        # The defect this pins: bare values used to fabricate 'gpt-6-sol@gpt-6.1-sol'.
        (@($d | Where-Object Spelling -eq 'bare')[0].NewTarget) | Should -Be 'gpt-6.1-sol'
        (@($d | Where-Object Spelling -eq 'bare')[0].Provider) | Should -Be ''
    }
    It 'reports current when routing already points at the latest' {
        $d = Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available
        (@($d | Where-Object Family -eq 'gpt-astra')[0].Action) | Should -Be 'current'
        (@($d | Where-Object Family -eq 'glm')[0].Action) | Should -Be 'current'
    }
    It 'never proposes a downgrade (routing ahead of the listing stays current)' {
        $r = [pscustomobject]@{ 'ahead' = @('cx@gpt-6.2-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol')
        (@($d | Where-Object Spelling -eq 'ahead')[0].Action) | Should -Be 'current'
    }
}

Describe 'Edit-RoutingForMinor surgery' {
    BeforeAll {
        $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-{0}.json" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        $script:config = @{
            apiKeys  = @{ DEMO_KEY = 'value-that-must-survive' }
            routing  = @{
                'gpt-6-sol' = @('cx@gpt-6-sol')
                'gpt-5.6-sol' = @('cx@gpt-5.6-sol')
                'glm-5.3'   = @('gc@glm-5.3')
            }
            profiles = @{ default = @{ models = @{ sonnet = 'glm-5.3' } } }
        }
    }
    BeforeEach {
        [System.IO.File]::WriteAllText($script:tmp, ($script:config | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
    }
    AfterAll {
        if (Test-Path $script:tmp) { Remove-Item $script:tmp -Force }
        Get-ChildItem "$($script:tmp).bak-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    }

    It 'repins each spelling to its OWN target and registers the new spelling' {
        $backup = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol'; 'gpt-5.6-sol' = 'cx@gpt-6.1-sol' } `
            -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $backup | Should -Not -BeNullOrEmpty
        (Test-Path $backup) | Should -Be $true
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-5.6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-6.1-sol' | Should -Be 'cx@gpt-6.1-sol'
    }
    It 'repins a bare spelling BARE (no fabricated provider prefix)' {
        $r = @{ routing = @{ 'gpt-6-sol' = @('gpt-6-sol') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'gpt-6.1-sol'
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'gpt-6.1-sol'
        $after.routing.'gpt-6.1-sol' | Should -Be 'gpt-6.1-sol'
    }
    It 'preserves the OTHER-family member of a multi-target spelling' {
        $r = @{ routing = @{ 'sonnet' = @('cx@gpt-6-sol', 'gc@glm-5.3') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'sonnet' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        @($after.routing.sonnet).Count | Should -Be 2
        @($after.routing.sonnet)[0] | Should -Be 'cx@gpt-6.1-sol'   # gpt-sol member moved
        @($after.routing.sonnet)[1] | Should -Be 'gc@glm-5.3'       # glm member preserved in place
    }
    It 'leaves other families, apiKeys and profiles intact in value' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'glm-5.3' | Should -Be 'gc@glm-5.3'
        $after.apiKeys.DEMO_KEY | Should -Be 'value-that-must-survive'
        $after.profiles.default.models.sonnet | Should -Be 'glm-5.3'
    }
    It 'refuses on unparseable config (returns null, file untouched)' {
        [System.IO.File]::WriteAllText($script:tmp, 'this is not json {{{', (New-Object System.Text.UTF8Encoding($false)))
        $before = [System.IO.File]::ReadAllText($script:tmp)
        $r = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $r | Should -BeNullOrEmpty
        [System.IO.File]::ReadAllText($script:tmp) | Should -Be $before
    }
    It 'refuses on a missing file' {
        (Edit-RoutingForMinor -ConfigPath "$($script:tmp)-absent" -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol') | Should -BeNullOrEmpty
    }
    It 'is idempotent when the target already holds the value (no diff, no backup)' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $b1 = (Get-ChildItem "$($script:tmp).bak-*").Count
        # Second call with the same targets: every spelling and the new-spelling
        # entry already hold the value — $changed stays false, null returned,
        # NO second backup. (Pinned because the first draft set $changed
        # unconditionally and wrote a fresh backup every run.)
        $r2 = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol'
        $r2 | Should -BeNullOrEmpty
        (Get-ChildItem "$($script:tmp).bak-*").Count | Should -Be $b1
    }
}

Describe 'Write-VersionEvent / Test-ClaudishOptIn' {
    BeforeAll {
        $script:dir = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-{0}" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        New-Item -ItemType Directory -Path $script:dir | Out-Null
        $script:evts = Join-Path $script:dir 'events.log'
    }
    AfterAll { Remove-Item $script:dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'appends one parseable NDJSON line per event, no BOM' {
        Write-VersionEvent -EventsPath $script:evts -Kind minor-applied -Family gpt-sol -From gpt-6-sol -To gpt-6.1-sol -Detail test
        Write-VersionEvent -EventsPath $script:evts -Kind major-ask -Family gpt-sol -From gpt-6-sol -To gpt-7-sol
        $lines = @(Get-Content $script:evts)
        $lines.Count | Should -Be 2
        ($lines[0] | ConvertFrom-Json).kind | Should -Be 'minor-applied'
        ($lines[1] | ConvertFrom-Json).to | Should -Be 'gpt-7-sol'
        $bytes = [System.IO.File]::ReadAllBytes($script:evts)
        ($bytes[0] -eq 0xEF) | Should -Be $false
    }
    It 'opt-in gate: absent file, empty file and wrong word all refuse; only the exact token arms' {
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') ''
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') 'yes'
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') 'enabled'
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $true
    }
}
