[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Profile,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Lane,

    [Parameter(Mandatory = $true)]
    [ValidateSet('local', 'hosted')]
    [string]$ExecutionClass,

    [string]$StartedAt = '',

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string[]]$RequirementIds,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z0-9-]+$')]
    [string]$ScenarioId,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$FixtureIds,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedOracle,

    [string]$ExpectedNodeVersion = '24.18.1',
    [string]$ExpectedNpmVersion = '11.16.0',
    [string]$ExpectedNodeSha256 = 'ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582',

    [ValidatePattern('^[a-z0-9-]*$')]
    [string]$ToolName = '',
    [string]$ExpectedToolVersion = '',
    [string]$ExpectedToolSha256 = '',
    [string]$ExpectedSignerOrganization = '',
    [string]$ToolPath = '',

    [ValidatePattern('^[a-z0-9-]+$')]
    [string[]]$SelectedToolIds = @(),
    [string[]]$SelectedToolPaths = @(),

    [ValidateSet('executed-pass', 'executed-fail', 'non-blocking-canary')]
    [string]$ObservedStatus = 'executed-pass',
    [int]$RawExitCode = 0,
    [ValidateSet('direct-process', 'github-job-status-normalized')]
    [string]$ExitCodeSource = 'direct-process',
    [ValidateSet('executed-pass', 'executed-fail', 'not-applicable', 'not-run')]
    [string]$ResourceOracleStatus = 'not-applicable'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib\p5-runner-provenance.psm1') -Force

function Invoke-ExactVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $output = (& $Executable --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $output -notmatch "(?<![0-9])$([regex]::Escape($Expected))(?![0-9])") {
        throw "P5E_TOOL_VERSION: exact version $Expected was not observed"
    }
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileRegistryPath = Join-Path $repoRoot 'ci\matrix-profiles-v1.json'
$scenarioRegistryPath = Join-Path $repoRoot 'ci\scenario-registry-v1.json'
$profileRegistry = Get-Content -Raw -LiteralPath $profileRegistryPath | ConvertFrom-Json
$scenarioRegistry = Get-Content -Raw -LiteralPath $scenarioRegistryPath | ConvertFrom-Json
$profileRecord = @($profileRegistry.profiles | Where-Object { $_.id -ceq $Profile })
$scenarioRecord = @($scenarioRegistry.scenarios | Where-Object { $_.id -ceq $ScenarioId })
if ($profileRecord.Count -ne 1 -or $scenarioRecord.Count -ne 1) {
    throw 'P5E_EVIDENCE_REGISTRY: exact profile and scenario records are required'
}
$profileRecord = $profileRecord[0]
$scenarioRecord = $scenarioRecord[0]
if ($scenarioRecord.profileId -cne $Profile) {
    throw 'P5E_EVIDENCE_PROFILE: scenario does not belong to the selected profile'
}
$expectedRequirementIds = @($scenarioRecord.requirementIds | Sort-Object -Unique)
$providedRequirementIds = @($RequirementIds | Sort-Object -Unique)
$expectedFixtureIds = @($scenarioRecord.fixtureIds | Sort-Object -Unique)
$providedFixtureIds = @($FixtureIds | Sort-Object -Unique)
if (
    ($expectedRequirementIds -join "`n") -cne ($providedRequirementIds -join "`n")
) {
    throw 'P5E_EVIDENCE_REQUIREMENT: requirement IDs must exactly match the scenario registry'
}
if (
    $providedFixtureIds.Count -ne $FixtureIds.Count -or
    @($providedFixtureIds | Where-Object { $_ -cnotin $expectedFixtureIds }).Count -ne 0
) {
    throw 'P5E_EVIDENCE_FIXTURE: verified fixture IDs must be a unique subset of the scenario registry'
}
$oracleRegistryDigest = Get-P5FileSha256 -LiteralPath $scenarioRegistryPath
$runtimeImplementedProperty = $profileRecord.PSObject.Properties['runtimeImplemented']
$runtimeImplemented = if ($null -eq $runtimeImplementedProperty) {
    $true
}
else {
    [bool]$runtimeImplementedProperty.Value
}
$deferredPhaseProperty = $profileRecord.PSObject.Properties['deferredPhase']
$deferredPhase = if ($null -eq $deferredPhaseProperty) {
    $null
}
else {
    $deferredPhaseProperty.Value
}
if (
    -not $runtimeImplemented -or
    [string]::IsNullOrWhiteSpace([string]$profileRecord.workflowJob) -or
    $profileRecord.workflowJob -cne $Profile
) {
    throw 'P5E_FALSE_GREEN: runner evidence is forbidden for a blocked or unbound profile'
}
if ([bool]$scenarioRecord.blocking -ne [bool]$profileRecord.blocking) {
    throw 'P5E_FALSE_GREEN: runner evidence may not execute a differently classified scenario'
}
$expectedLanes = if ($null -eq $profileRecord.matrix) {
    @('default')
}
else {
    @($profileRecord.matrix.values)
}
if ($Lane -cnotin $expectedLanes) {
    throw 'P5E_PROFILE_LANE: lane must exactly match the selected profile registry'
}
$expectedLaneFixtureIds = switch ("$Profile/$Lane") {
    'core-contract/current' { @('P4-TARGETED-GREEN-001', 'P5-LIFECYCLE-CURRENT-001') }
    'core-contract/previous' { @('P5-LIFECYCLE-PREVIOUS-001') }
    'claude-lifecycle/minimum' { @('P5-CLAUDE-MINIMUM-001') }
    'claude-lifecycle/current' { @('P5-CLAUDE-CURRENT-001') }
    default { @($expectedFixtureIds) }
}
$expectedLaneFixtureIds = @($expectedLaneFixtureIds | Sort-Object)
if (
    ($ObservedStatus -ceq 'executed-pass' -and $RawExitCode -ne 0) -or
    ($ObservedStatus -ceq 'executed-fail' -and $RawExitCode -eq 0) -or
    ([bool]$profileRecord.blocking -and $ObservedStatus -ceq 'non-blocking-canary') -or
    (-not [bool]$profileRecord.blocking -and $ObservedStatus -cne 'non-blocking-canary')
) {
    throw 'P5E_ATTEMPT_OUTCOME: observed status and exit code are inconsistent'
}
$successfulObservation =
    $ObservedStatus -ceq 'executed-pass' -or
    ($ObservedStatus -ceq 'non-blocking-canary' -and $RawExitCode -eq 0)
if (
    ($successfulObservation -and
        ($providedFixtureIds -join "`n") -cne ($expectedLaneFixtureIds -join "`n")) -or
    (-not $successfulObservation -and $providedFixtureIds.Count -ne 0)
) {
    throw 'P5E_EVIDENCE_FIXTURE: success requires every fixture and failure may not claim verified fixtures'
}
if (
    ($Profile -ceq 'windows-integration' -and
        $ObservedStatus -ceq 'executed-pass' -and
        $ResourceOracleStatus -cne 'executed-pass') -or
    ($Profile -ceq 'windows-integration' -and
        $ObservedStatus -ceq 'executed-fail' -and
        $ResourceOracleStatus -notin @('executed-pass', 'executed-fail', 'not-run')) -or
    ($Profile -cne 'windows-integration' -and $ResourceOracleStatus -cne 'not-applicable')
) {
    throw 'P5E_RESOURCE_ORACLE: resource status must be exact for the Windows integration profile only'
}
$nodeIdentityRequired =
    $ObservedStatus -ceq 'executed-pass' -or
    ($ObservedStatus -ceq 'non-blocking-canary' -and $RawExitCode -eq 0)
$provenance = Get-P5ExecutionProvenance `
    -RepositoryRoot $repoRoot `
    -OutputPath $resolvedOutput `
    -ExecutionClass $ExecutionClass `
    -ExpectedNodeVersion $ExpectedNodeVersion `
    -ExpectedNpmVersion $ExpectedNpmVersion `
    -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -RequireNodeIdentity $nodeIdentityRequired `
    -CheckRunId $env:P5_CHECK_RUN_ID
if (
    $ExecutionClass -ceq 'hosted' -and
    (
        $provenance.run.yamlJobKey -cne $Profile -or
        $env:P5_CONTEXT_LANE -cne $Lane
    )
) {
    throw 'P5E_PROFILE_LANE: hosted job key, profile, and matrix lane must agree'
}

$selectedTools = @()
$singleToolRequested = -not [string]::IsNullOrWhiteSpace($ToolName)
$toolSetRequested = $SelectedToolIds.Count -gt 0 -or $SelectedToolPaths.Count -gt 0
if ($singleToolRequested -and $toolSetRequested) {
    throw 'P5E_TOOL_INPUT: single-tool and selected-tool-set inputs are mutually exclusive'
}
if ($singleToolRequested) {
    if (
        [string]::IsNullOrWhiteSpace($ToolPath) -or
        [string]::IsNullOrWhiteSpace($ExpectedToolVersion) -or
        $ExpectedToolSha256 -notmatch '^[0-9a-f]{64}$'
    ) {
        throw 'P5E_TOOL_INPUT: a complete exact tool identity is required'
    }
    $resolvedTool = [IO.Path]::GetFullPath($ToolPath)
    if (-not (Test-Path -LiteralPath $resolvedTool -PathType Leaf)) {
        throw 'P5E_TOOL_MISSING: exact tool executable is missing'
    }
    $toolDigest = Get-P5FileSha256 -LiteralPath $resolvedTool
    if ($toolDigest -ne $ExpectedToolSha256) {
        throw 'P5E_TOOL_DIGEST: exact tool executable digest differs'
    }
    Invoke-ExactVersion -Executable $resolvedTool -Expected $ExpectedToolVersion
    $signature = Get-AuthenticodeSignature -LiteralPath $resolvedTool
    if (
        $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate
    ) {
        throw 'P5E_TOOL_SIGNATURE: a valid Authenticode signature is required'
    }
    $signerSimpleName = $signature.SignerCertificate.GetNameInfo(
        [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
        $false
    )
    $organizationPattern = '(?:^|,\s*)O="?' +
        [regex]::Escape($ExpectedSignerOrganization) +
        '"?(?:,|$)'
    if (
        -not [string]::IsNullOrWhiteSpace($ExpectedSignerOrganization) -and
        $signerSimpleName -cne $ExpectedSignerOrganization -and
        $signature.SignerCertificate.Subject -notmatch $organizationPattern
    ) {
        throw 'P5E_TOOL_SIGNER: signer organization differs'
    }
    $selectedTools += [ordered]@{
        id = $ToolName
        version = $ExpectedToolVersion
        executableSha256 = $toolDigest
        verification = 'version-digest-authenticode'
        authenticodeStatus = 'valid'
        signerOrganization = $ExpectedSignerOrganization
    }
}
if ($toolSetRequested) {
    if (
        $SelectedToolIds.Count -eq 0 -or
        $SelectedToolIds.Count -ne $SelectedToolPaths.Count -or
        @($SelectedToolIds | Sort-Object -Unique).Count -ne $SelectedToolIds.Count
    ) {
        throw 'P5E_TOOL_INPUT: selected tool IDs and paths must be a one-to-one unique set'
    }
    $toolchain = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'toolchain.json') |
        ConvertFrom-Json
    for ($index = 0; $index -lt $SelectedToolIds.Count; $index += 1) {
        $toolId = $SelectedToolIds[$index]
        $record = @($toolchain.tools | Where-Object { $_.id -ceq $toolId })
        if ($record.Count -ne 1) {
            throw "P5E_TOOL_INPUT: exact toolchain record is missing for $toolId"
        }
        $record = $record[0]
        $resolvedTool = [IO.Path]::GetFullPath($SelectedToolPaths[$index])
        if (-not (Test-Path -LiteralPath $resolvedTool -PathType Leaf)) {
            throw "P5E_TOOL_MISSING: exact $toolId executable is missing"
        }
        $toolDigest = Get-P5FileSha256 -LiteralPath $resolvedTool
        if ($toolDigest -cne [string]$record.artifact.executableSha256) {
            throw "P5E_TOOL_DIGEST: exact $toolId executable digest differs"
        }
        Invoke-ExactVersion -Executable $resolvedTool -Expected ([string]$record.version)
        $runtimeSignatureStatus = 'not-required'
        if ([bool]$record.signature.authenticodeRequired) {
            $signature = Get-AuthenticodeSignature -LiteralPath $resolvedTool
            if (
                $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
                $null -eq $signature.SignerCertificate -or
                -not $signature.SignerCertificate.Subject.Equals(
                    [string]$record.signature.authenticodeSubject,
                    [StringComparison]::Ordinal
                ) -or
                -not $signature.SignerCertificate.Thumbprint.Equals(
                    [string]$record.signature.authenticodeThumbprint,
                    [StringComparison]::OrdinalIgnoreCase
                )
            ) {
                throw "P5E_TOOL_SIGNATURE: exact $toolId Authenticode identity differs"
            }
            $runtimeSignatureStatus = 'valid-exact'
        }
        $selectedTools += [ordered]@{
            id = $toolId
            version = [string]$record.version
            executableSha256 = $toolDigest
            verification = 'toolchain-version-and-executable-digest'
            runtimeSignatureStatus = $runtimeSignatureStatus
            admissionSignatureKind = [string]$record.signature.kind
            admissionSignatureVerified = [bool]$record.signature.verified
        }
    }
}
$expectedToolIds = switch ($Profile) {
    'install-build' { @('codex') }
    'core-contract' { @('codex') }
    'claude-lifecycle' { @('claude') }
    'security' { @('actionlint', 'gitleaks', 'osv-scanner', 'zizmor') }
    'next-canary' { @('codex') }
    default { @() }
}
$actualToolIds = @($selectedTools | ForEach-Object { [string]$_.id } | Sort-Object)
$expectedToolIds = @($expectedToolIds | Sort-Object)
if (
    ($successfulObservation -and
        ($actualToolIds -join "`n") -cne ($expectedToolIds -join "`n")) -or
    @($actualToolIds | Where-Object { $_ -cnotin $expectedToolIds }).Count -ne 0
) {
    throw 'P5E_TOOL_PROFILE: selected tools must exactly match a successful profile or be a valid failed-attempt subset'
}

$attempt = Get-P5AttemptEvidence `
    -StartedAt $StartedAt `
    -ObservedStatus $ObservedStatus `
    -RawExitCode $RawExitCode `
    -RawExitCodeSource $ExitCodeSource `
    -ResourceOracleStatus $ResourceOracleStatus `
    -RunAttempt ([long]$provenance.run.attempt) `
    -RequireStartedAt $successfulObservation
$nodeIdentity = $provenance.node
$null = $provenance.Remove('node')
$dependencyReviewArtifact = $Profile -ceq 'dependency-review'

$evidence = [ordered]@{
    schemaVersion = 'p5-runner-evidence-v2'
    evidenceKind = 'profile-lane'
    profile = $Profile
    lane = $Lane
    blocking = [bool]$profileRecord.blocking
    requirementIds = @($scenarioRecord.requirementIds)
    scenarioId = $ScenarioId
    scenarioFixtureIds = @($scenarioRecord.fixtureIds)
    verifiedFixtureIds = @($FixtureIds)
    oracle = [ordered]@{
        registrySha256 = $oracleRegistryDigest
        aggregateExpected = $scenarioRecord.oracle
        expected = $ExpectedOracle
        observedStatus = $ObservedStatus
    }
    runtimeEnforced = $runtimeImplemented
    deferredPhase = $deferredPhase
    provenance = $provenance
    tools = [ordered]@{
        nodeIdentityStatus = $nodeIdentity.nodeIdentityStatus
        node = $nodeIdentity.node
        npm = $nodeIdentity.npm
        nodeArchitecture = $nodeIdentity.nodeArchitecture
        nodeExecutableSha256 = $nodeIdentity.nodeExecutableSha256
        selected = @($selectedTools)
    }
    attempt = $attempt
    artifact = [ordered]@{
        repositoryAuthoredUpload = $false
        actionOwnedConditionalUploadPossible = $dependencyReviewArtifact
        observedUpload = if ($dependencyReviewArtifact) { $null } else { $false }
        digest = $null
        retentionDays = if ($dependencyReviewArtifact) { 1 } else { $null }
        readbackStatus = if ($dependencyReviewArtifact) { 'pending-rest-readback' } else { 'not-applicable' }
        releaseTrustInput = $false
    }
    cache = [ordered]@{
        repositoryAuthoredCacheEnabled = $false
        readbackStatus = if ($ExecutionClass -eq 'hosted') { 'pending-rest-readback' } else { 'not-applicable' }
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
