[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$ToolId,

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
        throw "P3E_PATH_ESCAPE: selected path is outside the run-owned root"
    }
}

$repoRoot = Get-NormalizedFullPath -LiteralPath (Join-Path $PSScriptRoot '..')
$destination = Get-NormalizedFullPath -LiteralPath $DestinationRoot
if (
    $destination.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $destination.StartsWith(
        $repoRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "P3E_WORKSPACE_DESTINATION: tools must be acquired outside the repository"
}

$manifestPath = Join-Path $repoRoot 'toolchain.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$tool = @($manifest.tools | Where-Object { $_.id -eq $ToolId })
if ($tool.Count -ne 1) {
    throw "P3E_TOOL_ID: expected one exact tool entry for '$ToolId'"
}
$tool = $tool[0]
if (-not $tool.installable) {
    throw "P3E_NOT_INSTALLABLE: '$ToolId' is inherited rather than independently installed"
}
if ($tool.artifact.url -notmatch '^https://') {
    throw "P3E_ARTIFACT_URL: HTTPS is required"
}
if ($tool.artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "P3E_ARTIFACT_DIGEST: exact SHA-256 is required"
}
if ($tool.artifact.executableSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "P3E_EXECUTABLE_DIGEST: exact executable SHA-256 is required"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
$toolRoot = Join-Path $destination ($tool.id + '-' + $tool.version)
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
Assert-ContainedPath -Parent $destination -Candidate $toolRoot

$downloadPath = Join-Path $toolRoot 'download.bin'
Invoke-WebRequest -Uri $tool.artifact.url -OutFile $downloadPath -MaximumRedirection 3
$downloadDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
if ($downloadDigest -ne $tool.artifact.sha256) {
    throw "P3E_ARTIFACT_DIGEST_MISMATCH: downloaded bytes do not match toolchain.json"
}

switch ($tool.artifact.kind) {
    'zip' {
        $archivePath = Join-Path $toolRoot 'download.zip'
        Move-Item -LiteralPath $downloadPath -Destination $archivePath
        $extractRoot = Join-Path $toolRoot 'extracted'
        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
        $selectedPath = Join-Path $extractRoot $tool.artifact.executableRelativePath
    }
    'file' {
        $selectedPath = $downloadPath
    }
    default {
        throw "P3E_ARTIFACT_KIND: unsupported installable artifact kind"
    }
}

Assert-ContainedPath -Parent $toolRoot -Candidate $selectedPath
if (-not (Test-Path -LiteralPath $selectedPath -PathType Leaf)) {
    throw "P3E_EXECUTABLE_MISSING: selected executable was not found"
}
$selectedItem = Get-Item -Force -LiteralPath $selectedPath
if (($selectedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "P3E_REPARSE_POINT: selected executable may not be a reparse point"
}
foreach ($ancestor in @($selectedItem.Directory, $selectedItem.Directory.Parent)) {
    if (
        $null -ne $ancestor -and
        ($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
        throw "P3E_REPARSE_ANCESTOR: executable ancestry may not contain a reparse point"
    }
}

$executableDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $selectedPath).Hash.ToLowerInvariant()
if ($executableDigest -ne $tool.artifact.executableSha256) {
    throw "P3E_EXECUTABLE_DIGEST_MISMATCH: executable bytes do not match toolchain.json"
}

if ($tool.signature.authenticodeRequired) {
    $signature = Get-AuthenticodeSignature -LiteralPath $selectedPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "P3E_AUTHENTICODE_STATUS: a valid Authenticode signature is required"
    }
    if (
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject.IndexOf(
            $tool.signature.signer,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -lt 0
    ) {
        throw "P3E_AUTHENTICODE_SIGNER: signer does not match toolchain.json"
    }
}

$installedPath = Join-Path $toolRoot $tool.artifact.installedExecutableName
Assert-ContainedPath -Parent $toolRoot -Candidate $installedPath
if (-not $selectedPath.Equals(
    $installedPath,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    Copy-Item -LiteralPath $selectedPath -Destination $installedPath -Force
}

$installedDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedPath).Hash.ToLowerInvariant()
if ($installedDigest -ne $tool.artifact.executableSha256) {
    throw "P3E_INSTALLED_DIGEST_MISMATCH: installed executable changed after selection"
}

Write-Output (Get-NormalizedFullPath -LiteralPath $installedPath)
