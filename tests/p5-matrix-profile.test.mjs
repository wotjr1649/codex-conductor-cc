import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateAttemptLedger,
  validateP5Evidence,
  validateP5Privacy,
  validateP5Workflow,
  isP5AllowedPath,
  validateProfileRegistry,
  validateScenarioRegistry
} from "../scripts/lib/p5-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

const toolchain = readJson("toolchain.json");
const profiles = readJson("ci/matrix-profiles-v1.json");
const scenarios = readJson("ci/scenario-registry-v1.json");
const workflow = readFileSync(
  path.join(root, ".github", "workflows", "pull-request-ci.yml"),
  "utf8"
);

test("P5-RED-001 versioned profile, scenario, schema, and evidence sources exist", () => {
  for (const relativePath of [
    "ci/matrix-profiles-v1.json",
    "ci/scenario-registry-v1.json",
    "evidence/schemas/p5-evidence-v1.schema.json",
    "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json",
    "evidence/ledgers/p5-attempts.json",
    "scripts/validate-p5.mjs",
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
  const mismatchedTimeouts = structuredClone(profiles);
  mismatchedTimeouts.profiles.find(({ id }) => id === "unit").timeoutMinutes = 29;
  assert.ok(
    validateP5Workflow(workflow, toolchain.actions, mismatchedTimeouts).some(
      (entry) => entry.includes("P5E_PROFILE_JOB_POLICY:unit")
    )
  );
  const successOnlyEvidence = workflow.replace(
    "        if: ${{ !cancelled() }}",
    "        if: ${{ success() }}"
  );
  assert.ok(
    validateP5Workflow(successOnlyEvidence, toolchain.actions, profiles).some(
      (entry) => entry.includes("P5E_FAILURE_EVIDENCE")
    )
  );
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
  assert.equal(isP5AllowedPath(".github/workflows/pull-request-ci.yml"), true);
  assert.equal(isP5AllowedPath("scripts/validate-p5.mjs"), true);
  assert.equal(isP5AllowedPath("tests/p5-new.test.mjs"), true);
  assert.equal(isP5AllowedPath(".github/workflows/pull-request-ci.yml.bak"), false);
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
