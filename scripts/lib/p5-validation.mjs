import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateWorkflowText as validateP3WorkflowText } from "./p3-validation.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PRIVATE_PATH =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\(?:[?.]\\|wsl\$\\)|\/(?:home|Users)\/)/i;
const SECRET =
  /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{20,})/;
const EXPECTED_PROFILE_IDS = [
  "policy-validation",
  "install-build",
  "unit",
  "core-contract",
  "windows-integration",
  "claude-lifecycle",
  "security",
  "dependency-review",
  "next-canary",
  "windows-c0",
  "state-d1"
];
const EXPECTED_JOBS = [
  "policy-validation",
  "install-build",
  "unit",
  "core-contract",
  "windows-integration",
  "claude-lifecycle",
  "security",
  "dependency-review",
  "next-canary",
  "gate"
];
const BLOCKING_JOBS = EXPECTED_JOBS.filter(
  (job) => !["next-canary", "gate"].includes(job)
);
const P5_EXACT_PATHS = new Set([
  ".github/CODEOWNERS",
  ".github/workflows/pull-request-ci.yml",
  "scripts/invoke-p4-validator-at-handoff.ps1",
  "scripts/validate-p5.mjs",
  "scripts/write-p5-runner-evidence.ps1"
]);
const P5_PATH_PREFIXES = [
  "ci/",
  "docs/baselines/2026-07-31-p5-",
  "evidence/inventory/p5-",
  "evidence/ledgers/p5-",
  "evidence/manifests/p5/",
  "evidence/schemas/p5-",
  "scripts/run-p5-",
  "scripts/lib/p5-",
  "tests/p5-"
];

export function sha256File(absolutePath) {
  return createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

export function isP5AllowedPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    P5_EXACT_PATHS.has(normalized) ||
    P5_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function sha256CanonicalTextFile(absolutePath) {
  return createHash("sha256")
    .update(fs.readFileSync(absolutePath, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function includesExactSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function profileById(registry, id) {
  return registry?.profiles?.find((profile) => profile.id === id);
}

export function validateP5Privacy(value, location = "$") {
  const errors = [];
  function visit(candidate, current) {
    if (typeof candidate === "string") {
      if (PRIVATE_PATH.test(candidate)) errors.push(`${current}: private host path present`);
      if (SECRET.test(candidate)) errors.push(`${current}: credential-shaped value present`);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${current}[${index}]`));
      return;
    }
    if (!ownObject(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      const next = `${current}.${key}`;
      if (
        /(?:rawEnvironment|rawPrompt|rawPayload|rawStdout|rawStderr)/i.test(key) &&
        entry !== false &&
        entry !== null
      ) {
        errors.push(`${next}: raw sensitive evidence must be false or null`);
      }
      if (/(?:secret|credential|token)/i.test(key) && entry !== false && entry !== null) {
        errors.push(`${next}: secret-bearing field must be false or null`);
      }
      visit(entry, next);
    }
  }
  visit(value, location);
  return errors;
}

export function validateAttemptLedger(ledger) {
  const errors = [];
  const rootKeys = [
    "schemaVersion",
    "phase",
    "sourceCommit",
    "automaticRetryPolicy",
    "attempts",
    "reviewFindings",
    "privacy"
  ];
  if (
    !includesExactSet(Object.keys(ledger ?? {}), rootKeys) ||
    ledger?.schemaVersion !== "p5-attempt-ledger-v1" ||
    !COMMIT.test(ledger?.sourceCommit ?? "") ||
    ledger?.automaticRetryPolicy?.count !== 0 ||
    ledger?.automaticRetryPolicy?.cancelledIsPassing !== false ||
    ledger?.automaticRetryPolicy?.failedAttemptMayBeRewritten !== false ||
    !Array.isArray(ledger?.attempts) ||
    ledger.attempts.length === 0
  ) {
    errors.push("P5E_LEDGER_IDENTITY: exact source and no-automatic-retry policy required");
    return errors;
  }
  const ids = new Set();
  const attemptKeys = [
    "ordinal",
    "id",
    "commandClass",
    "executionStatus",
    "rawExitCode",
    "retryCount",
    "timeout",
    "expected",
    "observed",
    "disposition"
  ];
  ledger.attempts.forEach((attempt, index) => {
    const location = `attempts[${index}]`;
    if (!includesExactSet(Object.keys(attempt ?? {}), attemptKeys)) {
      errors.push(`P5E_LEDGER_PROPERTIES:${location}`);
    }
    if (attempt?.ordinal !== index + 1) {
      errors.push(`P5E_LEDGER_ORDINAL:${location}`);
    }
    if (typeof attempt?.id !== "string" || ids.has(attempt.id)) {
      errors.push(`P5E_LEDGER_ID:${location}`);
    } else {
      ids.add(attempt.id);
    }
    if (
      typeof attempt?.commandClass !== "string" ||
      typeof attempt?.expected !== "string" ||
      typeof attempt?.observed !== "string" ||
      typeof attempt?.disposition !== "string" ||
      !Number.isInteger(attempt?.rawExitCode) ||
      !Number.isInteger(attempt?.retryCount) ||
      attempt.retryCount < 0 ||
      typeof attempt?.timeout !== "boolean"
    ) {
      errors.push(`P5E_LEDGER_FIELDS:${location}`);
    }
    if (
      (attempt?.executionStatus === "executed-pass" &&
        (attempt.rawExitCode !== 0 || attempt.timeout !== false)) ||
      (attempt?.executionStatus === "executed-fail" && attempt.rawExitCode === 0) ||
      !["executed-pass", "executed-fail"].includes(attempt?.executionStatus) ||
      (attempt?.timeout === true && attempt.executionStatus !== "executed-fail")
    ) {
      errors.push(`P5E_LEDGER_OUTCOME:${location}`);
    }
  });
  const reviewIds = new Set();
  for (const [index, finding] of (ledger.reviewFindings ?? []).entries()) {
    if (
      !includesExactSet(Object.keys(finding ?? {}), [
        "id",
        "severity",
        "disposition",
        "summary",
        "correction"
      ]) ||
      typeof finding.id !== "string" ||
      reviewIds.has(finding.id) ||
      !["P1", "P2", "P3"].includes(finding.severity) ||
      typeof finding.disposition !== "string" ||
      typeof finding.summary !== "string" ||
      typeof finding.correction !== "string"
    ) {
      errors.push(`P5E_LEDGER_REVIEW:reviewFindings[${index}]`);
    }
    reviewIds.add(finding.id);
  }
  errors.push(...validateP5Privacy(ledger, "attemptLedger"));
  return errors;
}

export function validateProfileRegistry(registry, toolchain) {
  const errors = [];
  if (
    registry?.schemaVersion !== "p5-matrix-profiles-v1" ||
    registry.reviewPolicy?.reviewedAt !== "2026-07-31" ||
    registry.reviewPolicy?.expiresAt !== "2026-08-31" ||
    registry.support?.operatingSystem !== "windows" ||
    registry.support?.architecture !== "x64" ||
    registry.support?.nodeRange !== ">=24.0.0" ||
    registry.support?.exactBlockingNode !== "24.18.1" ||
    registry.support?.runnerLabel !== "windows-2025"
  ) {
    errors.push("P5E_PROFILE_IDENTITY: exact Windows x64/Node 24 policy is required");
  }
  if (
    registry.workflowPolicy?.trigger !== "pull_request" ||
    registry.workflowPolicy?.permissions?.contents !== "read" ||
    registry.workflowPolicy?.concurrencyGroup !==
      "${{ github.workflow }}-${{ github.ref }}" ||
    registry.workflowPolicy?.cancelInProgress !== true ||
    registry.workflowPolicy?.cancelledAttemptIsPassing !== false ||
    registry.workflowPolicy?.automaticRetryCount !== 0 ||
    registry.workflowPolicy?.cacheEnabled !== false ||
    registry.workflowPolicy?.repositoryAuthoredArtifactUploadEnabled !== false ||
    registry.workflowPolicy?.dependencyReviewLargeSummaryArtifact?.possible !== true ||
    registry.workflowPolicy?.dependencyReviewLargeSummaryArtifact?.thresholdBytes !==
      1048576 ||
    registry.workflowPolicy?.dependencyReviewLargeSummaryArtifact?.retentionDays !== 1 ||
    registry.workflowPolicy?.dependencyReviewLargeSummaryArtifact?.releaseTrustInput !==
      false ||
    registry.workflowPolicy?.authenticatedClaudeEnabled !== false ||
    registry.workflowPolicy?.oidcEnabled !== false
  ) {
    errors.push("P5E_WORKFLOW_POLICY: least-privilege deterministic PR policy changed");
  }
  if (
    registry.tools?.node?.version !== "24.18.1" ||
    registry.tools?.node?.npmVersion !== "11.16.0" ||
    registry.tools?.node?.archiveSha256 !==
      "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765" ||
    registry.tools?.node?.executableSha256 !==
      "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582"
  ) {
    errors.push("P5E_NODE_PIN: exact admitted Node/npm bytes changed");
  }
  const codex = new Map((registry.tools?.codex ?? []).map((tool) => [tool.lane, tool]));
  for (const [lane, version, digest] of [
    [
      "current",
      "0.146.0",
      "bc343ba420dc2e2e9f59e6fc5e5bf0aae1cd8c771fc319665241fc9c0271fddb"
    ],
    [
      "previous",
      "0.145.0",
      "83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c"
    ],
    [
      "next",
      "0.147.0-alpha.2",
      "40e8f5b6cf031d74912f01a6c67c6896397743fe00ac059903f59a916dd23c68"
    ]
  ]) {
    if (
      codex.get(lane)?.version !== version ||
      codex.get(lane)?.executableSha256 !== digest
    ) {
      errors.push(`P5E_CODEX_PIN:${lane}`);
    }
  }
  const claude = new Map((registry.tools?.claude ?? []).map((tool) => [tool.lane, tool]));
  for (const [lane, version, digest] of [
    [
      "minimum",
      "2.1.196",
      "180d7b279455e8b89d4353a5146447be2f80b80fb0db14bdc6dd9cb98c0aef09"
    ],
    [
      "current",
      "2.1.220",
      "af5bf1f1b2aadffc768eccd787084c6fdf9ba81624cbe96c1c6d9ac1a1550231"
    ]
  ]) {
    if (
      claude.get(lane)?.version !== version ||
      claude.get(lane)?.executableSha256 !== digest
    ) {
      errors.push(`P5E_CLAUDE_PIN:${lane}`);
    }
  }
  if (
    !includesExactSet(
      registry.profiles?.map(({ id }) => id),
      EXPECTED_PROFILE_IDS
    )
  ) {
    errors.push("P5E_PROFILE_SET: exact profile set is required");
  }
  for (const id of [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security",
    "dependency-review"
  ]) {
    const profile = profileById(registry, id);
    if (profile?.blocking !== true || profile?.definitionStatus !== "defined") {
      errors.push(`P5E_BLOCKING_PROFILE:${id}`);
    }
  }
  for (const [id, values, maxParallel] of [
    ["core-contract", ["current", "previous"], 2],
    ["claude-lifecycle", ["minimum", "current"], 2],
    ["next-canary", ["next"], 1]
  ]) {
    const matrix = profileById(registry, id)?.matrix;
    if (
      !includesExactSet(matrix?.values, values) ||
      matrix?.failFast !== false ||
      matrix?.maxParallel !== maxParallel ||
      matrix?.cartesianProduct !== false
    ) {
      errors.push(`P5E_MATRIX_POLICY:${id}`);
    }
  }
  const canary = profileById(registry, "next-canary");
  if (
    canary?.blocking !== false ||
    canary?.continueOnError !== true ||
    canary?.definitionStatus !== "non-blocking-canary"
  ) {
    errors.push("P5E_CANARY_BLOCKING: next candidate must remain non-blocking");
  }
  const c0 = profileById(registry, "windows-c0");
  if (
    c0?.workflowJob !== null ||
    c0?.blocking !== false ||
    c0?.timeoutMinutes !== null ||
    !includesExactSet(c0?.allowedEvidenceStatuses, ["blocked-with-evidence"]) ||
    c0?.runtimeImplemented !== false ||
    c0?.nativeArtifactDigest !== null ||
    c0?.priorEvidenceMaySatisfyRuntime !== false ||
    c0?.deferredPhase !== "v0.2" ||
    c0?.definitionStatus !== "blocked-with-evidence"
  ) {
    errors.push("P5E_C0_FALSE_GREEN: Windows C0 shipping runtime is absent");
  }
  const d1 = profileById(registry, "state-d1");
  if (
    d1?.workflowJob !== null ||
    d1?.blocking !== false ||
    d1?.timeoutMinutes !== null ||
    !includesExactSet(d1?.allowedEvidenceStatuses, ["blocked-with-evidence"]) ||
    d1?.runtimeImplemented !== false ||
    d1?.shippingBinding !== null ||
    d1?.ddlDigest !== null ||
    d1?.migrationDigest !== null ||
    d1?.priorEvidenceMaySatisfyRuntime !== false ||
    d1?.deferredPhase !== "v0.2" ||
    d1?.definitionStatus !== "blocked-with-evidence"
  ) {
    errors.push("P5E_D1_FALSE_GREEN: state D1 shipping runtime is absent");
  }
  const blocker = registry.baselineBlockers?.find(
    ({ id }) => id === "P5-BLOCK-P4-SOURCE-BINDING"
  );
  if (
    blocker?.recordedCommit !== "843e679a90d4ef6946af251d36f43d257f8a5a10" ||
    blocker?.actualCommit !== "843e679936daba71a6c4c2fdd55fcade01b46b73" ||
    blocker?.recordedCommitResolvable !== false ||
    blocker?.status !== "blocked-with-evidence"
  ) {
    errors.push("P5E_P4_SOURCE_BINDING: inherited P4 source defect must remain explicit");
  }
  const admittedActions = new Map(
    (toolchain?.actions ?? []).map((action) => [action.id, action.commit])
  );
  for (const action of registry.actions ?? []) {
    if (admittedActions.get(action.id) !== action.commit) {
      errors.push(`P5E_ACTION_ADMISSION:${action.id}`);
    }
  }
  errors.push(...validateP5Privacy(registry, "profileRegistry"));
  return errors;
}

export function validateScenarioRegistry(registry, root, profileRegistry) {
  const errors = [];
  if (
    registry?.schemaVersion !== "p5-scenario-registry-v1" ||
    registry.sourceCommit !== "84515289913dfe8a7452754ad442d37873bdfd53"
  ) {
    errors.push("P5E_SCENARIO_IDENTITY: exact P4 handoff binding is required");
  }
  if (
    registry.inheritedTestTotals?.files !== 13 ||
    registry.inheritedTestTotals?.executedTests !== 167 ||
    registry.inheritedTestTotals?.skippedTests !== 0 ||
    registry.inheritedTestTotals?.fileMappingDuplicates !== 0 ||
    registry.inheritedTestTotals?.fileMappingOmissions !== 0
  ) {
    errors.push("P5E_TEST_TOTAL: inherited 167/167 zero-skip baseline changed");
  }
  const inherited = registry.inheritedTests ?? [];
  const observedPaths = inherited.map(({ path: testPath }) => testPath);
  if (inherited.length !== 13 || new Set(observedPaths).size !== 13) {
    errors.push("P5E_TEST_DUPLICATE: every inherited test file must map exactly once");
  }
  const diskTests = fs
    .readdirSync(path.join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs") && !name.startsWith("p5-"))
    .map((name) => `tests/${name}`)
    .sort();
  if (!includesExactSet(observedPaths, diskTests)) {
    errors.push("P5E_TEST_OMITTED: inherited test mapping differs from the exact tree");
  }
  for (const entry of inherited) {
    const absolutePath = path.join(root, entry.path);
    const rawDigest = fs.existsSync(absolutePath) ? sha256File(absolutePath) : "";
    const canonicalDigest = fs.existsSync(absolutePath)
      ? sha256CanonicalTextFile(absolutePath)
      : "";
    if (
      !fs.existsSync(absolutePath) ||
      !SHA256.test(entry.sha256) ||
      (rawDigest !== entry.sha256 && canonicalDigest !== entry.sha256)
    ) {
      errors.push(`P5E_TEST_DIGEST:${entry.path}`);
    }
    if (!profileById(profileRegistry, entry.profileId)?.blocking) {
      errors.push(`P5E_TEST_PROFILE:${entry.path}`);
    }
  }
  const blockingMappedTests = (registry.scenarios ?? [])
    .filter(({ blocking }) => blocking === true)
    .flatMap(({ testFiles }) => testFiles ?? []);
  const allDiskTests = fs
    .readdirSync(path.join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`)
    .sort();
  if (
    blockingMappedTests.length !== new Set(blockingMappedTests).size ||
    !includesExactSet(blockingMappedTests, allDiskTests)
  ) {
    errors.push("P5E_BLOCKING_TEST_COVERAGE: every test file must map exactly once");
  }
  const profileIds = new Set(profileRegistry?.profiles?.map(({ id }) => id));
  for (const scenario of registry.scenarios ?? []) {
    if (
      !profileIds.has(scenario.profileId) ||
      !Array.isArray(scenario.requirementIds) ||
      scenario.requirementIds.length === 0 ||
      !Array.isArray(scenario.fixtureIds) ||
      scenario.fixtureIds.length === 0
    ) {
      errors.push(`P5E_SCENARIO_FIELDS:${scenario.id ?? "unknown"}`);
    }
  }
  for (const profile of profileRegistry?.profiles?.filter(({ blocking }) => blocking) ?? []) {
    const blockingScenarios = registry.scenarios?.filter(
      ({ profileId, blocking }) => profileId === profile.id && blocking === true
    );
    if (blockingScenarios?.length !== 1) {
      errors.push(`P5E_BLOCKING_SCENARIO:${profile.id}`);
    }
  }
  const c0 = registry.scenarios?.find(({ id }) => id === "P5-C0-001");
  const d1 = registry.scenarios?.find(({ id }) => id === "P5-D1-001");
  const auth = registry.scenarios?.find(({ id }) => id === "P5-CLAUDE-AUTH-001");
  if (
    c0?.expectedStatus !== "blocked-with-evidence" ||
    c0?.deferredPhase !== "v0.2"
  ) {
    errors.push("P5E_C0_TARGET_CLASS: actual Windows 11 evidence is absent");
  }
  if (
    d1?.expectedStatus !== "blocked-with-evidence" ||
    d1?.deferredPhase !== "v0.2"
  ) {
    errors.push("P5E_D1_FALSE_GREEN: shipping SQLite profile is absent");
  }
  if (auth?.expectedStatus !== "not-run") {
    errors.push("P5E_CLAUDE_AUTH: paid authenticated inference is not authorized");
  }
  errors.push(...validateP5Privacy(registry, "scenarioRegistry"));
  return errors;
}

export function extractWorkflowJobs(workflow) {
  const lines = workflow.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  const jobs = new Map();
  if (jobsIndex < 0) return jobs;
  let current = null;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^  ([a-z0-9-]+):\s*$/.exec(lines[index]);
    if (match) {
      current = match[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current).push(lines[index]);
  }
  return new Map(
    [...jobs].map(([id, jobLines]) => [id, jobLines.join("\n")])
  );
}

export function validateP5Workflow(workflow, admittedActions, profileRegistry) {
  const errors = [...validateP3WorkflowText(workflow, admittedActions)];
  const jobs = extractWorkflowJobs(workflow);
  if (
    !/^env:\s*\n\s{2}P5_SOURCE_SHA:\s+\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}\s*$/m.test(
      workflow
    )
  ) {
    errors.push("P5E_SOURCE_HEAD_SHA: exact pull-request head SHA evidence binding is required");
  }
  if (!includesExactSet([...jobs.keys()], EXPECTED_JOBS)) {
    errors.push("P5E_JOB_SET: exact P5 workflow jobs are required");
  }
  if (
    !/concurrency:\s*\n\s+group:\s+\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*\n\s+cancel-in-progress:\s+true/m.test(
      workflow
    )
  ) {
    errors.push("P5E_CONCURRENCY: exact PR cancellation group is required");
  }
  for (const [id, block] of jobs) {
    if (!/^\s{4}timeout-minutes:\s+[1-9][0-9]*\s*$/m.test(block)) {
      errors.push(`P5E_TIMEOUT_REQUIRED:${id}`);
    }
    if (!/^\s{4}runs-on:\s+windows-2025\s*$/m.test(block)) {
      errors.push(`P5E_RUNNER_LABEL:${id}`);
    }
  }
  for (const profile of profileRegistry?.profiles ?? []) {
    if (!profile.workflowJob) continue;
    const block = jobs.get(profile.workflowJob) ?? "";
    const timeout = /^\s{4}timeout-minutes:\s+([1-9][0-9]*)\s*$/m.exec(block);
    if (
      profile.workflowJob !== profile.id ||
      !timeout ||
      Number(timeout[1]) !== profile.timeoutMinutes
    ) {
      errors.push(`P5E_PROFILE_JOB_POLICY:${profile.id}`);
    }
  }
  for (const id of [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security",
    "next-canary"
  ]) {
    const block = jobs.get(id) ?? "";
    if (
      !/actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/.test(block) ||
      !/persist-credentials:\s+false/.test(block) ||
      !/actions\/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f/.test(
        block
      ) ||
      !/node-version:\s+24\.18\.1/.test(block) ||
      !/architecture:\s+x64/.test(block) ||
      !/package-manager-cache:\s+false/.test(block)
    ) {
      errors.push(`P5E_EXACT_SETUP:${id}`);
    }
    const clockIndex = block.indexOf("./scripts/run-p5-attempt-clock.ps1");
    const setupNodeIndex = block.indexOf("actions/setup-node@");
    const identityIndex = block.indexOf("./scripts/run-p5-node-identity.ps1");
    const firstProfileCommand = [
      "node scripts/",
      "npm ci",
      "install-p3-tool.ps1",
      "install-p4-codex.ps1",
      "node --test"
    ]
      .map((command) => block.indexOf(command))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    if (clockIndex < 0 || setupNodeIndex < 0 || clockIndex > setupNodeIndex) {
      errors.push(`P5E_ATTEMPT_CLOCK:${id}`);
    }
    if (
      identityIndex < 0 ||
      (firstProfileCommand !== undefined && identityIndex > firstProfileCommand)
    ) {
      errors.push(`P5E_NODE_IDENTITY_ORDER:${id}`);
    }
  }
  for (const id of [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security",
    "next-canary"
  ]) {
    if (!/write-p5-runner-evidence\.ps1/.test(jobs.get(id) ?? "")) {
      errors.push(`P5E_RUNNER_WRITER:${id}`);
    }
  }
  for (const id of [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security"
  ]) {
    const block = jobs.get(id) ?? "";
    if (
      !/if:\s+\$\{\{\s*!cancelled\(\)\s*\}\}/.test(block) ||
      !/P5_JOB_STATUS:\s+\$\{\{\s*job\.status\s*\}\}/.test(block) ||
      !/executed-fail/.test(block) ||
      !/github-job-status-normalized/.test(block)
    ) {
      errors.push(`P5E_FAILURE_EVIDENCE:${id}`);
    }
  }
  const policy = jobs.get("policy-validation") ?? "";
  if (
    !/node scripts\/validate-p3\.mjs/.test(policy) ||
    !/invoke-p4-validator-at-handoff\.ps1/.test(policy) ||
    !/node scripts\/validate-p5\.mjs/.test(policy)
  ) {
    errors.push("P5E_POLICY_VALIDATORS: P3/P4/P5 validation is incomplete");
  }
  const install = jobs.get("install-build") ?? "";
  const npmIndex = install.indexOf("npm ci");
  for (const command of [
    "node scripts/validate-p3.mjs",
    "invoke-p4-validator-at-handoff.ps1",
    "node scripts/validate-p5.mjs"
  ]) {
    const index = install.indexOf(command);
    if (index < 0 || npmIndex < 0 || index > npmIndex) {
      errors.push(`P5E_VALIDATOR_ORDER:${command}`);
    }
  }
  if (
    !/install-p3-tool\.ps1[\s\S]*codex-regression-only/.test(install) ||
    !/npm run build/.test(install)
  ) {
    errors.push("P5E_INSTALL_BUILD: exact build Codex or build command is missing");
  }
  const unit = jobs.get("unit") ?? "";
  for (const name of [
    "bump-version",
    "commands",
    "downstream-identity",
    "git",
    "platform-policy",
    "render",
    "state"
  ]) {
    if (!unit.includes(`tests/${name}.test.mjs`)) {
      errors.push(`P5E_UNIT_PARTITION:${name}`);
    }
  }
  const core = jobs.get("core-contract") ?? "";
  if (
    !/fail-fast:\s+false/.test(core) ||
    !/max-parallel:\s+2/.test(core) ||
    !/- lane:\s+current/.test(core) ||
    !/- lane:\s+previous/.test(core) ||
    !/- lane:\s+current[\s\S]*?run_contract:\s+true[\s\S]*?- lane:\s+previous[\s\S]*?run_contract:\s+false/.test(core) ||
    !/- name:\s+Run P4 targeted contract once[\s\S]*?if:\s+\$\{\{\s*matrix\.run_contract\s*\}\}[\s\S]*?tests\/p4-contract-baseline\.test\.mjs/.test(core) ||
    !/install-p4-codex\.ps1/.test(core) ||
    !/run-p5-core-contract\.mjs/.test(core) ||
    !/tests\/p4-contract-baseline\.test\.mjs/.test(core)
  ) {
    errors.push("P5E_CORE_MATRIX: exact current/previous contract matrix is incomplete");
  }
  const windows = jobs.get("windows-integration") ?? "";
  for (const name of [
    "broker-endpoint",
    "generate-app-server-types",
    "process",
    "runtime",
    "p5-windows-resource"
  ]) {
    if (!windows.includes(`tests/${name}.test.mjs`)) {
      errors.push(`P5E_WINDOWS_PARTITION:${name}`);
    }
  }
  if (
    !/ResourceOracleStatus\s+\$observedStatus/.test(windows) ||
    !/P5-RUNNER-METADATA-001/.test(windows)
  ) {
    errors.push("P5E_RESOURCE_ORACLE_MISSING: Windows postcondition is not evidence-bound");
  }
  const claude = jobs.get("claude-lifecycle") ?? "";
  if (
    !/fail-fast:\s+false/.test(claude) ||
    !/max-parallel:\s+2/.test(claude) ||
    !/- lane:\s+minimum/.test(claude) ||
    !/- lane:\s+current/.test(claude) ||
    !/CLAUDE_CONFIG_DIR/.test(claude) ||
    !/DISABLE_UPDATES:\s+["']?1/.test(claude) ||
    !/plugin validate \. --strict/.test(claude) ||
    !/plugin validate plugins\/codex --strict/.test(claude)
  ) {
    errors.push("P5E_CLAUDE_MATRIX: isolated minimum/current structural lane is incomplete");
  }
  const security = jobs.get("security") ?? "";
  for (const command of [
    "actionlint.exe",
    "zizmor.exe --offline --persona pedantic --strict-collection",
    "osv-scanner.exe scan --lockfile package-lock.json",
    "gitleaks.exe dir --redact --no-banner"
  ]) {
    if (!security.includes(command)) errors.push(`P5E_SECURITY_COMMAND:${command}`);
  }
  const canary = jobs.get("next-canary") ?? "";
  if (
    !/continue-on-error:\s+true/.test(canary) ||
    !/fail-fast:\s+false/.test(canary) ||
    !/max-parallel:\s+1/.test(canary) ||
    !/0\.147\.0-alpha\.2/.test(canary) ||
    !/40e8f5b6cf031d74912f01a6c67c6896397743fe00ac059903f59a916dd23c68/.test(
      canary
    )
  ) {
    errors.push("P5E_CANARY_POLICY: exact isolated non-blocking canary is incomplete");
  }
  const withoutCanary = workflow.replace(
    /^  next-canary:\s*$[\s\S]*?(?=^  [a-z0-9-]+:\s*$)/m,
    ""
  );
  if (/continue-on-error:\s+true/.test(withoutCanary)) {
    errors.push("P5E_CONTINUE_ON_ERROR: only next-canary may allow failure");
  }
  if (/^\s+cache:\s+npm\s*$/m.test(workflow)) {
    errors.push("P5E_NPM_CACHE: PR dependency cache is not admitted");
  }
  const gate = jobs.get("gate") ?? "";
  const gateNeeds = /^\s{4}needs:\s*\n((?:\s{6}-\s+[a-z0-9-]+\s*\n)+)/m.exec(
    gate
  );
  const parsedGateNeeds = gateNeeds
    ? [...gateNeeds[1].matchAll(/^\s{6}-\s+([a-z0-9-]+)\s*$/gm)].map(
        (match) => match[1]
      )
    : [];
  const gateResultVariables = new Map([
    ["policy-validation", "POLICY_RESULT"],
    ["install-build", "BUILD_RESULT"],
    ["unit", "UNIT_RESULT"],
    ["core-contract", "CONTRACT_RESULT"],
    ["windows-integration", "WINDOWS_RESULT"],
    ["claude-lifecycle", "CLAUDE_RESULT"],
    ["security", "SECURITY_RESULT"],
    ["dependency-review", "DEPENDENCY_RESULT"]
  ]);
  const gateBindingsAreExact = [...gateResultVariables].every(([job, variable]) => {
    const binding = new RegExp(
      `^\\s{6}${variable}:\\s+\\$\\{\\{\\s*needs\\.${job}\\.result\\s*\\}\\}\\s*$`,
      "m"
    );
    const use = new RegExp(`\\$env:${variable}\\b`, "g");
    return binding.test(gate) && (gate.match(use) ?? []).length === 1;
  });
  if (
    !/name:\s+CI/.test(gate) ||
    !/if:\s+\$\{\{\s*always\(\)\s*\}\}/.test(gate) ||
    !includesExactSet(parsedGateNeeds, BLOCKING_JOBS) ||
    !gateBindingsAreExact ||
    !/\.Where\(\{ \$_ -ne 'success' \}\)\.Count -ne 0/.test(gate) ||
    gate.includes("next-canary")
  ) {
    errors.push("P5E_GATE_GRAPH: legacy CI must aggregate every blocking job only");
  }
  const dependency = jobs.get("dependency-review") ?? "";
  if (
    !/actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/.test(
      dependency
    )
  ) {
    errors.push("P5E_DEPENDENCY_REVIEW: exact admitted action is missing");
  }
  if (
    /\b(?:node-version|codex)[^#\r\n]*latest\b/i.test(workflow) ||
    /\b(?:pull_request_target|workflow_run)\b/.test(workflow) ||
    /\bid-token\s*:/.test(workflow)
  ) {
    errors.push("P5E_PRIVILEGED_WORKFLOW: mutable or privileged PR input is forbidden");
  }
  const profileJobs = new Set(
    profileRegistry?.profiles
      ?.filter(({ workflowJob }) => workflowJob)
      .map(({ workflowJob }) => workflowJob)
  );
  for (const id of profileJobs) {
    if (!jobs.has(id)) errors.push(`P5E_PROFILE_JOB:${id}`);
  }
  return errors;
}

export function validateP5Evidence(manifest, profileRegistry) {
  const errors = [];
  if (
    manifest?.schemaVersion !== "p5-evidence-v1" ||
    manifest.phase !== "P5" ||
    manifest.source?.handoffCommit !==
      "84515289913dfe8a7452754ad442d37873bdfd53" ||
    !COMMIT.test(manifest.source?.sourceCommit ?? "") ||
    manifest.source?.branch !== "codex/p5-matrix-profile-bootstrap" ||
    manifest.environment?.os !== "windows" ||
    manifest.environment?.architecture !== "x64" ||
    manifest.environment?.node !== "24.18.1" ||
    manifest.environment?.npm !== "11.16.0"
  ) {
    errors.push("P5E_EVIDENCE_IDENTITY: exact local P5 source/environment binding is required");
  }
  const actual = new Map((manifest.profileResults ?? []).map((result) => [result.profileId, result]));
  if (!includesExactSet([...actual.keys()], EXPECTED_PROFILE_IDS)) {
    errors.push("P5E_EVIDENCE_PROFILES: every profile needs one truth record");
  }
  for (const id of [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security"
  ]) {
    const result = actual.get(id);
    if (result?.localStatus !== "local-pass" || result?.hostedStatus !== "not-run") {
      errors.push(`P5E_LOCAL_HOSTED_TRUTH:${id}`);
    }
  }
  const dependency = actual.get("dependency-review");
  if (
    dependency?.localStatus !== "not-applicable" ||
    dependency?.hostedStatus !== "not-run"
  ) {
    errors.push("P5E_DEPENDENCY_TRUTH: remote dependency review was not executed");
  }
  const canary = actual.get("next-canary");
  if (
    canary?.blocking !== false ||
    canary?.localStatus !== "not-run" ||
    canary?.hostedStatus !== "not-run" ||
    canary?.disposition !== "non-blocking-canary"
  ) {
    errors.push("P5E_CANARY_TRUTH: defined canary is not an executed supported lane");
  }
  for (const id of ["windows-c0", "state-d1"]) {
    const result = actual.get(id);
    if (
      result?.localStatus !== "blocked-with-evidence" ||
      result?.hostedStatus !== "blocked-with-evidence" ||
      result?.runtimeImplemented !== false ||
      result?.deferredPhase !== "v0.2"
    ) {
      errors.push(`P5E_FALSE_GREEN:${id}`);
    }
  }
  if (
    manifest.authenticatedClaude?.executionStatus !== "not-run" ||
    manifest.authenticatedClaude?.authorized !== false
  ) {
    errors.push("P5E_AUTHENTICATED_CLAUDE: inference is not authorized");
  }
  if (
    manifest.remoteExecution !== "not-run" ||
    manifest.hostedRunner?.imageVersion !== null ||
    manifest.hostedRunner?.osBuild !== null ||
    manifest.hostedRunner?.filesystem !== null
  ) {
    errors.push("P5E_HOSTED_EVIDENCE_MISSING: YAML definition is not a hosted run");
  }
  if (
    manifest.p4SourceBinding?.recordedCommit !==
      "843e679a90d4ef6946af251d36f43d257f8a5a10" ||
    manifest.p4SourceBinding?.actualCommit !==
      "843e679936daba71a6c4c2fdd55fcade01b46b73" ||
    manifest.p4SourceBinding?.status !== "blocked-with-evidence"
  ) {
    errors.push("P5E_P4_SOURCE_BINDING: inherited source defect is not retained");
  }
  if (
    manifest.immutableReadback?.protectedDigest !==
      "b24fec394e331f6b550dfdb614be07ec19955c9f95288951afbcac4e4c8d0473" ||
    manifest.immutableReadback?.generatedProtocolSha256 !==
      "c4d141174754e04ef1cd1b904cd800d05e3174a772f86f0fc9c3f4d30ec3daf5" ||
    manifest.immutableReadback?.generatedSchemaDigest !==
      "e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834" ||
    manifest.immutableReadback?.toolchainSha256 !==
      "a6033a05ebecd4ff5bca3a5924ff06e55a2e2de9b41541da2c050642102dbb5d" ||
    manifest.immutableReadback?.securityPolicySha256 !==
      "f4353ad5c207396f6c6c314aa522e16b556db81f2b0f18bb10741d5f4d8a9957" ||
    manifest.immutableReadback?.p4SnapshotSha256 !==
      "820456f8bdc229db1076604cafbddfd75974310e2fe0936136f6748dc8d21749"
  ) {
    errors.push("P5E_IMMUTABLE_READBACK: P2/P3/P4 digest drift");
  }
  const requiredChecks = new Set([
    "p5-red",
    "p5-targeted",
    "p5-exact-node",
    "p5-npm-ci",
    "p5-p3-validator",
    "p5-p4-validator-at-handoff",
    "p5-p4-targeted",
    "p5-full-regression",
    "p5-build",
    "p5-codex-current-lifecycle",
    "p5-codex-previous-lifecycle",
    "p5-claude-minimum",
    "p5-claude-current",
    "p5-windows-resource",
    "p5-actionlint",
    "p5-zizmor",
    "p5-osv",
    "p5-gitleaks",
    "p5-privacy-negative",
    "p5-hygiene"
  ]);
  const green = new Set(
    (manifest.localChecks ?? [])
      .filter(
        (check) =>
          check.executionStatus === "executed-pass" &&
          check.retryCount === 0 &&
          check.timeout === false &&
          check.rawExitCode === 0
      )
      .map(({ id }) => id)
  );
  for (const id of requiredChecks) {
    if (!green.has(id)) errors.push(`P5E_LOCAL_CHECK:${id}`);
  }
  if (
    manifest.privacy?.privatePathsPersisted !== false ||
    manifest.privacy?.secretsPersisted !== false ||
    manifest.privacy?.rawEnvironmentPersisted !== false ||
    manifest.privacy?.rawPromptOrPayloadPersisted !== false ||
    manifest.privacy?.rawStdoutOrStderrPersisted !== false ||
    manifest.privacy?.redactionStatus !== "executed-pass"
  ) {
    errors.push("P5E_PRIVACY: fail-closed privacy result is required");
  }
  const allowedStatuses = new Map(
    profileRegistry?.profiles?.map((profile) => [
      profile.id,
      new Set(profile.allowedEvidenceStatuses)
    ])
  );
  for (const result of manifest.profileResults ?? []) {
    for (const status of [result.localStatus, result.hostedStatus]) {
      if (
        status !== "not-applicable" &&
        !allowedStatuses.get(result.profileId)?.has(status)
      ) {
        errors.push(`P5E_STATUS_ENUM:${result.profileId}:${status}`);
      }
    }
  }
  errors.push(...validateP5Privacy(manifest, "p5Evidence"));
  return errors;
}
