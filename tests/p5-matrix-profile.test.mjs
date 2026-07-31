import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateP5Evidence,
  validateP5Privacy,
  validateP5Workflow,
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
  const diagnostics = validateProfileRegistry(mutated, toolchain);
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_C0_FALSE_GREEN")));
  assert.ok(diagnostics.some((entry) => entry.includes("P5E_D1_FALSE_GREEN")));
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
