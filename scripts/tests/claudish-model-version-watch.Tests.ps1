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
            'gpt-5.6-sol' = @('cx@gpt-6-sol')
            'gpt-6.1-sol' = @('cx@gpt-6.1-sol')
            'gpt-6-astra' = @('cx@gpt-6-astra')
            'glm-5.3'     = @('gc@glm-5.3')
        }
        $script:available = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'glm-5.3')
    }
    It 'groups every spelling of a family into one decision' {
        $d = Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available
        $sol = @($d | Where-Object Family -eq 'gpt-sol')
        $sol.Count | Should -Be 1
        @($sol[0].Spellings) -contains 'gpt-6-sol' | Should -Be $true
        @($sol[0].Spellings) -contains 'gpt-5.6-sol' | Should -Be $true
        @($sol[0].Spellings) -contains 'gpt-6.1-sol' | Should -Be $true
    }
    It 'flags a minor bump' {
        $d = Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available
        (@($d | Where-Object Family -eq 'gpt-sol')[0].Action) | Should -Be 'minor'
    }
    It 'reports current when routing already points at the latest' {
        $d = Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available
        (@($d | Where-Object Family -eq 'gpt-astra')[0].Action) | Should -Be 'current'
        (@($d | Where-Object Family -eq 'glm')[0].Action) | Should -Be 'current'
    }
    It 'flags a major bump (5.6 -> 6)' {
        $r56 = [pscustomobject]@{ 'gpt-5.6-sol' = @('cx@gpt-5.6-sol') }
        $d56 = Compare-RoutingToFamilies -Routing $r56 -AvailableIds @('gpt-6-sol', 'gpt-5.6-sol')
        (@($d56 | Where-Object Family -eq 'gpt-sol')[0].Action) | Should -Be 'major'
    }
}

Describe 'Edit-RoutingForMinor surgery' {
    BeforeAll {
        $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-{0}.json" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        $script:config = @{
            apiKeys  = @{ DEMO_KEY = 'value-that-must-survive' }
            routing  = @{
                'gpt-6-sol'   = @('cx@gpt-6-sol')
                'gpt-5.6-sol' = @('cx@gpt-6-sol')
                'glm-5.3'     = @('gc@glm-5.3')
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

    It 'repins every spelling of the family and registers the new one' {
        $backup = Edit-RoutingForMinor -ConfigPath $script:tmp -Spellings @('gpt-6-sol', 'gpt-5.6-sol') -NewTarget 'cx@gpt-6.1-sol'
        $backup | Should -Not -BeNullOrEmpty
        (Test-Path $backup) | Should -Be $true
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-5.6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-6.1-sol' | Should -Be 'cx@gpt-6.1-sol'
    }
    It 'leaves other families, apiKeys and profiles intact in value' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Spellings @('gpt-6-sol') -NewTarget 'cx@gpt-6.1-sol'
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'glm-5.3' | Should -Be 'gc@glm-5.3'
        $after.apiKeys.DEMO_KEY | Should -Be 'value-that-must-survive'
        $after.profiles.default.models.sonnet | Should -Be 'glm-5.3'
    }
    It 'refuses on unparseable config (returns null, file untouched)' {
        [System.IO.File]::WriteAllText($script:tmp, 'this is not json {{{', (New-Object System.Text.UTF8Encoding($false)))
        $before = [System.IO.File]::ReadAllText($script:tmp)
        $r = Edit-RoutingForMinor -ConfigPath $script:tmp -Spellings @('gpt-6-sol') -NewTarget 'cx@gpt-6.1-sol'
        $r | Should -BeNullOrEmpty
        [System.IO.File]::ReadAllText($script:tmp) | Should -Be $before
    }
    It 'refuses on a missing file' {
        (Edit-RoutingForMinor -ConfigPath "$($script:tmp)-absent" -Spellings @('gpt-6-sol') -NewTarget 'cx@gpt-6.1-sol') | Should -BeNullOrEmpty
    }
    It 'is idempotent when the target already holds the value (no diff, no backup)' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Spellings @('gpt-6-sol') -NewTarget 'cx@gpt-6.1-sol'
        $b1 = (Get-ChildItem "$($script:tmp).bak-*").Count
        # Second call with the same target: every spelling and the new-spelling
        # entry already hold the value — $changed stays false, null returned,
        # NO second backup. (Pinned because the first draft set $changed
        # unconditionally and wrote a fresh backup every run.)
        $r2 = Edit-RoutingForMinor -ConfigPath $script:tmp -Spellings @('gpt-6-sol') -NewTarget 'cx@gpt-6.1-sol'
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
