import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateAttemptLedger,
  validateP5Evidence,
  validateP5GateEvidence,
  validateP5HostedHarvest,
  validateP5Privacy,
  validateP5RestJobBinding,
  validateP5RunnerEvidence,
  validateP5Workflow,
  isP5AllowedPath,
  validateProfileRegistry,
  validateScenarioRegistry
} from "../scripts/lib/p5-validation.mjs";
import { validateJsonSchema } from "../scripts/lib/p4-schema-validator.mjs";
import { extractP5StepMarkers } from "../scripts/run-p5-hosted-evidence-collector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

const toolchain = readJson("toolchain.json");
const profiles = readJson("ci/matrix-profiles-v1.json");
const scenarios = readJson("ci/scenario-registry-v1.json");
const scenarioRegistrySha256 = createHash("sha256")
  .update(readFileSync(path.join(root, "ci", "scenario-registry-v1.json")))
  .digest("hex");
const runnerEvidenceSchema = readJson("evidence/schemas/p5-runner-evidence-v2.schema.json");
const gateEvidenceSchema = readJson("evidence/schemas/p5-gate-evidence-v1.schema.json");
const hostedHarvestSchema = readJson("evidence/schemas/p5-hosted-harvest-v1.schema.json");
const p5EvidenceSchemas = new Map([
  ["p5-evidence-v1", readJson("evidence/schemas/p5-evidence-v1.schema.json")],
  ["p5-evidence-v2", readJson("evidence/schemas/p5-evidence-v2.schema.json")],
  ["p5-evidence-v3", readJson("evidence/schemas/p5-evidence-v3.schema.json")]
]);
const gitAttributes = readFileSync(path.join(root, ".gitattributes"), "utf8")
  .replace(/\r\n/g, "\n");
const workflow = readFileSync(
  path.join(root, ".github", "workflows", "pull-request-ci.yml"),
  "utf8"
).replace(/\r\n/g, "\n");
const runnerWriter = readFileSync(
  path.join(root, "scripts", "write-p5-runner-evidence.ps1"),
  "utf8"
);
const provenanceModule = readFileSync(
  path.join(root, "scripts", "lib", "p5-runner-provenance.psm1"),
  "utf8"
);
const nodeIdentityScript = readFileSync(
  path.join(root, "scripts", "run-p5-node-identity.ps1"),
  "utf8"
);

const exactBootstrapFixture = {
  boundSource: "4ad56ea41a479cae0950bce817760455d5fb87fc",
  evidenceRebindParents: ["4ad56ea41a479cae0950bce817760455d5fb87fc"],
  windowsFixParents: ["5475e3e2bccc9af6e10079da5d355b4dab88b3e5"],
  headParents: ["748d6181e30f642930bc13f4f9a718a1f366dd27"],
  evidenceRebindPaths: [
    "docs/baselines/2026-07-31-p5-matrix-profile-bootstrap.md",
    "evidence/ledgers/p5-attempts.json",
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json"
  ],
  windowsFixPaths: [
    "scripts/lib/p5-runner-provenance.psm1",
    "scripts/write-p5-runner-evidence.ps1",
    "tests/p5-matrix-profile.test.mjs"
  ],
  policyPaths: [
    "evidence/schemas/p5-evidence-v3.schema.json",
    "scripts/lib/p5-validation.mjs",
    "scripts/validate-p5.mjs",
    "tests/p5-matrix-profile.test.mjs"
  ],
  uncommittedPaths: []
};

function hostedProvenance(jobKey, checkRunId) {
  return {
    repository: "wotjr1649/codex-conductor-cc",
    workflow: {
      name: "Pull Request CI",
      ref: "wotjr1649/codex-conductor-cc/.github/workflows/pull-request-ci.yml@refs/pull/7/merge",
      sha: "3".repeat(40)
    },
    pullRequest: {
      number: 7,
      baseRepository: "wotjr1649/codex-conductor-cc",
      baseRef: "codex/p4-contract-baseline",
      baseSha: "1".repeat(40),
      headRepository: "wotjr1649/codex-conductor-cc",
      headRef: "codex/p5-matrix-profile-bootstrap",
      headSha: "2".repeat(40)
    },
    sourceHeadSha: "2".repeat(40),
    eventMergeSha: "4".repeat(40),
    actualCheckoutSha: "4".repeat(40),
    executionClass: "hosted",
    run: { id: 9001, attempt: 1, yamlJobKey: jobKey, checkRunId },
    runner: {
      requestedLabel: "windows-2025",
      environment: "github-hosted",
      os: "Windows",
      architecture: "X64",
      imageOS: "win25",
      imageVersion: "20260720.1.0",
      osCaption: "Microsoft Windows Server 2025 Datacenter",
      osVersion: "10.0.26100",
      osBuild: "26100",
      osArchitecture: "64-bit",
      productType: 3,
      powershellVersion: "7.5.2",
      filesystem: "NTFS",
      storageClass: {
        value: "github-hosted-ephemeral-runner-temp",
        basis: "runner-environment-and-documented-hosted-semantics"
      }
    }
  };
}

function partialAttempt(observedStatus = "executed-pass") {
  return {
    trial: 1,
    runAttempt: 1,
    jobAttempt: null,
    restJobId: null,
    workflowRerunCount: null,
    automaticRetryCount: null,
    timeout: null,
    authority: "runner-self-observed-partial",
    restConsolidationStatus: "pending-post-run-attempt-jobs",
    rawExitCode: observedStatus === "executed-pass" ? 0 : 1,
    rawExitCodeSource: "github-job-status-normalized",
    startedAt: "2026-07-31T12:00:00.000Z",
    startedAtSource: "profile-clock",
    finishedAt: "2026-07-31T12:01:00.000Z",
    wallTimeMs: 60000,
    observedStatus,
    resourceOracleStatus: "not-applicable"
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixedProbeDiagnostic(result, fallback) {
  return /\bP5E_[A-Z0-9_]+\b/.exec(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)?.[0] ?? fallback;
}

const P5_TEST_NODE_SHA256 =
  "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582";
const P5_TEST_REGISTRY_SHA256 =
  "28781c049eaeebcfe189b360d3f77583843c50ce08cbc073748537e84e9e6aa8";
const P5_TEST_POLICY_STEPS = [
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
const P5_TEST_DEPENDENCY_STEPS = [
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
const P5_TEST_GATE_STEPS = [
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

function p5TestJobTools(imageVersion = "20260728.188.1") {
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
    powershellVersion: "7.6.4",
    powershellObservationStatus: "observed-in-sanitized-marker",
    filesystem: "NTFS",
    filesystemObservationStatus: "observed-in-sanitized-marker",
    node: "24.18.1",
    npm: "11.16.0",
    nodeExecutableSha256: P5_TEST_NODE_SHA256,
    rawLogsPersisted: false,
    hostedGateInput: false
  };
}

function p5TestJob([
  jobName,
  jobKey,
  checkRunId,
  conclusion,
  startedAt,
  completedAt,
  runnerName,
  steps = [],
  failureCode = null,
  markerCount = 0,
  imageVersion = "20260728.188.1"
]) {
  const skipped = conclusion === "skipped";
  return {
    jobName,
    jobKey,
    checkRunId,
    status: "completed",
    conclusion,
    startedAt,
    completedAt,
    runnerName,
    runnerToolProjection: skipped ? null : p5TestJobTools(imageVersion),
    steps: steps.map(([number, name, stepConclusion]) => ({
      number,
      name,
      status: "completed",
      conclusion: stepConclusion
    })),
    log: {
      authority: "read-only-sanitized-log-projection",
      readbackStatus: skipped ? "not-applicable-skipped-job" : "resolved",
      markerCount,
      failureCodes: failureCode === null ? [] : [failureCode],
      failureObservations: [],
      policyTestTotal: null,
      policyTestPassed: null,
      rawLogsPersisted: false
    }
  };
}

function p5TestFragment({
  jobName,
  jobKey,
  checkRunId,
  conclusion,
  markerSha256,
  startedAt,
  finishedAt,
  wallTimeMs,
  rawExitCode,
  observedStatus,
  hostedGateInput,
  registryBound = true,
  imageVersion = "20260728.188.1"
}) {
  return {
    jobName,
    jobKey,
    checkRunId,
    conclusion,
    markerCount: 1,
    markerSha256,
    fragmentStatus: "validated-rest-bound",
    restBindingStatus: "validated",
    observedRegistrySha256: registryBound ? P5_TEST_REGISTRY_SHA256 : null,
    expectedRegistrySha256: registryBound ? P5_TEST_REGISTRY_SHA256 : null,
    validationErrorCodes: [],
    releaseTrustInput: false,
    sanitizedLogProjection: {
      authority: "read-only-sanitized-log-projection",
      imageOS: "win25-vs2026",
      imageVersion,
      osCaption: "Microsoft Windows Server 2025 Datacenter",
      osVersion: "10.0.26100",
      osBuild: "26100",
      architecture: "X64",
      powershellVersion: "7.6.4",
      filesystem: "NTFS",
      node: "24.18.1",
      npm: "11.16.0",
      nodeExecutableSha256: P5_TEST_NODE_SHA256,
      runnerVersion: "2.336.0",
      startedAt,
      finishedAt,
      wallTimeMs,
      rawExitCode,
      observedStatus,
      rawLogsPersisted: false,
      hostedGateInput
    }
  };
}

function p5TestArtifacts(runId, observedAt) {
  return {
    authority: "run-artifacts-rest-readback",
    endpoint: `repos/wotjr1649/codex-conductor-cc/actions/runs/${runId}/artifacts`,
    observedAt,
    readbackStatus: "resolved",
    observedCount: 0,
    entries: [],
    releaseTrustInput: false
  };
}

const p5Run4Observation = {
  repository: "wotjr1649/codex-conductor-cc",
  pullRequestNumber: 2,
  runId: 31003825837,
  runNumber: 4,
  runAttempt: 1,
  rerunCount: 0,
  automaticRetryCount: null,
  event: "pull_request",
  runUrl: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/31003825837",
  sourceHeadSha: "5475e3e2bccc9af6e10079da5d355b4dab88b3e5",
  eventMergeSha: "525cda85ca7d5e24dbfee48f1f5b95a42a65cc2e",
  workflowSha: "525cda85ca7d5e24dbfee48f1f5b95a42a65cc2e",
  baseSha: "84515289913dfe8a7452754ad442d37873bdfd53",
  checkSuiteId: 84085308029,
  runStartedAt: "2026-08-05T12:01:11Z",
  runCompletedAt: "2026-08-05T12:02:46Z",
  conclusion: "failure",
  expectedLogicalJobCount: 12,
  observedRestJobCount: 10,
  placeholderJobCount: 3,
  collectionStatus: "incomplete-or-invalid",
  collectionIssues: [
    { code: "P5E_COLLECT_JOB_SET", jobKey: null, stepName: null, count: 1 },
    {
      code: "P5E_COLLECT_STEP",
      jobKey: null,
      stepName: "Write sanitized runner evidence",
      count: 7
    }
  ],
  jobObservations: [
    p5TestJob(["Policy validation", "policy-validation", 92298810047, "failure", "2026-08-05T12:01:14Z", "2026-08-05T12:02:15Z", "GitHub Actions 1000002391", P5_TEST_POLICY_STEPS, "P5E_TEST_MODULE_PROBE", 1]),
    p5TestJob(["Dependency review", "dependency-review", 92298810150, "success", "2026-08-05T12:01:13Z", "2026-08-05T12:01:45Z", "GitHub Actions 1000002392", P5_TEST_DEPENDENCY_STEPS, null, 1]),
    p5TestJob(["CI", "gate", 92299062268, "failure", "2026-08-05T12:02:18Z", "2026-08-05T12:02:46Z", "GitHub Actions 1000002393", P5_TEST_GATE_STEPS, "P5E_BLOCKING_PROFILE_RESULT", 1]),
    p5TestJob(["Core contract / ${{ matrix.lane }}", "core-contract", 92299062368, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Security", "security", 92299062426, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Unit tests", "unit", 92299062432, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Claude structural lifecycle / ${{ matrix.lane }}", "claude-lifecycle", 92299062587, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Non-blocking Codex canary / ${{ matrix.lane }}", "next-canary", 92299062615, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Windows integration", "windows-integration", 92299062806, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null]),
    p5TestJob(["Install and build", "install-build", 92299062927, "skipped", "2026-08-05T12:02:16Z", "2026-08-05T12:02:15Z", null])
  ],
  validatedFragments: [
    p5TestFragment({ jobName: "Policy validation", jobKey: "policy-validation", checkRunId: 92298810047, conclusion: "failure", markerSha256: "e639b48cdcab3b7b65efb00f3abec124089385fcbfd1ac03896b77a056d8cf24", startedAt: "2026-08-05T12:01:29.4032231+00:00", finishedAt: "2026-08-05T12:02:11.0726427+00:00", wallTimeMs: 41669, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: false }),
    p5TestFragment({ jobName: "Dependency review", jobKey: "dependency-review", checkRunId: 92298810150, conclusion: "success", markerSha256: "c6a05b38a86ecde3aa7bef34b42b09db2a1b6a4f7662cc03f2b8999f3263360a", startedAt: "2026-08-05T12:01:27.2089396+00:00", finishedAt: "2026-08-05T12:01:40.4598559+00:00", wallTimeMs: 13251, rawExitCode: 0, observedStatus: "executed-pass", hostedGateInput: false }),
    p5TestFragment({ jobName: "CI", jobKey: "gate", checkRunId: 92299062268, conclusion: "failure", markerSha256: "cb2f11bb1e7c455017e62fffb9652627af4a5bf8dd52fc6231cb0662c3e3da00", startedAt: "2026-08-05T12:02:29.6031685+00:00", finishedAt: "2026-08-05T12:02:41.7674343+00:00", wallTimeMs: 12164, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: true, registryBound: false })
  ],
  rejectedFragments: [],
  artifacts: p5TestArtifacts(31003825837, "2026-08-06T00:31:53Z")
};

const p5Run5Observation = {
  ...p5Run4Observation,
  runId: 31027289099,
  runNumber: 5,
  runUrl: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/31027289099",
  sourceHeadSha: "748d6181e30f642930bc13f4f9a718a1f366dd27",
  eventMergeSha: "3bc3b92931880d771096cb877de8a4aa35ec8410",
  workflowSha: "3bc3b92931880d771096cb877de8a4aa35ec8410",
  checkSuiteId: 84155049291,
  runStartedAt: "2026-08-05T16:51:54Z",
  runCompletedAt: "2026-08-05T16:53:39Z",
  jobObservations: [
    p5TestJob(["Policy validation", "policy-validation", 92378887500, "failure", "2026-08-05T16:51:57Z", "2026-08-05T16:53:05Z", "GitHub Actions 1000002394", P5_TEST_POLICY_STEPS.map((step) => step[0] === 8 ? [8, step[1], "failure"] : step[0] === 9 ? [9, step[1], "skipped"] : step), "P5E_POST_SOURCE_CHANGE", 1]),
    p5TestJob(["Dependency review", "dependency-review", 92378887679, "success", "2026-08-05T16:51:57Z", "2026-08-05T16:52:26Z", "GitHub Actions 1000002395", P5_TEST_DEPENDENCY_STEPS, null, 1]),
    p5TestJob(["CI", "gate", 92379203178, "failure", "2026-08-05T16:53:07Z", "2026-08-05T16:53:38Z", "GitHub Actions 1000002396", P5_TEST_GATE_STEPS, "P5E_BLOCKING_PROFILE_RESULT", 1]),
    p5TestJob(["Claude structural lifecycle / ${{ matrix.lane }}", "claude-lifecycle", 92379203410, "skipped", "2026-08-05T16:53:05Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Security", "security", 92379203480, "skipped", "2026-08-05T16:53:05Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Unit tests", "unit", 92379203531, "skipped", "2026-08-05T16:53:05Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Non-blocking Codex canary / ${{ matrix.lane }}", "next-canary", 92379203602, "skipped", "2026-08-05T16:53:05Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Windows integration", "windows-integration", 92379203717, "skipped", "2026-08-05T16:53:06Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Core contract / ${{ matrix.lane }}", "core-contract", 92379203779, "skipped", "2026-08-05T16:53:06Z", "2026-08-05T16:53:05Z", null]),
    p5TestJob(["Install and build", "install-build", 92379203928, "skipped", "2026-08-05T16:53:06Z", "2026-08-05T16:53:05Z", null])
  ],
  validatedFragments: [
    p5TestFragment({ jobName: "Policy validation", jobKey: "policy-validation", checkRunId: 92378887500, conclusion: "failure", markerSha256: "feaa8d4fdbb5eaf933f7729a7bf10e334ad560fee34bba22a79dfdff8a2e4b90", startedAt: "2026-08-05T16:52:18.8855485+00:00", finishedAt: "2026-08-05T16:53:01.7150067+00:00", wallTimeMs: 42829, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: false }),
    p5TestFragment({ jobName: "Dependency review", jobKey: "dependency-review", checkRunId: 92378887679, conclusion: "success", markerSha256: "1e967340deb0f653e95189eef7da50220a38a90e5754c8293f93fb4b2c11ff14", startedAt: "2026-08-05T16:52:08.4741597+00:00", finishedAt: "2026-08-05T16:52:21.8655948+00:00", wallTimeMs: 13391, rawExitCode: 0, observedStatus: "executed-pass", hostedGateInput: false }),
    p5TestFragment({ jobName: "CI", jobKey: "gate", checkRunId: 92379203178, conclusion: "failure", markerSha256: "059c64816fd4307dd418dd89b47ede85ac9edf8dbaec0048326e6498854e62f4", startedAt: "2026-08-05T16:53:19.8305004+00:00", finishedAt: "2026-08-05T16:53:34.1398625+00:00", wallTimeMs: 14309, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: true, registryBound: false })
  ],
  rejectedFragments: [],
  artifacts: p5TestArtifacts(31027289099, "2026-08-06T00:31:53Z")
};

const p5Run6Observation = {
  ...p5Run5Observation,
  runId: 31060819525,
  runNumber: 6,
  runUrl: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/31060819525",
  sourceHeadSha: "4190a2ba59637dcdbe3f32be0edc019483496620",
  eventMergeSha: "82cedd70775b3a3ee857bc57595ce822612cc467",
  workflowSha: "82cedd70775b3a3ee857bc57595ce822612cc467",
  checkSuiteId: 84251433132,
  runStartedAt: "2026-08-06T00:47:40Z",
  runCompletedAt: "2026-08-06T00:49:38Z",
  jobObservations: [
    p5TestJob(["Policy validation", "policy-validation", 92488210860, "failure", "2026-08-06T00:47:42Z", "2026-08-06T00:48:29Z", "GitHub Actions 1000002399", P5_TEST_POLICY_STEPS.map((step) => step[0] === 8 ? [8, step[1], "failure"] : step[0] === 9 ? [9, step[1], "skipped"] : step), "P5E_POST_SOURCE_CHANGE", 1]),
    p5TestJob(["Dependency review", "dependency-review", 92488210883, "success", "2026-08-06T00:47:42Z", "2026-08-06T00:48:13Z", "GitHub Actions 1000002398", P5_TEST_DEPENDENCY_STEPS, null, 1, "20260803.193.1"]),
    p5TestJob(["CI", "gate", 92488340496, "failure", "2026-08-06T00:48:33Z", "2026-08-06T00:49:37Z", "GitHub Actions 1000002400", P5_TEST_GATE_STEPS, "P5E_BLOCKING_PROFILE_RESULT", 1, "20260803.193.1"]),
    p5TestJob(["Security", "security", 92488340646, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Install and build", "install-build", 92488340699, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Windows integration", "windows-integration", 92488340707, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Unit tests", "unit", 92488340788, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Non-blocking Codex canary / ${{ matrix.lane }}", "next-canary", 92488340834, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Core contract / ${{ matrix.lane }}", "core-contract", 92488340839, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null]),
    p5TestJob(["Claude structural lifecycle / ${{ matrix.lane }}", "claude-lifecycle", 92488340899, "skipped", "2026-08-06T00:48:29Z", "2026-08-06T00:48:29Z", null])
  ],
  validatedFragments: [
    p5TestFragment({ jobName: "Policy validation", jobKey: "policy-validation", checkRunId: 92488210860, conclusion: "failure", markerSha256: "2c326c0b52ebc440b7920239f96742217dbc4ebb90217ca9e1e72b3b57ff94d2", startedAt: "2026-08-06T09:47:53.4856117+09:00", finishedAt: "2026-08-06T09:48:25.2062249+09:00", wallTimeMs: 31721, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: false }),
    p5TestFragment({ jobName: "Dependency review", jobKey: "dependency-review", checkRunId: 92488210883, conclusion: "success", markerSha256: "ddf0d5491bab84818977afebfd54d6454faa5751e74074f85ec3a93a77c8b9f6", startedAt: "2026-08-06T09:47:53.6766969+09:00", finishedAt: "2026-08-06T09:48:09.7938305+09:00", wallTimeMs: 16117, rawExitCode: 0, observedStatus: "executed-pass", hostedGateInput: false, imageVersion: "20260803.193.1" }),
    p5TestFragment({ jobName: "CI", jobKey: "gate", checkRunId: 92488340496, conclusion: "failure", markerSha256: "6f9d91950c77453bd08c197c7d4c4db62308fa955be26194c43d2dfe6b14a77b", startedAt: "2026-08-06T09:48:45.2480533+09:00", finishedAt: "2026-08-06T09:49:34.9122271+09:00", wallTimeMs: 49664, rawExitCode: 1, observedStatus: "executed-fail", hostedGateInput: true, registryBound: false, imageVersion: "20260803.193.1" })
  ],
  rejectedFragments: [],
  artifacts: p5TestArtifacts(31060819525, "2026-08-06T00:56:38Z")
};

const P5_TEST_FINAL_JOBS = [
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
];

function p5SyntheticClosureObservation(sourceCommit) {
  const eventMergeSha = "c".repeat(40);
  const jobObservations = P5_TEST_FINAL_JOBS.map(([jobName, jobKey], index) =>
    p5TestJob([
      jobName,
      jobKey,
      99000000000 + index,
      "success",
      "2026-08-06T01:00:00Z",
      "2026-08-06T01:01:00Z",
      `GitHub Actions ${1000002500 + index}`,
      [],
      null,
      1
    ])
  );
  const validatedFragments = P5_TEST_FINAL_JOBS.map(([jobName, jobKey], index) =>
    p5TestFragment({
      jobName,
      jobKey,
      checkRunId: 99000000000 + index,
      conclusion: "success",
      markerSha256: (index + 1).toString(16).padStart(64, "0"),
      startedAt: "2026-08-06T01:00:01Z",
      finishedAt: "2026-08-06T01:00:59Z",
      wallTimeMs: 58000,
      rawExitCode: 0,
      observedStatus:
        jobKey === "next-canary" ? "non-blocking-canary" : "executed-pass",
      hostedGateInput: jobKey !== "next-canary",
      registryBound: jobKey !== "gate"
    })
  );
  return {
    repository: "wotjr1649/codex-conductor-cc",
    pullRequestNumber: 2,
    runId: 39999999999,
    runNumber: 7,
    runAttempt: 1,
    rerunCount: 0,
    automaticRetryCount: null,
    event: "pull_request",
    runUrl: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/39999999999",
    sourceHeadSha: sourceCommit,
    eventMergeSha,
    workflowSha: eventMergeSha,
    baseSha: "84515289913dfe8a7452754ad442d37873bdfd53",
    checkSuiteId: 89999999999,
    runStartedAt: "2026-08-06T00:59:59Z",
    runCompletedAt: "2026-08-06T01:01:01Z",
    conclusion: "success",
    expectedLogicalJobCount: 12,
    observedRestJobCount: 12,
    placeholderJobCount: 0,
    collectionStatus: "validated",
    collectionIssues: [],
    jobObservations,
    validatedFragments,
    rejectedFragments: [],
    artifacts: p5TestArtifacts(39999999999, "2026-08-06T01:02:00Z")
  };
}

function p5ClosureFixture() {
  const historical = readJson(
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json"
  );
  const closure = structuredClone(historical);
  closure.source.sourceCommit = "b".repeat(40);
  closure.overallStatus = "hosted-complete";
  closure.hostedGateStatus = "hosted-pass";
  closure.remoteExecution = "executed-pass";
  const finalObservation = p5SyntheticClosureObservation(closure.source.sourceCommit);
  closure.hostedObservations = [
    ...historical.hostedObservations,
    structuredClone(p5Run4Observation),
    structuredClone(p5Run5Observation),
    structuredClone(p5Run6Observation),
    finalObservation
  ];
  for (const result of closure.profileResults) {
    if (result.blocking) result.hostedStatus = "hosted-pass";
    if (result.profileId === "next-canary") {
      result.hostedStatus = "non-blocking-canary";
    }
  }
  for (const observation of closure.hostedObservations.slice(2)) {
    for (const fragment of observation.validatedFragments) {
      if (fragment.jobKey === "gate") continue;
      const result = closure.profileResults.find(
        ({ profileId }) => profileId === fragment.jobKey
      );
      if (result) result.evidenceIds.push(`p5-hosted-fragment-${fragment.checkRunId}`);
    }
  }
  closure.prRefCacheObservation = {
    authority: "actions-cache-rest-readback",
    endpoint: "repos/wotjr1649/codex-conductor-cc/actions/caches?ref=refs/pull/2/merge",
    ref: "refs/pull/2/merge",
    mergeSha: finalObservation.eventMergeSha,
    observedAt: "2026-08-06T01:02:00Z",
    readbackStatus: "resolved",
    matchingRefCacheCount: 0,
    entries: [],
    inventorySha256:
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    executionWindowAttribution: "not-observed",
    releaseTrustInput: false
  };
  return closure;
}

function p5ObservationDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("P5-EVIDENCE-V3-DIGEST-001 remediation observations stay canonical", () => {
  assert.deepEqual(
    [
      p5ObservationDigest(p5Run4Observation),
      p5ObservationDigest(p5Run5Observation),
      p5ObservationDigest(p5Run6Observation)
    ],
    [
      "226dbb7a4d9b8bf2727b42d688af1ac608edca9f7ba5ae81f70b580caf944fa1",
      "8c7a6955d040431e6e9c3ee0341cc67dddc3d25cb3bd38b0bef13514c1c6e7ec",
      "82433eea5afe5fa3a72eb91edc07118a4c9abb7a1eba449bded7d99a4c68697d"
    ]
  );
});

test("P5-DIAGNOSTIC-001 subprocess diagnostics expose only fixed P5 tokens", () => {
  const fallback = "P5E_TEST_MODULE_PROBE";

  for (const token of [
    "P5E_NODE_IDENTITY_RESOLUTION",
    "P5E_NODE_IDENTITY_NPM_ADJACENCY",
    "P5E_NODE_IDENTITY_NODE_VERSION",
    "P5E_NODE_IDENTITY_NPM_VERSION",
    "P5E_NODE_IDENTITY_ARCHITECTURE",
    "P5E_NODE_IDENTITY_DIGEST",
    "P5E_NODE_IDENTITY_INVOCATION"
  ]) {
    assert.equal(
      fixedProbeDiagnostic({ stderr: `${token}: synthetic-private-path`, stdout: "" }, fallback),
      token
    );
  }
  assert.equal(
    fixedProbeDiagnostic({ stderr: "synthetic-private-path", stdout: "" }, fallback),
    fallback
  );
});

test("P5-SOURCE-BOOTSTRAP-001 accepts only the exact one-time frontier", async () => {
  const {
    isExactP5BootstrapCheckout,
    isExactP5BootstrapFrontier
  } = await import(
    "../scripts/lib/p5-validation.mjs"
  );
  assert.equal(typeof isExactP5BootstrapFrontier, "function");
  assert.equal(typeof isExactP5BootstrapCheckout, "function");
  assert.equal(isExactP5BootstrapFrontier(exactBootstrapFixture), true);
  for (const mutate of [
    (value) => { value.boundSource = "0".repeat(40); },
    (value) => { value.headParents.push("1".repeat(40)); },
    (value) => { value.evidenceRebindParents = []; },
    (value) => { value.windowsFixPaths.push("scripts/unreviewed.mjs"); },
    (value) => { value.policyPaths.pop(); },
    (value) => { value.uncommittedPaths.push("tests/untracked.test.mjs"); }
  ]) {
    const observed = structuredClone(exactBootstrapFixture);
    mutate(observed);
    assert.equal(isExactP5BootstrapFrontier(observed), false);
  }
  const rebound = structuredClone(exactBootstrapFixture);
  rebound.boundSource = "f".repeat(40);
  assert.equal(isExactP5BootstrapFrontier(rebound), false);

  const exactCorrectionFixture = {
    ...structuredClone(exactBootstrapFixture),
    headParents: ["4190a2ba59637dcdbe3f32be0edc019483496620"],
    policyCommitParents: ["748d6181e30f642930bc13f4f9a718a1f366dd27"],
    policyCommitPaths: structuredClone(exactBootstrapFixture.policyPaths)
  };
  assert.equal(isExactP5BootstrapFrontier(exactCorrectionFixture), true);
  for (const mutate of [
    (value) => { value.policyCommitParents = []; },
    (value) => { value.policyCommitPaths.pop(); },
    (value) => { value.headParents = ["0".repeat(40)]; }
  ]) {
    const observed = structuredClone(exactCorrectionFixture);
    mutate(observed);
    assert.equal(isExactP5BootstrapFrontier(observed), false);
  }

  const mergeCheckout = structuredClone(exactBootstrapFixture);
  mergeCheckout.headParents = [
    "84515289913dfe8a7452754ad442d37873bdfd53",
    "4190a2ba59637dcdbe3f32be0edc019483496620"
  ];
  mergeCheckout.policyPaths = [".github/workflows/pull-request-ci.yml"];
  const baseParent = structuredClone(exactBootstrapFixture);
  baseParent.headParents = ["0".repeat(40)];
  baseParent.policyPaths = [".gitattributes"];
  assert.equal(
    isExactP5BootstrapCheckout([
      "4190a2ba59637dcdbe3f32be0edc019483496620"
    ], [
      exactCorrectionFixture,
      exactBootstrapFixture
    ]),
    true
  );
  assert.equal(
    isExactP5BootstrapCheckout([
      "84515289913dfe8a7452754ad442d37873bdfd53",
      "4190a2ba59637dcdbe3f32be0edc019483496620"
    ], [
      mergeCheckout,
      baseParent,
      exactCorrectionFixture
    ]),
    true
  );
  assert.equal(
    isExactP5BootstrapCheckout([
      "84515289913dfe8a7452754ad442d37873bdfd53",
      "4190a2ba59637dcdbe3f32be0edc019483496620"
    ], [
      mergeCheckout,
      exactBootstrapFixture,
      exactBootstrapFixture
    ]),
    false
  );
  assert.equal(
    isExactP5BootstrapCheckout([
      "84515289913dfe8a7452754ad442d37873bdfd53",
      "4190a2ba59637dcdbe3f32be0edc019483496620"
    ], [mergeCheckout, baseParent]),
    false
  );
});

test("P5-RED-001 versioned profile, scenario, schema, and evidence sources exist", () => {
  for (const relativePath of [
    "ci/matrix-profiles-v1.json",
    "ci/scenario-registry-v1.json",
    "evidence/schemas/p5-evidence-v1.schema.json",
    "evidence/schemas/p5-evidence-v2.schema.json",
    "evidence/schemas/p5-evidence-v3.schema.json",
    "evidence/schemas/p5-runner-evidence-v2.schema.json",
    "evidence/schemas/p5-gate-evidence-v1.schema.json",
    "evidence/schemas/p5-hosted-harvest-v1.schema.json",
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json",
    "evidence/ledgers/p5-attempts.json",
    "scripts/validate-p5.mjs",
    "scripts/run-p5-attempt-clock.ps1",
    "scripts/run-p5-hosted-evidence-collector.mjs",
    "scripts/write-p5-runner-evidence.ps1"
  ]) {
    assert.equal(existsSync(path.join(root, relativePath)), true, relativePath);
  }
  const v3SchemaText = JSON.stringify(p5EvidenceSchemas.get("p5-evidence-v3"));
  for (const unsupportedKeyword of [
    "maximum",
    "oneOf",
    "anyOf",
    "uniqueItems",
    "contains",
    "if",
    "then",
    "else"
  ]) {
    assert.equal(
      v3SchemaText.includes(`"${unsupportedKeyword}":`),
      false,
      `P5E_TEST_V3_SCHEMA_KEYWORD:${unsupportedKeyword}`
    );
  }
  const v3Schema = p5EvidenceSchemas.get("p5-evidence-v3");
  assert.equal(v3Schema.properties.hostedObservations.minItems, 2);
  assert.equal(v3Schema.properties.hostedObservations.maxItems, 6);
  assert.deepEqual(
    v3Schema.$defs.hostedObservationV3.properties.conclusion.enum,
    ["failure", "success"]
  );
  assert.deepEqual(
    v3Schema.$defs.hostedObservationV3.properties.observedRestJobCount.enum,
    [10, 12]
  );
  assert.deepEqual(
    v3Schema.$defs.hostedObservationV3.properties.placeholderJobCount.enum,
    [0, 3]
  );
  assert.deepEqual(
    v3Schema.$defs.hostedObservationV3.properties.collectionStatus.enum,
    ["incomplete-or-invalid", "validated"]
  );
});

test("P5-PROFILE-001 exact supported, canary, and blocked profile policy validates", () => {
  assert.deepEqual(validateProfileRegistry(profiles, toolchain), []);
});

test("P5-PARTITION-001 every inherited test maps once with exact byte identity", () => {
  assert.deepEqual(validateScenarioRegistry(scenarios, root, profiles), []);
});

test("P5-WORKFLOW-001 job-scoped security and matrix policy validates", () => {
  assert.deepEqual(
    validateP5Workflow(workflow, toolchain.actions, profiles),
    []
  );
  assert.deepEqual(
    validateP5Workflow(workflow.replaceAll("\n", "\r\n"), toolchain.actions, profiles),
    []
  );
});

test("P5-PROVENANCE-001 every hosted allocation emits exact, bindable provenance", () => {
  assert.equal(
    gitAttributes,
    [
      "# Evidence digests bind repository bytes, so security manifests must not vary",
      "# with a contributor's core.autocrlf setting.",
      "toolchain.json text eol=lf",
      "ci/scenario-registry-v1.json text eol=lf",
      "security/*.json text eol=lf",
      "evidence/**/*.json text eol=lf",
      "contracts/codex/**/*.json text eol=lf",
      "contracts/codex/snapshots/** text eol=lf",
      "tests/contract/**/*.json text eol=lf",
      ""
    ].join("\n")
  );
  const attributeProbe = spawnSync(
    "git",
    ["check-attr", "text", "eol", "--", "ci/scenario-registry-v1.json"],
    { cwd: root, encoding: "utf8", shell: false, windowsHide: true }
  );
  assert.equal(attributeProbe.status, 0, attributeProbe.stderr);
  assert.deepEqual(attributeProbe.stdout.trim().split(/\r?\n/), [
    "ci/scenario-registry-v1.json: text: set",
    "ci/scenario-registry-v1.json: eol: lf"
  ]);
  for (const relativePath of [
    "scripts/lib/p5-runner-provenance.psm1",
    "scripts/write-p5-gate-evidence.ps1"
  ]) {
    assert.equal(existsSync(path.join(root, relativePath)), true, relativePath);
  }
  for (const invariant of [
    "p5-runner-evidence-v2",
    "actualCheckoutSha",
    "eventMergeSha",
    "checkRunId",
    "jobAttempt",
    "workflowRerunCount",
    "P5_SANITIZED_EVIDENCE_JSON=",
    "SelectedToolIds",
    "SelectedToolPaths"
  ]) {
    assert.ok(
      `${runnerWriter}\n${provenanceModule}`.includes(invariant),
      invariant
    );
  }
  assert.doesNotMatch(nodeIdentityScript, /P5_STARTED_AT=/);
  assert.match(provenanceModule, /Join-Path\s+\(Split-Path[^\r\n]+\)\s+'npm\.cmd'/);
  assert.match(provenanceModule, /startedAtValue\s+-gt\s+\$finishedAt/);
  assert.doesNotMatch(provenanceModule, /jobAttempt\s*=\s*\$RunAttempt/);
  assert.doesNotMatch(provenanceModule, /timeout\s*=\s*\$false/);
  assert.match(workflow, /P5_CHECK_RUN_ID:\s+\$\{\{\s*job\.check_run_id\s*\}\}/);
  assert.match(
    workflow,
    /^  dependency-review:[\s\S]*?write-p5-runner-evidence\.ps1[\s\S]*?(?=^  next-canary:)/m
  );
  assert.match(
    workflow,
    /^  gate:[\s\S]*?write-p5-gate-evidence\.ps1/m
  );
  for (const toolId of ["actionlint", "zizmor", "osv-scanner", "gitleaks"]) {
    const pathVariable = `P5_${toolId.replaceAll("-", "_").toUpperCase()}_PATH`;
    assert.match(
      workflow,
      new RegExp(`['"]?${toolId}['"]?\\s*=\\s*\\$env:${pathVariable}`),
      toolId
    );
  }
});

test("P5-HOSTED-CONSUMER-001 fragments require fail-closed REST consolidation", () => {
  const unitScenario = scenarios.scenarios.find(({ id }) => id === "P5-UNIT-001");
  const runner = {
    schemaVersion: "p5-runner-evidence-v2",
    evidenceKind: "profile-lane",
    profile: "unit",
    lane: "default",
    blocking: true,
    requirementIds: [...unitScenario.requirementIds],
    scenarioId: "P5-UNIT-001",
    scenarioFixtureIds: ["P5-UNIT-PARTITION-001"],
    verifiedFixtureIds: ["P5-UNIT-PARTITION-001"],
    oracle: {
      registrySha256: scenarioRegistrySha256,
      aggregateExpected: unitScenario.oracle,
      expected: "unit fixture",
      observedStatus: "executed-pass"
    },
    runtimeEnforced: true,
    deferredPhase: null,
    provenance: hostedProvenance("unit", 7001),
    tools: {
      nodeIdentityStatus: "verified-exact",
      node: "24.18.1",
      npm: "11.16.0",
      nodeArchitecture: "x64",
      nodeExecutableSha256: "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582",
      selected: []
    },
    attempt: partialAttempt(),
    artifact: {
      repositoryAuthoredUpload: false,
      actionOwnedConditionalUploadPossible: false,
      observedUpload: false,
      digest: null,
      retentionDays: null,
      readbackStatus: "not-applicable",
      releaseTrustInput: false
    },
    cache: {
      repositoryAuthoredCacheEnabled: false,
      readbackStatus: "pending-rest-readback",
      releaseTrustInput: false
    },
    privacy: {
      privatePathsPersisted: false,
      secretsPersisted: false,
      rawEnvironmentPersisted: false,
      rawPromptOrPayloadPersisted: false,
      rawStdoutOrStderrPersisted: false,
      redactionStatus: "executed-pass"
    }
  };
  assert.deepEqual(validateJsonSchema(runner, runnerEvidenceSchema, "runner fixture"), []);
  assert.deepEqual(
    validateP5RunnerEvidence(runner, profiles, toolchain, scenarios, scenarioRegistrySha256),
    []
  );
  const missingFixture = structuredClone(runner);
  missingFixture.verifiedFixtureIds = [];
  assert.ok(
    validateP5RunnerEvidence(
      missingFixture,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    ).some((entry) =>
      entry.includes("P5E_RUNNER_EVIDENCE_FIXTURE")
    )
  );
  const forgedJob = structuredClone(runner);
  forgedJob.provenance.run.yamlJobKey = "policy-validation";
  assert.ok(
    validateP5RunnerEvidence(
      forgedJob,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    ).some((entry) =>
      entry.includes("P5E_RUNNER_EVIDENCE_IDENTITY")
    )
  );
  const security = structuredClone(runner);
  security.profile = "security";
  security.provenance.run.yamlJobKey = "security";
  const securityScenario = scenarios.scenarios.find(
    ({ id }) => id === "P5-SECURITY-001"
  );
  security.requirementIds = [...securityScenario.requirementIds];
  security.scenarioId = securityScenario.id;
  security.oracle.aggregateExpected = securityScenario.oracle;
  security.scenarioFixtureIds = [
    "P5-ACTIONLINT-001",
    "P5-ZIZMOR-001",
    "P5-OSV-001",
    "P5-GITLEAKS-001"
  ];
  security.verifiedFixtureIds = [...security.scenarioFixtureIds];
  security.tools.selected = ["actionlint", "zizmor", "osv-scanner", "gitleaks"].map(
    (id) => {
      const admitted = toolchain.tools.find((entry) => entry.id === id);
      return {
        id,
        version: admitted.version,
        executableSha256: admitted.artifact.executableSha256,
        verification: "toolchain-version-and-executable-digest",
        runtimeSignatureStatus: admitted.signature.authenticodeRequired
          ? "valid-exact"
          : "not-required",
        admissionSignatureKind: admitted.signature.kind,
        admissionSignatureVerified: admitted.signature.verified
      };
    }
  );
  assert.deepEqual(
    validateP5RunnerEvidence(security, profiles, toolchain, scenarios, scenarioRegistrySha256),
    []
  );
  security.tools.selected[0].executableSha256 = "0".repeat(64);
  assert.ok(
    validateP5RunnerEvidence(
      security,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    ).some((entry) =>
      entry.includes("P5E_RUNNER_EVIDENCE_TOOL_IDENTITY")
    )
  );
  const missingToolProof = structuredClone(security);
  missingToolProof.tools.selected[0].executableSha256 =
    toolchain.tools.find(({ id }) => id === "actionlint").artifact.executableSha256;
  delete missingToolProof.tools.selected[0].runtimeSignatureStatus;
  assert.ok(
    validateP5RunnerEvidence(
      missingToolProof,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    ).some((entry) => entry.includes("P5E_RUNNER_EVIDENCE_TOOL_PROOF"))
  );
  const falseUpload = structuredClone(runner);
  falseUpload.artifact.observedUpload = true;
  falseUpload.artifact.digest = "f".repeat(64);
  assert.ok(
    validateP5RunnerEvidence(
      falseUpload,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    ).some((entry) => entry.includes("P5E_RUNNER_EVIDENCE_DISPOSITION"))
  );
  const restJob = {
    id: 7001,
    run_id: 9001,
    run_attempt: 1,
    status: "completed",
    name: "Unit tests",
    check_run_url: "https://api.github.com/repos/wotjr1649/codex-conductor-cc/check-runs/7001",
    run_url: "https://api.github.com/repos/wotjr1649/codex-conductor-cc/actions/runs/9001",
    html_url: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/9001/job/7001",
    workflow_name: "Pull Request CI",
    head_sha: "2".repeat(40),
    labels: ["windows-2025"],
    conclusion: "success",
    started_at: "2026-07-31T11:59:59.000Z",
    completed_at: "2026-07-31T12:01:01.000Z",
    steps: [
      { number: 8, name: "Verify clean evidence source", status: "completed", conclusion: "success" },
      { number: 9, name: "Write sanitized runner evidence", status: "completed", conclusion: "success" }
    ]
  };
  const expected = {
    runId: 9001,
    runAttempt: 1,
    sourceHeadSha: "2".repeat(40),
    eventMergeSha: "4".repeat(40),
    workflowSha: "3".repeat(40)
  };
  expected.repository = runner.provenance.repository;
  expected.pullRequest = structuredClone(runner.provenance.pullRequest);
  expected.workflowRef = runner.provenance.workflow.ref;
  assert.deepEqual(validateP5RestJobBinding(runner, restJob, expected), []);
  const wrongCheckRun = { ...restJob, id: 8001 };
  assert.ok(
    validateP5RestJobBinding(runner, wrongCheckRun, expected).some((entry) =>
      entry.includes("P5E_REST_JOB_BINDING")
    )
  );
  const wrongAttempt = { ...restJob, run_attempt: 2 };
  assert.ok(
    validateP5RestJobBinding(runner, wrongAttempt, expected).some((entry) =>
      entry.includes("P5E_REST_JOB_BINDING")
    )
  );
  const markerStep = {
    name: "Write sanitized runner evidence",
    started_at: "2026-07-31T12:00:50.000Z",
    completed_at: "2026-07-31T12:01:00.000Z"
  };
  const markers = extractP5StepMarkers(
    [
      `Unit tests\tRun unit partition\t2026-07-31T12:00:40.000Z P5_SANITIZED_EVIDENCE_JSON={"forged":true}`,
      `Unit tests\tWrite sanitized runner evidence\t2026-07-31T12:00:55.000Z P5_SANITIZED_EVIDENCE_JSON={"accepted":true}`,
      `Unit tests\tWrite sanitized runner evidence\t2026-07-31T12:01:02.000Z P5_SANITIZED_EVIDENCE_JSON={"late":true}`
    ],
    "Unit tests",
    markerStep
  );
  assert.deepEqual(markers, ['{"accepted":true}']);
  const fractionalBoundaryMarkers = extractP5StepMarkers(
    [
      `Unit tests\tWrite sanitized runner evidence\t2026-07-31T12:01:00.9599936Z P5_SANITIZED_EVIDENCE_JSON={"fractional":true}`
    ],
    "Unit tests",
    {
      name: "Write sanitized runner evidence",
      started_at: "2026-07-31T12:01:00Z",
      completed_at: "2026-07-31T12:01:00Z"
    }
  );
  assert.deepEqual(fractionalBoundaryMarkers, ['{"fractional":true}']);

  const emptyValidatedHarvest = {
    schemaVersion: "p5-hosted-harvest-v1",
    repository: runner.provenance.repository,
    run: { id: 9001, attempt: 1 },
    sourceHeadSha: runner.provenance.sourceHeadSha,
    eventMergeSha: runner.provenance.eventMergeSha,
    workflowSha: runner.provenance.workflow.sha,
    validationSource: {
      sourceHeadSha: runner.provenance.sourceHeadSha,
      authority: "source-commit-git-objects-and-matched-executable",
      files: []
    },
    extraction: {},
    collectionStatus: "validated",
    collectionErrors: [],
    jobs: []
  };
  assert.ok(
    validateP5HostedHarvest(emptyValidatedHarvest).some((entry) =>
      entry.includes("P5E_HARVEST_JOB_SET")
    )
  );

  for (const mutate of [
    (record) => { record.attempt.rawExitCode = 23; },
    (record) => { record.attempt.startedAtSource = "finalizer-fallback"; },
    (record) => { record.attempt.resourceOracleStatus = "executed-fail"; },
    (record) => { record.attempt.wallTimeMs = 1; },
    (record) => { record.oracle.registrySha256 = "0".repeat(64); },
    (record) => { record.oracle.executionTranscript = "arbitrary raw output"; }
  ]) {
    const malformed = structuredClone(runner);
    mutate(malformed);
    const schemaErrors = validateJsonSchema(
      malformed,
      runnerEvidenceSchema,
      "malformed runner"
    );
    const semanticErrors = validateP5RunnerEvidence(
      malformed,
      profiles,
      toolchain,
      scenarios,
      scenarioRegistrySha256
    );
    assert.ok(schemaErrors.length > 0 || semanticErrors.length > 0);
  }

  const gate = {
    schemaVersion: "p5-gate-evidence-v1",
    evidenceKind: "terminal-gate",
    jobKey: "gate",
    checkName: "CI",
    blocking: true,
    expectedBlockingResult: "success",
    allBlockingSucceeded: true,
    blockingResults: Object.fromEntries([
      "policy-validation",
      "install-build",
      "unit",
      "core-contract",
      "windows-integration",
      "claude-lifecycle",
      "security",
      "dependency-review"
    ].map((job) => [job, "success"])),
    provenance: hostedProvenance("gate", 7002),
    tools: {
      nodeIdentityStatus: "verified-exact",
      node: "24.18.1",
      npm: "11.16.0",
      nodeArchitecture: "x64",
      nodeExecutableSha256: "ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582",
      selected: []
    },
    attempt: partialAttempt(),
    artifact: {
      repositoryAuthoredUpload: false,
      actionOwnedConditionalUploadPossible: false,
      observedUpload: false,
      digest: null,
      retentionDays: null,
      readbackStatus: "not-applicable",
      releaseTrustInput: false
    },
    cache: {
      repositoryAuthoredCacheEnabled: false,
      readbackStatus: "pending-rest-readback",
      releaseTrustInput: false
    },
    privacy: {
      privatePathsPersisted: false,
      secretsPersisted: false,
      rawEnvironmentPersisted: false,
      rawPromptOrPayloadPersisted: false,
      rawStdoutOrStderrPersisted: false,
      redactionStatus: "executed-pass"
    }
  };
  assert.deepEqual(validateJsonSchema(gate, gateEvidenceSchema, "gate fixture"), []);
  assert.deepEqual(validateP5GateEvidence(gate), []);
  const structurallyEmptyGate = structuredClone(gate);
  for (const key of ["provenance", "tools", "attempt", "artifact", "cache", "privacy"]) {
    structurallyEmptyGate[key] = {};
  }
  assert.ok(
    validateJsonSchema(structurallyEmptyGate, gateEvidenceSchema, "empty gate").length > 0
  );
  const validationSourcePaths = [
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
  const validationSource = {
    sourceHeadSha: runner.provenance.sourceHeadSha,
    authority: "source-commit-git-objects-and-matched-executable",
    files: validationSourcePaths.map((sourcePath, index) => ({
      path: sourcePath,
      sha256: String(index).padStart(64, "a").slice(-64)
    }))
  };
  const fragmentJson = JSON.stringify(runner);
  const fragmentSha256 = createHash("sha256").update(fragmentJson).digest("hex");
  const restRecord = {
    id: 7001,
    runId: 9001,
    runAttempt: 1,
    name: "Unit tests",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-07-31T11:59:59.000Z",
    completedAt: "2026-07-31T12:01:01.000Z",
    url: "https://api.github.com/repos/wotjr1649/codex-conductor-cc/actions/jobs/7001",
    runUrl: restJob.run_url,
    htmlUrl: "https://github.com/wotjr1649/codex-conductor-cc/actions/runs/9001/job/7001",
    checkRunUrl: restJob.check_run_url,
    headSha: runner.provenance.sourceHeadSha,
    workflowName: "Pull Request CI",
    labels: ["windows-2025"],
    integrityStep: {
      number: 8,
      name: "Verify clean evidence source",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-07-31T12:00:48.000Z",
      completedAt: "2026-07-31T12:00:49.000Z"
    },
    evidenceStep: {
      number: 9,
      name: "Write sanitized runner evidence",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-07-31T12:00:50.000Z",
      completedAt: "2026-07-31T12:01:00.000Z"
    }
  };
  const harvest = {
    schemaVersion: "p5-hosted-harvest-v1",
    repository: runner.provenance.repository,
    run: { id: 9001, attempt: 1 },
    sourceHeadSha: runner.provenance.sourceHeadSha,
    eventMergeSha: runner.provenance.eventMergeSha,
    workflowSha: runner.provenance.workflow.sha,
    pullRequest: structuredClone(runner.provenance.pullRequest),
    validationSource,
    trustReadback: {
      artifact: {
        authority: "run-artifacts-rest-plus-reviewed-workflow",
        endpoint: "/repos/wotjr1649/codex-conductor-cc/actions/runs/9001/artifacts",
        repositoryAuthoredUpload: false,
        actionOwnedConditionalUploadPossible: true,
        observedUpload: false,
        attemptAttribution: "exact-first-attempt-time-window",
        otherAttemptArtifactCount: 0,
        artifacts: [],
        readbackStatus: "resolved",
        releaseTrustInput: false
      },
      cache: {
        authority: "pr-ref-cache-rest-plus-reviewed-workflow",
        ref: "refs/pull/7/merge",
        repositoryAuthoredCacheEnabled: false,
        packageManagerCacheEnabled: false,
        matchingRefCacheCount: 0,
        entries: [],
        inventorySha256: createHash("sha256").update("[]").digest("hex"),
        readbackStatus: "resolved",
        releaseTrustInput: false
      }
    },
    extraction: {
      command: "gh run view --job --log",
      scope: "exact REST evidence-step name and immutable tabular log columns",
      rawLogsPersisted: false,
      markerPrefix: "P5_SANITIZED_EVIDENCE_JSON=",
      markerCardinality: "exactly-one-per-successful-evidence-step"
    },
    collectionStatus: "incomplete-or-invalid",
    collectionErrors: ["P5E_COLLECT_JOB_SET: exact attempt allocation set differs"],
    jobs: [{
      rest: restRecord,
      consolidatedAttempt: {
        authority: "attempt-scoped-rest-plus-validated-runner-fragment",
        runAttempt: 1,
        restJobId: 7001,
        workflowRerunCount: 0,
        jobAttempt: null,
        jobAttemptStatus: "not-exposed-by-attempt-jobs-api",
        automaticRetryCount: null,
        automaticRetryStatus: "not-exposed-by-attempt-jobs-api",
        timeout: false,
        restConclusion: "success",
        restStartedAt: restRecord.startedAt,
        restCompletedAt: restRecord.completedAt,
        restWallTimeMs: 62000,
        rawExitCode: 0,
        rawExitCodeSource: "github-job-status-normalized",
        runnerObservedStatus: "executed-pass",
        fragmentAuthority: "validated-rest-bound"
      },
      fragmentStatus: "validated-rest-bound",
      markerCount: 1,
      markerSha256: fragmentSha256,
      fragmentSha256,
      validationErrors: [],
      fragment: structuredClone(runner)
    }]
  };
  const harvestContext = {
    profiles,
    toolchain,
    scenarios,
    scenarioRegistrySha256,
    validationSource,
    schemas: { runner: runnerEvidenceSchema, gate: gateEvidenceSchema },
    expected: {
      ...expected,
      repository: runner.provenance.repository,
      pullRequest: runner.provenance.pullRequest,
      workflowRef: runner.provenance.workflow.ref
    }
  };
  assert.deepEqual(validateJsonSchema(harvest, hostedHarvestSchema, "harvest"), []);
  assert.deepEqual(validateP5HostedHarvest(harvest, harvestContext), []);
  for (const mutate of [
    (value) => { value.jobs[0].rest.integrityStep = null; },
    (value) => { value.jobs[0].rest.integrityStep.startedAt = null; },
    (value) => {
      value.jobs[0].rest.evidenceStep.startedAt = "2026-07-31T12:01:00.000Z";
      value.jobs[0].rest.evidenceStep.completedAt = "2026-07-31T12:00:50.000Z";
    },
    (value) => { value.jobs[0].consolidatedAttempt.restWallTimeMs = 1; },
    (value) => { value.jobs[0].rest.htmlUrl = "https://attacker.invalid/phish"; },
    (value) => { value.trustReadback.artifact.observedUpload = true; },
    (value) => { value.trustReadback.artifact.otherAttemptArtifactCount = 1; },
    (value) => {
      value.trustReadback.artifact.observedUpload = true;
      value.trustReadback.artifact.artifacts = [{
        id: 77,
        name: "dependency-review",
        sizeBytes: 10,
        digest: `sha256:${"a".repeat(64)}`,
        expired: false,
        createdAt: "2026-07-31T12:00:00.000Z",
        updatedAt: "2026-07-31T12:00:30.000Z",
        expiresAt: "2026-08-02T23:00:00.000Z",
        retentionDays: 1,
        url: "https://api.github.com/repos/wotjr1649/codex-conductor-cc/actions/artifacts/77"
      }];
    },
    (value) => { value.trustReadback.cache.inventorySha256 = "0".repeat(64); },
    (value) => {
      value.trustReadback.cache.entries = [{
        id: 88,
        keySha256: "b".repeat(64),
        sizeBytes: 10,
        createdAt: "2026-07-31T12:01:00.000Z",
        lastAccessedAt: "2026-07-31T12:00:00.000Z"
      }];
      value.trustReadback.cache.matchingRefCacheCount = 1;
      value.trustReadback.cache.inventorySha256 = createHash("sha256")
        .update(JSON.stringify(value.trustReadback.cache.entries))
        .digest("hex");
    },
    (value) => { value.jobs[0].markerSha256 = "f".repeat(64); },
    (value) => {
      value.jobs[0].fragment.provenance.repository = "attacker/other";
      value.jobs[0].fragment.provenance.pullRequest.baseRepository = "attacker/other";
    }
  ]) {
    const malformedHarvest = structuredClone(harvest);
    mutate(malformedHarvest);
    assert.ok(validateP5HostedHarvest(malformedHarvest, harvestContext).length > 0);
  }
  gate.blockingResults.security = "skipped";
  assert.ok(
    validateP5GateEvidence(gate).some((entry) =>
      entry.includes("P5E_GATE_EVIDENCE_STATUS")
    )
  );
});

test("P5-POWERSHELL-001 exact npm, clock, and local writer contracts execute", (t) => {
  const probeRoot = mkdtempSync(path.join(tmpdir(), "p5-provenance-runtime-"));
  t.after(() => rmSync(probeRoot, { recursive: true, force: true }));
  const outputPath = path.join(probeRoot, "policy.json");
  const branchRefOutputPath = path.join(probeRoot, "branch-ref.json");
  const fineGrainedPatOutputPath = path.join(probeRoot, "fine-grained-pat.json");
  const failedCanaryOutputPath = path.join(probeRoot, "failed-canary.json");
  const modulePath = path.join(root, "scripts", "lib", "p5-runner-provenance.psm1");
  const writerPath = path.join(root, "scripts", "write-p5-runner-evidence.ps1");
  const powershellPath = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const shadowNodePath = path.join(probeRoot, "node.cmd");
  writeFileSync(shadowNodePath, "@echo off\r\necho v0.0.0\r\n", "utf8");
  writeFileSync(
    path.join(probeRoot, "npm.cmd"),
    "@echo off\r\necho 0.0.0\r\n",
    "utf8"
  );
  const inheritedPath = Object.entries(process.env).find(
    ([name]) => name.toUpperCase() === "PATH"
  )?.[1];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH")
  );
  env.Path = [probeRoot, inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
  const exactNodePrelude = [
    `$env:Path = ${psQuote(path.dirname(process.execPath))} + [IO.Path]::PathSeparator + $env:Path`,
    "try { $resolvedNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source } catch { throw 'P5E_NODE_IDENTITY_RESOLUTION' }",
    `if (-not [string]::Equals([IO.Path]::GetFullPath($resolvedNode), [IO.Path]::GetFullPath(${psQuote(process.execPath)}), [StringComparison]::OrdinalIgnoreCase)) { throw 'P5E_NODE_IDENTITY_RESOLUTION' }`
  ].join("; ");
  const nodeIdentityDiagnosticPrelude = [
    "$diagnosticNpm = Join-Path (Split-Path -Parent $resolvedNode) 'npm.cmd'",
    "if (-not (Test-Path -LiteralPath $diagnosticNpm -PathType Leaf)) { throw 'P5E_NODE_IDENTITY_NPM_ADJACENCY' }",
    "try { $diagnosticNodeVersion = (& $resolvedNode --version).Trim().TrimStart('v') } catch { throw 'P5E_NODE_IDENTITY_NODE_VERSION' }",
    "try { $diagnosticNpmVersion = (& $diagnosticNpm --version).Trim() } catch { throw 'P5E_NODE_IDENTITY_NPM_VERSION' }",
    "try { $diagnosticArchitecture = (& $resolvedNode -p 'process.arch').Trim() } catch { throw 'P5E_NODE_IDENTITY_ARCHITECTURE' }",
    "if ($diagnosticNodeVersion -cne '24.18.1') { throw 'P5E_NODE_IDENTITY_NODE_VERSION' }",
    "if ($diagnosticNpmVersion -cne '11.16.0') { throw 'P5E_NODE_IDENTITY_NPM_VERSION' }",
    "if ($diagnosticArchitecture -cne 'x64') { throw 'P5E_NODE_IDENTITY_ARCHITECTURE' }"
  ].join("; ");
  {
    const shadowProbe = spawnSync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          "$resolvedNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source",
          `if (-not [string]::Equals([IO.Path]::GetFullPath($resolvedNode), [IO.Path]::GetFullPath(${psQuote(shadowNodePath)}), [StringComparison]::OrdinalIgnoreCase)) { exit 1 }`
        ].join("; ")
      ],
      { cwd: root, encoding: "utf8", env, shell: false, windowsHide: true }
    );
    assert.equal(shadowProbe.status, 0, "P5E_TEST_SHADOW_PATH");

    const moduleProbe = spawnSync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          exactNodePrelude,
          nodeIdentityDiagnosticPrelude,
          `Import-Module ${psQuote(modulePath)} -Force`,
          "function global:npm { '99.99.99' }",
          `$p = Get-P5ExecutionProvenance -RepositoryRoot ${psQuote(root)} -OutputPath ${psQuote(outputPath)} -ExecutionClass local -ExpectedNodeVersion 24.18.1 -ExpectedNpmVersion 11.16.0 -ExpectedNodeSha256 ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582 -RequireNodeIdentity $true`,
          "if ($p.node.nodeIdentityStatus -cne 'verified-exact') { throw 'P5E_TEST_NPM_SHADOW' }",
          "$futureRejected = $false",
          "try { Get-P5AttemptEvidence -StartedAt '2099-01-01T00:00:00Z' -ObservedStatus executed-pass -RawExitCode 0 -RawExitCodeSource direct-process -ResourceOracleStatus not-applicable -RunAttempt 1 -RequireStartedAt $true | Out-Null } catch { if ($_.Exception.Message -like 'P5E_ATTEMPT_CLOCK:*') { $futureRejected = $true } else { throw } }",
          "if (-not $futureRejected) { throw 'P5E_TEST_FUTURE_CLOCK' }",
          `Write-P5SanitizedEvidence -Evidence ([ordered]@{ headRef = 'feature/home/settings' }) -OutputPath ${psQuote(branchRefOutputPath)} | Out-Null`,
          "$fineGrainedPatRejected = $false",
          `try { Write-P5SanitizedEvidence -Evidence ([ordered]@{ headRef = ('feature/' + ('github' + '_pat_') + (('A' * 24) -join '')) }) -OutputPath ${psQuote(fineGrainedPatOutputPath)} | Out-Null } catch { if ($_.Exception.Message -like 'P5E_PRIVACY:*') { $fineGrainedPatRejected = $true } else { throw } }`,
          "if (-not $fineGrainedPatRejected) { throw 'P5E_TEST_FINE_GRAINED_PAT' }"
        ].join("; ")
      ],
      { cwd: root, encoding: "utf8", env, shell: false, windowsHide: true }
    );
    assert.equal(
      moduleProbe.status,
      0,
      fixedProbeDiagnostic(moduleProbe, "P5E_TEST_MODULE_PROBE")
    );

    const writerProbe = spawnSync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          exactNodePrelude,
          `$startedAt = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o')`,
          `& ${psQuote(writerPath)} -Profile policy-validation -Lane default -ExecutionClass local -StartedAt $startedAt -OutputPath ${psQuote(outputPath)} -RequirementIds @('P5-1','P5-2','P5-10','P5-11','P5-12','X5','X8','X9') -ScenarioId P5-POLICY-001 -FixtureIds @('P5-RED-001','P5-PRIVACY-001','P5-FALSE-GREEN-001') -ExpectedOracle 'dependency-free validators and policy tests exit zero before npm ci' -ObservedStatus executed-pass -RawExitCode 0 -ExitCodeSource direct-process`
        ].join("; ")
      ],
      { cwd: root, encoding: "utf8", env, shell: false, windowsHide: true }
    );
    assert.equal(writerProbe.status, 0, "P5E_TEST_WRITER_PROBE");
    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(evidence.schemaVersion, "p5-runner-evidence-v2");
    assert.equal(evidence.tools.nodeIdentityStatus, "verified-exact");
    assert.equal(evidence.attempt.authority, "runner-self-observed-partial");
    assert.equal(evidence.attempt.jobAttempt, null);
    assert.equal(evidence.attempt.timeout, null);

    const failedCanaryProbe = spawnSync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          exactNodePrelude,
          "$fixtureIds = @()",
          `& ${psQuote(writerPath)} -Profile next-canary -Lane next -ExecutionClass local -StartedAt '' -OutputPath ${psQuote(failedCanaryOutputPath)} -RequirementIds @('P5-6','P5-9','P5-12') -ScenarioId P5-CANARY-001 -FixtureIds $fixtureIds -ExpectedOracle 'the exact prerelease digest is observed without satisfying or blocking a supported profile' -ObservedStatus non-blocking-canary -RawExitCode 1 -ExitCodeSource github-job-status-normalized`
        ].join("; ")
      ],
      { cwd: root, encoding: "utf8", env, shell: false, windowsHide: true }
    );
    assert.equal(
      failedCanaryProbe.status,
      0,
      "P5E_TEST_CANARY_PROBE"
    );
    const failedCanary = JSON.parse(readFileSync(failedCanaryOutputPath, "utf8"));
    assert.equal(failedCanary.attempt.startedAtSource, "finalizer-fallback");

    const negativeWriterProbe = spawnSync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          exactNodePrelude,
          "$startedAt = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o')",
          "$laneRejected = $false",
          `try { & ${psQuote(writerPath)} -Profile unit -Lane fabricated -ExecutionClass local -StartedAt $startedAt -OutputPath ${psQuote(path.join(probeRoot, "wrong-lane.json"))} -RequirementIds @('P5-3','X2','X8','X9') -ScenarioId P5-UNIT-001 -FixtureIds @('P5-UNIT-PARTITION-001') -ExpectedOracle 'fixture' -ObservedStatus executed-pass -RawExitCode 0 -ExitCodeSource direct-process } catch { if ($_.Exception.Message -like 'P5E_PROFILE_LANE:*') { $laneRejected = $true } else { throw } }`,
          "if (-not $laneRejected) { throw 'P5E_TEST_LANE_ACCEPTED' }",
          "$toolRejected = $false",
          `try { & ${psQuote(writerPath)} -Profile install-build -Lane default -ExecutionClass local -StartedAt $startedAt -OutputPath ${psQuote(path.join(probeRoot, "missing-tool.json"))} -RequirementIds @('P5-1','P5-2','P5-3','X1','X8') -ScenarioId P5-BUILD-001 -FixtureIds @('P5-BUILD-EXACT-001') -ExpectedOracle 'fixture' -ObservedStatus executed-pass -RawExitCode 0 -ExitCodeSource direct-process } catch { if ($_.Exception.Message -like 'P5E_TOOL_PROFILE:*') { $toolRejected = $true } else { throw } }`,
          "if (-not $toolRejected) { throw 'P5E_TEST_TOOL_ACCEPTED' }"
        ].join("; ")
      ],
      { cwd: root, encoding: "utf8", env, shell: false, windowsHide: true }
    );
    assert.equal(
      negativeWriterProbe.status,
      0,
      "P5E_TEST_NEGATIVE_WRITER_PROBE"
    );
  }
});

test("P5-WORKFLOW-NEGATIVE-001 gate, cache, timeout, and early Node identity fail closed", () => {
  const weakGate = workflow.replace(
    "DEPENDENCY_RESULT: ${{ needs.dependency-review.result }}",
    "DEPENDENCY_RESULT: success"
  );
  assert.ok(
    validateP5Workflow(weakGate, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_GATE")
    )
  );
  const cached = workflow.replace(
    "package-manager-cache: false",
    "package-manager-cache: false\n          cache: npm"
  );
  assert.ok(
    validateP5Workflow(cached, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_NPM_CACHE")
    )
  );
  const lateIdentity = workflow.replace(
    "        run: ./scripts/run-p5-node-identity.ps1",
    "        run: Write-Output missing-identity"
  );
  assert.ok(
    validateP5Workflow(lateIdentity, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_NODE_IDENTITY_ORDER")
    )
  );
  const missingClock = workflow.replace(
    "        run: ./scripts/run-p5-attempt-clock.ps1",
    "        run: Write-Output missing-clock"
  );
  assert.ok(
    validateP5Workflow(missingClock, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_ATTEMPT_CLOCK")
    )
  );
  const skippedContract = workflow.replace(
    "            run_contract: true",
    "            run_contract: false"
  );
  assert.ok(
    validateP5Workflow(skippedContract, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CORE_MATRIX")
    )
  );
  const noOpContract = workflow.replace(
    "        run: node --test --test-concurrency=1 tests/p4-contract-baseline.test.mjs",
    "        run: Write-Output tests/p4-contract-baseline.test.mjs"
  );
  assert.ok(
    validateP5Workflow(noOpContract, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CORE_MATRIX")
    )
  );
  const maskedContract = workflow.replace(
    "        run: node --test --test-concurrency=1 tests/p4-contract-baseline.test.mjs",
    "        run: node --test --test-concurrency=1 tests/p4-contract-baseline.test.mjs; exit 0"
  );
  assert.ok(
    validateP5Workflow(maskedContract, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CORE_MATRIX")
    )
  );
  const decoyContract = workflow.replace(
    "        run: node --test --test-concurrency=1 tests/p4-contract-baseline.test.mjs",
    [
      "        run: |",
      "          $decoy = @'",
      "          - name: Run P4 targeted contract once",
      "            if: ${{ matrix.run_contract }}",
      "            run: node --test --test-concurrency=1 tests/p4-contract-baseline.test.mjs",
      "",
      "          - name: Decoy boundary",
      "          '@",
      "          Write-Output 'contract omitted'"
    ].join("\n")
  );
  assert.ok(
    validateP5Workflow(decoyContract, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CORE_MATRIX")
    )
  );
  const mismatchedTimeouts = structuredClone(profiles);
  mismatchedTimeouts.profiles.find(({ id }) => id === "unit").timeoutMinutes = 29;
  assert.ok(
    validateP5Workflow(workflow, toolchain.actions, mismatchedTimeouts).some(
      (entry) => entry.includes("P5E_PROFILE_JOB_POLICY:unit")
    )
  );
  const successOnlyEvidence = workflow.replace(
    "      - name: Write sanitized runner evidence\n        if: ${{ !cancelled() }}",
    "      - name: Write sanitized runner evidence\n        if: ${{ success() }}"
  );
  assert.notEqual(successOnlyEvidence, workflow);
  assert.ok(
    validateP5Workflow(successOnlyEvidence, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_FAILURE_EVIDENCE")
    )
  );
  const missingCheckRunId = workflow.replace(
    "P5_CHECK_RUN_ID: ${{ job.check_run_id }}",
    "P5_CHECK_RUN_ID: unavailable"
  );
  assert.ok(
    validateP5Workflow(missingCheckRunId, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CHECK_RUN_ID")
    )
  );
  const dirtySourceAccepted = workflow.replace(
    "        run: git diff --exit-code HEAD -- .",
    "        run: Write-Output source-integrity-omitted"
  );
  assert.ok(
    validateP5Workflow(dirtySourceAccepted, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_SOURCE_INTEGRITY")
    )
  );
  const decoyDependencyEvidence = workflow.replace(
    "-Profile dependency-review",
    "-Profile security"
  );
  assert.ok(
    validateP5Workflow(decoyDependencyEvidence, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_DEPENDENCY_REVIEW")
    )
  );
  const missingGateEvidence = workflow.replace(
    "./scripts/write-p5-gate-evidence.ps1",
    "Write-Output missing-gate-evidence"
  );
  assert.ok(
    validateP5Workflow(missingGateEvidence, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_GATE_GRAPH")
    )
  );
  const skippedDependencyReview = workflow.replace(
    "      - name: Review dependency changes\n        uses:",
    "      - name: Review dependency changes\n        if: ${{ false }}\n        uses:"
  );
  assert.ok(
    validateP5Workflow(skippedDependencyReview, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_DEPENDENCY_REVIEW")
    )
  );
  const warningDependencyReview = workflow.replace(
    "        uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0",
    [
      "        uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0",
      "        with:",
      "          warn-only: true"
    ].join("\n")
  );
  assert.ok(
    validateP5Workflow(warningDependencyReview, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_DEPENDENCY_REVIEW")
    )
  );
  const duplicateCoreLane = workflow.replace(
    "          - lane: previous\n            version: 0.145.0",
    [
      "          - lane: current",
      "            version: 0.146.0",
      "            sha256: bc343ba420dc2e2e9f59e6fc5e5bf0aae1cd8c771fc319665241fc9c0271fddb",
      "            run_contract: true",
      "          - lane: previous",
      "            version: 0.145.0"
    ].join("\n")
  );
  assert.ok(
    validateP5Workflow(duplicateCoreLane, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_CORE_MATRIX")
    )
  );
  const canaryIdentityStep = [
    "      - name: Verify exact Node identity",
    "        shell: pwsh",
    "        run: ./scripts/run-p5-node-identity.ps1",
    ""
  ].join("\n");
  const canaryJob = /^  next-canary:[\s\S]*?(?=^  gate:)/m.exec(workflow)[0];
  const lateCanaryJob = canaryJob
    .replace(canaryIdentityStep, "")
    .replace(
      "      - name: Write sanitized canary evidence",
      `${canaryIdentityStep}      - name: Write sanitized canary evidence`
    );
  const lateCanaryIdentity = workflow.replace(canaryJob, lateCanaryJob);
  assert.ok(
    validateP5Workflow(lateCanaryIdentity, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_NODE_IDENTITY_ORDER:next-canary")
    )
  );
  const dependencyEvidenceStep = /^      - name: Write sanitized runner evidence\r?\n[\s\S]*?(?=^  next-canary:)/m;
  const dependencyEvidenceDecoy = workflow.replace(
    dependencyEvidenceStep,
    [
      "      - name: Write sanitized runner evidence",
      "        if: ${{ !cancelled() }}",
      "        shell: pwsh",
      "        env:",
      "          P5_JOB_STATUS: ${{ job.status }}",
      "          P5_CHECK_RUN_ID: ${{ job.check_run_id }}",
      "        run: |",
      "          $decoy = @'",
      "          ./scripts/write-p5-runner-evidence.ps1",
      "          -Profile dependency-review",
      "          -ScenarioId P5-DEPENDENCY-001",
      "          -FixtureIds @('P5-DEPENDENCY-REVIEW-001')",
      "          executed-fail",
      "          github-job-status-normalized",
      "          '@",
      "          Write-Output 'evidence omitted'",
      ""
    ].join("\n")
  );
  assert.ok(
    validateP5Workflow(dependencyEvidenceDecoy, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_DEPENDENCY_REVIEW") || entry.includes("P5E_RUNNER_WRITER")
    )
  );
  const gateEvidenceStep = /^      - name: Write sanitized terminal gate evidence\r?\n[\s\S]*$/m;
  const gateEvidenceDecoy = workflow.replace(
    gateEvidenceStep,
    [
      "      - name: Write sanitized terminal gate evidence",
      "        if: ${{ !cancelled() }}",
      "        shell: pwsh",
      "        env:",
      "          P5_JOB_STATUS: ${{ job.status }}",
      "          P5_CHECK_RUN_ID: ${{ job.check_run_id }}",
      "        run: |",
      "          $decoy = @'",
      "          ./scripts/write-p5-gate-evidence.ps1",
      "          $env:POLICY_RESULT $env:BUILD_RESULT $env:UNIT_RESULT $env:CONTRACT_RESULT",
      "          $env:WINDOWS_RESULT $env:CLAUDE_RESULT $env:SECURITY_RESULT $env:DEPENDENCY_RESULT",
      "          '@",
      "          Write-Output 'gate evidence omitted'",
      ""
    ].join("\n")
  );
  assert.ok(
    validateP5Workflow(gateEvidenceDecoy, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_GATE_GRAPH")
    )
  );

  const disabledGateGuard = workflow.replace(
    "          if ($results.Where({ $_ -ne 'success' }).Count -ne 0) {",
    "          if ($false -and $results.Where({ $_ -ne 'success' }).Count -ne 0) {"
  );
  assert.ok(
    validateP5Workflow(disabledGateGuard, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_GATE_GRAPH")
    )
  );
  const wrongGateName = workflow.replace("    name: CI\n", "    name: Wrong # name: CI\n");
  assert.ok(
    validateP5Workflow(wrongGateName, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_GATE_GRAPH")
    )
  );
  const commentOnlyCanaryPolicy = workflow.replace(
    "    continue-on-error: true\n",
    "    # continue-on-error: true\n"
  );
  assert.ok(
    validateP5Workflow(commentOnlyCanaryPolicy, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_CANARY_POLICY")
    )
  );
  const dependencyJob = /^  dependency-review:[\s\S]*?(?=^  next-canary:)/m.exec(workflow)[0];
  const unreachableDependency = workflow.replace(
    dependencyJob,
    dependencyJob.replace(
      "          ./scripts/write-p5-runner-evidence.ps1 `",
      "          return\n          ./scripts/write-p5-runner-evidence.ps1 `"
    )
  );
  assert.ok(
    validateP5Workflow(unreachableDependency, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_DEPENDENCY_REVIEW") || entry.includes("P5E_RUNNER_WRITER")
    )
  );
  const splitDependencyStep = workflow.replace(
    dependencyJob,
    dependencyJob.replace(
      "        run: |\n          $observedStatus",
      "        run: Write-Output 'named evidence omitted'\n      - shell: pwsh\n        run: |\n          $observedStatus"
    )
  );
  assert.ok(
    validateP5Workflow(splitDependencyStep, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_DEPENDENCY_REVIEW") || entry.includes("P5E_RUNNER_WRITER")
    )
  );
  const unreachableGate = workflow.replace(
    "          ./scripts/write-p5-gate-evidence.ps1 `",
    "          return\n          ./scripts/write-p5-gate-evidence.ps1 `"
  );
  assert.ok(
    validateP5Workflow(unreachableGate, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_GATE_GRAPH")
    )
  );
  const noOpIdentity = workflow.replace(
    "        run: ./scripts/run-p5-node-identity.ps1",
    "        run: Write-Output './scripts/run-p5-node-identity.ps1'"
  );
  assert.ok(
    validateP5Workflow(noOpIdentity, toolchain.actions, profiles).some((entry) =>
      entry.includes("P5E_NODE_IDENTITY_ORDER") || entry.includes("P5E_WORKFLOW_DIGEST")
    )
  );
  for (const [needle, replacement] of [
    ["        run: npm run build", "        run: Write-Output 'npm run build'"],
    ["        run: actionlint.exe", "        run: Write-Output 'actionlint.exe'"],
    [
      "          node --test --test-concurrency=1\n          tests/bump-version.test.mjs",
      "          Write-Output 'node --test --test-concurrency=1'\n          tests/bump-version.test.mjs"
    ]
  ]) {
    const noOpOracle = workflow.replace(needle, replacement);
    assert.notEqual(noOpOracle, workflow);
    assert.ok(
      validateP5Workflow(noOpOracle, toolchain.actions, profiles).some((entry) =>
        entry.includes("P5E_WORKFLOW_DIGEST")
      )
    );
  }
});

test("P5-COVERAGE-NEGATIVE-001 every test and blocking profile maps exactly once", () => {
  const mutated = structuredClone(scenarios);
  const windows = mutated.scenarios.find(({ id }) => id === "P5-WINDOWS-001");
  windows.testFiles = windows.testFiles.filter(
    (testFile) => testFile !== "tests/p5-windows-resource.test.mjs"
  );
  const diagnostics = validateScenarioRegistry(mutated, root, profiles);
  assert.ok(
    diagnostics.some((entry) => entry.includes("P5E_BLOCKING_TEST_COVERAGE"))
  );
});

test("P5-EVIDENCE-001 local, hosted, not-run, canary, and blocked truth stays disjoint", () => {
  const evidence = readJson(
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json"
  );
  const evidenceSchema = p5EvidenceSchemas.get(evidence.schemaVersion);
  assert.ok(evidenceSchema, "P5E_TEST_EVIDENCE_SCHEMA_VERSION");
  assert.deepEqual(validateJsonSchema(evidence, evidenceSchema, "P5 evidence"), []);
  assert.deepEqual(validateP5Evidence(evidence, profiles), []);
  const mutations =
    evidence.schemaVersion === "p5-evidence-v3"
      ? [
          [
            "observation-removed",
            (value) => {
              value.hostedObservations.pop();
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "observation-order",
            (value) => {
              value.hostedObservations.reverse();
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "observation-duplicate",
            (value) => {
              value.hostedObservations[1] = structuredClone(
                value.hostedObservations[0]
              );
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "run-head",
            (value) => {
              value.hostedObservations[1].sourceHeadSha = "0".repeat(40);
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "step-conclusion",
            (value) => {
              value.hostedObservations[1].jobObservations[1].steps[8].conclusion =
                "success";
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "runner-tool-provenance",
            (value) => {
              value.hostedObservations[0].jobObservations[0]
                .runnerToolProjection.powershellVersion = "7.6.3";
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "rejected-promotion",
            (value) => {
              const [fragment] = value.hostedObservations[1].rejectedFragments.splice(
                0,
                1
              );
              fragment.fragmentStatus = "validated-rest-bound";
              fragment.validationErrorCodes = [];
              fragment.sanitizedLogProjection.hostedGateInput = true;
              value.hostedObservations[1].validatedFragments[0] = fragment;
            },
            "P5E_HOSTED_V3_TRUST_BOUNDARY"
          ],
          [
            "registry-digest",
            (value) => {
              value.hostedObservations[0].rejectedFragments[0]
                .expectedRegistrySha256 = "0".repeat(64);
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "artifact-count",
            (value) => {
              value.hostedObservations[0].artifacts.observedCount = 1;
            },
            "P5E_HOSTED_V3_BINDING"
          ],
          [
            "cache-attribution",
            (value) => {
              value.prRefCacheObservation.executionWindowAttribution = "observed";
            },
            "P5E_HOSTED_V3_CACHE"
          ],
          [
            "evidence-id",
            (value) => {
              value.profileResults.find(
                ({ profileId }) => profileId === "dependency-review"
              ).evidenceIds[0] = "fabricated";
            },
            "P5E_HOSTED_V3_PROFILE_EVIDENCE"
          ]
        ]
      : [
          [
            "collector-error",
            (value) => {
              value.hostedObservation.collectionErrors[0] = "fabricated";
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ],
          [
            "fragment-job",
            (value) => {
              value.hostedObservation.validatedFragments[0].jobName = "CI";
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ],
          [
            "fragment-powershell",
            (value) => {
              value.hostedObservation.validatedFragments[0].powershellVersion =
                "0.0.0";
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ],
          [
            "fragment-clock",
            (value) => {
              value.hostedObservation.validatedFragments[0].startedAt =
                "2030-01-01T00:00:00Z";
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ],
          [
            "fragment-wall",
            (value) => {
              value.hostedObservation.validatedFragments[0].wallTimeMs = 0;
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ],
          [
            "evidence-id",
            (value) => {
              value.profileResults.find(
                ({ profileId }) => profileId === "dependency-review"
              ).evidenceIds[0] = "fabricated";
            },
            "P5E_HOSTED_FAILURE_BINDING"
          ]
        ];
  for (const [label, mutate, diagnostic] of mutations) {
    const fabricated = structuredClone(evidence);
    mutate(fabricated);
    assert.ok(
      validateP5Evidence(fabricated, profiles).some((entry) =>
        entry.includes(diagnostic)
      ),
      label
    );
  }
  const unknown = structuredClone(evidence);
  unknown.schemaVersion = "p5-evidence-v999";
  assert.ok(
    validateP5Evidence(unknown, profiles).some((entry) =>
      entry.includes("P5E_EVIDENCE_SCHEMA_VERSION")
    )
  );
});

test("P5-EVIDENCE-V3-CLOSURE-001 accepts only the exact six-run closure", () => {
  const closure = p5ClosureFixture();
  const schema = p5EvidenceSchemas.get("p5-evidence-v3");
  assert.deepEqual(validateJsonSchema(closure, schema, "P5 evidence"), []);
  assert.deepEqual(validateP5Evidence(closure, profiles), []);

  for (const count of [3, 4, 5]) {
    const partial = structuredClone(closure);
    partial.hostedObservations.length = count;
    assert.ok(
      validateP5Evidence(partial, profiles).some((entry) =>
        entry.includes("P5E_HOSTED_V3_BINDING")
      )
    );
  }

  const mutations = [
    ["historical-digest", (value) => {
      value.hostedObservations[0].eventMergeSha = "0".repeat(40);
    }, "P5E_HOSTED_V3_BINDING"],
    ["remediation-order", (value) => {
      [value.hostedObservations[2], value.hostedObservations[3]] =
        [value.hostedObservations[3], value.hostedObservations[2]];
    }, "P5E_HOSTED_V3_BINDING"],
    ["duplicate-run", (value) => {
      value.hostedObservations[3] = structuredClone(value.hostedObservations[2]);
    }, "P5E_HOSTED_V3_BINDING"],
    ["remediation-source", (value) => {
      value.hostedObservations[3].sourceHeadSha = "0".repeat(40);
    }, "P5E_HOSTED_V3_BINDING"],
    ["attempt", (value) => {
      value.hostedObservations[3].runAttempt = 2;
    }, "P5E_HOSTED_V3_BINDING"],
    ["rerun", (value) => {
      value.hostedObservations[3].rerunCount = 1;
    }, "P5E_HOSTED_V3_BINDING"],
    ["conclusion", (value) => {
      value.hostedObservations[5].conclusion = "failure";
    }, "P5E_HOSTED_V3_BINDING"],
    ["job-set", (value) => {
      value.hostedObservations[5].jobObservations.pop();
    }, "P5E_HOSTED_V3_BINDING"],
    ["canary-promotion", (value) => {
      value.hostedObservations[5].validatedFragments
        .find(({ jobKey }) => jobKey === "next-canary")
        .sanitizedLogProjection.hostedGateInput = true;
    }, "P5E_HOSTED_V3_TRUST_BOUNDARY"],
    ["artifact-readback", (value) => {
      value.hostedObservations[5].artifacts.readbackStatus = "pending";
    }, "P5E_HOSTED_V3_BINDING"],
    ["cache-merge", (value) => {
      value.prRefCacheObservation.mergeSha = "0".repeat(40);
    }, "P5E_HOSTED_V3_CACHE"],
    ["profile-status", (value) => {
      value.profileResults.find(({ profileId }) => profileId === "security")
        .hostedStatus = "skipped";
    }, "P5E_HOSTED_V3_GATE"],
    ["evidence-id", (value) => {
      value.profileResults.find(({ profileId }) => profileId === "unit")
        .evidenceIds.push("fabricated");
    }, "P5E_HOSTED_V3_PROFILE_EVIDENCE"]
  ];
  for (const [label, mutate, diagnostic] of mutations) {
    const fabricated = structuredClone(closure);
    mutate(fabricated);
    assert.ok(
      validateP5Evidence(fabricated, profiles).some((entry) =>
        entry.includes(diagnostic)
      ),
      label
    );
  }
});

test("P5-PRIVACY-001 seeded credential, private path, and raw payload are rejected", () => {
  const seeded = {
    safe: "repository-relative",
    nested: {
      rawPayload: "must-not-persist",
      value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      location: "C:\\Users\\private\\fixture"
    }
  };
  const diagnostics = validateP5Privacy(seeded, "seeded");
  assert.ok(diagnostics.some((entry) => entry.includes("raw sensitive")));
  assert.ok(diagnostics.some((entry) => entry.includes("credential-shaped")));
  assert.ok(diagnostics.some((entry) => entry.includes("private host path")));
  assert.ok(
    validateP5Privacy(
      { ref: `feature/${"github" + "_pat_"}${"A".repeat(24)}` },
      "fine-grained-pat"
    ).some((entry) => entry.includes("credential-shaped"))
  );
});

test("P5-FALSE-GREEN-001 state D1 and Windows C0 cannot pass without runtime evidence", () => {
  const mutated = structuredClone(profiles);
  const c0 = mutated.profiles.find(({ id }) => id === "windows-c0");
  const d1 = mutated.profiles.find(({ id }) => id === "state-d1");
  c0.runtimeImplemented = true;
  c0.definitionStatus = "hosted-pass";
  d1.shippingBinding = "placeholder";
  d1.definitionStatus = "local-pass";
  c0.workflowJob = "windows-integration";
  c0.allowedEvidenceStatuses.push("hosted-pass");
  d1.workflowJob = "windows-integration";
  d1.allowedEvidenceStatuses.push("local-pass");
  const diagnostics = validateProfileRegistry(mutated, toolchain);
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_C0_FALSE_GREEN")));
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_D1_FALSE_GREEN")));
});

test("P5-SCOPE-NEGATIVE-001 exact allowlist entries reject suffix lookalikes", () => {
  assert.equal(isP5AllowedPath(".gitattributes"), true);
  assert.equal(isP5AllowedPath(".github/workflows/pull-request-ci.yml"), true);
  assert.equal(isP5AllowedPath("scripts/validate-p5.mjs"), true);
  assert.equal(isP5AllowedPath("tests/p5-new.test.mjs"), true);
  assert.equal(isP5AllowedPath(".github/workflows/pull-request-ci.yml.bak"), false);
  assert.equal(isP5AllowedPath(".gitattributes.bak"), false);
  assert.equal(isP5AllowedPath("scripts/validate-p5.mjs.unreviewed"), false);
});

test("P5-LEDGER-NEGATIVE-001 attempt order, identity, and outcomes fail closed", () => {
  const ledger = readJson("evidence/ledgers/p5-attempts.json");
  assert.deepEqual(validateAttemptLedger(ledger), []);
  const mutated = structuredClone(ledger);
  mutated.attempts[1].ordinal = 999;
  mutated.attempts[1].id = mutated.attempts[0].id;
  mutated.attempts[1].executionStatus = "executed-pass";
  mutated.attempts[1].unreviewed = true;
  const diagnostics = validateAttemptLedger(mutated);
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_LEDGER_ORDINAL")));
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_LEDGER_ID")));
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_LEDGER_OUTCOME")));
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_LEDGER_PROPERTIES")));
});

test("P5-CANARY-NEGATIVE-001 canary cannot satisfy a blocking profile", () => {
  const mutated = structuredClone(profiles);
  const canary = mutated.profiles.find(({ id }) => id === "next-canary");
  canary.blocking = true;
  canary.continueOnError = false;
  const diagnostics = validateProfileRegistry(mutated, toolchain);
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_CANARY_BLOCKING")));
});

test("P5-P4-BINDING-001 inherited invalid P4 source claim remains explicit", () => {
  assert.deepEqual(
    profiles.baselineBlockers.find(
      ({ id }) => id === "P5-BLOCK-P4-SOURCE-BINDING"
    ),
    {
      id: "P5-BLOCK-P4-SOURCE-BINDING",
      recordedCommit: "843e679a90d4ef6946af251d36f43d257f8a5a10",
      actualCommit: "843e679936daba71a6c4c2fdd55fcade01b46b73",
      recordedCommitResolvable: false,
      status: "blocked-with-evidence",
      correctionScope: "separate P4 evidence repair; P5 does not rewrite P4 evidence"
    }
  );
});
