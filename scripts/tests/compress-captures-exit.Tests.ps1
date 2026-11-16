#requires -Version 5.1
<#
    compress-captures.ps1 exit contract (#1013 g7).

    Founder (13/11, ai-01): the scheduler read LastTaskResult 0 for a night
    whose journal closed on END (errors=3). The script's own contract is
    `exit $errors` (compress-captures.ps1 L.680) -- whatever swallows the code
    on a given seat, the script side must be PINNED end-to-end so a future
    regression here is caught in both interpreters and any remaining
    0-despite-errors is provably the launcher chain, not the script.

    The counted error is the deterministic one: a manifest entry whose archive
    is ABSENT off-site (compress-captures.ps1 L.565-568) -- no hash math, no
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
foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', 'C:\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
}
$sevenZip = $cands | Select-Object -First 1
if (-not $sevenZip) {
    # Write-Host, not Write-Output: Pester's discovery phase discards top-level
    # Write-Output, and the skip reason must reach the operator (review 14/11).
    Write-Host 'SKIP-REASON: no 7z binary resolved (PATH, C:\Program Files\7-Zip, PortableApps, ~/.claudish/bin/7zr.exe) - exit-contract Its will skip on this host'
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
        foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', 'C:\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
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
        foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', 'C:\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
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

    It 'an unset Drive root COUNTS on a seat that archived off-site before, and only there (Q85 review)' -Skip:(-not $sevenZip) {
        # Two-sided pin for the ai-01 #1095 blocking item: the pre-Q85 script
        # skipped every off-site block SILENTLY when the root was empty, so a
        # night with no off-site copy closed on END (errors=0) and the monitor
        # saw nothing wrong. The proof of history is the local
        # `.offsite-state.json` marker written on a confirmed off-site copy.
        $sevenZip = $null
        foreach ($c in @('7z', '7z.exe', 'C:\Program Files\7-Zip\7z.exe', 'C:\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe', "$env:USERPROFILE\.claudish\bin\7zr.exe")) {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if ($cmd) { $sevenZip = $cmd.Source; break }
        }
        $tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("cc-q85-" + [guid]::NewGuid().ToString('N')))
        $savedRoot = $env:CLAUDISH_GDRIVE_ROOT
        $env:CLAUDISH_GDRIVE_ROOT = $null   # hermetic: the child must see an unset root
        try {
            $host_ = (Get-Process -Id $PID).Path

            # Run 1 -- the seat has an off-site dir: a real copy happens, the
            # marker is written. This is the "archived off-site before" state.
            $cap1 = Join-Path $tmp 'captures1'; $arch1 = Join-Path $tmp 'arch1'; $gd1 = Join-Path $tmp 'gdrive1'
            New-Item -ItemType Directory -Force -Path $cap1, $arch1, $gd1 | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $cap1 'req-1-1-2026-11-01T00-00-00-000Z-pin.json'), '{}', (New-Object System.Text.UTF8Encoding($false)))
            $out1 = Join-Path $tmp 'run1.out'
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap1 -ArchiveDir $arch1 -MachineTag 'pintest' -GDriveDir $gd1 `
                -KeepDays 1 -ShaCheckCount 0 -SevenZip $sevenZip *> $out1
            $rc1 = $LASTEXITCODE
            $log1 = Get-Content -LiteralPath $out1 -Raw
            $log1 | Should -Match 'END \(errors=0\)'
            $rc1 | Should -Be 0
            $marker = Join-Path $arch1 '.offsite-state.json'
            $marker | Should -Exist
            (Get-Content -LiteralPath $marker -Raw) | Should -Match ([regex]::Escape($gd1))

            # Run 2 -- same seat, root now unset (no -GDriveDir, env empty):
            # this night MUST count. Nothing to pack any more, so the early
            # "nothing to do" exit is exercised too (it used to hardcode 0).
            $out2 = Join-Path $tmp 'run2.out'
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap1 -ArchiveDir $arch1 -MachineTag 'pintest' `
                -KeepDays 1 -ShaCheckCount 0 -SevenZip $sevenZip *> $out2
            $rc2 = $LASTEXITCODE
            $log2 = Get-Content -LiteralPath $out2 -Raw
            $log2 | Should -Match 'ERROR GDriveDir unset but this seat archived off-site before'
            $log2 | Should -Match 'END \(errors=1\)'
            $rc2 | Should -Be 1

            # Run 2b -- the RETROACTIVE proof: an existing seat has uploaded for
            # months and carries no marker yet (the marker is new). With the
            # marker deleted, the journal line alone must still count the night.
            Remove-Item -LiteralPath $marker -Force
            $out2b = Join-Path $tmp 'run2b.out'
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap1 -ArchiveDir $arch1 -MachineTag 'pintest' `
                -KeepDays 1 -ShaCheckCount 0 -SevenZip $sevenZip *> $out2b
            $rc2b = $LASTEXITCODE
            $log2b = Get-Content -LiteralPath $out2b -Raw
            $log2b | Should -Match 'archived off-site before \(compaction\.log:'
            $log2b | Should -Match 'END \(errors=1\)'
            $rc2b | Should -Be 1

            # Run 3 -- negative control: a seat that never archived off-site
            # owes nothing; an unset root must NOT fabricate an error.
            $cap3 = Join-Path $tmp 'captures3'; $arch3 = Join-Path $tmp 'arch3'
            New-Item -ItemType Directory -Force -Path $cap3, $arch3 | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $cap3 'req-1-1-2026-11-01T00-00-00-000Z-pin.json'), '{}', (New-Object System.Text.UTF8Encoding($false)))
            $out3 = Join-Path $tmp 'run3.out'
            & $host_ -NoProfile -ExecutionPolicy Bypass -File $script:CompactionScript `
                -CaptureDir $cap3 -ArchiveDir $arch3 -MachineTag 'pintest' `
                -KeepDays 1 -ShaCheckCount 0 -SevenZip $sevenZip *> $out3
            $rc3 = $LASTEXITCODE
            $log3 = Get-Content -LiteralPath $out3 -Raw
            $log3 | Should -Not -Match 'ERROR GDriveDir unset'
            $log3 | Should -Match 'END \(errors=0\)'
            $rc3 | Should -Be 0
            (Join-Path $arch3 '.offsite-state.json') | Should -Not -Exist
        }
        finally {
            $env:CLAUDISH_GDRIVE_ROOT = $savedRoot
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }
    }
}
