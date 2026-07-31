[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('build', 'current', 'previous')]
    [string]$Lane,

    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $normalizedParent = Get-NormalizedFullPath -LiteralPath $Parent
    $normalizedCandidate = Get-NormalizedFullPath -LiteralPath $Candidate
    $prefix = $normalizedParent + [System.IO.Path]::DirectorySeparatorChar
    if (-not $normalizedCandidate.StartsWith(
        $prefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'P4E_PATH_ESCAPE: selected path is outside the run-owned root'
    }
}

function Assert-NoReparsePath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $cursor = Get-Item -Force -LiteralPath $LiteralPath
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'P4E_REPARSE_PATH: path ancestry may not contain a reparse point'
        }
        if ($cursor -is [System.IO.FileInfo]) {
            $cursor = $cursor.Directory
        }
        else {
            $cursor = $cursor.Parent
        }
    }
}

$repoRoot = Get-NormalizedFullPath -LiteralPath (Join-Path $PSScriptRoot '..')
$destination = Get-NormalizedFullPath -LiteralPath $DestinationRoot
$volumeRoot = Get-NormalizedFullPath -LiteralPath (
    [System.IO.Path]::GetPathRoot($destination)
)
if ($destination.Equals($volumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'P4E_BROAD_DESTINATION: a volume root cannot be a tool destination'
}
if (
    $destination.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $destination.StartsWith(
        $repoRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw 'P4E_WORKSPACE_DESTINATION: tools must be acquired outside the repository'
}

$manifestPath = Join-Path $repoRoot 'contracts/codex/contract-tools-v1.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$laneRecord = $manifest.lanes.$Lane
$artifact = @($manifest.artifacts | Where-Object { $_.id -eq $laneRecord.artifactId })
if ($artifact.Count -ne 1) {
    throw "P4E_ARTIFACT_ID: expected one exact artifact for lane '$Lane'"
}
$artifact = $artifact[0]
if ($laneRecord.version -ne $artifact.version) {
    throw 'P4E_LANE_VERSION: lane and artifact versions differ'
}
if ($artifact.archiveUrl -notmatch '^https://') {
    throw 'P4E_ARTIFACT_URL: HTTPS is required'
}
if ($artifact.archiveSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'P4E_ARCHIVE_DIGEST: exact SHA-256 is required'
}
if ($artifact.executableSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'P4E_EXECUTABLE_DIGEST: exact SHA-256 is required'
}

if (-not (Test-Path -LiteralPath $destination)) {
    New-Item -ItemType Directory -Path $destination | Out-Null
}
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    throw 'P4E_DESTINATION_TYPE: destination must be a directory'
}
Assert-NoReparsePath -LiteralPath $destination

$toolRoot = Join-Path $destination ("codex-$Lane-" + $artifact.version)
if (Test-Path -LiteralPath $toolRoot) {
    throw 'P4E_TOOL_ROOT_EXISTS: exact tool root must be newly run-owned'
}
New-Item -ItemType Directory -Path $toolRoot | Out-Null
Assert-ContainedPath -Parent $destination -Candidate $toolRoot
Assert-NoReparsePath -LiteralPath $toolRoot

$archivePath = Join-Path $toolRoot 'codex.zip'
Invoke-WebRequest -Uri $artifact.archiveUrl -OutFile $archivePath -MaximumRedirection 3
$archiveDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($archiveDigest -ne $artifact.archiveSha256) {
    throw 'P4E_ARCHIVE_DIGEST_MISMATCH: downloaded archive does not match the manifest'
}

$extractRoot = Join-Path $toolRoot 'extracted'
New-Item -ItemType Directory -Path $extractRoot | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $archive.Entries) {
        if ([string]::IsNullOrWhiteSpace($entry.FullName)) {
            throw 'P4E_ZIP_ENTRY: empty archive entry is forbidden'
        }
        $entryPath = Join-Path $extractRoot $entry.FullName
        $normalizedEntry = Get-NormalizedFullPath -LiteralPath $entryPath
        $normalizedExtractRoot = Get-NormalizedFullPath -LiteralPath $extractRoot
        if ($normalizedEntry.Equals(
            $normalizedExtractRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            if (-not $entry.FullName.EndsWith('/')) {
                throw 'P4E_ZIP_ESCAPE: archive file resolves to extraction root'
            }
        }
        else {
            Assert-ContainedPath -Parent $extractRoot -Candidate $normalizedEntry
        }
    }
}
finally {
    $archive.Dispose()
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot

$selectedPath = Join-Path $extractRoot $artifact.executableRelativePath
Assert-ContainedPath -Parent $extractRoot -Candidate $selectedPath
if (-not (Test-Path -LiteralPath $selectedPath -PathType Leaf)) {
    throw 'P4E_EXECUTABLE_MISSING: selected executable was not found'
}
Assert-NoReparsePath -LiteralPath $selectedPath

$executableDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $selectedPath).Hash.ToLowerInvariant()
if ($executableDigest -ne $artifact.executableSha256) {
    throw 'P4E_EXECUTABLE_DIGEST_MISMATCH: selected executable does not match the manifest'
}

$signature = Get-AuthenticodeSignature -LiteralPath $selectedPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw 'P4E_AUTHENTICODE_STATUS: a valid Authenticode signature is required'
}
if ($null -eq $signature.SignerCertificate) {
    throw 'P4E_AUTHENTICODE_CERTIFICATE: signer certificate is missing'
}
if (-not $signature.SignerCertificate.Subject.Equals(
    $artifact.authenticode.subject,
    [System.StringComparison]::Ordinal
)) {
    throw 'P4E_AUTHENTICODE_SUBJECT: signer subject differs from the manifest'
}
if (-not $signature.SignerCertificate.Thumbprint.Equals(
    $artifact.authenticode.leafThumbprint,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'P4E_AUTHENTICODE_THUMBPRINT: signer leaf differs from the observed release'
}

$installedPath = Join-Path $toolRoot 'codex.exe'
Copy-Item -LiteralPath $selectedPath -Destination $installedPath
$installedDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedPath).Hash.ToLowerInvariant()
if ($installedDigest -ne $artifact.executableSha256) {
    throw 'P4E_INSTALLED_DIGEST_MISMATCH: installed bytes changed after selection'
}

Write-Output (Get-NormalizedFullPath -LiteralPath $installedPath)
