[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$registry = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'ci\matrix-profiles-v1.json') |
    ConvertFrom-Json
$expectedVersion = [string]$registry.support.exactBlockingNode
$expectedNpm = [string]$registry.tools.node.npmVersion
$expectedDigest = [string]$registry.tools.node.executableSha256

$node = Get-Command node -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
$nodePath = $node.Source
$observedVersion = (& $nodePath --version).Trim().TrimStart('v')
$observedNpm = (& npm --version).Trim()
$observedArchitecture = (& $nodePath -p 'process.arch').Trim()
$observedDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant()

if (
    $observedVersion -cne $expectedVersion -or
    $observedNpm -cne $expectedNpm -or
    $observedArchitecture -cne 'x64' -or
    $observedDigest -cne $expectedDigest
) {
    throw 'P5E_NODE_IDENTITY: exact Node/npm/x64 executable identity is required before profile execution'
}

$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) {
    Add-Content -LiteralPath $env:GITHUB_ENV -Value "P5_STARTED_AT=$startedAt"
}

[ordered]@{
    node = $observedVersion
    npm = $observedNpm
    architecture = $observedArchitecture
    executableSha256 = $observedDigest
    startedAt = $startedAt
} | ConvertTo-Json -Compress
