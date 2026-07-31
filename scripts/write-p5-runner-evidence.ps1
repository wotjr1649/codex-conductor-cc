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

    [Parameter(Mandatory = $true)]
    [datetimeoffset]$StartedAt,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string[]]$RequirementIds,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z0-9-]+$')]
    [string]$ScenarioId,

    [Parameter(Mandatory = $true)]
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

    [ValidateSet('executed-pass', 'executed-fail', 'non-blocking-canary')]
    [string]$ObservedStatus = 'executed-pass',
    [int]$RawExitCode = 0,
    [ValidateSet('executed-pass', 'not-applicable', 'not-run')]
    [string]$ResourceOracleStatus = 'not-applicable'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [IO.Path]::GetFullPath($LiteralPath)
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $parentPath = (Get-NormalizedFullPath -LiteralPath $Parent).TrimEnd('\', '/')
    $candidatePath = Get-NormalizedFullPath -LiteralPath $Candidate
    if (-not $candidatePath.StartsWith(
        $parentPath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'P5E_EVIDENCE_PATH: hosted evidence must stay under the run-owned runner temp'
    }
}

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

$resolvedOutput = Get-NormalizedFullPath -LiteralPath $OutputPath
$outputParent = Split-Path -Parent $resolvedOutput
$repoRoot = Get-NormalizedFullPath -LiteralPath (Join-Path $PSScriptRoot '..')
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
    $providedFixtureIds.Count -eq 0 -or
    $providedFixtureIds.Count -ne $FixtureIds.Count -or
    @($providedFixtureIds | Where-Object { $_ -cnotin $expectedFixtureIds }).Count -ne 0
) {
    throw 'P5E_EVIDENCE_FIXTURE: executed fixture IDs must be a unique subset of the scenario registry'
}
$oracleRegistryDigest = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $scenarioRegistryPath
).Hash.ToLowerInvariant()
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
if ($ExecutionClass -eq 'hosted') {
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        throw 'P5E_RUNNER_TEMP: hosted evidence requires RUNNER_TEMP'
    }
    Assert-ContainedPath -Parent $env:RUNNER_TEMP -Candidate $resolvedOutput
}
if (-not (Test-Path -LiteralPath $outputParent)) {
    New-Item -ItemType Directory -Path $outputParent | Out-Null
}
if (Test-Path -LiteralPath $resolvedOutput) {
    throw 'P5E_EVIDENCE_EXISTS: evidence output must be newly run-owned'
}

$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
$nodePath = $nodeCommand.Source
$nodeVersion = (& $nodePath --version).Trim().TrimStart('v')
$npmVersion = (& npm --version).Trim()
$nodeArchitecture = (& $nodePath -p 'process.arch').Trim()
$nodeDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant()
if (
    $nodeVersion -ne $ExpectedNodeVersion -or
    $npmVersion -ne $ExpectedNpmVersion -or
    $nodeArchitecture -ne 'x64' -or
    $nodeDigest -ne $ExpectedNodeSha256
) {
    throw 'P5E_NODE_IDENTITY: exact Node/npm/x64 executable identity is required'
}

$tool = $null
if (-not [string]::IsNullOrWhiteSpace($ToolName)) {
    if (
        [string]::IsNullOrWhiteSpace($ToolPath) -or
        [string]::IsNullOrWhiteSpace($ExpectedToolVersion) -or
        $ExpectedToolSha256 -notmatch '^[0-9a-f]{64}$'
    ) {
        throw 'P5E_TOOL_INPUT: a complete exact tool identity is required'
    }
    $resolvedTool = Get-NormalizedFullPath -LiteralPath $ToolPath
    if (-not (Test-Path -LiteralPath $resolvedTool -PathType Leaf)) {
        throw 'P5E_TOOL_MISSING: exact tool executable is missing'
    }
    $toolDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedTool).Hash.ToLowerInvariant()
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
    $tool = [ordered]@{
        id = $ToolName
        version = $ExpectedToolVersion
        executableSha256 = $toolDigest
        authenticodeStatus = 'valid'
        signerOrganization = $ExpectedSignerOrganization
    }
}

$os = Get-CimInstance Win32_OperatingSystem
$outputRoot = [IO.Path]::GetPathRoot($resolvedOutput).TrimEnd('\')
$logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$outputRoot'"
if ($null -eq $logicalDisk -or [string]::IsNullOrWhiteSpace($logicalDisk.FileSystem)) {
    throw 'P5E_FILESYSTEM: output filesystem could not be classified'
}

$finishedAt = [datetimeoffset]::UtcNow
$wallTimeMs = [math]::Max(0, [long]($finishedAt - $StartedAt).TotalMilliseconds)
$checkoutSha = if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
    $env:GITHUB_SHA
}
else {
    (& git -C $repoRoot rev-parse HEAD).Trim()
}
$sourceSha = if ($ExecutionClass -eq 'hosted') {
    $env:P5_SOURCE_SHA
}
else {
    (& git -C $repoRoot rev-parse HEAD).Trim()
}
$workflowSha = if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_WORKFLOW_SHA)) {
    $env:GITHUB_WORKFLOW_SHA
}
else {
    $checkoutSha
}
if (
    $sourceSha -notmatch '^[0-9a-f]{40}$' -or
    $checkoutSha -notmatch '^[0-9a-f]{40}$' -or
    $workflowSha -notmatch '^[0-9a-f]{40}$'
) {
    throw 'P5E_SOURCE_SHA: exact source, checkout, and workflow commit identities are required'
}

$runAttempt = if ($env:GITHUB_RUN_ATTEMPT -match '^[1-9][0-9]*$') {
    [int]$env:GITHUB_RUN_ATTEMPT
}
else {
    1
}
$runnerEnvironment = if ($ExecutionClass -eq 'hosted') {
    $env:RUNNER_ENVIRONMENT
}
else {
    'local'
}
$runnerOS = if ($ExecutionClass -eq 'hosted') { $env:RUNNER_OS } else { 'Windows' }
$runnerArch = if ($ExecutionClass -eq 'hosted') { $env:RUNNER_ARCH } else { 'X64' }
$imageOS = if ($ExecutionClass -eq 'hosted' -and -not [string]::IsNullOrWhiteSpace($env:ImageOS)) {
    $env:ImageOS
}
else {
    $null
}
$imageVersion = if ($ExecutionClass -eq 'hosted' -and -not [string]::IsNullOrWhiteSpace($env:ImageVersion)) {
    $env:ImageVersion
}
else {
    $null
}
$storageClass = if ($ExecutionClass -eq 'hosted') {
    'github-hosted-ephemeral-runner-temp'
}
else {
    'run-owned-temp-volume'
}
if (
    $ExecutionClass -eq 'hosted' -and (
        $runnerEnvironment -cne 'github-hosted' -or
        $runnerOS -cne 'Windows' -or
        $runnerArch -cne 'X64' -or
        [string]::IsNullOrWhiteSpace($imageOS) -or
        [string]::IsNullOrWhiteSpace($imageVersion) -or
        $logicalDisk.FileSystem -cne 'NTFS' -or
        [string]::IsNullOrWhiteSpace($os.BuildNumber)
    )
) {
    throw 'P5E_HOSTED_RUNNER: exact GitHub-hosted Windows x64 image and NTFS readback are required'
}

$evidence = [ordered]@{
    schemaVersion = 'p5-runner-evidence-v1'
    profile = $Profile
    lane = $Lane
    blocking = [bool]$profileRecord.blocking
    requirementIds = @($scenarioRecord.requirementIds)
    scenarioId = $ScenarioId
    scenarioFixtureIds = @($scenarioRecord.fixtureIds)
    executedFixtureIds = @($FixtureIds)
    oracle = [ordered]@{
        registrySha256 = $oracleRegistryDigest
        aggregateExpected = $scenarioRecord.oracle
        expected = $ExpectedOracle
        observedStatus = $ObservedStatus
    }
    runtimeEnforced = $runtimeImplemented
    deferredPhase = $deferredPhase
    sourceSha = $sourceSha
    checkoutSha = $checkoutSha
    workflowSha = $workflowSha
    executionClass = $ExecutionClass
    runner = [ordered]@{
        requestedLabel = 'windows-2025'
        environment = $runnerEnvironment
        os = $runnerOS
        architecture = $runnerArch
        imageOS = $imageOS
        imageVersion = $imageVersion
        osCaption = $os.Caption
        osVersion = $os.Version
        osBuild = $os.BuildNumber
        osArchitecture = $os.OSArchitecture
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        filesystem = $logicalDisk.FileSystem
        storageClass = $storageClass
    }
    tools = [ordered]@{
        node = $nodeVersion
        npm = $npmVersion
        nodeArchitecture = $nodeArchitecture
        nodeExecutableSha256 = $nodeDigest
        selected = $tool
    }
    attempt = [ordered]@{
        trial = 1
        runAttempt = $runAttempt
        automaticRetryCount = 0
        timeout = $false
        rawExitCode = $RawExitCode
        startedAt = $StartedAt.ToUniversalTime().ToString('o')
        finishedAt = $finishedAt.ToString('o')
        wallTimeMs = $wallTimeMs
        observedStatus = $ObservedStatus
        resourceOracleStatus = $ResourceOracleStatus
    }
    artifact = [ordered]@{
        uploaded = $false
        digest = $null
        retentionDays = $null
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

$json = $evidence | ConvertTo-Json -Depth 8 -Compress
$privatePath = '(?i)(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\(?:[?.]\\|wsl\$\\)|/(?:home|Users)/)'
$secret = '(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{20,})'
if ($json -match $privatePath -or $json -match $secret) {
    throw 'P5E_PRIVACY: serialized runner evidence contains a private path or credential shape'
}
[IO.File]::WriteAllText($resolvedOutput, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output $json
