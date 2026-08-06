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
$npmPath = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw 'P5E_NODE_IDENTITY: npm.cmd must be adjacent to the exact node.exe'
}
$observedVersion = (& $nodePath --version).Trim().TrimStart('v')
$observedNpm = (& $npmPath --version).Trim()
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

[ordered]@{
    node = $observedVersion
    npm = $observedNpm
    architecture = $observedArchitecture
    executableSha256 = $observedDigest
} | ConvertTo-Json -Compress
