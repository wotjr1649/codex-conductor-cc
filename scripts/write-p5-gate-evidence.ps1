[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$StartedAt = '',
    [Parameter(Mandatory = $true)]
    [ValidateSet('success', 'failure', 'cancelled')]
    [string]$JobStatus,
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$BlockingResults,
    [string]$ExpectedNodeVersion = '24.18.1',
    [string]$ExpectedNpmVersion = '11.16.0',
    [string]$ExpectedNodeSha256 = 'ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib\p5-runner-provenance.psm1') -Force

$expectedJobs = @(
    'policy-validation',
    'install-build',
    'unit',
    'core-contract',
    'windows-integration',
    'claude-lifecycle',
    'security',
    'dependency-review'
)
$actualJobs = @($BlockingResults.Keys | ForEach-Object { [string]$_ } | Sort-Object)
if (($actualJobs -join "`n") -cne (@($expectedJobs | Sort-Object) -join "`n")) {
    throw 'P5E_GATE_EVIDENCE: exact blocking job result set is required'
}
$normalizedResults = [ordered]@{}
foreach ($job in $expectedJobs) {
    $result = [string]$BlockingResults[$job]
    if ($result -notin @('success', 'failure', 'cancelled', 'skipped')) {
        throw "P5E_GATE_EVIDENCE: invalid result for $job"
    }
    $normalizedResults[$job] = $result
}
$allBlockingSucceeded = @(
    $normalizedResults.Values | Where-Object { $_ -cne 'success' }
).Count -eq 0
$observedStatus = if ($JobStatus -ceq 'success' -and $allBlockingSucceeded) {
    'executed-pass'
}
else {
    'executed-fail'
}
$rawExitCode = if ($observedStatus -ceq 'executed-pass') { 0 } else { 1 }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$provenance = Get-P5ExecutionProvenance `
    -RepositoryRoot $repoRoot `
    -OutputPath $resolvedOutput `
    -ExecutionClass hosted `
    -ExpectedNodeVersion $ExpectedNodeVersion `
    -ExpectedNpmVersion $ExpectedNpmVersion `
    -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -RequireNodeIdentity ($observedStatus -ceq 'executed-pass') `
    -CheckRunId $env:P5_CHECK_RUN_ID
if ($provenance.run.yamlJobKey -cne 'gate') {
    throw 'P5E_GATE_EVIDENCE: terminal evidence must originate from the gate job'
}
$attempt = Get-P5AttemptEvidence `
    -StartedAt $StartedAt `
    -ObservedStatus $observedStatus `
    -RawExitCode $rawExitCode `
    -RawExitCodeSource github-job-status-normalized `
    -ResourceOracleStatus not-applicable `
    -RunAttempt ([long]$provenance.run.attempt) `
    -RequireStartedAt ($observedStatus -ceq 'executed-pass')
$nodeIdentity = $provenance.node
$null = $provenance.Remove('node')

$evidence = [ordered]@{
    schemaVersion = 'p5-gate-evidence-v1'
    evidenceKind = 'terminal-gate'
    jobKey = 'gate'
    checkName = 'CI'
    blocking = $true
    expectedBlockingResult = 'success'
    blockingResults = $normalizedResults
    allBlockingSucceeded = $allBlockingSucceeded
    provenance = $provenance
    tools = [ordered]@{
        nodeIdentityStatus = $nodeIdentity.nodeIdentityStatus
        node = $nodeIdentity.node
        npm = $nodeIdentity.npm
        nodeArchitecture = $nodeIdentity.nodeArchitecture
        nodeExecutableSha256 = $nodeIdentity.nodeExecutableSha256
        selected = @()
    }
    attempt = $attempt
    artifact = [ordered]@{
        repositoryAuthoredUpload = $false
        actionOwnedConditionalUploadPossible = $false
        observedUpload = $false
        digest = $null
        retentionDays = $null
        readbackStatus = 'not-applicable'
        releaseTrustInput = $false
    }
    cache = [ordered]@{
        repositoryAuthoredCacheEnabled = $false
        readbackStatus = 'pending-rest-readback'
        releaseTrustInput = $false
    }
    privacy = [ordered]@{
        privatePathsPersisted = $false
        secretsPersisted = $false
        rawEnvironmentPersisted = $false
        rawPromptOrPayloadPersisted = $false
        rawStdoutOrStderrPersisted = $false
        redactionStatus = 'executed-pass'
    }
}
Write-P5SanitizedEvidence -Evidence $evidence -OutputPath $resolvedOutput
