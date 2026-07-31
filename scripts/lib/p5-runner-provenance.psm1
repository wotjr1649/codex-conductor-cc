Set-StrictMode -Version Latest

function Get-P5NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [IO.Path]::GetFullPath($LiteralPath)
}

function Assert-P5NoReparsePath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $cursorPath = Get-P5NormalizedFullPath -LiteralPath $LiteralPath
    while (-not (Test-Path -LiteralPath $cursorPath)) {
        $parent = Split-Path -Parent $cursorPath
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursorPath) {
            throw 'P5E_EVIDENCE_PATH: no existing output ancestor could be resolved'
        }
        $cursorPath = $parent
    }
    $cursor = Get-Item -Force -LiteralPath $cursorPath
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'P5E_EVIDENCE_PATH: evidence path ancestry may not contain a reparse point'
        }
        if ($cursor -is [IO.FileInfo]) {
            $cursor = $cursor.Directory
        }
        else {
            $cursor = $cursor.Parent
        }
    }
}

function Assert-P5ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $parentPath = (Get-P5NormalizedFullPath -LiteralPath $Parent).TrimEnd('\', '/')
    $candidatePath = Get-P5NormalizedFullPath -LiteralPath $Candidate
    if (-not $candidatePath.StartsWith(
        $parentPath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'P5E_EVIDENCE_PATH: hosted evidence must stay under the run-owned runner temp'
    }
    Assert-P5NoReparsePath -LiteralPath (Split-Path -Parent $candidatePath)
}

function Get-P5PositiveInteger {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowEmptyString()][string]$Value
    )
    if ($Value -notmatch '^[1-9][0-9]*$') {
        throw "P5E_RUN_IDENTITY: $Name must be a positive integer"
    }
    return [long]$Value
}

function Get-P5GitHead {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
    $head = (& git -C $RepositoryRoot rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
        throw 'P5E_CHECKOUT_SHA: actual checkout commit could not be resolved'
    }
    return $head
}

function Get-P5NodeIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedNodeVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedNpmVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedNodeSha256
    )
    $nodeVersion = $null
    $npmVersion = $null
    $nodeArchitecture = $null
    $nodeDigest = $null
    $status = 'unavailable'
    try {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $nodePath = $nodeCommand.Source
        $npmPath = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
            throw 'npm.cmd is not adjacent to node.exe'
        }
        $nodeVersion = (& $nodePath --version).Trim().TrimStart('v')
        $npmVersion = (& $npmPath --version).Trim()
        $nodeArchitecture = (& $nodePath -p 'process.arch').Trim()
        $nodeDigest = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath
        ).Hash.ToLowerInvariant()
        $status = if (
            $nodeVersion -ceq $ExpectedNodeVersion -and
            $npmVersion -ceq $ExpectedNpmVersion -and
            $nodeArchitecture -ceq 'x64' -and
            $nodeDigest -ceq $ExpectedNodeSha256
        ) {
            'verified-exact'
        }
        else {
            'mismatch'
        }
    }
    catch {
        $status = 'unavailable'
    }
    return [ordered]@{
        nodeIdentityStatus = $status
        node = $nodeVersion
        npm = $npmVersion
        nodeArchitecture = $nodeArchitecture
        nodeExecutableSha256 = $nodeDigest
    }
}

function Get-P5ExecutionProvenance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)]
        [ValidateSet('local', 'hosted')]
        [string]$ExecutionClass,
        [Parameter(Mandatory = $true)][string]$ExpectedNodeVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedNpmVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedNodeSha256,
        [Parameter(Mandatory = $true)][bool]$RequireNodeIdentity,
        [string]$RequestedRunnerLabel = 'windows-2025',
        [string]$CheckRunId = ''
    )

    $repoRoot = Get-P5NormalizedFullPath -LiteralPath $RepositoryRoot
    $resolvedOutput = Get-P5NormalizedFullPath -LiteralPath $OutputPath
    if (Test-Path -LiteralPath $resolvedOutput) {
        throw 'P5E_EVIDENCE_EXISTS: evidence output must be newly run-owned'
    }
    if ($ExecutionClass -eq 'hosted') {
        if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
            throw 'P5E_RUNNER_TEMP: hosted evidence requires RUNNER_TEMP'
        }
        Assert-P5ContainedPath -Parent $env:RUNNER_TEMP -Candidate $resolvedOutput
    }
    $actualCheckoutSha = Get-P5GitHead -RepositoryRoot $repoRoot
    $nodeIdentity = Get-P5NodeIdentity `
        -ExpectedNodeVersion $ExpectedNodeVersion `
        -ExpectedNpmVersion $ExpectedNpmVersion `
        -ExpectedNodeSha256 $ExpectedNodeSha256
    if ($RequireNodeIdentity -and $nodeIdentity.nodeIdentityStatus -cne 'verified-exact') {
        throw 'P5E_NODE_IDENTITY: exact Node/npm/x64 executable identity is required'
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $outputRoot = [IO.Path]::GetPathRoot($resolvedOutput).TrimEnd('\')
    $logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$outputRoot'"
    if ($null -eq $logicalDisk -or [string]::IsNullOrWhiteSpace($logicalDisk.FileSystem)) {
        throw 'P5E_FILESYSTEM: output filesystem could not be classified'
    }

    $repository = $null
    $workflow = [ordered]@{
        name = $null
        ref = $null
        sha = $null
    }
    $pullRequest = [ordered]@{
        number = $null
        baseRepository = $null
        baseRef = $null
        baseSha = $null
        headRepository = $null
        headRef = $null
        headSha = $null
    }
    $sourceHeadSha = $actualCheckoutSha
    $eventMergeSha = $null
    $run = [ordered]@{
        id = $null
        attempt = 1
        yamlJobKey = $null
        checkRunId = $null
    }
    $runnerEnvironment = 'local'
    $runnerOS = 'Windows'
    $runnerArch = 'X64'
    $imageOS = $null
    $imageVersion = $null
    $storageClass = [ordered]@{
        value = 'run-owned-temp-volume'
        basis = 'observed-output-volume'
    }

    if ($ExecutionClass -eq 'hosted') {
        if (
            $env:GITHUB_EVENT_NAME -cne 'pull_request' -or
            [string]::IsNullOrWhiteSpace($env:GITHUB_EVENT_PATH) -or
            -not (Test-Path -LiteralPath $env:GITHUB_EVENT_PATH -PathType Leaf)
        ) {
            throw 'P5E_PULL_REQUEST_EVENT: exact pull_request event payload is required'
        }
        $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
        $repository = [string]$env:GITHUB_REPOSITORY
        $workflow.name = [string]$env:GITHUB_WORKFLOW
        $workflow.ref = [string]$env:GITHUB_WORKFLOW_REF
        $workflow.sha = [string]$env:GITHUB_WORKFLOW_SHA
        $pullRequest.number = [long]$event.number
        $pullRequest.baseRepository = [string]$event.pull_request.base.repo.full_name
        $pullRequest.baseRef = [string]$event.pull_request.base.ref
        $pullRequest.baseSha = [string]$event.pull_request.base.sha
        $pullRequest.headRepository = [string]$event.pull_request.head.repo.full_name
        $pullRequest.headRef = [string]$event.pull_request.head.ref
        $pullRequest.headSha = [string]$event.pull_request.head.sha
        $sourceHeadSha = $pullRequest.headSha
        $eventMergeSha = [string]$env:GITHUB_SHA
        $run.id = Get-P5PositiveInteger -Name 'GITHUB_RUN_ID' -Value $env:GITHUB_RUN_ID
        $run.attempt = Get-P5PositiveInteger `
            -Name 'GITHUB_RUN_ATTEMPT' `
            -Value $env:GITHUB_RUN_ATTEMPT
        $run.yamlJobKey = [string]$env:GITHUB_JOB
        $run.checkRunId = Get-P5PositiveInteger -Name 'job.check_run_id' -Value $CheckRunId
        $runnerEnvironment = [string]$env:RUNNER_ENVIRONMENT
        $runnerOS = [string]$env:RUNNER_OS
        $runnerArch = [string]$env:RUNNER_ARCH
        $imageOS = [string]$env:ImageOS
        $imageVersion = [string]$env:ImageVersion
        $storageClass = [ordered]@{
            value = 'github-hosted-ephemeral-runner-temp'
            basis = 'runner-environment-and-documented-hosted-semantics'
        }

        if (
            [string]::IsNullOrWhiteSpace($repository) -or
            $repository -cne [string]$event.repository.full_name -or
            $workflow.name -cne 'Pull Request CI' -or
            $workflow.ref -cne "$repository/.github/workflows/pull-request-ci.yml@$($env:GITHUB_REF)" -or
            $workflow.sha -notmatch '^[0-9a-f]{40}$' -or
            $pullRequest.number -lt 1 -or
            $pullRequest.baseRepository -cne $repository -or
            [string]::IsNullOrWhiteSpace($pullRequest.baseRef) -or
            $pullRequest.baseSha -notmatch '^[0-9a-f]{40}$' -or
            [string]::IsNullOrWhiteSpace($pullRequest.headRepository) -or
            [string]::IsNullOrWhiteSpace($pullRequest.headRef) -or
            $pullRequest.headSha -notmatch '^[0-9a-f]{40}$' -or
            $sourceHeadSha -cne $pullRequest.headSha -or
            $eventMergeSha -notmatch '^[0-9a-f]{40}$' -or
            $actualCheckoutSha -cne $eventMergeSha -or
            $env:GITHUB_REF -cne "refs/pull/$($pullRequest.number)/merge" -or
            $run.yamlJobKey -notmatch '^[a-z0-9-]+$'
        ) {
            throw 'P5E_SOURCE_SHA: repository, PR, source, merge checkout, workflow, and job identities must agree'
        }
        if (
            $runnerEnvironment -cne 'github-hosted' -or
            $runnerOS -cne 'Windows' -or
            $runnerArch -cne 'X64' -or
            [string]::IsNullOrWhiteSpace($imageOS) -or
            [string]::IsNullOrWhiteSpace($imageVersion) -or
            $logicalDisk.FileSystem -cne 'NTFS' -or
            [string]::IsNullOrWhiteSpace($os.BuildNumber) -or
            [int]$os.ProductType -ne 3 -or
            [string]$os.Caption -notmatch 'Windows Server 2025'
        ) {
            throw 'P5E_HOSTED_RUNNER: exact GitHub-hosted Windows Server 2025 x64 image and NTFS readback are required'
        }
    }

    return [ordered]@{
        repository = $repository
        workflow = $workflow
        pullRequest = $pullRequest
        sourceHeadSha = $sourceHeadSha
        eventMergeSha = $eventMergeSha
        actualCheckoutSha = $actualCheckoutSha
        executionClass = $ExecutionClass
        run = $run
        runner = [ordered]@{
            requestedLabel = $RequestedRunnerLabel
            environment = $runnerEnvironment
            os = $runnerOS
            architecture = $runnerArch
            imageOS = $imageOS
            imageVersion = $imageVersion
            osCaption = [string]$os.Caption
            osVersion = [string]$os.Version
            osBuild = [string]$os.BuildNumber
            osArchitecture = [string]$os.OSArchitecture
            productType = [int]$os.ProductType
            powershellVersion = $PSVersionTable.PSVersion.ToString()
            filesystem = [string]$logicalDisk.FileSystem
            storageClass = $storageClass
        }
        node = $nodeIdentity
    }
}

function Get-P5AttemptEvidence {
    [CmdletBinding()]
    param(
        [string]$StartedAt = '',
        [Parameter(Mandatory = $true)]
        [ValidateSet('executed-pass', 'executed-fail', 'non-blocking-canary')]
        [string]$ObservedStatus,
        [Parameter(Mandatory = $true)][int]$RawExitCode,
        [Parameter(Mandatory = $true)]
        [ValidateSet('direct-process', 'github-job-status-normalized')]
        [string]$RawExitCodeSource,
        [Parameter(Mandatory = $true)]
        [ValidateSet('executed-pass', 'executed-fail', 'not-applicable', 'not-run')]
        [string]$ResourceOracleStatus,
        [Parameter(Mandatory = $true)][long]$RunAttempt,
        [Parameter(Mandatory = $true)][bool]$RequireStartedAt
    )
    $finishedAt = [datetimeoffset]::UtcNow
    $startedAtValue = [datetimeoffset]::MinValue
    $startedAtSource = 'profile-clock'
    try {
        $startedAtValue = [datetimeoffset]::Parse(
            $StartedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch {
        if ($RequireStartedAt) {
            throw 'P5E_ATTEMPT_CLOCK: successful evidence requires a valid profile start time'
        }
        $startedAtValue = $finishedAt
        $startedAtSource = 'finalizer-fallback'
    }
    if ($startedAtValue -gt $finishedAt) {
        throw 'P5E_ATTEMPT_CLOCK: profile start time may not be in the future'
    }
    return [ordered]@{
        trial = $RunAttempt
        runAttempt = $RunAttempt
        jobAttempt = $null
        restJobId = $null
        workflowRerunCount = $null
        automaticRetryCount = $null
        timeout = $null
        authority = 'runner-self-observed-partial'
        restConsolidationStatus = 'pending-post-run-attempt-jobs'
        rawExitCode = $RawExitCode
        rawExitCodeSource = $RawExitCodeSource
        startedAt = $startedAtValue.ToUniversalTime().ToString('o')
        startedAtSource = $startedAtSource
        finishedAt = $finishedAt.ToString('o')
        wallTimeMs = [math]::Max(0, [long]($finishedAt - $startedAtValue).TotalMilliseconds)
        observedStatus = $ObservedStatus
        resourceOracleStatus = $ResourceOracleStatus
    }
}

function Test-P5PrivatePathValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $false }
    if ($Value -is [string]) {
        return $Value -match '(?i)(?:^|[\s"''=])(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\(?:[?.]\\|wsl\$\\)|/(?:home|Users)/)'
    }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($item in $Value.Values) {
            if (Test-P5PrivatePathValue -Value $item) { return $true }
        }
        return $false
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) {
            if (Test-P5PrivatePathValue -Value $item) { return $true }
        }
    }
    return $false
}

function Write-P5SanitizedEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Evidence,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )
    $resolvedOutput = Get-P5NormalizedFullPath -LiteralPath $OutputPath
    $outputParent = Split-Path -Parent $resolvedOutput
    if (-not (Test-Path -LiteralPath $outputParent)) {
        New-Item -ItemType Directory -Path $outputParent | Out-Null
    }
    Assert-P5NoReparsePath -LiteralPath $outputParent
    if (Test-Path -LiteralPath $resolvedOutput) {
        throw 'P5E_EVIDENCE_EXISTS: evidence output must be newly run-owned'
    }
    $json = $Evidence | ConvertTo-Json -Depth 12 -Compress
    $fineGrainedPatPrefix = [regex]::Escape(('github' + '_pat_'))
    $secret = '(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|' +
        $fineGrainedPatPrefix +
        '[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{20,})'
    if ((Test-P5PrivatePathValue -Value $Evidence) -or $json -match $secret) {
        throw 'P5E_PRIVACY: serialized runner evidence contains a private path or credential shape'
    }
    [IO.File]::WriteAllText(
        $resolvedOutput,
        $json + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    Write-Output "P5_SANITIZED_EVIDENCE_JSON=$json"
}

Export-ModuleMember -Function `
    Get-P5ExecutionProvenance, `
    Get-P5AttemptEvidence, `
    Write-P5SanitizedEvidence
