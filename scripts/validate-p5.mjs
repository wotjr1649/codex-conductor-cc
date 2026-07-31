#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/p4-schema-validator.mjs";
import {
  validateP5Evidence,
  validateP5Privacy,
  validateP5Workflow,
  validateProfileRegistry,
  validateScenarioRegistry
} from "./lib/p5-validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P4_FINAL = "84515289913dfe8a7452754ad442d37873bdfd53";
const ACTUAL_P4_SOURCE = "843e679936daba71a6c4c2fdd55fcade01b46b73";
const errors = [];

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0) {
    errors.push(`git ${args.join(" ")}: exit ${result.status}`);
    return "";
  }
  return result.stdout.trimEnd();
}

const requiredFiles = [
  "ci/matrix-profiles-v1.json",
  "ci/scenario-registry-v1.json",
  "evidence/inventory/p5-prechange-20260731.json",
  "evidence/schemas/p5-evidence-v1.schema.json",
  "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json",
  "evidence/ledgers/p5-attempts.json",
  "scripts/invoke-p4-validator-at-handoff.ps1",
  "scripts/run-p5-core-contract.mjs",
  "scripts/run-p5-p4-generator.mjs",
  "scripts/write-p5-runner-evidence.ps1",
  "tests/p5-matrix-profile.test.mjs",
  "tests/p5-windows-resource.test.mjs",
  "docs/baselines/2026-07-31-p5-matrix-profile-bootstrap.md"
];
for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT, relativePath))) {
    errors.push(`${relativePath}: required file is missing`);
  }
}

const toolchain = readJson("toolchain.json");
const profiles = readJson("ci/matrix-profiles-v1.json");
const scenarios = readJson("ci/scenario-registry-v1.json");
const evidence = readJson(
  "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json"
);
const schema = readJson("evidence/schemas/p5-evidence-v1.schema.json");
const ledger = readJson("evidence/ledgers/p5-attempts.json");
const inventory = readJson("evidence/inventory/p5-prechange-20260731.json");

if (profiles) errors.push(...validateProfileRegistry(profiles, toolchain));
if (scenarios && profiles) {
  errors.push(...validateScenarioRegistry(scenarios, ROOT, profiles));
}
const workflowPath = path.join(ROOT, ".github", "workflows", "pull-request-ci.yml");
if (fs.existsSync(workflowPath) && profiles) {
  errors.push(
    ...validateP5Workflow(
      fs.readFileSync(workflowPath, "utf8"),
      toolchain?.actions ?? [],
      profiles
    )
  );
}
if (evidence && schema) {
  errors.push(...validateJsonSchema(evidence, schema, "P5 evidence"));
  errors.push(...validateP5Evidence(evidence, profiles));
}
if (
  ledger?.schemaVersion !== "p5-attempt-ledger-v1" ||
  !Array.isArray(ledger.attempts) ||
  ledger.attempts.length === 0 ||
  !ledger.attempts.some(
    (attempt) =>
      attempt.id === "p5-red-001" &&
      attempt.executionStatus === "executed-fail" &&
      attempt.rawExitCode === 1 &&
      attempt.retryCount === 0
  )
) {
  errors.push("P5E_LEDGER: meaningful RED and ordered material attempts are required");
}
if (
  inventory?.source?.handoffCommit !== P4_FINAL ||
  inventory?.source?.actualP4SourceCommit !== ACTUAL_P4_SOURCE ||
  inventory?.source?.recordedP4SourceResolvable !== false ||
  inventory?.source?.sourceBindingDisposition !== "blocked-with-evidence"
) {
  errors.push("P5E_INVENTORY: exact prechange handoff and source-binding blocker required");
}
for (const authored of [inventory, ledger, evidence, profiles, scenarios]) {
  if (authored) errors.push(...validateP5Privacy(authored, "authoredEvidence"));
}

if (git(["rev-parse", `${P4_FINAL}^`]) !== ACTUAL_P4_SOURCE) {
  errors.push("P5E_P4_PARENT: exact P4 final parent changed");
}
const recordedType = spawnSync(
  "git",
  ["cat-file", "-t", "843e679a90d4ef6946af251d36f43d257f8a5a10"],
  { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true }
);
if (recordedType.status === 0) {
  errors.push("P5E_P4_SOURCE_BLOCKER: recorded invalid P4 source unexpectedly resolves");
}

const immutablePaths = [
  "contracts/codex",
  "plugins/codex/commands",
  "plugins/codex/agents",
  "plugins/codex/skills",
  "plugins/codex/hooks",
  "plugins/codex/scripts",
  "toolchain.json",
  "security/p3-policy.json",
  "package-lock.json",
  "LICENSE",
  "NOTICE",
  "evidence/manifests/p3",
  "evidence/manifests/p4",
  "evidence/ledgers/p3-attempts.json",
  "evidence/ledgers/p4-attempts.json",
  "evidence/inventory/p4-prechange-20260731.json",
  "evidence/schemas/p4-contract-tools-v1.schema.json",
  "evidence/schemas/p4-evidence-v1.schema.json",
  "tests/contract",
  "tests/p4-contract-baseline.test.mjs",
  "scripts/generate-p4-contracts.mjs",
  "scripts/install-p4-codex.ps1",
  "scripts/run-p4-lifecycle.mjs",
  "scripts/validate-p4.mjs",
  "scripts/lib/p4-lifecycle-fixture.mjs",
  "scripts/lib/p4-schema-validator.mjs",
  "scripts/lib/p4-snapshot.mjs",
  "docs/baselines/2026-07-31-p3-threat-toolchain-baseline.md",
  "docs/baselines/2026-07-31-p4-contract-baseline.md"
];
for (const immutablePath of immutablePaths) {
  const diff = git(["diff", "--name-only", P4_FINAL, "--", immutablePath]);
  const status = git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    immutablePath
  ]);
  if (diff || status) errors.push(`P5E_IMMUTABLE_PATH:${immutablePath}`);
}
if (
  git(["rev-parse", `${P4_FINAL}:contracts/codex`]) !==
  "0bdf12fd860076bd9ad57c400d24a368e92f5bd6"
) {
  errors.push("P5E_P4_CONTRACT_TREE: exact P4 contract tree changed");
}

const allowed = [
  ".github/workflows/pull-request-ci.yml",
  "ci/",
  "docs/baselines/2026-07-31-p5-",
  "evidence/inventory/p5-",
  "evidence/ledgers/p5-",
  "evidence/manifests/p5/",
  "evidence/schemas/p5-",
  "scripts/invoke-p4-validator-at-handoff.ps1",
  "scripts/run-p5-",
  "scripts/validate-p5.mjs",
  "scripts/write-p5-runner-evidence.ps1",
  "scripts/lib/p5-",
  "tests/p5-"
];
const changed = [
  ...git(["diff", "--name-only", `${P4_FINAL}..HEAD`]).split(/\r?\n/),
  ...git(["diff", "--name-only"]).split(/\r?\n/),
  ...git(["diff", "--name-only", "--cached"]).split(/\r?\n/),
  ...git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/)
].filter(Boolean);
for (const relativePath of new Set(changed.map((item) => item.replaceAll("\\", "/")))) {
  if (!allowed.some((prefix) => relativePath.startsWith(prefix))) {
    errors.push(`P5E_SCOPE: path outside P5 allowlist: ${relativePath}`);
  }
}
const binary = git(["diff", "--numstat", P4_FINAL])
  .split(/\r?\n/)
  .filter((line) => line.startsWith("-\t-\t"));
if (binary.length > 0) errors.push("P5E_BINARY: committed binary additions are forbidden");

if (errors.length > 0) {
  process.stderr.write(
    `P5 validation failed with ${errors.length} error(s):\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "P5 validation passed: exact profiles, scenario coverage, workflow policy, local/hosted truth, privacy, and immutable P2/P3/P4 readbacks are consistent.\n"
  );
}
