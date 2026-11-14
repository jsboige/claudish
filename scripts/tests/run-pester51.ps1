# Hermetic Pester runner for the 5.1 lane (#959).
#
# `bun run test:scripts:win51` spawns powershell.exe through Bun Shell, which
# passes the parent's PSModulePath through VERBATIM (measured 10/11: the
# bun-spawned child's path is byte-identical to the pwsh 7 parent's). A pwsh 7
# parent therefore hands the 5.1 child Documents\PowerShell\Modules - the pwsh-7
# user module dir - and the child auto-loads Pester 6.1.0 from there while its
# own Documents\WindowsPowerShell\Modules (Pester 6.2.0) never enters the path.
# The skewed harness dropped built-in cmdlets mid-suite (Get-FileHash at
# Add-OffsiteEvidence) and reddened 14 tests, byte-identical on origin/main.
#
# A direct powershell.exe invocation rebuilds its own module path and is immune;
# only the bun-spawned lane needs this reset. The reset must NOT be inlined in
# package.json: Bun Shell expands $-vars inside the double-quoted -Command
# before powershell.exe parses it (measured: `$m` arrived as the empty string).
#
# The 5.1 user module dir is derived from the MyDocuments known folder - it is
# in NO registry scope on this fleet (Machine holds the two system dirs, User is
# unset), so a registry-only recompute would drop it and fall back to the
# machine-wide Pester 3.4.0.
param(
    [string]$Path = './scripts/tests'
)
# NO `$ErrorActionPreference = 'Stop'` here: it would outlive this file and
# leak into Invoke-Pester's test session, where every child-process stderr
# write becomes a terminating RemoteException (measured: 9 reds that the old
# inline form, which ran under the default 'Continue', never showed).

$m = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
$u = [Environment]::GetEnvironmentVariable('PSModulePath', 'User')
$d = [Environment]::GetFolderPath('MyDocuments')
if ($d) { $d = Join-Path $d 'WindowsPowerShell\Modules' }
# ORDER is load-bearing: module resolution walks PSModulePath entries in order
# and the FIRST dir holding the module wins - machine-first would resolve the
# machine-wide Pester 3.4.0 over the user's 6.2.0 (measured). 5.1's own native
# construction puts the user dir first; mirror it.
$env:PSModulePath = (@($u, $d, $m) | Where-Object { $_ }) -join ';'

Invoke-Pester $Path -Output Detailed -CI
