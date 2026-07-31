[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) {
    throw 'P5E_ATTEMPT_CLOCK: GITHUB_ENV is required'
}

$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
Add-Content -LiteralPath $env:GITHUB_ENV -Value "P5_STARTED_AT=$startedAt"
Write-Output $startedAt
