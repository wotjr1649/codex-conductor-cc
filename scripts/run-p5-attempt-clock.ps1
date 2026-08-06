[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
    throw 'P5E_ATTEMPT_CLOCK: GITHUB_OUTPUT is required'
}

$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "started_at=$startedAt"
Write-Output $startedAt
