<#
.SYNOPSIS
    Monthly retention for W3SVC49 IIS logs (models.myia.io): archive to the Drive,
    verify, record, then purge by explicit name.

.DESCRIPTION
    ACKed policy (ai-01, 10/11 00:09Z — thread po2023-iis49-proposal-repost-20261109):

    - Rayon STRICT: `u_ex*.log` in one W3SVC49 directory only (the `_x` rolled
      shape included). Any other path is refused.
    - Selection by NAME, never mtime: the day is encoded in `u_exYYMMDD.log`.
      Today and yesterday are never touched (by construction). A file is a
      candidate iff its name-date is strictly older than -CutoffDays (30).
      Unparseable names are ignored and listed, never touched.
    - Pipeline, in order: 7z a (explicit names, staged locally) -> copy to the
      Drive dir -> `7z t` ON THE DRIVE COPY (the artifact of record) -> verify
      size equality + sha256 x2 concordant + staging==drive -> append the
      manifest via Update-ShaManifest -Extra (source=iis49-retention) -> purge
      by explicit name, one Remove-Item -LiteralPath at a time.
    - Never overwrites an existing archive on the Drive (re-run safety).
    - Never purges anything on the Drive. No other W3SVC site is touched.

    `-WhatIf` lists exactly the names that would be purged (and each step it
    would perform) and writes nothing — no staging, no Drive write, no manifest
    append, no delete.

    PS 5.1-compatible syntax (the scheduled/manual interpreter).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceDir  = 'C:\inetpub\logs\LogFiles\W3SVC49',
    [string]$DriveDir   = 'G:\Mon Drive\Backups-Cloud\claudish\iis-logs',
    [string]$StagingDir = (Join-Path $env:TEMP 'iis49-retention'),
    [string]$SevenZip   = 'D:\Apps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe',
    [int]$CutoffDays    = 30,
    [string]$ArchiveName = ''
)

$ErrorActionPreference = 'Stop'

function Assert-Iis49SourceDir {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "refusing: source dir not found: $Path"
    }
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\')
    if ($resolved -notmatch '(?i)\\W3SVC49$') {
        throw "refusing: source dir is not a W3SVC49 directory: $resolved"
    }
    return $resolved
}

function Get-Iis49NameDate {
    # u_exYYMMDD.log or u_exYYMMDD_x.log -> [datetime]; anything else -> $null.
    # The date must ROUND-TRIP: PowerShell's Get-Date silently overflows an
    # impossible day (Feb 30 -> Mar 2) instead of throwing, so the parsed tag is
    # compared back to the captured one — u_ex260230.log is unparseable by design.
    param([Parameter(Mandatory)][string]$Name)
    if ($Name -match '^u_ex(\d{2})(\d{2})(\d{2})(?:_x)?\.log$') {
        $tag = $Matches[1] + $Matches[2] + $Matches[3]
        # -Millisecond 0 is load-bearing: Get-Date with explicit Y/M/D/H/M/S
        # inherits the CURRENT millisecond, so two files of the same day would
        # get non-tie dates and the lot order would depend on parse order.
        try   { $d = Get-Date -Year (2000 + [int]$Matches[1]) -Month ([int]$Matches[2]) -Day ([int]$Matches[3]) -Hour 12 -Minute 0 -Second 0 -Millisecond 0 }
        catch { return $null }
        if ($d.ToString('yyMMdd') -ne $tag) { return $null }
        return $d
    }
    return $null
}

function Confirm-Iis49Copy {
    # Size equality + sha256 twice on the drive copy + staging == drive.
    # Returns $true only when every check passes.
    param(
        [Parameter(Mandatory)][string]$StagingPath,
        [Parameter(Mandatory)][string]$DrivePath
    )
    $s = Get-Item -LiteralPath $StagingPath
    $d = Get-Item -LiteralPath $DrivePath
    if ($s.Length -ne $d.Length) { Write-Verbose ("copy-verify: SIZE mismatch staging={0} drive={1}" -f $s.Length, $d.Length); return $false }
    $hs = (Get-FileHash -LiteralPath $StagingPath -Algorithm SHA256).Hash
    $d1 = (Get-FileHash -LiteralPath $DrivePath  -Algorithm SHA256).Hash
    $d2 = (Get-FileHash -LiteralPath $DrivePath  -Algorithm SHA256).Hash
    if ($d1 -ne $d2) { Write-Verbose 'copy-verify: drive sha256 DIVERGENT across two reads'; return $false }
    if ($hs -ne $d1) { Write-Verbose 'copy-verify: staging sha256 != drive sha256'; return $false }
    return $true
}

# --- guard A: rayon ---
$src = Assert-Iis49SourceDir -Path $SourceDir

# --- selection by NAME ---
$now      = [DateTime]::Now
$todayMid = $now.Date
$cutoff   = $todayMid.AddDays(-$CutoffDays)

$all = @(Get-ChildItem -LiteralPath $src -File -Filter '*.log' | Sort-Object Name)
$purge = @(); $ignored = @(); $kept = @()
foreach ($f in $all) {
    $d = Get-Iis49NameDate -Name $f.Name
    if ($null -eq $d) { $ignored += $f; continue }
    # today and yesterday are protected BY NAME (parsed date >= yesterday 00:00)
    if ($d -ge $todayMid.AddDays(-1)) { $kept += $f; continue }
    if ($d -lt $cutoff) {
        # projected record: plain property names sort reliably — Sort-Object
        # scriptblock keys on FileInfo objects silently no-op (measured: the
        # lot came back in culture Name order, u_exYYMMDD_x.log before its base).
        # IsRoll: base file first, then its _x roll of the same day.
        $purge += [pscustomobject]@{ File = $f; Date = $d; IsRoll = [int]($f.Name -match '_x\.log$') }
    } else { $kept += $f }
}
$purge = @($purge | Sort-Object Date, IsRoll, { $_.File.Name })

$purgeSize = [long]0; foreach ($p in $purge) { $purgeSize += $p.File.Length }
Write-Output ("now={0:yyyy-MM-ddTHH:mmZ} cutoff={1:yyyy-MM-dd} files={2} purge={3} kept={4} ignored={5}" -f `
    $now.ToUniversalTime(), $cutoff, $all.Count, $purge.Count, $kept.Count, $ignored.Count)
foreach ($f in $ignored) { Write-Output ("ignored (unparseable name, untouched): {0}" -f $f.Name) }
if ($purge.Count -eq 0) { Write-Output 'nothing older than cutoff, nothing to do'; exit 0 }

Write-Output ("purge set: {0} files, {1:N1} MB" -f $purge.Count, ($purgeSize / 1MB))
foreach ($p in $purge) { Write-Output ("  WOULD PURGE {0}  {1:N2} MB" -f $p.File.Name, ($p.File.Length / 1MB)) }

if (-not $WhatIfPreference -and -not (Test-Path -LiteralPath $SevenZip)) { throw "7z not found: $SevenZip" }

# --- 1. stage the archive locally ---
if (-not $PSCmdlet.ShouldProcess($StagingDir, 'create staging dir')) { exit 0 }
$null = New-Item -ItemType Directory -Path $StagingDir -Force
if ([string]::IsNullOrWhiteSpace($ArchiveName)) {
    $ArchiveName = 'iis49-{0:yyyyMMdd-HHmm}.7z' -f $now.ToUniversalTime()
}
$stagingPath = Join-Path $StagingDir $ArchiveName
$drivePath   = Join-Path $DriveDir $ArchiveName

if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Force }
if (-not $PSCmdlet.ShouldProcess($stagingPath, '7z a (staging archive)')) { exit 0 }
$names = @($purge | ForEach-Object { $_.File.Name })
Push-Location -LiteralPath $src
try {
    & $SevenZip a -t7z -mx=5 -bso0 -bsp0 $stagingPath @names | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "refusing: 7z a failed with exit $LASTEXITCODE — nothing copied, nothing purged" }
    if (-not (Test-Path -LiteralPath $stagingPath)) { throw 'refusing: 7z a reported success but the staging archive is missing' }
}
finally { Pop-Location }

# --- 2. copy to the Drive (never overwrite an existing archive) ---
if (Test-Path -LiteralPath $drivePath) {
    throw "refusing: archive already exists on the Drive: $drivePath — a re-run must not overwrite it"
}
if (-not $PSCmdlet.ShouldProcess($drivePath, 'copy archive to Drive')) { exit 0 }
$null = New-Item -ItemType Directory -Path $DriveDir -Force
Copy-Item -LiteralPath $stagingPath -Destination $drivePath

# --- 3. integrity: 7z t on the DRIVE copy (the artifact of record) ---
if (-not $PSCmdlet.ShouldProcess($drivePath, '7z t (drive copy)')) { exit 0 }
& $SevenZip t -bso0 -bsp0 $drivePath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "refusing: 7z t failed with exit $LASTEXITCODE on the drive copy — nothing purged" }

# --- 4. verify the copy: size equal + sha256 x2 + staging == drive ---
if (-not (Confirm-Iis49Copy -StagingPath $stagingPath -DrivePath $drivePath)) {
    throw 'refusing: drive copy does not verify against the staging archive — nothing purged'
}
$finalHash  = (Get-FileHash -LiteralPath $drivePath -Algorithm SHA256).Hash
$finalBytes = (Get-Item -LiteralPath $drivePath).Length

# --- 5. manifest append (provenance extras; never purged on the Drive) ---
$manifest = Join-Path $DriveDir 'iis49-sha256.jsonl'
Import-Module (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1') -Force
if (-not $PSCmdlet.ShouldProcess($manifest, 'append manifest entry')) { exit 0 }
# return captured: an uncaptured PSCustomObject on the output stream mid-script
# corrupts the stream (measured: every Write-Output after it is swallowed and the
# child renders one blank line, while the pipeline itself runs to completion).
$null = Update-ShaManifest -Path $manifest -Archive $ArchiveName -Sha256 $finalHash -Bytes ([long]$finalBytes) `
    -RecordedUtc ($now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) `
    -Extra @{
        source        = 'iis49-retention'
        source_files  = $purge.Count
        source_bytes  = $purgeSize
        oldest        = $purge[0].File.Name
        newest        = $purge[-1].File.Name
        cutoff_days   = $CutoffDays
    }

# --- 6. purge by explicit name ---
$purged = 0
foreach ($p in $purge) {
    if (-not $PSCmdlet.ShouldProcess($p.File.FullName, 'purge (retention)')) { break }
    Remove-Item -LiteralPath $p.File.FullName -Force
    $purged++
}
Write-Output ("DONE archive={0} purged={1}/{2} freed={3:N1} MB sha256={4}" -f `
    $drivePath, $purged, $purge.Count, ($purgeSize / 1MB), $finalHash)
exit 0
