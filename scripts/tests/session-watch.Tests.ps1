<#
    Pester 5/6 suite for the session-watch organ (jsboige/claudish#362, CR 07/10 B1/B2).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    The organ can KILL processes. Before its silence or its journal can mean anything,
    the two load-bearing guards must be pinned (CR B2):

      (a) consent file absent -> 'kill-blocked-no-consent', ZERO Stop-Process calls —
          the detector-first default is the safety property of the whole organ;
      (b) B1: a session_id-less line with consent PRESENT and -DryRun ABSENT must
          journal 'skip-unattributed' and kill NOTHING. Pre-B1 this was the latent
          kill-everything path: [regex]::Escape('') matches every CommandLine, so the
          relecteur's fixture bound BOTH fixture PIDs;
      (c) the rogue-schtasks detector journals the task NAME only — a /TR carrying a
          credential-shaped secret never enters the journal (docker-events #192 class);
      (d) the PS 5.1 array unroll (7694ed55): an UNCHANGED 8-id catalog must yield
          new=0 gone=0 (the pre-fix shape was new-model x8 + model-gone x1), with a
          positive control so the pin cannot pass vacuously (a 9th id MUST surface).

    INVOCATION SHAPE
    -----------------
    The script ends with `exit 0`, so each pin runs it as a CHILD process — the same
    shape the scheduled task uses — under the SAME interpreter as the suite (5.1 suite
    tests 5.1 behavior). All injectable seams (-RunScan/-GetProcesses/-StopProcess/
    -GetSchTasks/-FetchCatalog, CR B2) are passed as literal scriptblock text through
    -Command; the fixtures themselves ride files under $env:WATCH_SB (the sandbox home
    the child inherits), so no per-test quoting is involved anywhere.
#>

BeforeAll {
    $script:WatchPath = Join-Path $PSScriptRoot '..\session-watch.ps1'
    (Test-Path -LiteralPath $script:WatchPath) | Should -Be $true

    # Same interpreter as the suite (5.1 suite -> 5.1 child — the divergence under pin).
    $script:ChildExe = (Get-Process -Id $PID).Path

    # Constant fixture-seam scriptblocks: they only read files under $env:WATCH_SB.
    # NO double quotes anywhere in these (or in $inner): a 5.1 PARENT re-quotes native
    # arguments and silently EATS embedded " chars on the way to the child — measured
    # 07/10 ("stops.log" reached the child as bare stops.log, parse error at col 729;
    # the same string from a pwsh 7 parent passed clean). Single quotes + [char]10 are
    # invisible to the native command-line parser under BOTH parents.
    $script:SeamScan      = "{ param(`$p,`$s,`$h) Get-Content -Raw (Join-Path `$env:WATCH_SB 'scan-output.json') }"
    $script:SeamProcs     = "{ @(Get-Content -Raw (Join-Path `$env:WATCH_SB 'procs.json') | ConvertFrom-Json) }"
    $script:SeamStop      = "{ param(`$ProcessId) [IO.File]::AppendAllText((Join-Path `$env:WATCH_SB 'stops.log'), (`$ProcessId + [char]10)) }"
    $script:SeamSchTasks  = "{ Get-Content (Join-Path `$env:WATCH_SB 'schtasks.csv') }"
    $script:SeamCatalog   = "{ param(`$u,`$k) Get-Content -Raw (Join-Path `$env:WATCH_SB 'catalog.json') | ConvertFrom-Json }"

    function New-WatchSandbox {
        $dir = Join-Path $env:TEMP ("sw-test-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $dir -Force | Out-Null
        return $dir
    }

    function Write-SandboxFile([string]$Sandbox, [string]$Name, [string]$Content) {
        [IO.File]::WriteAllText((Join-Path $Sandbox $Name), $Content, (New-Object System.Text.UTF8Encoding($false)))
    }

    function New-ScanSession([string]$Sid, [int]$Sol, [int]$Sonnet, [int]$Total, [string[]]$ExtraFlags = @()) {
        $flags = @('OPENAI-SHAPED') + $ExtraFlags
        [ordered]@{
            session_id = $Sid
            machine    = $env:COMPUTERNAME.ToLower()
            requests   = $Total
            last       = (Get-Date).ToUniversalTime().ToString('o')
            models     = [ordered]@{ 'gpt-6-sol' = $Sol; 'claude-sonnet-5' = $Sonnet }
            flags      = $flags
        }
    }

    function ScanJson([object[]]$Sessions) {
        @{ sessions = @($Sessions) } | ConvertTo-Json -Depth 6 -Compress
    }

    function Invoke-Watch([string]$Sandbox, [string]$HubConfig = '') {
        # Child = production shape (task runs powershell.exe -File); seams + sandbox
        # ride -Command / the inherited environment. -RepoScripts points at an empty
        # dir (split-brain hook off), -HubConfig at a non-existent path (catalog skip,
        # except the catalog pin which provides its own fixture home).
        if (-not $HubConfig) { $HubConfig = "$Sandbox\no-hub-config.json" }
        $inner = "& '$($script:WatchPath)' -ClaudishHome '$Sandbox'" +
            " -ScanScript '$Sandbox\scan.py' -HubConfig '$HubConfig'" +
            " -RepoScripts '$Sandbox' -RunScan $script:SeamScan -GetProcesses $script:SeamProcs" +
            " -StopProcess $script:SeamStop -GetSchTasks $script:SeamSchTasks -FetchCatalog $script:SeamCatalog"
        $prev = $env:WATCH_SB
        $env:WATCH_SB = $Sandbox
        try {
            $out = & $script:ChildExe -NoProfile -ExecutionPolicy Bypass -Command $inner 2>&1 | Out-String
        } finally {
            if ($null -ne $prev) { $env:WATCH_SB = $prev } else { Remove-Item Env:WATCH_SB -ErrorAction SilentlyContinue }
        }
        [pscustomobject]@{ Out = $out; Code = $LASTEXITCODE }
    }

    function Get-Journal([string]$Sandbox) {
        $jp = Join-Path $Sandbox 'session-watch.log'
        if (-not (Test-Path $jp)) { return @() }
        # NDJSON: one JSON object per line — parse per line (a -Raw multi-doc blob
        # throws "Additional text encountered"; the ForEach unroll keeps 5.1 flat).
        @((Get-Content $jp) | Where-Object { $_ -match '\S' } | ForEach-Object { $_ | ConvertFrom-Json })
    }

    function Get-StopCount([string]$Sandbox) {
        $sp = Join-Path $Sandbox 'stops.log'
        if (-not (Test-Path $sp)) { return 0 }
        @((Get-Content $sp) | Where-Object { $_ -match '\S' }).Count
    }

    # Benign defaults so every pin shares one harness: empty scan, no processes,
    # only the CSV header (no rogue task), empty catalog.
    function Initialize-BenignFixtures([string]$Sandbox) {
        Write-SandboxFile $Sandbox 'scan-output.json' (ScanJson @())
        Write-SandboxFile $Sandbox 'procs.json' '[]'
        Write-SandboxFile $Sandbox 'schtasks.csv' '"HostName","TaskName"'
        Write-SandboxFile $Sandbox 'catalog.json' '{"data":[]}'
    }

    $script:Sandboxes = @()
    AfterAll {
        foreach ($d in $script:Sandboxes) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'session-watch consent guard (CR B2-a)' {
    It 'consent absent -> kill-blocked-no-consent, zero Stop-Process (a qualified target never dies on a detector-only tick)' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        Write-SandboxFile $sb 'scan-output.json' (ScanJson @(New-ScanSession 'a1b2c3d4-0000-0000-0000-000000000000' 90 10 100))
        # one live-looking claude.exe the kill path WOULD have bound
        Write-SandboxFile $sb 'procs.json' (@(@{ ProcessId = 4242; CommandLine = 'claude.exe --session a1b2c3d4' }) | ConvertTo-Json -Compress)
        # consent file deliberately ABSENT

        $r = Invoke-Watch $sb
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $kinds = @(Get-Journal $sb | ForEach-Object { $_.kind })
        $kinds | Should -Contain 'kill-blocked-no-consent'
        $kinds | Should -Not -Contain 'killed'
        $kinds | Should -Not -Contain 'dryrun-kill'
        Get-StopCount $sb | Should -Be 0
    }
}

Describe 'session-watch unattributed guard (CR B1)' {
    It 'session_id empty, consent PRESENT, -DryRun absent -> skip-unattributed, zero kills even with bound-looking processes' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        Write-SandboxFile $sb 'scan-output.json' (ScanJson @(New-ScanSession '' 90 10 100))
        # the pre-B1 trap: two PIDs, an empty regex "binds" both
        Write-SandboxFile $sb 'procs.json' (@(
            @{ ProcessId = 111; CommandLine = 'claude.exe --print' },
            @{ ProcessId = 222; CommandLine = 'claude.exe --continue' }
        ) | ConvertTo-Json -Compress)
        New-Item -ItemType File (Join-Path $sb 'session-watch.kill.enabled') -Force | Out-Null

        $r = Invoke-Watch $sb
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $kinds = @(Get-Journal $sb | ForEach-Object { $_.kind })
        $kinds | Should -Contain 'skip-unattributed'
        $kinds | Should -Not -Contain 'killed'
        $kinds | Should -Not -Contain 'dryrun-kill'
        $kinds | Should -Not -Contain 'kill-blocked-no-consent'   # never reached the consent path
        Get-StopCount $sb | Should -Be 0
    }

    It 'session_id 7 chars (below the 8-char floor) -> same refusal' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        Write-SandboxFile $sb 'scan-output.json' (ScanJson @(New-ScanSession 'abc1234' 90 10 100))
        New-Item -ItemType File (Join-Path $sb 'session-watch.kill.enabled') -Force | Out-Null

        $r = Invoke-Watch $sb
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $kinds = @(Get-Journal $sb | ForEach-Object { $_.kind })
        $kinds | Should -Contain 'skip-unattributed'
        Get-StopCount $sb | Should -Be 0
    }
}

Describe 'session-watch rogue-schtasks name-only journal (CR B2-c)' {
    It 'a rogue action journals task=NAME only — a credential-shaped /TR secret never enters the journal' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        $secret = 'sk-ant-PESTER-SECRET-DO-NOT-JOURNAL'
        # CSV /V: HostName first, TaskName second; the action column carries claude.exe,
        # the "Task To Run" column carries the secret (the exact #192 leak shape).
        Write-SandboxFile $sb 'schtasks.csv' (
            '"HostName","TaskName"' + "`n" +
            '"' + $env:COMPUTERNAME + '","\Microsoft\Windows\FakeCare","claude.exe /coordinate","","N/A"' + "`n" +
            '"' + $env:COMPUTERNAME + '","\RogueAgent","powershell.exe -Command claude.exe --print /continue","' + $secret + '","N/A"'
        )

        $r = Invoke-Watch $sb
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $rogue = @(Get-Journal $sb | Where-Object { $_.kind -eq 'rogue-schtasks' })
        $rogue.Count | Should -Be 1
        $rogue[0].detail | Should -BeLike '*task=\RogueAgent*'
        $rogue[0].detail | Should -Not -BeLike '*Microsoft*'      # the \Microsoft\ row stays excluded
        (Get-Content (Join-Path $sb 'session-watch.log') -Raw) | Should -Not -BeLike "*$secret*"
    }
}

Describe 'session-watch catalog unroll (CR B2-d, PS 5.1 vs 7)' {
    It 'unchanged 8-id catalog -> new=0 gone=0 (the pre-7694ed55 shape was new x8 + gone x1)' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        $ids = 1..8 | ForEach-Object { 'MiniMax-M{0}' -f $_ }
        $catalog = @{ data = @($ids | ForEach-Object { @{ id = $_ } }) } | ConvertTo-Json -Depth 4 -Compress
        Write-SandboxFile $sb 'catalog.json' $catalog
        # seed the baseline with the SAME 8 ids (written the way the organ writes it)
        Write-SandboxFile $sb 'session-watch-models.baseline.json' ($ids | ConvertTo-Json -Compress)
        # the catalog pin needs a real HubConfig shape: apiKeys.MINIMAX_CODING_API_KEY present
        Write-SandboxFile $sb 'hub-config.json' '{"apiKeys":{"MINIMAX_CODING_API_KEY":"test-key"}}'

        $r = Invoke-Watch $sb -HubConfig "$sb\hub-config.json"
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $kinds = @(Get-Journal $sb | ForEach-Object { $_.kind })
        $kinds | Should -Not -Contain 'new-model'
        $kinds | Should -Not -Contain 'model-gone'
    }

    It 'positive control: a 9th id MUST surface as new-model (the pin can detect, not just pass)' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        $ids = 1..8 | ForEach-Object { 'MiniMax-M{0}' -f $_ }
        Write-SandboxFile $sb 'session-watch-models.baseline.json' ($ids | ConvertTo-Json -Compress)
        $catalogIds = $ids + 'MiniMax-M3.1-Flash'
        Write-SandboxFile $sb 'catalog.json' (@{ data = @($catalogIds | ForEach-Object { @{ id = $_ } }) } | ConvertTo-Json -Depth 4 -Compress)
        Write-SandboxFile $sb 'hub-config.json' '{"apiKeys":{"MINIMAX_CODING_API_KEY":"test-key"}}'

        $r = Invoke-Watch $sb -HubConfig "$sb\hub-config.json"
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
        $new = @(Get-Journal $sb | Where-Object { $_.kind -eq 'new-model' })
        $new.Count | Should -Be 1
        $new[0].detail | Should -BeLike '*MiniMax-M3.1-Flash*'
    }
}

Describe 'session-watch exit discipline' {
    It 'scan fixture absent seams still exit 0 (a crashed tick is worse than a skipped one)' {
        $sb = New-WatchSandbox; $script:Sandboxes += $sb
        Initialize-BenignFixtures $sb
        $r = Invoke-Watch $sb
        $r.Code | Should -Be 0 -Because "child must exit clean; child output was: [$($r.Out)]"
    }
}
