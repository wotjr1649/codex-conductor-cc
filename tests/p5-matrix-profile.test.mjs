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

test("P5-RED-001 versioned profile, scenario, schema, and evidence sources exist", () => {
  for (const relativePath of [
    "ci/matrix-profiles-v1.json",
    "ci/scenario-registry-v1.json",
    "evidence/schemas/p5-evidence-v1.schema.json",
    "evidence/schemas/p5-evidence-v2.schema.json",
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
    "$resolvedNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source",
    `if (-not [string]::Equals([IO.Path]::GetFullPath($resolvedNode), [IO.Path]::GetFullPath(${psQuote(process.execPath)}), [StringComparison]::OrdinalIgnoreCase)) { throw 'P5E_TEST_NODE_PATH' }`
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
    assert.equal(moduleProbe.status, 0, "P5E_TEST_MODULE_PROBE");

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
  assert.deepEqual(validateP5Evidence(evidence, profiles), []);
  for (const [label, mutate] of [
    ["collector-error", (value) => { value.hostedObservation.collectionErrors[0] = "fabricated"; }],
    ["fragment-job", (value) => { value.hostedObservation.validatedFragments[0].jobName = "CI"; }],
    ["fragment-powershell", (value) => { value.hostedObservation.validatedFragments[0].powershellVersion = "0.0.0"; }],
    ["fragment-clock", (value) => { value.hostedObservation.validatedFragments[0].startedAt = "2030-01-01T00:00:00Z"; }],
    ["fragment-wall", (value) => { value.hostedObservation.validatedFragments[0].wallTimeMs = 0; }],
    [
      "evidence-id",
      (value) => {
        value.profileResults.find(({ profileId }) => profileId === "dependency-review")
          .evidenceIds[0] = "fabricated";
      }
    ]
  ]) {
    const fabricated = structuredClone(evidence);
    mutate(fabricated);
    assert.ok(
      validateP5Evidence(fabricated, profiles).some((entry) =>
        entry.includes("P5E_HOSTED_FAILURE_BINDING")
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
