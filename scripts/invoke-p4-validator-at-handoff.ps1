[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$p4Final = '84515289913dfe8a7452754ad442d37873bdfd53'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\', '/')
$toolDestination = [IO.Path]::GetFullPath($destination + '.tools').TrimEnd('\', '/')
$volumeRoot = [IO.Path]::GetPathRoot($destination).TrimEnd('\', '/')
if (
    $destination.Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $destination.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $destination.StartsWith(
        $repoRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
) {
    throw 'P5E_P4_VALIDATOR_ROOT: detached validation requires a narrow root outside the repository'
}
if (Test-Path -LiteralPath $destination) {
    throw 'P5E_P4_VALIDATOR_EXISTS: detached validation root must be new'
}
if (
    (Test-Path -LiteralPath $toolDestination) -or
    [IO.Path]::GetDirectoryName($toolDestination) -cne [IO.Path]::GetDirectoryName($destination)
) {
    throw 'P5E_P4_TOOL_ROOT: exact P4 tool root must be a new sibling of the detached worktree'
}

$commitType = (& git -C $repoRoot cat-file -t $p4Final 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $commitType -ne 'commit') {
    throw 'P5E_P4_HANDOFF_MISSING: exact P4 final commit is unavailable'
}

& git -C $repoRoot worktree add --detach -- $destination $p4Final
if ($LASTEXITCODE -ne 0) {
    throw 'P5E_P4_WORKTREE_ADD: exact P4 validation worktree could not be created'
}
try {
    $codexPath = & (Join-Path $destination 'scripts\install-p4-codex.ps1') `
        -Lane current `
        -DestinationRoot $toolDestination
    if ($LASTEXITCODE -ne 0) {
        throw 'P5E_P4_CODEX: exact current Codex acquisition failed'
    }
    $priorPath = $env:PATH
    $env:PATH = [IO.Path]::GetDirectoryName($codexPath) +
        [IO.Path]::PathSeparator +
        $priorPath
    Push-Location -LiteralPath $destination
    try {
        $nodeVersion = (& node --version | Out-String).Trim()
        $npmVersion = (& npm --version | Out-String).Trim()
        if ($nodeVersion -ne 'v24.18.1' -or $npmVersion -ne '11.16.0') {
            throw 'P5E_P4_RUNTIME: exact Node 24.18.1 and npm 11.16.0 are required'
        }
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'P5E_P4_NPM_CI: exact clean dependency installation failed'
        }
        & node 'scripts\generate-app-server-types.mjs'
        if ($LASTEXITCODE -ne 0) {
            throw 'P5E_P4_GENERATED: exact generated tree reproduction failed'
        }
    }
    finally {
        Pop-Location
        $env:PATH = $priorPath
    }
    & node (Join-Path $destination 'scripts\validate-p4.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'P5E_P4_VALIDATOR: exact handoff validator failed'
    }
}
finally {
    & git -C $repoRoot worktree remove --force -- $destination
    if ($LASTEXITCODE -ne 0) {
        throw 'P5E_P4_WORKTREE_REMOVE: detached validation worktree cleanup failed'
    }
    if (Test-Path -LiteralPath $toolDestination) {
        Remove-Item -Recurse -Force -LiteralPath $toolDestination
    }
}
