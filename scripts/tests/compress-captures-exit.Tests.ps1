#requires -Version 5.1
<#
    compress-captures.ps1 exit contract (#1013 g7).

    Founder (13/11, ai-01): the scheduler read LastTaskResult 0 for a night
    whose journal closed on END (errors=3). The script's own contract is
    `exit $errors` (compress-captures.ps1 L.680) — whatever swallows the code
    on a given seat, the script side must be PINNED end-to-end so a future
    regression here is caught in both interpreters and any remaining
    0-despite-errors is provably the launcher chain, not the script.

    The counted error is the deterministic one: a manifest entry whose archive
    is ABSENT off-site (compress-captures.ps1 L.565-568) — no hash math, no
    clock dependence. A second, clean run pins that the exit code is not
    vacuously nonzero: zero counted errors must exit 0.

    7z: the script cannot archive without a binary, and this pin must run the
    REAL script end to end. Candidates resolve from PATH and the known fleet
    paths; where none resolves the Its SKIP with a line that says so (never
    silently pass).
#>
# 7z resolution runs at SCRIPT scope, not in BeforeAll: Pester evaluates an
# It's -Skip predicate at DISCOVERY time, before any BeforeAll -- a resolution
# hidden there skips every run on every host (#1013 g7, measured 13/11).
$cands = @()
foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
}
$sevenZip = $cands | Select-Object -First 1
if (-not $sevenZip) {
    Write-Output 'SKIP-REASON: no 7z binary resolved (PATH, C:\Program Files\7-Zip, ~/.claudish/bin/7zr.exe) - exit-contract Its will skip on this host'
}

BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:CompactionScript = Join-Path $script:RepoRoot 'scripts\compress-captures.ps1'
}

Describe 'compress-captures exit code (#1013 g7)' {
    It 'exits with the counted error count: an ABSENT off-site manifest entry -> END (errors=1), exit 1' -Skip:(-not $sevenZip) {
        # Resolve 7z INSIDE the run scope: Pester 6's discovery/run phases use
        # separate script scopes, and a top-level value does not reliably reach
        # the It (measured 13/11 -- -Skip saw it, the body did not).
        $sevenZip = $null
        foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if ($cmd) { $sevenZip = $cmd.Source; break }
        }
        $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("cc-exit-" + [guid]::NewGuid().ToString('N')))
        try {
            $cap  = Join-Path $tmp 'captures'; $arch = Join-Path $tmp 'arch'; $gd = Join-Path $tmp 'gdrive'
            New-Item -ItemType Directory -Force -Path $cap, $arch, $gd | Out-Null
            # One completed past day, one loose file (name must match ^(req|resp)-.*?<d>...).
            [System.IO.File]::WriteAllText((Join-Path $cap 'req-1-1-2026-11-01T00-00-00-000Z-pin.json'), '{}', (New-Object System.Text.UTF8Encoding($false)))
            # Manifest poison: an entry whose archive is absent off-site -> deterministic $errors++.
            $entry = '{"archive":"captures-2020-01-01-pintest.7z","sha256":"' + ('AB' * 32) + '","recorded":"2020-01-02T00:00:00Z","bytes":1}'
            [System.IO.File]::WriteAllText((Join-Path $gd 'captures-sha256-pintest.jsonl'), $entry + "`n", (New-Object System.Text.UTF8Encoding($false)))
            $out = Join-Path $tmp 'run.out'
            $host_ = (Get-Process -Id $PID).Path
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap -ArchiveDir $arch -MachineTag 'pintest' -GDriveDir $gd `
                -KeepDays 1 -ShaCheckCount 10 -SevenZip $sevenZip *> $out
            $rc = $LASTEXITCODE
            $logTxt = Get-Content -LiteralPath $out -Raw
            $logTxt | Should -Match 'ERROR SHA-CHECK captures-2020-01-01-pintest\.7z: recorded in manifest but ABSENT off-site'
            $logTxt | Should -Match 'END \(errors=1\)'
            $rc | Should -Be 1
        }
        finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }

    It 'exits 0 on the same fixture without the poison (the pin is not vacuously nonzero)' -Skip:(-not $sevenZip) {
        # Resolve 7z INSIDE the run scope: Pester 6's discovery/run phases use
        # separate script scopes, and a top-level value does not reliably reach
        # the It (measured 13/11 -- -Skip saw it, the body did not).
        $sevenZip = $null
        foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if ($cmd) { $sevenZip = $cmd.Source; break }
        }
        $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("cc-exit-" + [guid]::NewGuid().ToString('N')))
        try {
            $cap  = Join-Path $tmp 'captures'; $arch = Join-Path $tmp 'arch'; $gd = Join-Path $tmp 'gdrive'
            New-Item -ItemType Directory -Force -Path $cap, $arch, $gd | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $cap 'req-1-1-2026-11-01T00-00-00-000Z-pin.json'), '{}', (New-Object System.Text.UTF8Encoding($false)))
            $out = Join-Path $tmp 'run.out'
            $host_ = (Get-Process -Id $PID).Path
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap -ArchiveDir $arch -MachineTag 'pintest' -GDriveDir $gd `
                -KeepDays 1 -ShaCheckCount 10 -SevenZip $sevenZip *> $out
            $rc = $LASTEXITCODE
            $logTxt = Get-Content -LiteralPath $out -Raw
            $logTxt | Should -Match 'END \(errors=0\)'
            $rc | Should -Be 0
        }
        finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}
