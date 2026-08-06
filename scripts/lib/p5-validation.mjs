import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validateWorkflowText as validateP3WorkflowText } from "./p3-validation.mjs";
import { validateJsonSchema } from "./p4-schema-validator.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PRIVATE_PATH =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\(?:[?.]\\|wsl\$\\)|(?:^|[\s"'=])\/(?:home|Users)\/)/i;
const GITHUB_FINE_GRAINED_PAT_PREFIX = "github" + "_pat_";
const SECRET = new RegExp(
  `(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|${GITHUB_FINE_GRAINED_PAT_PREFIX}` +
    "[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\\s+[A-Za-z0-9._~-]{20,})"
);
const EXPECTED_P5_WORKFLOW_SHA256 =
  "07422db5aff2d9709444e9b6493f95021bdaf415a5febbeda71138fff368a02e";
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
  ".gitattributes",
  ".github/CODEOWNERS",
  ".github/workflows/pull-request-ci.yml",
  "scripts/invoke-p4-validator-at-handoff.ps1",
  "scripts/validate-p5.mjs",
  "scripts/write-p5-gate-evidence.ps1",
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

export const P5_BOOTSTRAP_FRONTIER = Object.freeze({
  boundSource: "4ad56ea41a479cae0950bce817760455d5fb87fc",
  evidenceRebindCommit: "5475e3e2bccc9af6e10079da5d355b4dab88b3e5",
  windowsFixCommit: "748d6181e30f642930bc13f4f9a718a1f366dd27",
  policyCommit: "4190a2ba59637dcdbe3f32be0edc019483496620",
  evidenceRebindPaths: Object.freeze([
    "docs/baselines/2026-07-31-p5-matrix-profile-bootstrap.md",
    "evidence/ledgers/p5-attempts.json",
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json"
  ]),
  windowsFixPaths: Object.freeze([
    "scripts/lib/p5-runner-provenance.psm1",
    "scripts/write-p5-runner-evidence.ps1",
    "tests/p5-matrix-profile.test.mjs"
  ]),
  policyPaths: Object.freeze([
    "evidence/schemas/p5-evidence-v3.schema.json",
    "scripts/lib/p5-validation.mjs",
    "scripts/validate-p5.mjs",
    "tests/p5-matrix-profile.test.mjs"
  ])
});

function exactPathSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === new Set(actual).size &&
    isDeepStrictEqual([...actual].sort(), [...expected].sort())
  );
}

export function isExactP5BootstrapFrontier(observed) {
  const directPolicy =
    isDeepStrictEqual(observed?.headParents, [
      P5_BOOTSTRAP_FRONTIER.windowsFixCommit
    ]) &&
    exactPathSet(observed?.policyPaths, P5_BOOTSTRAP_FRONTIER.policyPaths);
  const exactCorrection =
    isDeepStrictEqual(observed?.headParents, [
      P5_BOOTSTRAP_FRONTIER.policyCommit
    ]) &&
    isDeepStrictEqual(observed?.policyCommitParents, [
      P5_BOOTSTRAP_FRONTIER.windowsFixCommit
    ]) &&
    exactPathSet(
      observed?.policyCommitPaths,
      P5_BOOTSTRAP_FRONTIER.policyPaths
    ) &&
    exactPathSet(observed?.policyPaths, P5_BOOTSTRAP_FRONTIER.policyPaths);
  return (
    observed?.boundSource === P5_BOOTSTRAP_FRONTIER.boundSource &&
    isDeepStrictEqual(observed?.evidenceRebindParents, [
      P5_BOOTSTRAP_FRONTIER.boundSource
    ]) &&
    isDeepStrictEqual(observed?.windowsFixParents, [
      P5_BOOTSTRAP_FRONTIER.evidenceRebindCommit
    ]) &&
    exactPathSet(
      observed?.evidenceRebindPaths,
      P5_BOOTSTRAP_FRONTIER.evidenceRebindPaths
    ) &&
    exactPathSet(observed?.windowsFixPaths, P5_BOOTSTRAP_FRONTIER.windowsFixPaths) &&
    (directPolicy || exactCorrection) &&
    isDeepStrictEqual(observed?.uncommittedPaths, [])
  );
}

export function isExactP5BootstrapCheckout(headParents, candidates) {
  const inspectedCandidates =
    headParents?.length === 1
      ? candidates?.slice(0, 1)
      : headParents?.length === 2
        ? candidates
        : [];
  return (
    Array.isArray(headParents) &&
    Array.isArray(candidates) &&
    candidates.length === headParents.length + 1 &&
    inspectedCandidates.filter(isExactP5BootstrapFrontier).length === 1
  );
}

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

function extractNamedSteps(jobBlock, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return jobBlock.match(
    new RegExp(
      `^ {6}- name: ${escapedName}[ \\t]*\\r?\\n[\\s\\S]*?(?=^ {6}- |(?![\\s\\S]))`,
      "gm"
    )
  ) ?? [];
}

function hasExactPowerShellInvocation(step, scriptName) {
  if (/@['"]/.test(step)) return false;
  const escapedName = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const calls = step.match(
    new RegExp(
      `^ {10}\\./scripts/${escapedName}(?:[ \\t]+@arguments|[ \\t]+\x60)[ \\t]*$`,
      "gm"
    )
  ) ?? [];
  if (calls.length !== 1) return false;
  const invocationIndex = step.indexOf(calls[0]);
  const prefix = step.slice(0, invocationIndex);
  return !/^ {10}(?:return|exit|break|continue)(?:\s|$)/m.test(prefix);
}

function extractMatrixIncludeRows(jobBlock) {
  const lines = jobBlock.split(/\r?\n/);
  const includeIndex = lines.findIndex((line) => line === "        include:");
  if (includeIndex < 0) return [];
  const rows = [];
  let row = null;
  for (let index = includeIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const first = /^ {10}- ([a-z0-9_]+):[ \t]*(.+)$/.exec(line);
    if (first) {
      row = { [first[1]]: first[2].trim() };
      rows.push(row);
      continue;
    }
    const field = /^ {12}([a-z0-9_]+):[ \t]*(.+)$/.exec(line);
    if (field && row) {
      row[field[1]] = field[2].trim();
      continue;
    }
    if (/^ {8}\S/.test(line) || /^ {6}- name:/.test(line)) break;
  }
  return rows;
}

function exactMatrixRows(actual, expected) {
  const canonical = (rows) => rows
    .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
    .sort();
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

export function validateP5Workflow(workflow, admittedActions, profileRegistry) {
  const errors = [...validateP3WorkflowText(workflow, admittedActions)];
  const normalizedWorkflow = workflow.replace(/\r\n/g, "\n");
  if (
    createHash("sha256").update(normalizedWorkflow).digest("hex") !==
    EXPECTED_P5_WORKFLOW_SHA256
  ) {
    errors.push("P5E_WORKFLOW_DIGEST: PR workflow differs from the reviewed P5 executable graph");
  }
  const jobs = extractWorkflowJobs(workflow);
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
    "dependency-review",
    "gate",
    "next-canary"
  ]) {
    const block = jobs.get(id) ?? "";
    const checkoutSteps = extractNamedSteps(block, "Check out repository");
    const clockSteps = extractNamedSteps(block, "Start profile clock");
    const setupSteps = extractNamedSteps(block, "Set up Node.js");
    const identitySteps = extractNamedSteps(block, "Verify exact Node identity");
    const exactCheckout = [
      "      - name: Check out repository",
      "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
      "        with:",
      ...(["policy-validation", "install-build"].includes(id)
        ? ["          fetch-depth: 0"]
        : []),
      "          persist-credentials: false"
    ].join("\n");
    const exactClock = [
      "      - name: Start profile clock",
      "        id: p5_clock",
      "        shell: pwsh",
      "        run: ./scripts/run-p5-attempt-clock.ps1"
    ].join("\n");
    const exactSetup = [
      "      - name: Set up Node.js",
      "        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0",
      "        with:",
      "          node-version: 24.18.1",
      "          architecture: x64",
      "          check-latest: false",
      "          package-manager-cache: false"
    ].join("\n");
    const exactIdentity = [
      "      - name: Verify exact Node identity",
      "        shell: pwsh",
      "        run: ./scripts/run-p5-node-identity.ps1"
    ].join("\n");
    if (
      checkoutSteps.length !== 1 ||
      checkoutSteps[0].trimEnd() !== exactCheckout ||
      setupSteps.length !== 1 ||
      setupSteps[0].trimEnd() !== exactSetup
    ) {
      errors.push(`P5E_EXACT_SETUP:${id}`);
    }
    const clockIndex = block.indexOf(clockSteps[0] ?? "\u0000");
    const setupNodeIndex = block.indexOf(setupSteps[0] ?? "\u0000");
    const identityIndex = block.indexOf(identitySteps[0] ?? "\u0000");
    const firstProfileCommand = [
      "node scripts/",
      "npm ci",
      "install-p3-tool.ps1",
      "install-p4-codex.ps1",
      "node --test",
      "actions/dependency-review-action@",
      "Invoke-WebRequest",
      "P5E_BLOCKING_PROFILE_RESULT"
    ]
      .map((command) => block.indexOf(command))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    if (
      clockIndex < 0 ||
      setupNodeIndex < 0 ||
      clockIndex > setupNodeIndex ||
      clockSteps.length !== 1 ||
      clockSteps[0].trimEnd() !== exactClock
    ) {
      errors.push(`P5E_ATTEMPT_CLOCK:${id}`);
    }
    if (
      identityIndex < 0 ||
      identityIndex < setupNodeIndex ||
      identitySteps.length !== 1 ||
      identitySteps[0].trimEnd() !== exactIdentity ||
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
    "dependency-review",
    "next-canary"
  ]) {
    const stepName = id === "next-canary"
      ? "Write sanitized canary evidence"
      : id === "windows-integration"
        ? "Write sanitized runner and resource evidence"
        : "Write sanitized runner evidence";
    const steps = extractNamedSteps(jobs.get(id) ?? "", stepName);
    const step = steps[0] ?? "";
    const profileBinding = new RegExp(
      `(?:-Profile[ \\t]+${id}\\b|Profile[ \\t]*=[ \\t]*'${id}')`
    );
    if (
      steps.length !== 1 ||
      !hasExactPowerShellInvocation(step, "write-p5-runner-evidence.ps1") ||
      !profileBinding.test(step) ||
      !/P5_CONTEXT_LANE:\s+(?:default|\$\{\{\s*matrix\.lane\s*\}\})/.test(step)
    ) {
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
    "security",
    "dependency-review"
  ]) {
    const stepName = id === "windows-integration"
      ? "Write sanitized runner and resource evidence"
      : "Write sanitized runner evidence";
    const step = extractNamedSteps(jobs.get(id) ?? "", stepName)[0] ?? "";
    if (
      !/if:\s+\$\{\{\s*!cancelled\(\)\s*\}\}/.test(step) ||
      !/P5_JOB_STATUS:\s+\$\{\{\s*job\.status\s*\}\}/.test(step) ||
      !/executed-fail/.test(step) ||
      !/github-job-status-normalized/.test(step) ||
      !/(?:\$fixtureIds|FixtureIds)\s*=\s*@\(\)/.test(step) ||
      /(?:\$fixtureIds|FixtureIds)\s*=\s*if\b/.test(step)
    ) {
      errors.push(`P5E_FAILURE_EVIDENCE:${id}`);
    }
  }
  for (const [id, block] of jobs) {
    const evidenceStep = extractNamedSteps(
      block,
      id === "gate"
        ? "Write sanitized terminal gate evidence"
        : id === "next-canary"
          ? "Write sanitized canary evidence"
          : id === "windows-integration"
            ? "Write sanitized runner and resource evidence"
            : "Write sanitized runner evidence"
    )[0] ?? "";
    if (
      !/P5_CHECK_RUN_ID:\s+\$\{\{\s*job\.check_run_id\s*\}\}/.test(evidenceStep) ||
      !/P5_STARTED_AT:\s+\$\{\{\s*steps\.p5_clock\.outputs\.started_at\s*\}\}/.test(evidenceStep)
    ) {
      errors.push(`P5E_CHECK_RUN_ID:${id}`);
    }
    const integritySteps = extractNamedSteps(block, "Verify clean evidence source");
    const exactIntegrityStep = [
      "      - name: Verify clean evidence source",
      "        if: ${{ !cancelled() }}",
      "        run: git diff --exit-code HEAD -- ."
    ].join("\n");
    if (
      integritySteps.length !== 1 ||
      integritySteps[0].trimEnd() !== exactIntegrityStep ||
      block.indexOf(integritySteps[0]) > block.indexOf(evidenceStep)
    ) {
      errors.push(`P5E_SOURCE_INTEGRITY:${id}`);
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
  const coreRows = extractMatrixIncludeRows(core);
  const codexTools = profileRegistry?.tools?.codex ?? [];
  const currentCodex = codexTools.find(({ lane }) => lane === "current") ?? {};
  const previousCodex = codexTools.find(({ lane }) => lane === "previous") ?? {};
  const exactP4ContractSteps = core.match(
    /^ {6}- name: Run P4 targeted contract once[ \t]*\r?\n {8}if:[ \t]+\$\{\{[ \t]*matrix\.run_contract[ \t]*\}\}[ \t]*\r?\n {8}run:[ \t]+node --test --test-concurrency=1 tests\/p4-contract-baseline\.test\.mjs[ \t]*\r?\n(?:[ \t]*\r?\n)*(?= {6}- name:)/gm
  ) ?? [];
  if (
    !/fail-fast:\s+false/.test(core) ||
    !/max-parallel:\s+2/.test(core)
  ) {
    errors.push("P5E_CORE_MATRIX_POLICY: exact current/previous matrix policy is incomplete");
  }
  if (
    !exactMatrixRows(coreRows, [
      {
        lane: "current",
        version: String(currentCodex.version ?? ""),
        sha256: String(currentCodex.executableSha256 ?? ""),
        run_contract: "true"
      },
      {
        lane: "previous",
        version: String(previousCodex.version ?? ""),
        sha256: String(previousCodex.executableSha256 ?? ""),
        run_contract: "false"
      }
    ])
  ) {
    errors.push("P5E_CORE_MATRIX_ALLOCATION: exact current/previous allocation set differs");
  }
  if (
    exactP4ContractSteps.length !== 1 ||
    !/install-p4-codex\.ps1/.test(core) ||
    !/run-p5-core-contract\.mjs/.test(core) ||
    !/tests\/p4-contract-baseline\.test\.mjs/.test(core)
  ) {
    errors.push("P5E_CORE_MATRIX_CONTRACT: exact current/previous contract execution is incomplete");
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
    !/^ {8}id:\s+resource_oracle\s*$/m.test(windows) ||
    !/P5_RESOURCE_OUTCOME:\s+\$\{\{\s*steps\.resource_oracle\.outcome\s*\}\}/.test(windows) ||
    !/ResourceOracleStatus\s+\$resourceOracleStatus/.test(windows) ||
    !/'success'\s+\{\s*'executed-pass'\s*\}/.test(windows) ||
    !/'failure'\s+\{\s*'executed-fail'\s*\}/.test(windows) ||
    !/default\s+\{\s*'not-run'\s*\}/.test(windows) ||
    !/P5-RUNNER-METADATA-001/.test(windows)
  ) {
    errors.push("P5E_RESOURCE_ORACLE_MISSING: Windows postcondition is not evidence-bound");
  }
  const claude = jobs.get("claude-lifecycle") ?? "";
  const claudeRows = extractMatrixIncludeRows(claude);
  const claudeTools = profileRegistry?.tools?.claude ?? [];
  const minimumClaude = claudeTools.find(({ lane }) => lane === "minimum") ?? {};
  const currentClaude = claudeTools.find(({ lane }) => lane === "current") ?? {};
  if (
    !/fail-fast:\s+false/.test(claude) ||
    !/max-parallel:\s+2/.test(claude) ||
    !exactMatrixRows(claudeRows, [
      {
        lane: "minimum",
        tool_id: "claude-minimum",
        version: String(minimumClaude.version ?? ""),
        sha256: String(minimumClaude.executableSha256 ?? "")
      },
      {
        lane: "current",
        tool_id: "claude-current",
        version: String(currentClaude.version ?? ""),
        sha256: String(currentClaude.executableSha256 ?? "")
      }
    ]) ||
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
  for (const toolId of ["actionlint", "zizmor", "osv-scanner", "gitleaks"]) {
    const pathVariable = `P5_${toolId.replaceAll("-", "_").toUpperCase()}_PATH`;
    if (
      !new RegExp(`(?:^|\\s)['"]?${toolId}['"]?[ \\t]*=[ \\t]*\\$env:${pathVariable}\\b`, "m").test(
        security
      )
    ) {
      errors.push(`P5E_SECURITY_PROVENANCE:${toolId}`);
    }
  }
  const canary = jobs.get("next-canary") ?? "";
  const canaryRows = extractMatrixIncludeRows(canary);
  const nextCodex = codexTools.find(({ lane }) => lane === "next") ?? {};
  if (
    !/^ {4}continue-on-error: true$/m.test(canary) ||
    !/^ {6}fail-fast: false$/m.test(canary) ||
    !/^ {6}max-parallel: 1$/m.test(canary) ||
    !/0\.147\.0-alpha\.2/.test(canary) ||
    !/40e8f5b6cf031d74912f01a6c67c6896397743fe00ac059903f59a916dd23c68/.test(
      canary
    ) ||
    !exactMatrixRows(canaryRows, [
      {
        lane: "next",
        version: String(nextCodex.version ?? ""),
        sha256: String(nextCodex.executableSha256 ?? "")
      }
    ])
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
  const gateEvidenceSteps = extractNamedSteps(
    gate,
    "Write sanitized terminal gate evidence"
  );
  const gateEvidenceStep = gateEvidenceSteps[0] ?? "";
  const gateGuardSteps = extractNamedSteps(gate, "Require every blocking profile");
  const exactGateGuard = [
    "      - name: Require every blocking profile",
    "        shell: pwsh",
    "        run: |",
    "          $results = @(",
    "            $env:POLICY_RESULT,",
    "            $env:BUILD_RESULT,",
    "            $env:UNIT_RESULT,",
    "            $env:CONTRACT_RESULT,",
    "            $env:WINDOWS_RESULT,",
    "            $env:CLAUDE_RESULT,",
    "            $env:SECURITY_RESULT,",
    "            $env:DEPENDENCY_RESULT",
    "          )",
    "          if ($results.Where({ $_ -ne 'success' }).Count -ne 0) {",
    "            throw 'P5E_BLOCKING_PROFILE_RESULT'",
    "          }"
  ].join("\n");
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
    return binding.test(gate) && (gate.match(use) ?? []).length === 2;
  });
  if (
    !/^ {4}name: CI$/m.test(gate) ||
    !/^ {4}if: \$\{\{ always\(\) \}\}$/m.test(gate) ||
    !includesExactSet(parsedGateNeeds, BLOCKING_JOBS) ||
    !gateBindingsAreExact ||
    gateGuardSteps.length !== 1 ||
    gateGuardSteps[0].trimEnd() !== exactGateGuard ||
    gateEvidenceSteps.length !== 1 ||
    !hasExactPowerShellInvocation(gateEvidenceStep, "write-p5-gate-evidence.ps1") ||
    !/if:\s+\$\{\{\s*!cancelled\(\)\s*\}\}/.test(gateEvidenceStep) ||
    gate.includes("next-canary")
  ) {
    errors.push("P5E_GATE_GRAPH: legacy CI must aggregate every blocking job only");
  }
  const dependency = jobs.get("dependency-review") ?? "";
  const dependencyActionSteps = extractNamedSteps(
    dependency,
    "Review dependency changes"
  );
  const dependencyEvidenceSteps = extractNamedSteps(
    dependency,
    "Write sanitized runner evidence"
  );
  const dependencyEvidenceStep = dependencyEvidenceSteps[0] ?? "";
  const exactDependencyAction = [
    "      - name: Review dependency changes",
    "        uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0"
  ].join("\n");
  if (
    dependencyActionSteps.length !== 1 ||
    dependencyActionSteps[0].trimEnd() !== exactDependencyAction ||
    dependencyEvidenceSteps.length !== 1 ||
    !hasExactPowerShellInvocation(dependencyEvidenceStep, "write-p5-runner-evidence.ps1") ||
    !/-Profile\s+dependency-review/.test(dependencyEvidenceStep) ||
    !/-ScenarioId\s+P5-DEPENDENCY-001/.test(dependencyEvidenceStep) ||
    !/P5-DEPENDENCY-REVIEW-001/.test(dependencyEvidenceStep)
  ) {
    errors.push("P5E_DEPENDENCY_REVIEW: exact admitted action or evidence binding is missing");
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

function expectedLaneFixtures(profile, lane, scenarioFixtures) {
  const exact = {
    "core-contract/current": ["P4-TARGETED-GREEN-001", "P5-LIFECYCLE-CURRENT-001"],
    "core-contract/previous": ["P5-LIFECYCLE-PREVIOUS-001"],
    "claude-lifecycle/minimum": ["P5-CLAUDE-MINIMUM-001"],
    "claude-lifecycle/current": ["P5-CLAUDE-CURRENT-001"]
  };
  return exact[`${profile}/${lane}`] ?? scenarioFixtures;
}

function expectedProfileTools(profile) {
  return {
    "install-build": ["codex"],
    "core-contract": ["codex"],
    "claude-lifecycle": ["claude"],
    security: ["actionlint", "gitleaks", "osv-scanner", "zizmor"],
    "next-canary": ["codex"]
  }[profile] ?? [];
}

function validRunnerProvenance(provenance) {
  const expectedWorkflowRef =
    `${provenance?.repository}/.github/workflows/pull-request-ci.yml@` +
    `refs/pull/${provenance?.pullRequest?.number}/merge`;
  return (
    ownObject(provenance) &&
    provenance.executionClass === "hosted" &&
    typeof provenance.repository === "string" &&
    provenance.repository === provenance.pullRequest?.baseRepository &&
    Number.isSafeInteger(provenance.pullRequest?.number) &&
    provenance.pullRequest.number > 0 &&
    COMMIT.test(provenance.pullRequest?.baseSha ?? "") &&
    typeof provenance.pullRequest?.baseRef === "string" &&
    provenance.pullRequest.baseRef.length > 0 &&
    typeof provenance.pullRequest?.headRepository === "string" &&
    provenance.pullRequest.headRepository.length > 0 &&
    typeof provenance.pullRequest?.headRef === "string" &&
    provenance.pullRequest.headRef.length > 0 &&
    COMMIT.test(provenance.sourceHeadSha ?? "") &&
    provenance.sourceHeadSha === provenance.pullRequest?.headSha &&
    COMMIT.test(provenance.eventMergeSha ?? "") &&
    provenance.actualCheckoutSha === provenance.eventMergeSha &&
    COMMIT.test(provenance.workflow?.sha ?? "") &&
    provenance.workflow?.name === "Pull Request CI" &&
    provenance.workflow?.ref === expectedWorkflowRef &&
    Number.isSafeInteger(provenance.run?.id) &&
    provenance.run.id > 0 &&
    Number.isSafeInteger(provenance.run?.attempt) &&
    provenance.run.attempt > 0 &&
    Number.isSafeInteger(provenance.run?.checkRunId) &&
    provenance.run.checkRunId > 0 &&
    provenance.runner?.requestedLabel === "windows-2025" &&
    provenance.runner?.environment === "github-hosted" &&
    provenance.runner?.os === "Windows" &&
    provenance.runner?.architecture === "X64" &&
    provenance.runner?.filesystem === "NTFS" &&
    provenance.runner?.productType === 3 &&
    /Windows Server 2025/.test(provenance.runner?.osCaption ?? "") &&
    typeof provenance.runner?.imageOS === "string" &&
    provenance.runner.imageOS.length > 0 &&
    typeof provenance.runner?.imageVersion === "string" &&
    provenance.runner.imageVersion.length > 0 &&
    provenance.runner?.storageClass?.value === "github-hosted-ephemeral-runner-temp"
  );
}

function exactNodeTools(tools) {
  return (
    tools?.nodeIdentityStatus === "verified-exact" &&
    tools?.node === "24.18.1" &&
    tools?.npm === "11.16.0" &&
    tools?.nodeArchitecture === "x64" &&
    tools?.nodeExecutableSha256 ===
      "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582"
  );
}

function safeEvidenceDisposition(record, dependencyReview) {
  return (
    record?.artifact?.repositoryAuthoredUpload === false &&
    record?.artifact?.releaseTrustInput === false &&
    record?.artifact?.actionOwnedConditionalUploadPossible === dependencyReview &&
    record?.artifact?.observedUpload === (dependencyReview ? null : false) &&
    record?.artifact?.digest === null &&
    record?.artifact?.retentionDays === (dependencyReview ? 1 : null) &&
    record?.artifact?.readbackStatus ===
      (dependencyReview ? "pending-rest-readback" : "not-applicable") &&
    record?.cache?.repositoryAuthoredCacheEnabled === false &&
    record?.cache?.readbackStatus === "pending-rest-readback" &&
    record?.cache?.releaseTrustInput === false &&
    record?.privacy?.privatePathsPersisted === false &&
    record?.privacy?.secretsPersisted === false &&
    record?.privacy?.rawEnvironmentPersisted === false &&
    record?.privacy?.rawPromptOrPayloadPersisted === false &&
    record?.privacy?.rawStdoutOrStderrPersisted === false &&
    record?.privacy?.redactionStatus === "executed-pass"
  );
}

function validPartialAttempt(attempt, runAttempt, profile) {
  const startedAt = Date.parse(attempt?.startedAt);
  const finishedAt = Date.parse(attempt?.finishedAt);
  const duration = finishedAt - startedAt;
  const successful =
    attempt?.observedStatus === "executed-pass" ||
    (attempt?.observedStatus === "non-blocking-canary" && attempt?.rawExitCode === 0);
  const expectedResourceStatus = profile === "windows-integration"
    ? attempt?.observedStatus === "executed-pass"
      ? "executed-pass"
      : ["executed-pass", "executed-fail", "not-run"].includes(
            attempt?.resourceOracleStatus
          )
        ? attempt.resourceOracleStatus
        : null
    : "not-applicable";
  return (
    ownObject(attempt) &&
    attempt.trial === runAttempt &&
    attempt.runAttempt === runAttempt &&
    attempt.jobAttempt === null &&
    attempt.restJobId === null &&
    attempt.workflowRerunCount === null &&
    attempt.automaticRetryCount === null &&
    attempt.timeout === null &&
    attempt.authority === "runner-self-observed-partial" &&
    attempt.restConsolidationStatus === "pending-post-run-attempt-jobs" &&
    ["executed-pass", "executed-fail", "non-blocking-canary"].includes(
      attempt.observedStatus
    ) &&
    Number.isSafeInteger(attempt.rawExitCode) &&
    attempt.rawExitCodeSource === "github-job-status-normalized" &&
    ((attempt.observedStatus === "executed-pass" && attempt.rawExitCode === 0) ||
      (attempt.observedStatus === "executed-fail" && attempt.rawExitCode === 1) ||
      (attempt.observedStatus === "non-blocking-canary" &&
        [0, 1].includes(attempt.rawExitCode))) &&
    typeof attempt.startedAt === "string" &&
    typeof attempt.finishedAt === "string" &&
    Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) &&
    Number.isSafeInteger(attempt.wallTimeMs) &&
    attempt.wallTimeMs >= 0 &&
    startedAt <= finishedAt &&
    Math.abs(attempt.wallTimeMs - duration) <= 1 &&
    (!successful || attempt.startedAtSource === "profile-clock") &&
    ["profile-clock", "finalizer-fallback"].includes(attempt.startedAtSource) &&
    expectedResourceStatus !== null &&
    attempt.resourceOracleStatus === expectedResourceStatus
  );
}

export function validateP5RunnerEvidence(
  record,
  profileRegistry,
  toolchain,
  scenarioRegistry,
  scenarioRegistrySha256
) {
  const errors = [];
  const profile = profileById(profileRegistry, record?.profile);
  const scenarioFixtures = record?.scenarioFixtureIds ?? [];
  const lanes = profile?.matrix?.values ?? ["default"];
  const successful =
    record?.attempt?.observedStatus === "executed-pass" ||
    (record?.attempt?.observedStatus === "non-blocking-canary" &&
      record?.attempt?.rawExitCode === 0);
  const scenario = scenarioRegistry?.scenarios?.find(
    (entry) => entry.id === record?.scenarioId
  );
  if (
    record?.schemaVersion !== "p5-runner-evidence-v2" ||
    record?.evidenceKind !== "profile-lane" ||
    !profile ||
    !scenario ||
    scenario.profileId !== record.profile ||
    scenario.blocking !== record.blocking ||
    !includesExactSet(record?.requirementIds, scenario.requirementIds) ||
    !includesExactSet(record?.scenarioFixtureIds, scenario.fixtureIds) ||
    record?.oracle?.aggregateExpected !== scenario.oracle ||
    typeof record?.oracle?.expected !== "string" ||
    record.oracle.expected.length === 0 ||
    record?.oracle?.observedStatus !== record?.attempt?.observedStatus ||
    record?.oracle?.registrySha256 !== scenarioRegistrySha256 ||
    !lanes.includes(record.lane) ||
    record.blocking !== Boolean(profile?.blocking) ||
    record.provenance?.run?.yamlJobKey !== record.profile ||
    !validRunnerProvenance(record.provenance) ||
    !validPartialAttempt(record.attempt, record.provenance?.run?.attempt, record.profile)
  ) {
    errors.push("P5E_RUNNER_EVIDENCE_IDENTITY: hosted profile evidence identity is invalid");
  }
  if (successful && !exactNodeTools(record?.tools)) {
    errors.push("P5E_RUNNER_EVIDENCE_NODE: successful evidence lacks exact Node identity");
  }
  if (
    (record.blocking && record?.attempt?.observedStatus === "non-blocking-canary") ||
    (!record.blocking && record?.attempt?.observedStatus !== "non-blocking-canary")
  ) {
    errors.push("P5E_RUNNER_EVIDENCE_STATUS: blocking and observed status disagree");
  }
  const expectedFixtures = expectedLaneFixtures(
    record?.profile,
    record?.lane,
    scenarioFixtures
  );
  if (
    !Array.isArray(record?.verifiedFixtureIds) ||
    (successful && !includesExactSet(record.verifiedFixtureIds, expectedFixtures)) ||
    (!successful && record.verifiedFixtureIds.length !== 0)
  ) {
    errors.push("P5E_RUNNER_EVIDENCE_FIXTURE: verified fixtures contradict outcome");
  }
  const selectedIds = Array.isArray(record?.tools?.selected)
    ? record.tools.selected.map((entry) => entry?.id)
    : null;
  const expectedTools = expectedProfileTools(record?.profile);
  if (
    !Array.isArray(selectedIds) ||
    (successful && !includesExactSet(selectedIds, expectedTools)) ||
    selectedIds?.some((id) => !expectedTools.includes(id))
  ) {
    errors.push("P5E_RUNNER_EVIDENCE_TOOL: selected tools contradict profile outcome");
  }
  for (const selected of record?.tools?.selected ?? []) {
    let admitted = null;
    if (selected?.id === "codex") {
      const lane = record?.profile === "install-build" ? "current" : record?.lane;
      admitted = profileRegistry?.tools?.codex?.find((entry) => entry.lane === lane);
    } else if (selected?.id === "claude") {
      admitted = profileRegistry?.tools?.claude?.find(
        (entry) => entry.lane === record?.lane
      );
    } else {
      admitted = toolchain?.tools?.find((entry) => entry.id === selected?.id);
    }
    const admittedDigest = admitted?.executableSha256 ?? admitted?.artifact?.executableSha256;
    if (
      !admitted ||
      selected?.version !== admitted.version ||
      selected?.executableSha256 !== admittedDigest
    ) {
      errors.push(`P5E_RUNNER_EVIDENCE_TOOL_IDENTITY:${selected?.id ?? "missing"}`);
    }
    const executableProof = ["codex", "claude"].includes(selected?.id)
      ? {
          keys: [
            "id",
            "version",
            "executableSha256",
            "verification",
            "authenticodeStatus",
            "signerOrganization"
          ],
          verification: "version-digest-authenticode",
          signerOrganization: selected.id === "codex" ? "OpenAI OpCo, LLC" : "Anthropic, PBC"
        }
      : null;
    const admissionProof = executableProof
      ? null
      : {
          keys: [
            "id",
            "version",
            "executableSha256",
            "verification",
            "runtimeSignatureStatus",
            "admissionSignatureKind",
            "admissionSignatureVerified"
          ],
          verification: "toolchain-version-and-executable-digest",
          runtimeSignatureStatus: admitted?.signature?.authenticodeRequired
            ? "valid-exact"
            : "not-required",
          admissionSignatureKind: admitted?.signature?.kind,
          admissionSignatureVerified: admitted?.signature?.verified
        };
    const proof = executableProof ?? admissionProof;
    if (
      !proof ||
      !includesExactSet(Object.keys(selected ?? {}), proof.keys) ||
      selected?.verification !== proof.verification ||
      (executableProof &&
        (selected?.authenticodeStatus !== "valid" ||
          selected?.signerOrganization !== proof.signerOrganization)) ||
      (admissionProof &&
        (selected?.runtimeSignatureStatus !== proof.runtimeSignatureStatus ||
          selected?.admissionSignatureKind !== proof.admissionSignatureKind ||
          selected?.admissionSignatureVerified !== proof.admissionSignatureVerified))
    ) {
      errors.push(`P5E_RUNNER_EVIDENCE_TOOL_PROOF:${selected?.id ?? "missing"}`);
    }
  }
  if (
    !safeEvidenceDisposition(record, record?.profile === "dependency-review") ||
    record?.runtimeEnforced !== true ||
    record?.deferredPhase !== null
  ) {
    errors.push("P5E_RUNNER_EVIDENCE_DISPOSITION: trust or runtime disposition is invalid");
  }
  errors.push(...validateP5Privacy(record, "runnerEvidence"));
  return errors;
}

export function validateP5GateEvidence(record) {
  const errors = [];
  const expectedJobs = [
    "policy-validation",
    "install-build",
    "unit",
    "core-contract",
    "windows-integration",
    "claude-lifecycle",
    "security",
    "dependency-review"
  ];
  const results = record?.blockingResults;
  const allSucceeded =
    ownObject(results) &&
    includesExactSet(Object.keys(results), expectedJobs) &&
    Object.values(results).every((value) => value === "success");
  if (
    record?.schemaVersion !== "p5-gate-evidence-v1" ||
    record?.evidenceKind !== "terminal-gate" ||
    record?.jobKey !== "gate" ||
    record?.checkName !== "CI" ||
    record?.blocking !== true ||
    record?.allBlockingSucceeded !== allSucceeded ||
    record?.provenance?.run?.yamlJobKey !== "gate" ||
    !validRunnerProvenance(record?.provenance) ||
    !validPartialAttempt(record?.attempt, record?.provenance?.run?.attempt, "gate")
  ) {
    errors.push("P5E_GATE_EVIDENCE_IDENTITY: terminal gate evidence is invalid");
  }
  if (
    (allSucceeded && !exactNodeTools(record?.tools)) ||
    !Array.isArray(record?.tools?.selected) ||
    record?.tools?.selected.length !== 0 ||
    !safeEvidenceDisposition(record, false)
  ) {
    errors.push("P5E_GATE_EVIDENCE_DISPOSITION: terminal trust disposition is invalid");
  }
  if (
    (allSucceeded && record?.attempt?.observedStatus !== "executed-pass") ||
    (!allSucceeded && record?.attempt?.observedStatus !== "executed-fail")
  ) {
    errors.push("P5E_GATE_EVIDENCE_STATUS: terminal result contradicts blocking jobs");
  }
  errors.push(...validateP5Privacy(record, "gateEvidence"));
  return errors;
}

export function validateP5RestJobBinding(record, restJob, expected) {
  const errors = [];
  const run = record?.provenance?.run;
  const evidenceStepName = record?.evidenceKind === "terminal-gate"
    ? "Write sanitized terminal gate evidence"
    : record?.profile === "next-canary"
      ? "Write sanitized canary evidence"
      : record?.profile === "windows-integration"
        ? "Write sanitized runner and resource evidence"
        : "Write sanitized runner evidence";
  const evidenceSteps = Array.isArray(restJob?.steps)
    ? restJob.steps.filter((step) => step?.name === evidenceStepName)
    : [];
  const integritySteps = Array.isArray(restJob?.steps)
    ? restJob.steps.filter((step) => step?.name === "Verify clean evidence source")
    : [];
  const expectedJobName = record?.evidenceKind === "terminal-gate"
    ? "CI"
    : {
        "policy-validation": "Policy validation",
        "install-build": "Install and build",
        unit: "Unit tests",
        "core-contract": `Core contract / ${record?.lane}`,
        "windows-integration": "Windows integration",
        "claude-lifecycle": `Claude structural lifecycle / ${record?.lane}`,
        security: "Security",
        "dependency-review": "Dependency review",
        "next-canary": `Non-blocking Codex canary / ${record?.lane}`
      }[record?.profile];
  const observedStatus = record?.attempt?.observedStatus;
  const conclusionAgrees =
    (observedStatus === "non-blocking-canary" &&
      ["success", "failure"].includes(restJob?.conclusion)) ||
    (observedStatus === "executed-pass" && restJob?.conclusion === "success") ||
    (observedStatus === "executed-fail" && restJob?.conclusion === "failure");
  const jobStartedAt = Date.parse(restJob?.started_at);
  const jobCompletedAt = Date.parse(restJob?.completed_at);
  const jobCompletedCeiling = jobCompletedAt + 999;
  const fragmentStartedAt = Date.parse(record?.attempt?.startedAt);
  const fragmentFinishedAt = Date.parse(record?.attempt?.finishedAt);
  if (
    run?.id !== expected?.runId ||
    run?.attempt !== expected?.runAttempt ||
    restJob?.run_id !== run?.id ||
    restJob?.run_attempt !== run?.attempt ||
    restJob?.status !== "completed" ||
    !Number.isSafeInteger(restJob?.id) ||
    restJob.id !== run?.checkRunId ||
    restJob?.name !== expectedJobName ||
    restJob?.check_run_url !==
      `https://api.github.com/repos/${expected?.repository}/check-runs/${run?.checkRunId}` ||
    restJob?.run_url !==
      `https://api.github.com/repos/${expected?.repository}/actions/runs/${run?.id}` ||
    restJob?.html_url !==
      `https://github.com/${expected?.repository}/actions/runs/${run?.id}/job/${restJob?.id}` ||
    restJob?.workflow_name !== "Pull Request CI" ||
    restJob?.head_sha !== expected?.sourceHeadSha ||
    !Array.isArray(restJob?.labels) ||
    !restJob.labels.includes("windows-2025") ||
    record?.provenance?.repository !== expected?.repository ||
    record?.provenance?.pullRequest?.number !== expected?.pullRequest?.number ||
    record?.provenance?.pullRequest?.baseRepository !== expected?.pullRequest?.baseRepository ||
    record?.provenance?.pullRequest?.baseRef !== expected?.pullRequest?.baseRef ||
    record?.provenance?.pullRequest?.baseSha !== expected?.pullRequest?.baseSha ||
    record?.provenance?.pullRequest?.headRepository !== expected?.pullRequest?.headRepository ||
    record?.provenance?.pullRequest?.headRef !== expected?.pullRequest?.headRef ||
    record?.provenance?.pullRequest?.headSha !== expected?.pullRequest?.headSha ||
    record?.provenance?.workflow?.ref !== expected?.workflowRef ||
    record?.provenance?.sourceHeadSha !== expected?.sourceHeadSha ||
    record?.provenance?.eventMergeSha !== expected?.eventMergeSha ||
    record?.provenance?.workflow?.sha !== expected?.workflowSha ||
    evidenceSteps.length !== 1 ||
    evidenceSteps[0]?.status !== "completed" ||
    evidenceSteps[0]?.conclusion !== "success" ||
    integritySteps.length !== 1 ||
    integritySteps[0]?.status !== "completed" ||
    integritySteps[0]?.conclusion !== "success" ||
    integritySteps[0]?.number >= evidenceSteps[0]?.number ||
    !conclusionAgrees ||
    !Number.isFinite(jobStartedAt) ||
    !Number.isFinite(jobCompletedAt) ||
    fragmentStartedAt < jobStartedAt ||
    fragmentFinishedAt > jobCompletedCeiling ||
    jobStartedAt > jobCompletedAt
  ) {
    errors.push("P5E_REST_JOB_BINDING: attempt-scoped REST job does not bind the evidence record");
  }
  return errors;
}

const EXPECTED_HOSTED_JOB_NAMES = [
  "Policy validation",
  "Install and build",
  "Unit tests",
  "Core contract / current",
  "Core contract / previous",
  "Windows integration",
  "Claude structural lifecycle / minimum",
  "Claude structural lifecycle / current",
  "Security",
  "Dependency review",
  "Non-blocking Codex canary / next",
  "CI"
];
const EXPECTED_HOSTED_JOB_KEYS = new Map([
  ["Policy validation", "policy-validation"],
  ["Install and build", "install-build"],
  ["Unit tests", "unit"],
  ["Core contract / current", "core-contract"],
  ["Core contract / previous", "core-contract"],
  ["Windows integration", "windows-integration"],
  ["Claude structural lifecycle / minimum", "claude-lifecycle"],
  ["Claude structural lifecycle / current", "claude-lifecycle"],
  ["Security", "security"],
  ["Dependency review", "dependency-review"],
  ["Non-blocking Codex canary / next", "next-canary"],
  ["CI", "gate"]
]);

const EXPECTED_VALIDATION_SOURCE_PATHS = [
  "scripts/run-p5-hosted-evidence-collector.mjs",
  "scripts/lib/p5-validation.mjs",
  "scripts/lib/p4-schema-validator.mjs",
  "scripts/lib/p3-validation.mjs",
  "ci/matrix-profiles-v1.json",
  "ci/scenario-registry-v1.json",
  "toolchain.json",
  "evidence/schemas/p5-runner-evidence-v2.schema.json",
  "evidence/schemas/p5-gate-evidence-v1.schema.json",
  "evidence/schemas/p5-hosted-harvest-v1.schema.json"
];

export function validateP5HostedHarvest(harvest, validationContext = {}) {
  const errors = [];
  const jobs = Array.isArray(harvest?.jobs) ? harvest.jobs : [];
  const collectionErrors = Array.isArray(harvest?.collectionErrors)
    ? harvest.collectionErrors
    : [];
  const names = jobs.map((record) => record?.rest?.name);
  const validationFiles = harvest?.validationSource?.files;
  const hasValidationContext =
    ownObject(validationContext?.profiles) &&
    ownObject(validationContext?.toolchain) &&
    ownObject(validationContext?.scenarios) &&
    ownObject(validationContext?.schemas?.runner) &&
    ownObject(validationContext?.schemas?.gate) &&
    ownObject(validationContext?.validationSource) &&
    ownObject(validationContext?.expected) &&
    SHA256.test(validationContext?.scenarioRegistrySha256 ?? "");
  if (!hasValidationContext) {
    errors.push("P5E_HARVEST_VALIDATOR_CONTEXT: pinned validation inputs are required");
  } else if (
    validationContext.validationSource.sourceHeadSha !== harvest?.sourceHeadSha ||
    validationContext.validationSource.authority !==
      "source-commit-git-objects-and-matched-executable" ||
    !includesExactSet(
      validationFiles?.map((entry) => `${entry?.path}:${entry?.sha256}`),
      validationContext.validationSource.files?.map(
        (entry) => `${entry?.path}:${entry?.sha256}`
      )
    )
  ) {
    errors.push("P5E_HARVEST_VALIDATOR_SOURCE: persisted validator digests differ");
  }
  if (
    hasValidationContext &&
    (harvest?.repository !== validationContext.expected.repository ||
      harvest?.run?.id !== validationContext.expected.runId ||
      harvest?.run?.attempt !== validationContext.expected.runAttempt ||
      harvest?.sourceHeadSha !== validationContext.expected.sourceHeadSha ||
      harvest?.eventMergeSha !== validationContext.expected.eventMergeSha ||
      harvest?.workflowSha !== validationContext.expected.workflowSha ||
      JSON.stringify(harvest?.pullRequest) !==
        JSON.stringify(validationContext.expected.pullRequest))
  ) {
    errors.push("P5E_HARVEST_EXPECTED_IDENTITY: harvest differs from requested run identity");
  }
  if (
    harvest?.schemaVersion !== "p5-hosted-harvest-v1" ||
    typeof harvest?.repository !== "string" ||
    !Number.isSafeInteger(harvest?.run?.id) ||
    harvest.run.id < 1 ||
    !Number.isSafeInteger(harvest?.run?.attempt) ||
    harvest.run.attempt < 1 ||
    !COMMIT.test(harvest?.sourceHeadSha ?? "") ||
    !COMMIT.test(harvest?.eventMergeSha ?? "") ||
    !COMMIT.test(harvest?.workflowSha ?? "") ||
    harvest?.pullRequest?.number < 1 ||
    harvest?.pullRequest?.baseRepository !== harvest?.repository ||
    !COMMIT.test(harvest?.pullRequest?.baseSha ?? "") ||
    harvest?.pullRequest?.headSha !== harvest?.sourceHeadSha ||
    harvest?.validationSource?.sourceHeadSha !== harvest?.sourceHeadSha ||
    harvest?.validationSource?.authority !==
      "source-commit-git-objects-and-matched-executable" ||
    !Array.isArray(validationFiles) ||
    !includesExactSet(
      validationFiles.map((entry) => entry?.path),
      EXPECTED_VALIDATION_SOURCE_PATHS
    ) ||
    validationFiles.some((entry) => !SHA256.test(entry?.sha256 ?? ""))
  ) {
    errors.push("P5E_HARVEST_IDENTITY: harvest or validator-source identity is invalid");
  }
  if (
    names.some((name) => !EXPECTED_HOSTED_JOB_NAMES.includes(name)) ||
    new Set(names).size !== names.length
  ) {
    errors.push("P5E_HARVEST_JOB_SET: jobs must be a unique subset of the exact allocation set");
  }
  const fullyValidated =
    harvest?.collectionStatus === "validated" && collectionErrors.length === 0;
  if (
    (harvest?.collectionStatus === "validated" && collectionErrors.length !== 0) ||
    (harvest?.collectionStatus === "incomplete-or-invalid" && collectionErrors.length === 0) ||
    !["validated", "incomplete-or-invalid"].includes(harvest?.collectionStatus)
  ) {
    errors.push("P5E_HARVEST_STATUS: collection status and errors disagree");
  }
  if (fullyValidated && !includesExactSet(names, EXPECTED_HOSTED_JOB_NAMES)) {
    errors.push("P5E_HARVEST_JOB_SET: validated harvest requires all exact allocations");
  }
  const artifactReadback = harvest?.trustReadback?.artifact;
  const cacheReadback = harvest?.trustReadback?.cache;
  const artifacts = Array.isArray(artifactReadback?.artifacts)
    ? artifactReadback.artifacts
    : [];
  const cacheEntries = Array.isArray(cacheReadback?.entries)
    ? cacheReadback.entries
    : [];
  const expectedAttemptAttribution = harvest?.run?.attempt === 1
    ? "exact-first-attempt-time-window"
    : artifacts.length === 0
      ? "exact-empty-current-attempt-window"
      : "unavailable-run-scoped-after-rerun";
  const harvestJobStarts = jobs
    .map((record) => Date.parse(record?.rest?.startedAt))
    .filter(Number.isFinite);
  const harvestJobEnds = jobs
    .map((record) => Date.parse(record?.rest?.completedAt))
    .filter(Number.isFinite);
  const harvestAttemptStartedAt =
    harvestJobStarts.length > 0 ? Math.min(...harvestJobStarts) : NaN;
  const harvestAttemptCompletedAt =
    harvestJobEnds.length > 0 ? Math.max(...harvestJobEnds) + 999 : NaN;
  if (
    artifactReadback?.authority !== "run-artifacts-rest-plus-reviewed-workflow" ||
    artifactReadback?.endpoint !==
      `/repos/${harvest?.repository}/actions/runs/${harvest?.run?.id}/artifacts` ||
    artifactReadback?.repositoryAuthoredUpload !== false ||
    artifactReadback?.actionOwnedConditionalUploadPossible !== true ||
    artifactReadback?.observedUpload !== (artifacts.length > 0) ||
    artifactReadback?.attemptAttribution !== expectedAttemptAttribution ||
    !Number.isSafeInteger(artifactReadback?.otherAttemptArtifactCount) ||
    artifactReadback.otherAttemptArtifactCount < 0 ||
    (harvest?.run?.attempt === 1 && artifactReadback.otherAttemptArtifactCount !== 0) ||
    artifactReadback?.releaseTrustInput !== false ||
    artifacts.some((artifact) => {
      const createdAt = Date.parse(artifact?.createdAt);
      const updatedAt = Date.parse(artifact?.updatedAt);
      const expiresAt = Date.parse(artifact?.expiresAt);
      return (
        !Number.isSafeInteger(artifact?.id) ||
        !Number.isSafeInteger(artifact?.sizeBytes) ||
        artifact.sizeBytes < 0 ||
        !/^sha256:[0-9a-f]{64}$/.test(artifact?.digest ?? "") ||
        artifact?.retentionDays !== 1 ||
        !Number.isFinite(createdAt) ||
        !Number.isFinite(updatedAt) ||
        !Number.isFinite(expiresAt) ||
        createdAt > updatedAt ||
        updatedAt > expiresAt ||
        createdAt < harvestAttemptStartedAt ||
        createdAt > harvestAttemptCompletedAt ||
        Math.abs(expiresAt - createdAt - 86_400_000) > 1_000 ||
        artifact?.url !==
          `https://api.github.com/repos/${harvest?.repository}/actions/artifacts/${artifact?.id}`
      );
    }) ||
    (fullyValidated && artifactReadback?.readbackStatus !== "resolved") ||
    (fullyValidated && expectedAttemptAttribution === "unavailable-run-scoped-after-rerun")
  ) {
    errors.push("P5E_HARVEST_ARTIFACT_READBACK: artifact disposition is unresolved");
  }
  const computedCacheInventorySha256 = createHash("sha256")
    .update(JSON.stringify(cacheEntries))
    .digest("hex");
  if (
    cacheReadback?.authority !== "pr-ref-cache-rest-plus-reviewed-workflow" ||
    cacheReadback?.ref !== `refs/pull/${harvest?.pullRequest?.number}/merge` ||
    cacheReadback?.repositoryAuthoredCacheEnabled !== false ||
    cacheReadback?.packageManagerCacheEnabled !== false ||
    cacheReadback?.matchingRefCacheCount !== cacheEntries.length ||
    cacheReadback?.inventorySha256 !== computedCacheInventorySha256 ||
    cacheReadback?.releaseTrustInput !== false ||
    cacheEntries.some(
      (entry) =>
        !Number.isSafeInteger(entry?.id) ||
        !SHA256.test(entry?.keySha256 ?? "") ||
        !Number.isSafeInteger(entry?.sizeBytes) ||
        entry.sizeBytes < 0 ||
        !Number.isFinite(Date.parse(entry?.createdAt)) ||
        !Number.isFinite(Date.parse(entry?.lastAccessedAt)) ||
        Date.parse(entry.createdAt) > Date.parse(entry.lastAccessedAt)
    ) ||
    (fullyValidated && cacheReadback?.readbackStatus !== "resolved")
  ) {
    errors.push("P5E_HARVEST_CACHE_READBACK: cache disposition is unresolved");
  }
  for (const record of jobs) {
    const rest = record?.rest;
    const attempt = record?.consolidatedAttempt;
    const fragment = record?.fragment;
    const timeout = rest?.status === "completed" && rest?.conclusion !== null
      ? rest.conclusion === "timed_out"
      : null;
    const restStartedAt = Date.parse(rest?.startedAt);
    const restCompletedAt = Date.parse(rest?.completedAt);
    const expectedRestWallTime =
      Number.isFinite(restStartedAt) && Number.isFinite(restCompletedAt)
        ? Math.max(0, restCompletedAt - restStartedAt)
        : null;
    if (
      !Number.isSafeInteger(rest?.id) ||
      rest?.runId !== harvest?.run?.id ||
      rest?.runAttempt !== harvest?.run?.attempt ||
      rest?.headSha !== harvest?.sourceHeadSha ||
      rest?.workflowName !== "Pull Request CI" ||
      rest?.runUrl !==
        `https://api.github.com/repos/${harvest?.repository}/actions/runs/${harvest?.run?.id}` ||
      rest?.checkRunUrl !==
        `https://api.github.com/repos/${harvest?.repository}/check-runs/${rest?.id}` ||
      rest?.url !==
        `https://api.github.com/repos/${harvest?.repository}/actions/jobs/${rest?.id}` ||
      rest?.htmlUrl !==
        `https://github.com/${harvest?.repository}/actions/runs/${harvest?.run?.id}/job/${rest?.id}` ||
      !Array.isArray(rest?.labels) ||
      !rest.labels.includes("windows-2025") ||
      attempt?.authority !== "attempt-scoped-rest-plus-validated-runner-fragment" ||
      attempt?.runAttempt !== rest?.runAttempt ||
      attempt?.restJobId !== rest?.id ||
      attempt?.workflowRerunCount !== rest?.runAttempt - 1 ||
      attempt?.jobAttempt !== null ||
      attempt?.jobAttemptStatus !== "not-exposed-by-attempt-jobs-api" ||
      attempt?.automaticRetryCount !== null ||
      attempt?.automaticRetryStatus !== "not-exposed-by-attempt-jobs-api" ||
      attempt?.timeout !== timeout ||
      attempt?.restConclusion !== rest?.conclusion ||
      attempt?.restStartedAt !== rest?.startedAt ||
      attempt?.restCompletedAt !== rest?.completedAt ||
      attempt?.restWallTimeMs !== expectedRestWallTime ||
      (rest?.status === "completed" &&
        (!Number.isFinite(restStartedAt) ||
          !Number.isFinite(restCompletedAt) ||
          restStartedAt > restCompletedAt))
    ) {
      errors.push(`P5E_HARVEST_REST:${rest?.name ?? "missing"}`);
    }
    const validatedRecord = record?.fragmentStatus === "validated-rest-bound";
    const expectedEvidenceStepName = rest?.name === "CI"
      ? "Write sanitized terminal gate evidence"
      : rest?.name === "Non-blocking Codex canary / next"
        ? "Write sanitized canary evidence"
        : rest?.name === "Windows integration"
          ? "Write sanitized runner and resource evidence"
          : "Write sanitized runner evidence";
    const expectedFragmentJobName = fragment?.evidenceKind === "terminal-gate"
      ? "CI"
      : {
          "policy-validation": "Policy validation",
          "install-build": "Install and build",
          unit: "Unit tests",
          "core-contract": `Core contract / ${fragment?.lane}`,
          "windows-integration": "Windows integration",
          "claude-lifecycle": `Claude structural lifecycle / ${fragment?.lane}`,
          security: "Security",
          "dependency-review": "Dependency review",
          "next-canary": `Non-blocking Codex canary / ${fragment?.lane}`
        }[fragment?.profile];
    const fragmentStartedAt = Date.parse(fragment?.attempt?.startedAt);
    const fragmentFinishedAt = Date.parse(fragment?.attempt?.finishedAt);
    const integrityStartedAt = Date.parse(rest?.integrityStep?.startedAt);
    const integrityCompletedAt = Date.parse(rest?.integrityStep?.completedAt);
    const evidenceStartedAt = Date.parse(rest?.evidenceStep?.startedAt);
    const evidenceCompletedAt = Date.parse(rest?.evidenceStep?.completedAt);
    const conclusionAgrees =
      (fragment?.attempt?.observedStatus === "non-blocking-canary" &&
        ["success", "failure"].includes(rest?.conclusion)) ||
      (fragment?.attempt?.observedStatus === "executed-pass" &&
        rest?.conclusion === "success") ||
      (fragment?.attempt?.observedStatus === "executed-fail" &&
        rest?.conclusion === "failure");
    if (validatedRecord && hasValidationContext) {
      const fragmentSchema = fragment?.evidenceKind === "terminal-gate"
        ? validationContext.schemas.gate
        : validationContext.schemas.runner;
      const fragmentErrors = [
        ...validateJsonSchema(fragment, fragmentSchema, `harvest:${rest?.name}`),
        ...(fragment?.evidenceKind === "terminal-gate"
          ? validateP5GateEvidence(fragment)
          : validateP5RunnerEvidence(
              fragment,
              validationContext.profiles,
              validationContext.toolchain,
              validationContext.scenarios,
              validationContext.scenarioRegistrySha256
            ))
      ];
      if (fragmentErrors.length > 0) {
        errors.push(`P5E_HARVEST_FRAGMENT_VALIDATION:${rest?.name ?? "missing"}`);
      }
    }
    if (
      validatedRecord !== (fragment !== null) ||
      (validatedRecord &&
        (record?.markerCount !== 1 ||
          !SHA256.test(record?.markerSha256 ?? "") ||
          record?.fragmentSha256 !==
            createHash("sha256").update(JSON.stringify(fragment)).digest("hex") ||
          record?.markerSha256 !== record?.fragmentSha256 ||
          record?.validationErrors?.length !== 0 ||
          rest?.status !== "completed" ||
          rest?.integrityStep?.name !== "Verify clean evidence source" ||
          rest?.integrityStep?.status !== "completed" ||
          rest?.integrityStep?.conclusion !== "success" ||
          rest?.evidenceStep?.name !== expectedEvidenceStepName ||
          rest?.evidenceStep?.status !== "completed" ||
          rest?.evidenceStep?.conclusion !== "success" ||
          rest?.integrityStep?.number >= rest?.evidenceStep?.number ||
          ![
            integrityStartedAt,
            integrityCompletedAt,
            evidenceStartedAt,
            evidenceCompletedAt
          ].every(Number.isFinite) ||
          integrityStartedAt < restStartedAt ||
          integrityStartedAt > integrityCompletedAt ||
          integrityCompletedAt > evidenceStartedAt ||
          evidenceStartedAt > evidenceCompletedAt ||
          evidenceCompletedAt > restCompletedAt + 999 ||
          expectedFragmentJobName !== rest?.name ||
          !conclusionAgrees ||
          fragmentStartedAt < restStartedAt ||
          fragmentFinishedAt > restCompletedAt + 999 ||
          fragment?.provenance?.repository !== harvest?.repository ||
          JSON.stringify(fragment?.provenance?.pullRequest) !==
            JSON.stringify(harvest?.pullRequest) ||
          fragment?.provenance?.workflow?.ref !==
            `${harvest?.repository}/.github/workflows/pull-request-ci.yml@` +
              `refs/pull/${harvest?.pullRequest?.number}/merge` ||
          fragment?.provenance?.run?.id !== rest?.runId ||
          fragment?.provenance?.run?.attempt !== rest?.runAttempt ||
          fragment?.provenance?.run?.checkRunId !== rest?.id ||
          fragment?.provenance?.sourceHeadSha !== harvest?.sourceHeadSha ||
          fragment?.provenance?.eventMergeSha !== harvest?.eventMergeSha ||
          fragment?.provenance?.workflow?.sha !== harvest?.workflowSha ||
          attempt?.rawExitCode !== fragment?.attempt?.rawExitCode ||
          attempt?.rawExitCodeSource !== fragment?.attempt?.rawExitCodeSource ||
          attempt?.runnerObservedStatus !== fragment?.attempt?.observedStatus ||
          attempt?.fragmentAuthority !== "validated-rest-bound")) ||
      (!validatedRecord &&
        (record?.fragmentSha256 !== null ||
          attempt?.rawExitCode !== null ||
          attempt?.rawExitCodeSource !== null ||
          attempt?.runnerObservedStatus !== null ||
          attempt?.fragmentAuthority !== "unavailable"))
    ) {
      errors.push(`P5E_HARVEST_FRAGMENT:${rest?.name ?? "missing"}`);
    }
    if (fullyValidated && !validatedRecord) {
      errors.push(`P5E_HARVEST_COMPLETE:${rest?.name ?? "missing"}`);
    }
  }
  errors.push(...validateP5Privacy(harvest, "hostedHarvest"));
  return errors;
}

const P5_V3_REGISTRY_SOURCE_SHA256 =
  "28781c049eaeebcfe189b360d3f77583843c50ce08cbc073748537e84e9e6aa8";
const P5_V3_REGISTRY_RUNNER_SHA256 =
  "854bb2937f087090ebebf8d03990ff1ee441e18bbcb006743cb29939f61fcb3a";
const P5_V3_NODE_SHA256 =
  "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582";

function p5V3Step([number, name, conclusion]) {
  return { number, name, status: "completed", conclusion };
}

function p5V3Log(
  readbackStatus,
  markerCount,
  failureCodes = [],
  policyTestTotal = null,
  policyTestPassed = null,
  failureObservations = []
) {
  return {
    authority: "read-only-sanitized-log-projection",
    readbackStatus,
    markerCount,
    failureCodes,
    failureObservations,
    policyTestTotal,
    policyTestPassed,
    rawLogsPersisted: false
  };
}

function p5V3JobRunnerToolProjection(imageVersion, powershellVersion = null) {
  return {
    authority: "read-only-job-log-runner-tool-projection",
    requestedLabel: "windows-2025",
    runnerVersion: "2.336.0",
    imageOS: "win25-vs2026",
    imageVersion,
    osCaption: "Microsoft Windows Server 2025 Datacenter",
    osVersion: "10.0.26100",
    osBuild: "26100",
    architecture: "X64",
    powershellVersion,
    powershellObservationStatus:
      powershellVersion === null
        ? "not-observed"
        : "observed-in-sanitized-marker",
    filesystem: powershellVersion === null ? null : "NTFS",
    filesystemObservationStatus:
      powershellVersion === null
        ? "not-observed"
        : "observed-in-sanitized-marker",
    node: "24.18.1",
    npm: "11.16.0",
    nodeExecutableSha256: P5_V3_NODE_SHA256,
    rawLogsPersisted: false,
    hostedGateInput: false
  };
}

function p5V3Job({
  jobName,
  jobKey,
  checkRunId,
  conclusion,
  startedAt,
  completedAt,
  runnerName,
  runnerToolProjection = null,
  steps = [],
  log
}) {
  return {
    jobName,
    jobKey,
    checkRunId,
    status: "completed",
    conclusion,
    startedAt,
    completedAt,
    runnerName,
    runnerToolProjection,
    steps: steps.map(p5V3Step),
    log
  };
}

const P5_V3_DEPENDENCY_STEPS = [
  [1, "Set up job", "success"],
  [2, "Check out repository", "success"],
  [3, "Start profile clock", "success"],
  [4, "Set up Node.js", "success"],
  [5, "Verify exact Node identity", "success"],
  [6, "Review dependency changes", "success"],
  [7, "Verify clean evidence source", "success"],
  [8, "Write sanitized runner evidence", "success"],
  [15, "Post Set up Node.js", "success"],
  [16, "Post Check out repository", "success"],
  [17, "Complete job", "success"]
];
const P5_V3_POLICY_STEPS = [
  [1, "Set up job", "success"],
  [2, "Check out repository", "success"],
  [3, "Start profile clock", "success"],
  [4, "Set up Node.js", "success"],
  [5, "Verify exact Node identity", "success"],
  [6, "Validate P3 baseline", "success"],
  [7, "Validate exact P4 handoff", "success"],
  [8, "Validate P5 profiles", "success"],
  [9, "Run policy tests", "failure"],
  [10, "Verify clean evidence source", "success"],
  [11, "Write sanitized runner evidence", "success"],
  [21, "Post Set up Node.js", "skipped"],
  [22, "Post Check out repository", "success"],
  [23, "Complete job", "success"]
];
const P5_V3_GATE_STEPS = [
  [1, "Set up job", "success"],
  [2, "Check out repository", "success"],
  [3, "Start profile clock", "success"],
  [4, "Set up Node.js", "success"],
  [5, "Verify exact Node identity", "success"],
  [6, "Require every blocking profile", "failure"],
  [7, "Verify clean evidence source", "success"],
  [8, "Write sanitized terminal gate evidence", "success"],
  [15, "Post Set up Node.js", "skipped"],
  [16, "Post Check out repository", "success"],
  [17, "Complete job", "success"]
];

function p5V3SkippedJob(jobName, jobKey, checkRunId, timestamp) {
  return p5V3Job({
    jobName,
    jobKey,
    checkRunId,
    conclusion: "skipped",
    startedAt: timestamp,
    completedAt: timestamp,
    runnerName: null,
    log: p5V3Log("not-applicable-skipped-job", 0)
  });
}

const P5_V3_EXPECTED_JOBS = new Map([
  [
    30643349422,
    [
      p5V3Job({
        jobName: "Policy validation",
        jobKey: "policy-validation",
        checkRunId: 91198526022,
        conclusion: "failure",
        startedAt: "2026-07-31T15:32:56Z",
        completedAt: "2026-07-31T15:33:44Z",
        runnerName: "GitHub Actions 1000002173",
        runnerToolProjection: p5V3JobRunnerToolProjection("20260714.173.1"),
        steps: P5_V3_POLICY_STEPS.map((step) =>
          step[0] === 11 ? [11, step[1], "failure"] : step
        ),
        log: p5V3Log(
          "resolved",
          0,
          [
            "P5E_NODE_IDENTITY"
          ],
          27,
          25,
          [
            "policy-assertion-falsy",
            "runner-evidence-null-fixture-ids"
          ]
        )
      }),
      p5V3Job({
        jobName: "Dependency review",
        jobKey: "dependency-review",
        checkRunId: 91198526087,
        conclusion: "success",
        startedAt: "2026-07-31T15:32:56Z",
        completedAt: "2026-07-31T15:33:32Z",
        runnerName: "GitHub Actions 1000002174",
        runnerToolProjection: p5V3JobRunnerToolProjection(
          "20260728.188.1",
          "7.6.4"
        ),
        steps: P5_V3_DEPENDENCY_STEPS,
        log: p5V3Log("resolved", 1)
      }),
      p5V3Job({
        jobName: "CI",
        jobKey: "gate",
        checkRunId: 91198731832,
        conclusion: "failure",
        startedAt: "2026-07-31T15:33:46Z",
        completedAt: "2026-07-31T15:34:12Z",
        runnerName: "GitHub Actions 1000002175",
        runnerToolProjection: p5V3JobRunnerToolProjection(
          "20260714.173.1",
          "7.6.3"
        ),
        steps: P5_V3_GATE_STEPS,
        log: p5V3Log("resolved", 1, ["P5E_BLOCKING_PROFILE_RESULT"])
      }),
      {
        ...p5V3SkippedJob(
          "Unit tests",
          "unit",
          91198731960,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Install and build",
          "install-build",
          91198732002,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Core contract / ${{ matrix.lane }}",
          "core-contract",
          91198732128,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Security",
          "security",
          91198732193,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Windows integration",
          "windows-integration",
          91198732292,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Claude structural lifecycle / ${{ matrix.lane }}",
          "claude-lifecycle",
          91198732463,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      },
      {
        ...p5V3SkippedJob(
          "Non-blocking Codex canary / ${{ matrix.lane }}",
          "next-canary",
          91198732483,
          "2026-07-31T15:33:45Z"
        ),
        completedAt: "2026-07-31T15:33:44Z"
      }
    ]
  ],
  [
    30660084412,
    [
      p5V3Job({
        jobName: "Dependency review",
        jobKey: "dependency-review",
        checkRunId: 91253973440,
        conclusion: "success",
        startedAt: "2026-07-31T19:41:57Z",
        completedAt: "2026-07-31T19:42:35Z",
        runnerName: "GitHub Actions 1000002189",
        runnerToolProjection: p5V3JobRunnerToolProjection(
          "20260728.188.1",
          "7.6.4"
        ),
        steps: P5_V3_DEPENDENCY_STEPS,
        log: p5V3Log("resolved", 1)
      }),
      p5V3Job({
        jobName: "Policy validation",
        jobKey: "policy-validation",
        checkRunId: 91253973529,
        conclusion: "failure",
        startedAt: "2026-07-31T19:41:59Z",
        completedAt: "2026-07-31T19:42:47Z",
        runnerName: "GitHub Actions 1000002190",
        runnerToolProjection: p5V3JobRunnerToolProjection(
          "20260714.173.1",
          "7.6.3"
        ),
        steps: P5_V3_POLICY_STEPS,
        log: p5V3Log("resolved", 1, ["P5E_NODE_IDENTITY"], 27, 26)
      }),
      p5V3Job({
        jobName: "CI",
        jobKey: "gate",
        checkRunId: 91254158347,
        conclusion: "failure",
        startedAt: "2026-07-31T19:42:51Z",
        completedAt: "2026-07-31T19:43:21Z",
        runnerName: "GitHub Actions 1000002191",
        runnerToolProjection: p5V3JobRunnerToolProjection(
          "20260728.188.1",
          "7.6.4"
        ),
        steps: P5_V3_GATE_STEPS,
        log: p5V3Log("resolved", 1, ["P5E_BLOCKING_PROFILE_RESULT"])
      }),
      p5V3SkippedJob(
        "Install and build",
        "install-build",
        91254158472,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Security",
        "security",
        91254158599,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Claude structural lifecycle / ${{ matrix.lane }}",
        "claude-lifecycle",
        91254158746,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Windows integration",
        "windows-integration",
        91254158821,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Non-blocking Codex canary / ${{ matrix.lane }}",
        "next-canary",
        91254158947,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Unit tests",
        "unit",
        91254158974,
        "2026-07-31T19:42:48Z"
      ),
      p5V3SkippedJob(
        "Core contract / ${{ matrix.lane }}",
        "core-contract",
        91254159050,
        "2026-07-31T19:42:48Z"
      )
    ]
  ]
]);

function p5V3RunnerProjection({
  imageVersion,
  powershellVersion,
  startedAt,
  finishedAt,
  wallTimeMs,
  rawExitCode,
  observedStatus,
  hostedGateInput
}) {
  return {
    authority: "read-only-sanitized-log-projection",
    imageOS: "win25-vs2026",
    imageVersion,
    osCaption: "Microsoft Windows Server 2025 Datacenter",
    osVersion: "10.0.26100",
    osBuild: "26100",
    architecture: "X64",
    powershellVersion,
    filesystem: "NTFS",
    node: "24.18.1",
    npm: "11.16.0",
    nodeExecutableSha256: P5_V3_NODE_SHA256,
    runnerVersion: "2.336.0",
    startedAt,
    finishedAt,
    wallTimeMs,
    rawExitCode,
    observedStatus,
    rawLogsPersisted: false,
    hostedGateInput
  };
}

function p5V3Fragment({
  jobName,
  jobKey,
  checkRunId,
  conclusion,
  markerSha256,
  fragmentStatus,
  observedRegistrySha256,
  expectedRegistrySha256,
  validationErrorCodes,
  projection
}) {
  return {
    jobName,
    jobKey,
    checkRunId,
    conclusion,
    markerCount: 1,
    markerSha256,
    fragmentStatus,
    restBindingStatus: "validated",
    observedRegistrySha256,
    expectedRegistrySha256,
    validationErrorCodes,
    releaseTrustInput: false,
    sanitizedLogProjection: projection
  };
}

const P5_V3_EXPECTED_OBSERVATIONS = [
  {
    repository: "wotjr1649/codex-conductor-cc",
    pullRequestNumber: 2,
    runId: 30643349422,
    runNumber: 2,
    runAttempt: 1,
    rerunCount: 0,
    automaticRetryCount: null,
    event: "pull_request",
    runUrl:
      "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/30643349422",
    sourceHeadSha: "4eeeb17b0ca3f2c248e7523dc65bddd69ca26f07",
    eventMergeSha: "de9c7dfc766716f53aa2dcc3c417d33fcb557bf2",
    workflowSha: "de9c7dfc766716f53aa2dcc3c417d33fcb557bf2",
    baseSha: "84515289913dfe8a7452754ad442d37873bdfd53",
    checkSuiteId: 83100676283,
    runStartedAt: "2026-07-31T15:32:54Z",
    runCompletedAt: "2026-07-31T15:34:13Z",
    conclusion: "failure",
    expectedLogicalJobCount: 12,
    observedRestJobCount: 10,
    placeholderJobCount: 3,
    collectionStatus: "incomplete-or-invalid",
    collectionIssues: [
      {
        code: "P5E_COLLECT_JOB_SET",
        jobKey: null,
        stepName: null,
        count: 1
      },
      {
        code: "P5E_RUNNER_EVIDENCE_IDENTITY",
        jobKey: "dependency-review",
        stepName: "Write sanitized runner evidence",
        count: 1
      },
      {
        code: "P5E_COLLECT_STEP",
        jobKey: null,
        stepName: "Write sanitized runner evidence",
        count: 5
      }
    ],
    jobObservations: P5_V3_EXPECTED_JOBS.get(30643349422),
    validatedFragments: [
      p5V3Fragment({
        jobName: "CI",
        jobKey: "gate",
        checkRunId: 91198731832,
        conclusion: "failure",
        markerSha256:
          "8813a43e28df050ac7b3b6a089e1998f30b783c32cd54bb049b7cd513fdb5450",
        fragmentStatus: "validated-rest-bound",
        observedRegistrySha256: null,
        expectedRegistrySha256: null,
        validationErrorCodes: [],
        projection: p5V3RunnerProjection({
          imageVersion: "20260714.173.1",
          powershellVersion: "7.6.3",
          startedAt: "2026-07-31T15:33:57.7579972+00:00",
          finishedAt: "2026-07-31T15:34:09.6007735+00:00",
          wallTimeMs: 11843,
          rawExitCode: 1,
          observedStatus: "executed-fail",
          hostedGateInput: true
        })
      })
    ],
    rejectedFragments: [
      p5V3Fragment({
        jobName: "Dependency review",
        jobKey: "dependency-review",
        checkRunId: 91198526087,
        conclusion: "success",
        markerSha256:
          "5d7f57ad58da0370160fdaad4ac2c2431803baf7235bf6c481a808cd984379d6",
        fragmentStatus: "rejected-untrusted-fragment",
        observedRegistrySha256: P5_V3_REGISTRY_RUNNER_SHA256,
        expectedRegistrySha256: P5_V3_REGISTRY_SOURCE_SHA256,
        validationErrorCodes: ["P5E_RUNNER_EVIDENCE_IDENTITY"],
        projection: p5V3RunnerProjection({
          imageVersion: "20260728.188.1",
          powershellVersion: "7.6.4",
          startedAt: "2026-07-31T15:33:08.9061482+00:00",
          finishedAt: "2026-07-31T15:33:28.6664146+00:00",
          wallTimeMs: 19760,
          rawExitCode: 0,
          observedStatus: "executed-pass",
          hostedGateInput: false
        })
      })
    ],
    artifacts: {
      authority: "run-artifacts-rest-readback",
      endpoint:
        "repos/wotjr1649/codex-conductor-cc/actions/runs/30643349422/artifacts",
      observedAt: "2026-08-01T00:05:36Z",
      readbackStatus: "resolved",
      observedCount: 0,
      entries: [],
      releaseTrustInput: false
    }
  },
  {
    repository: "wotjr1649/codex-conductor-cc",
    pullRequestNumber: 2,
    runId: 30660084412,
    runNumber: 3,
    runAttempt: 1,
    rerunCount: 0,
    automaticRetryCount: null,
    event: "pull_request",
    runUrl:
      "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/30660084412",
    sourceHeadSha: "9d2422c4cdf1156008f7dbc744f1ebc4171febe5",
    eventMergeSha: "7a84c7cfd45c9f8f8f74fb5ac2106dec8d0904f7",
    workflowSha: "7a84c7cfd45c9f8f8f74fb5ac2106dec8d0904f7",
    baseSha: "84515289913dfe8a7452754ad442d37873bdfd53",
    checkSuiteId: 83150548208,
    runStartedAt: "2026-07-31T19:41:53Z",
    runCompletedAt: "2026-07-31T19:43:22Z",
    conclusion: "failure",
    expectedLogicalJobCount: 12,
    observedRestJobCount: 10,
    placeholderJobCount: 3,
    collectionStatus: "incomplete-or-invalid",
    collectionIssues: [
      {
        code: "P5E_COLLECT_JOB_SET",
        jobKey: null,
        stepName: null,
        count: 1
      },
      {
        code: "P5E_RUNNER_EVIDENCE_IDENTITY",
        jobKey: null,
        stepName: "Write sanitized runner evidence",
        count: 2
      },
      {
        code: "P5E_COLLECT_STEP",
        jobKey: null,
        stepName: "Write sanitized runner evidence",
        count: 4
      }
    ],
    jobObservations: P5_V3_EXPECTED_JOBS.get(30660084412),
    validatedFragments: [
      p5V3Fragment({
        jobName: "CI",
        jobKey: "gate",
        checkRunId: 91254158347,
        conclusion: "failure",
        markerSha256:
          "506478994bf35af69f35746a4511f8b6b551e8a409ee0c0de78c5ecac10b7f28",
        fragmentStatus: "validated-rest-bound",
        observedRegistrySha256: null,
        expectedRegistrySha256: null,
        validationErrorCodes: [],
        projection: p5V3RunnerProjection({
          imageVersion: "20260728.188.1",
          powershellVersion: "7.6.4",
          startedAt: "2026-07-31T19:43:02.4047291+00:00",
          finishedAt: "2026-07-31T19:43:16.5340099+00:00",
          wallTimeMs: 14129,
          rawExitCode: 1,
          observedStatus: "executed-fail",
          hostedGateInput: true
        })
      })
    ],
    rejectedFragments: [
      p5V3Fragment({
        jobName: "Dependency review",
        jobKey: "dependency-review",
        checkRunId: 91253973440,
        conclusion: "success",
        markerSha256:
          "60c6a64ffdb6d645fddce8b4d20d7cea43d9f21872c10a785da226fbb1fae8ff",
        fragmentStatus: "rejected-untrusted-fragment",
        observedRegistrySha256: P5_V3_REGISTRY_RUNNER_SHA256,
        expectedRegistrySha256: P5_V3_REGISTRY_SOURCE_SHA256,
        validationErrorCodes: ["P5E_RUNNER_EVIDENCE_IDENTITY"],
        projection: p5V3RunnerProjection({
          imageVersion: "20260728.188.1",
          powershellVersion: "7.6.4",
          startedAt: "2026-07-31T19:42:10.3332473+00:00",
          finishedAt: "2026-07-31T19:42:32.0375404+00:00",
          wallTimeMs: 21704,
          rawExitCode: 0,
          observedStatus: "executed-pass",
          hostedGateInput: false
        })
      }),
      p5V3Fragment({
        jobName: "Policy validation",
        jobKey: "policy-validation",
        checkRunId: 91253973529,
        conclusion: "failure",
        markerSha256:
          "db9f0476c091dec2dd1a6fe0077423279274a36580284ecf0e121196cfe58897",
        fragmentStatus: "rejected-untrusted-fragment",
        observedRegistrySha256: P5_V3_REGISTRY_RUNNER_SHA256,
        expectedRegistrySha256: P5_V3_REGISTRY_SOURCE_SHA256,
        validationErrorCodes: ["P5E_RUNNER_EVIDENCE_IDENTITY"],
        projection: p5V3RunnerProjection({
          imageVersion: "20260714.173.1",
          powershellVersion: "7.6.3",
          startedAt: "2026-07-31T19:42:09.1630521+00:00",
          finishedAt: "2026-07-31T19:42:43.9815676+00:00",
          wallTimeMs: 34819,
          rawExitCode: 1,
          observedStatus: "executed-fail",
          hostedGateInput: false
        })
      })
    ],
    artifacts: {
      authority: "run-artifacts-rest-readback",
      endpoint:
        "repos/wotjr1649/codex-conductor-cc/actions/runs/30660084412/artifacts",
      observedAt: "2026-08-01T00:05:36Z",
      readbackStatus: "resolved",
      observedCount: 0,
      entries: [],
      releaseTrustInput: false
    }
  }
];

const P5_V3_EXPECTED_CACHE = {
  authority: "actions-cache-rest-readback",
  endpoint:
    "repos/wotjr1649/codex-conductor-cc/actions/caches?ref=refs/pull/2/merge",
  ref: "refs/pull/2/merge",
  mergeSha: "7a84c7cfd45c9f8f8f74fb5ac2106dec8d0904f7",
  observedAt: "2026-08-01T00:05:36Z",
  readbackStatus: "resolved",
  matchingRefCacheCount: 0,
  entries: [],
  inventorySha256:
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  executionWindowAttribution: "not-observed",
  releaseTrustInput: false
};

const P5_V3_REMEDIATION_RUNS = [
  {
    runId: 31003825837,
    runNumber: 4,
    sourceHeadSha: "5475e3e2bccc9af6e10079da5d355b4dab88b3e5",
    digest: "226dbb7a4d9b8bf2727b42d688af1ac608edca9f7ba5ae81f70b580caf944fa1"
  },
  {
    runId: 31027289099,
    runNumber: 5,
    sourceHeadSha: "748d6181e30f642930bc13f4f9a718a1f366dd27",
    digest: "8c7a6955d040431e6e9c3ee0341cc67dddc3d25cb3bd38b0bef13514c1c6e7ec"
  },
  {
    runId: 31060819525,
    runNumber: 6,
    sourceHeadSha: "4190a2ba59637dcdbe3f32be0edc019483496620",
    digest: "82433eea5afe5fa3a72eb91edc07118a4c9abb7a1eba449bded7d99a4c68697d"
  }
];

function p5V3ObservationDigest(observation) {
  return createHash("sha256")
    .update(JSON.stringify(observation))
    .digest("hex");
}

export function validateP5Evidence(manifest, profileRegistry) {
  const errors = [];
  const localOnly = manifest?.schemaVersion === "p5-evidence-v1";
  const hostedFailureV2 = manifest?.schemaVersion === "p5-evidence-v2";
  const hostedV3 = manifest?.schemaVersion === "p5-evidence-v3";
  const hostedV3Historical =
    hostedV3 && manifest?.hostedObservations?.length === 2;
  const hostedV3Closure =
    hostedV3 && manifest?.hostedObservations?.length === 6;
  const hostedObserved = hostedFailureV2 || hostedV3;
  if (!localOnly && !hostedObserved) {
    errors.push(
      `P5E_EVIDENCE_SCHEMA_VERSION:${manifest?.schemaVersion ?? "missing"}`
    );
  }
  if (
    (!localOnly && !hostedObserved) ||
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
    const expectedHostedStatus = hostedV3Closure
      ? "hosted-pass"
      : hostedObserved
        ? id === "policy-validation"
        ? "executed-fail"
        : "skipped"
        : "not-run";
    if (
      result?.localStatus !== "local-pass" ||
      result?.hostedStatus !== expectedHostedStatus
    ) {
      errors.push(`P5E_LOCAL_HOSTED_TRUTH:${id}`);
    }
  }
  const dependency = actual.get("dependency-review");
  if (
    dependency?.localStatus !== "not-applicable" ||
    dependency?.hostedStatus !== (hostedObserved ? "hosted-pass" : "not-run")
  ) {
    errors.push("P5E_DEPENDENCY_TRUTH: hosted dependency result differs from the bound attempt");
  }
  const canary = actual.get("next-canary");
  if (
    canary?.blocking !== false ||
    canary?.localStatus !== "not-run" ||
    canary?.hostedStatus !==
      (hostedV3Closure
        ? "non-blocking-canary"
        : hostedObserved
          ? "skipped"
          : "not-run") ||
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
  if (localOnly) {
    if (
      manifest.remoteExecution !== "not-run" ||
      manifest.hostedRunner?.imageVersion !== null ||
      manifest.hostedRunner?.osBuild !== null ||
      manifest.hostedRunner?.filesystem !== null
    ) {
      errors.push("P5E_HOSTED_EVIDENCE_MISSING: YAML definition is not a hosted run");
    }
  }
  if (hostedFailureV2) {
    const observation = manifest.hostedObservation;
    const expectedCollectionErrors = [
      "P5E_COLLECT_JOB_SET: exact attempt allocation set differs",
      ...Array(5).fill("P5E_COLLECT_STEP: exact successful evidence step is absent")
    ];
    const expectedFragments = [
      {
        jobName: "Dependency review",
        jobKey: "dependency-review",
        checkRunId: 91198526087,
        conclusion: "success",
        markerSha256:
          "5d7f57ad58da0370160fdaad4ac2c2431803baf7235bf6c481a808cd984379d6",
        imageOS: "win25-vs2026",
        imageVersion: "20260728.188.1",
        osCaption: "Microsoft Windows Server 2025 Datacenter",
        osVersion: "10.0.26100",
        osBuild: "26100",
        architecture: "X64",
        powershellVersion: "7.6.4",
        filesystem: "NTFS",
        node: "24.18.1",
        npm: "11.16.0",
        nodeExecutableSha256:
          "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582",
        startedAt: "2026-07-31T15:33:08.9061482+00:00",
        finishedAt: "2026-07-31T15:33:28.6664146+00:00",
        wallTimeMs: 19760
      },
      {
        jobName: "CI",
        jobKey: "gate",
        checkRunId: 91198731832,
        conclusion: "failure",
        markerSha256:
          "8813a43e28df050ac7b3b6a089e1998f30b783c32cd54bb049b7cd513fdb5450",
        imageOS: "win25-vs2026",
        imageVersion: "20260714.173.1",
        osCaption: "Microsoft Windows Server 2025 Datacenter",
        osVersion: "10.0.26100",
        osBuild: "26100",
        architecture: "X64",
        powershellVersion: "7.6.3",
        filesystem: "NTFS",
        node: "24.18.1",
        npm: "11.16.0",
        nodeExecutableSha256:
          "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582",
        startedAt: "2026-07-31T15:33:57.7579972+00:00",
        finishedAt: "2026-07-31T15:34:09.6007735+00:00",
        wallTimeMs: 11843
      }
    ];
    const expectedRemoteEvidenceIds = new Map([
      [
        "policy-validation",
        [
          "p5-p3-validator",
          "p5-p4-validator-at-handoff",
          "p5-targeted",
          "p5-hosted-run-30643349422-attempt-1"
        ]
      ],
      ["dependency-review", ["p5-hosted-dependency-91198526087"]],
      ["next-canary", []]
    ]);
    const remoteEvidenceIdsDiffer = [...expectedRemoteEvidenceIds].some(
      ([profileId, evidenceIds]) =>
        JSON.stringify(actual.get(profileId)?.evidenceIds) !== JSON.stringify(evidenceIds)
    );
    if (
      manifest.overallStatus !== "blocked" ||
      manifest.hostedGateStatus !== "executed-fail" ||
      manifest.remoteExecution !== "executed-fail" ||
      manifest.hostedRunner?.requestedLabel !== "windows-2025" ||
      manifest.hostedRunner?.imageVersion !== "20260714.173.1" ||
      manifest.hostedRunner?.osBuild !== "26100" ||
      manifest.hostedRunner?.architecture !== "X64" ||
      manifest.hostedRunner?.filesystem !== "NTFS" ||
      manifest.hostedRunner?.executionStatus !== "executed-fail" ||
      manifest.hostedRunner?.evidenceRole !== "terminal-gate-runner" ||
      observation?.repository !== "wotjr1649/codex-conductor-cc" ||
      observation?.pullRequestNumber !== 2 ||
      observation?.runId !== 30643349422 ||
      observation?.runAttempt !== 1 ||
      observation?.rerunCount !== 0 ||
      observation?.event !== "pull_request" ||
      observation?.runUrl !==
        "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/30643349422" ||
      observation?.sourceHeadSha !== "4eeeb17b0ca3f2c248e7523dc65bddd69ca26f07" ||
      observation?.eventMergeSha !== "de9c7dfc766716f53aa2dcc3c417d33fcb557bf2" ||
      observation?.workflowSha !== "de9c7dfc766716f53aa2dcc3c417d33fcb557bf2" ||
      observation?.baseSha !== "84515289913dfe8a7452754ad442d37873bdfd53" ||
      observation?.conclusion !== "failure" ||
      observation?.expectedLogicalJobCount !== 12 ||
      observation?.observedRestJobCount !== 10 ||
      observation?.placeholderJobCount !== 3 ||
      observation?.collectionStatus !== "incomplete-or-invalid" ||
      JSON.stringify(observation?.collectionErrors) !==
        JSON.stringify(expectedCollectionErrors) ||
      JSON.stringify(observation?.validatedFragments) !==
        JSON.stringify(expectedFragments) ||
      remoteEvidenceIdsDiffer ||
      observation?.artifacts?.readbackStatus !== "resolved" ||
      observation?.artifacts?.observedCount !== 0 ||
      observation?.artifacts?.releaseTrustInput !== false ||
      observation?.cache?.readbackStatus !== "resolved" ||
      observation?.cache?.observedCount !== 0 ||
      observation?.cache?.releaseTrustInput !== false
    ) {
      errors.push("P5E_HOSTED_FAILURE_BINDING: exact failed attempt 1 evidence is required");
    }
  }
  if (hostedV3) {
    const expectedEvidenceIds = new Map([
      [
        "policy-validation",
        [
          "p5-p3-validator",
          "p5-p4-validator-at-handoff",
          "p5-targeted",
          "p5-hosted-run-30643349422-attempt-1",
          "p5-hosted-run-30660084412-attempt-1"
        ]
      ],
      [
        "install-build",
        [
          "p5-npm-ci",
          "p5-build",
          "p5-hosted-skip-91198732002",
          "p5-hosted-skip-91254158472"
        ]
      ],
      [
        "unit",
        [
          "p5-full-regression",
          "p5-hosted-skip-91198731960",
          "p5-hosted-skip-91254158974"
        ]
      ],
      [
        "core-contract",
        [
          "p5-p4-targeted",
          "p5-codex-current-lifecycle",
          "p5-codex-previous-lifecycle",
          "p5-hosted-placeholder-91198732128",
          "p5-hosted-placeholder-91254159050"
        ]
      ],
      [
        "windows-integration",
        [
          "p5-windows-resource",
          "p5-full-regression",
          "p5-hosted-skip-91198732292",
          "p5-hosted-skip-91254158821"
        ]
      ],
      [
        "claude-lifecycle",
        [
          "p5-claude-minimum",
          "p5-claude-current",
          "p5-hosted-placeholder-91198732463",
          "p5-hosted-placeholder-91254158746"
        ]
      ],
      [
        "security",
        [
          "p5-actionlint",
          "p5-zizmor",
          "p5-osv",
          "p5-gitleaks",
          "p5-hosted-skip-91198732193",
          "p5-hosted-skip-91254158599"
        ]
      ],
      [
        "dependency-review",
        [
          "p5-hosted-dependency-job-91198526087",
          "p5-hosted-dependency-job-91253973440"
        ]
      ],
      [
        "next-canary",
        [
          "p5-hosted-placeholder-91198732483",
          "p5-hosted-placeholder-91254158947"
        ]
      ],
      ["windows-c0", ["P5-C0-BLOCKED"]],
      ["state-d1", ["P5-D1-BLOCKED"]]
    ]);
    const observations = Array.isArray(manifest.hostedObservations)
      ? manifest.hostedObservations
      : [];

    if (hostedV3Historical) {
      if (
        manifest.overallStatus !== "blocked" ||
        manifest.hostedGateStatus !== "executed-fail" ||
        manifest.remoteExecution !== "executed-fail"
      ) {
        errors.push(
          "P5E_HOSTED_V3_GATE: two failed hosted attempts must remain blocking"
        );
      }
      if (!isDeepStrictEqual(observations, P5_V3_EXPECTED_OBSERVATIONS)) {
        errors.push(
          "P5E_HOSTED_V3_BINDING: exact ordered run, job, step, log, artifact, and fragment observations are required"
        );
      }
      if (
        !isDeepStrictEqual(manifest.prRefCacheObservation, P5_V3_EXPECTED_CACHE)
      ) {
        errors.push(
          "P5E_HOSTED_V3_CACHE: the mutable PR-ref cache snapshot must remain run-unattributed"
        );
      }
    } else if (hostedV3Closure) {
      for (const observation of observations.slice(2)) {
        for (const fragment of observation?.validatedFragments ?? []) {
          const evidenceIds = expectedEvidenceIds.get(fragment?.jobKey);
          if (evidenceIds) {
            evidenceIds.push(`p5-hosted-fragment-${fragment.checkRunId}`);
          }
        }
      }

      if (
        manifest.overallStatus !== "hosted-complete" ||
        manifest.hostedGateStatus !== "hosted-pass" ||
        manifest.remoteExecution !== "executed-pass" ||
        BLOCKING_JOBS.some(
          (profileId) => actual.get(profileId)?.hostedStatus !== "hosted-pass"
        ) ||
        actual.get("next-canary")?.hostedStatus !== "non-blocking-canary"
      ) {
        errors.push(
          "P5E_HOSTED_V3_GATE: exact successful hosted closure is required"
        );
      }

      const historicalPrefixValid = isDeepStrictEqual(
        observations.slice(0, 2),
        P5_V3_EXPECTED_OBSERVATIONS
      );
      const remediationRunsValid = P5_V3_REMEDIATION_RUNS.every(
        (expected, index) => {
          const observation = observations[index + 2];
          return (
            observation?.runId === expected.runId &&
            observation?.runNumber === expected.runNumber &&
            observation?.runAttempt === 1 &&
            observation?.rerunCount === 0 &&
            observation?.sourceHeadSha === expected.sourceHeadSha &&
            observation?.conclusion === "failure" &&
            p5V3ObservationDigest(observation) === expected.digest
          );
        }
      );
      const finalObservation = observations[5];
      const finalJobs = Array.isArray(finalObservation?.jobObservations)
        ? finalObservation.jobObservations
        : [];
      const finalFragments = Array.isArray(finalObservation?.validatedFragments)
        ? finalObservation.validatedFragments
        : [];
      const finalJobNames = finalJobs.map((job) => job?.jobName);
      const finalJobIds = finalJobs.map((job) => job?.checkRunId);
      const finalFragmentIds = finalFragments.map(
        (fragment) => fragment?.checkRunId
      );
      const finalJobsValid =
        includesExactSet(finalJobNames, EXPECTED_HOSTED_JOB_NAMES) &&
        finalJobIds.length === new Set(finalJobIds).size &&
        finalJobs.every(
          (job) =>
            job?.status === "completed" &&
            job?.conclusion === "success" &&
            job?.jobKey === EXPECTED_HOSTED_JOB_KEYS.get(job?.jobName) &&
            job?.runnerToolProjection?.node === "24.18.1" &&
            job?.runnerToolProjection?.npm === "11.16.0" &&
            job?.runnerToolProjection?.nodeExecutableSha256 ===
              P5_V3_NODE_SHA256 &&
            job?.runnerToolProjection?.rawLogsPersisted === false &&
            job?.log?.markerCount === 1 &&
            job?.log?.rawLogsPersisted === false
        );
      const finalBindingValid =
        finalObservation?.runNumber === 7 &&
        finalObservation?.runAttempt === 1 &&
        finalObservation?.rerunCount === 0 &&
        finalObservation?.automaticRetryCount === null &&
        finalObservation?.sourceHeadSha === manifest.source?.sourceCommit &&
        finalObservation?.workflowSha === finalObservation?.eventMergeSha &&
        finalObservation?.conclusion === "success" &&
        finalObservation?.expectedLogicalJobCount === 12 &&
        finalObservation?.observedRestJobCount === 12 &&
        finalObservation?.placeholderJobCount === 0 &&
        finalObservation?.collectionStatus === "validated" &&
        isDeepStrictEqual(finalObservation?.collectionIssues, []) &&
        finalJobsValid &&
        finalFragments.length === 12 &&
        finalFragmentIds.length === new Set(finalFragmentIds).size &&
        finalObservation?.rejectedFragments?.length === 0 &&
        finalObservation?.artifacts?.readbackStatus === "resolved" &&
        finalObservation?.artifacts?.observedCount === 0 &&
        finalObservation?.artifacts?.entries?.length === 0 &&
        finalObservation?.artifacts?.releaseTrustInput === false &&
        new Set(observations.map((observation) => observation?.runId)).size ===
          6 &&
        isDeepStrictEqual(
          observations.map((observation) => observation?.runNumber),
          [2, 3, 4, 5, 6, 7]
        );

      if (!historicalPrefixValid || !remediationRunsValid || !finalBindingValid) {
        errors.push(
          "P5E_HOSTED_V3_BINDING: exact historical, remediation, and successful final observations are required"
        );
      }

      const finalTrustInvalid =
        finalFragments.some((fragment) => {
          const job = finalJobs.find(
            (candidate) => candidate?.checkRunId === fragment?.checkRunId
          );
          const canary = fragment?.jobKey === "next-canary";
          return (
            fragment?.fragmentStatus !== "validated-rest-bound" ||
            fragment?.restBindingStatus !== "validated" ||
            fragment?.validationErrorCodes?.length !== 0 ||
            fragment?.releaseTrustInput !== false ||
            fragment?.jobName !== job?.jobName ||
            fragment?.jobKey !== job?.jobKey ||
            fragment?.conclusion !== job?.conclusion ||
            fragment?.sanitizedLogProjection?.observedStatus !==
              (canary ? "non-blocking-canary" : "executed-pass") ||
            fragment?.sanitizedLogProjection?.rawExitCode !== 0 ||
            fragment?.sanitizedLogProjection?.rawLogsPersisted !== false ||
            fragment?.sanitizedLogProjection?.hostedGateInput !== !canary
          );
        }) || !isDeepStrictEqual([...finalFragmentIds].sort(), [...finalJobIds].sort());
      if (finalTrustInvalid) {
        errors.push(
          "P5E_HOSTED_V3_TRUST_BOUNDARY: every final fragment must remain REST-bound and canary input non-authoritative"
        );
      }

      const cache = manifest.prRefCacheObservation;
      if (
        cache?.mergeSha !== finalObservation?.eventMergeSha ||
        cache?.readbackStatus !== "resolved" ||
        cache?.matchingRefCacheCount !== 0 ||
        cache?.entries?.length !== 0 ||
        cache?.inventorySha256 !==
          "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" ||
        cache?.executionWindowAttribution !== "not-observed" ||
        cache?.releaseTrustInput !== false
      ) {
        errors.push(
          "P5E_HOSTED_V3_CACHE: final mutable PR-ref cache readback must bind the successful merge"
        );
      }
    } else {
      errors.push(
        "P5E_HOSTED_V3_BINDING: only the exact two-run history or six-run closure is accepted"
      );
    }

    const evidenceIdsDiffer = [...expectedEvidenceIds].some(
      ([profileId, evidenceIds]) =>
        !isDeepStrictEqual(actual.get(profileId)?.evidenceIds, evidenceIds)
    );
    if (evidenceIdsDiffer) {
      errors.push(
        "P5E_HOSTED_V3_PROFILE_EVIDENCE: hosted observations must remain linked only through REST-bound fragments"
      );
    }

    if (hostedV3Historical) {
      for (const observation of observations) {
        const validated = observation?.validatedFragments ?? [];
        const rejected = observation?.rejectedFragments ?? [];
        const validatedIds = new Set(
          validated.map((fragment) => fragment?.checkRunId)
        );
        if (
          validated.some(
            (fragment) =>
              fragment?.fragmentStatus !== "validated-rest-bound" ||
              fragment?.jobKey !== "gate" ||
              fragment?.validationErrorCodes?.length !== 0 ||
              fragment?.sanitizedLogProjection?.hostedGateInput !== true
          ) ||
          rejected.some(
            (fragment) =>
              validatedIds.has(fragment?.checkRunId) ||
              fragment?.fragmentStatus !== "rejected-untrusted-fragment" ||
              fragment?.validationErrorCodes?.[0] !==
                "P5E_RUNNER_EVIDENCE_IDENTITY" ||
              fragment?.releaseTrustInput !== false ||
              fragment?.sanitizedLogProjection?.hostedGateInput !== false
          )
        ) {
          errors.push(
            "P5E_HOSTED_V3_TRUST_BOUNDARY: rejected runner projections cannot become hosted gate inputs"
          );
        }
      }
    }
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
      const hostedFailureStatus =
        hostedObserved &&
        status === result.hostedStatus &&
        ["executed-fail", "skipped"].includes(status);
      if (
        status !== "not-applicable" &&
        !hostedFailureStatus &&
        !allowedStatuses.get(result.profileId)?.has(status)
      ) {
        errors.push(`P5E_STATUS_ENUM:${result.profileId}:${status}`);
      }
    }
  }
  errors.push(...validateP5Privacy(manifest, "p5Evidence"));
  return errors;
}
