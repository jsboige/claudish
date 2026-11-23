# Hermetic Pester runner for the 7.x lane (#1166).
#
# A script under test resolves its off-site dir from the SEAT's env when the
# test does not pass -GDriveDir explicitly (compress-captures.ps1:140-142,
# iis49-retention.ps1:47-49, reconcile-outage-captures.ps1:100-102): with
# CLAUDISH_GDRIVE_ROOT set, one suite invocation deposits into the REAL store
# (measured by ai-01 replaying #1160, c.7083536044). Suites may clear the var
# by hand (the exit suite does), but a runner-level reset makes a FORGOTTEN
# isolation harmless instead of an off-site write.
#
# The reset list lives HERE, in code — not only in the issue's inventory
# table: grep -n 'env:CLAUDISH_' scripts/*.ps1 scripts/lib/*.psm1 is the
# exhaustive source. Additive by design; extend it when a new seat-facing var
# appears in a script under test.
#
# Restore in finally: this file runs in the CALLER's scope (the CI leg
# dot-calls it), so a missing restore would leak the cleared env into whatever
# the caller does next. NO $ErrorActionPreference='Stop' (would leak into
# Invoke-Pester's session — the run-pester51.ps1 header documents that trap).
param(
    [string]$Path = './scripts/tests',
    [string[]]$ExcludeTagFilter = @()
)

$seatEnv = @('CLAUDISH_GDRIVE_ROOT', 'CLAUDISH_SESSION_WATCH_EXEMPT_PATTERN')
$backup = @{}
foreach ($n in $seatEnv) {
    $backup[$n] = [Environment]::GetEnvironmentVariable($n)
    Remove-Item "Env:$n" -ErrorAction SilentlyContinue
}
try {
    if ($ExcludeTagFilter -and $ExcludeTagFilter.Count) {
        Invoke-Pester $Path -Output Detailed -CI -ExcludeTagFilter $ExcludeTagFilter
    } else {
        Invoke-Pester $Path -Output Detailed -CI
    }
}
finally {
    foreach ($n in $seatEnv) {
        if ($null -ne $backup[$n]) { Set-Item "Env:$n" $backup[$n] }
        else { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
    }
}
