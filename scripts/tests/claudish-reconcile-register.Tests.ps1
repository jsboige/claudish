#requires -Version 5.1
<#
    reconcile-outage-captures.ps1 -Register (#912 arbitrage a).

    What these pins hold is the INSTALL PATH, not cosmetics: without the task,
    a sidecar's AUTONOMOUS-mode captures never reach the central corpus
    (#912, measured 06/11), and install-sidecar.ps1 never created it (the
    script was cited in its docstring only). The suite runs under BOTH
    interpreters (test:scripts + test:scripts:win51) because the task must be
    registrable from either — a seat without pwsh 7 schedules powershell.exe.
#>

BeforeAll {
    $script:RepoRoot      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:ReconcilePath = Join-Path $script:RepoRoot 'scripts\reconcile-outage-captures.ps1'
    $script:InstallerPath = Join-Path $script:RepoRoot 'scripts\install-sidecar.ps1'
    $script:ReconcileText = Get-Content -LiteralPath $script:ReconcilePath -Raw
    $script:InstallerText = Get-Content -LiteralPath $script:InstallerPath -Raw

    # Parse both under the CURRENT interpreter: a 5.1-only syntax error is a
    # broken scheduled task on every seat without pwsh 7.
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:ReconcilePath, [ref]$null, [ref]$errs) | Out-Null
    $script:ReconcileParseErrors = @($errs)
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:InstallerPath, [ref]$null, [ref]$errs) | Out-Null
    $script:InstallerParseErrors = @($errs)
}

Describe 'reconcile-outage-captures -Register (task shape)' {
    It 'both scripts parse clean under this interpreter (5.1 and 7 alike)' {
        $script:ReconcileParseErrors.Count | Should -Be 0
        $script:InstallerParseErrors.Count | Should -Be 0
    }

    It 'declares the -Register switch' {
        $script:ReconcileText | Should -Match '(?m)^\s*\[switch\]\$Register\s*$'
    }

    It 'registers under the operator account, RunLevel Limited — never a service principal' {
        $script:ReconcileText | Should -Match 'New-ScheduledTaskPrincipal\s+-UserId\s+"\$env:USERDOMAIN\\\$env:USERNAME"'
        $script:ReconcileText | Should -Match '-RunLevel\s+Limited'
        $script:ReconcileText | Should -Not -Match 'NT AUTHORITY'
        $script:ReconcileText | Should -Not -Match 'S-1-5-18'
    }

    It 'the task action runs the script WITHOUT -Register (the job is not the installer)' {
        $argLines = ($script:ReconcileText -split "`r?`n") | Where-Object { $_ -match '-Argument\s' }
        ($argLines -join ' ') | Should -Match '-File'
        ($argLines -join ' ') | Should -Not -Match '-Register'
    }

    It 'repeats hourly, catches missed runs, and is bounded' {
        $script:ReconcileText | Should -Match 'New-TimeSpan\s+-Hours\s+1'
        $script:ReconcileText | Should -Match '-StartWhenAvailable'
        $script:ReconcileText | Should -Match 'ExecutionTimeLimit\s+\(New-TimeSpan\s+-Hours\s+2\)'
        $script:ReconcileText | Should -Match '-MultipleInstances\s+IgnoreNew'
        # [TimeSpan]::MaxValue serializes out of Task Scheduler XML range — the
        # duration must be a large explicit bound (caught by the live run).
        $script:ReconcileText | Should -Not -Match 'RepetitionDuration\s+\(\[TimeSpan\]::MaxValue\)'
        $script:ReconcileText | Should -Match 'RepetitionDuration\s+\(New-TimeSpan\s+-Days\s+3650\)'
    }

    It 'prefers pwsh 7 but falls back to the 5.1 interpreter (feet without pwsh 7)' {
        $script:ReconcileText | Should -Match 'Join-Path\s+\$env:ProgramFiles\s+''PowerShell\\7\\pwsh\.exe'''
        $script:ReconcileText | Should -Match 'WindowsPowerShell\\v1\.0\\powershell\.exe'
    }
}

Describe '7z resolution (#214 port: the first armed-task run died on the hardcoded default)' {
    It 'default SevenZip is EMPTY - resolve from candidates, never a hardcoded path' {
        $script:ReconcileText | Should -Match '(?m)^\s*\[string\]\$SevenZip\s*=\s*""\s*,?\s*$'
        $script:ReconcileText | Should -Not -Match 'D:\\Apps\\PortableApps'
    }

    It 'resolves via the engine helpers with BOTH PATH names probed (7z AND 7zr)' {
        # Measured 08/11 on po-2024: all four built-in candidates absent, 7z not
        # on PATH - only the winget 7zr resolves. compress-captures' probe of
        # 'Get-Command 7z' ALONE would still die here.
        $script:ReconcileText | Should -Match 'claudish-engine\.psm1'
        $script:ReconcileText | Should -Match 'Get-SevenZipCandidates'
        $script:ReconcileText | Should -Match 'Resolve-SevenZipPath'
        $script:ReconcileText | Should -Match 'Get-Command\s+\$bin'
        $script:ReconcileText | Should -Match "'7z',\s*'7zr'"
    }

    It 'a failed resolution NAMES every path probed, not the single-path FATAL' {
        $script:ReconcileText | Should -Not -Match 'FATAL: 7z not found at \$SevenZip'
        $script:ReconcileText | Should -Match 'FATAL: 7z not found - tried:'
    }

    It 'declares -NoSevenZipFallback and -SevenZipCandidates (parity with compress-captures)' {
        $script:ReconcileText | Should -Match '(?m)^\s*\[switch\]\$NoSevenZipFallback\s*,?\s*$'
        $script:ReconcileText | Should -Match '(?m)^\s*\[string\[\]\]\$SevenZipCandidates\s*=\s*@\(\)\s*,?\s*$'
    }
}

Describe 'install-sidecar wires the registration (#912: installed means reconciled)' {
    It 'invokes reconcile-outage-captures.ps1 -Register as part of the install' {
        $script:InstallerText | Should -Match 'reconcile-outage-captures\.ps1'
        $script:InstallerText | Should -Match '&\s*\$reconcileScript\s+-Register'
    }

    It 'a registration failure never fails the install' {
        $script:InstallerText | Should -Match 'reconcile task registration failed \(install continues'
    }
}
