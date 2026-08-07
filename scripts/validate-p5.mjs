#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/p4-schema-validator.mjs";
import {
  P5_BOOTSTRAP_FRONTIER,
  isExactP5BootstrapCheckout,
  validateAttemptLedger,
  validateP5Evidence,
  validateP5Privacy,
  validateP5Workflow,
  isP5AllowedPath,
  validateProfileRegistry,
  validateScenarioRegistry
} from "./lib/p5-validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P4_FINAL = "84515289913dfe8a7452754ad442d37873bdfd53";
const ACTUAL_P4_SOURCE = "843e679936daba71a6c4c2fdd55fcade01b46b73";
const RECORDED_P4_SOURCE = "843e679a90d4ef6946af251d36f43d257f8a5a10";
const P4_SOURCE_ERRATUM_SCHEMA =
  "evidence/schemas/p5-p4-source-binding-erratum-v1.schema.json";
const P4_SOURCE_ERRATUM =
  "evidence/manifests/p5/p4-source-binding-erratum-20260807.json";
const P4_SOURCE_ERRATUM_REPAIR_BASE = "b947ac4c8c6483812d93105a6046cedd0feb9643";
const P4_SOURCE_ERRATUM_REPAIR_PATHS = [
  P4_SOURCE_ERRATUM_SCHEMA,
  P4_SOURCE_ERRATUM,
  "scripts/validate-p5.mjs",
  "tests/p5-matrix-profile.test.mjs"
];
const INTEGRATION_MAIN = "de6aa123bb1b6aacefeac2953df5c0817e3b93d2";
const INTEGRATION_MAIN_PATHS = ["docs/FORK_AND_PORTING_STRATEGY.md"];
const P5_INTEGRATION_REPAIRS = [
  {
    base: "ca9204646deb8c024cd76985092720ede2552028",
    paths: ["scripts/validate-p5.mjs", "tests/p5-matrix-profile.test.mjs"]
  },
  {
    base: "5ddb05da90378c97b54d5c86822fe6d33c643160",
    paths: ["scripts/validate-p5.mjs", "tests/p5-windows-resource.test.mjs"]
  },
  {
    base: "75523be882f8c67097cf9ec007de53a3cd920680",
    paths: ["scripts/validate-p5.mjs", "tests/p5-windows-resource.test.mjs"]
  },
  {
    base: P4_SOURCE_ERRATUM_REPAIR_BASE,
    paths: P4_SOURCE_ERRATUM_REPAIR_PATHS
  }
];
const errors = [];

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function gitProbe(args) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

function git(args) {
  const result = gitProbe(args);
  if (result.status !== 0) {
    errors.push(`git ${args.join(" ")}: exit ${result.status}`);
    return "";
  }
  return result.stdout.trimEnd();
}

const gitLines = (args) =>
  git(args)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"));
const commitParents = (commit) =>
  git(["rev-list", "--parents", "-n", "1", commit])
    .trim()
    .split(/\s+/)
    .slice(1);
const commitPaths = (commit) =>
  gitLines(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]);
const samePathSet = (actual, expected) => {
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((item) => actualSet.has(item));
};

function resolveValidationHead() {
  if (process.env.GITHUB_ACTIONS !== "true") return "HEAD";

  try {
    const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
    const eventStat = fs.statSync(eventPath);
    if (!eventStat.isFile() || eventStat.size > 1024 * 1024) throw new Error();
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const pullRequestNumber = event?.number;
    const base = event?.pull_request?.base;
    const head = event?.pull_request?.head;
    const baseSha = base?.sha ?? "";
    const headSha = head?.sha ?? "";
    const checkoutSha = gitProbe(["rev-parse", "HEAD"]);
    const checkoutParents = gitProbe(["rev-list", "--parents", "-n", "1", "HEAD"]);
    const parents = checkoutParents.stdout.trim().split(/\s+/).slice(1);
    const sha = /^[0-9a-f]{40}$/;

    if (
      process.env.GITHUB_EVENT_NAME !== "pull_request" ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber < 1 ||
      !repository ||
      event?.repository?.full_name !== repository ||
      base?.repo?.full_name !== repository ||
      base?.ref !== process.env.GITHUB_BASE_REF ||
      head?.ref !== process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF !== `refs/pull/${pullRequestNumber}/merge` ||
      !sha.test(baseSha) ||
      !sha.test(headSha) ||
      !sha.test(process.env.GITHUB_SHA ?? "") ||
      checkoutSha.status !== 0 ||
      checkoutSha.stdout.trim() !== process.env.GITHUB_SHA ||
      checkoutParents.status !== 0 ||
      parents.length !== 2 ||
      parents[0] !== baseSha ||
      parents[1] !== headSha
    ) {
      throw new Error();
    }
    return headSha;
  } catch {
    errors.push("P5E_PR_HEAD");
    return "HEAD";
  }
}

const requiredFiles = [
  "ci/matrix-profiles-v1.json",
  "ci/scenario-registry-v1.json",
  "evidence/inventory/p5-prechange-20260731.json",
  "evidence/schemas/p5-evidence-v1.schema.json",
  "evidence/schemas/p5-evidence-v2.schema.json",
  "evidence/schemas/p5-evidence-v3.schema.json",
  "evidence/schemas/p5-runner-evidence-v2.schema.json",
  "evidence/schemas/p5-gate-evidence-v1.schema.json",
  "evidence/schemas/p5-hosted-harvest-v1.schema.json",
  P4_SOURCE_ERRATUM_SCHEMA,
  "evidence/manifests/p5/p5-matrix-profile-bootstrap-20260731.json",
  P4_SOURCE_ERRATUM,
  "evidence/ledgers/p5-attempts.json",
  "scripts/invoke-p4-validator-at-handoff.ps1",
  "scripts/run-p5-attempt-clock.ps1",
  "scripts/run-p5-node-identity.ps1",
  "scripts/run-p5-hosted-evidence-collector.mjs",
  "scripts/run-p5-core-contract.mjs",
  "scripts/run-p5-p4-generator.mjs",
  "scripts/lib/p5-runner-provenance.psm1",
  "scripts/write-p5-gate-evidence.ps1",
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
const evidenceSchemaPaths = new Map([
  ["p5-evidence-v1", "evidence/schemas/p5-evidence-v1.schema.json"],
  ["p5-evidence-v2", "evidence/schemas/p5-evidence-v2.schema.json"],
  ["p5-evidence-v3", "evidence/schemas/p5-evidence-v3.schema.json"]
]);
const evidenceSchemaPath = evidenceSchemaPaths.get(evidence?.schemaVersion);
if (!evidenceSchemaPath) {
  errors.push(
    `P5E_EVIDENCE_SCHEMA_VERSION: unsupported schema version ${
      evidence?.schemaVersion ?? "missing"
    }`
  );
}
const schema = evidenceSchemaPath ? readJson(evidenceSchemaPath) : null;
const runnerEvidenceSchema = readJson("evidence/schemas/p5-runner-evidence-v2.schema.json");
const gateEvidenceSchema = readJson("evidence/schemas/p5-gate-evidence-v1.schema.json");
const hostedHarvestSchema = readJson("evidence/schemas/p5-hosted-harvest-v1.schema.json");
const sourceErratumSchema = readJson(P4_SOURCE_ERRATUM_SCHEMA);
const sourceErratum = readJson(P4_SOURCE_ERRATUM);
const ledger = readJson("evidence/ledgers/p5-attempts.json");
const inventory = readJson("evidence/inventory/p5-prechange-20260731.json");
const baselinePath = path.join(
  ROOT,
  "docs",
  "baselines",
  "2026-07-31-p5-matrix-profile-bootstrap.md"
);

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
const runnerWriterPath = path.join(ROOT, "scripts", "write-p5-runner-evidence.ps1");
if (fs.existsSync(runnerWriterPath)) {
  const runnerWriter = fs.readFileSync(runnerWriterPath, "utf8");
  const provenanceModule = fs.readFileSync(
    path.join(ROOT, "scripts", "lib", "p5-runner-provenance.psm1"),
    "utf8"
  );
  const gateWriter = fs.readFileSync(
    path.join(ROOT, "scripts", "write-p5-gate-evidence.ps1"),
    "utf8"
  );
  const provenanceSources = `${runnerWriter}\n${provenanceModule}\n${gateWriter}`;
  for (const invariant of [
    "$runnerEnvironment -cne 'github-hosted'",
    "$runnerOS -cne 'Windows'",
    "$runnerArch -cne 'X64'",
    "$logicalDisk.FileSystem -cne 'NTFS'",
    "P5E_FALSE_GREEN",
    "nodeIdentityStatus",
    "nodeIdentityRequired",
    "finalizer-fallback",
    "rawExitCodeSource",
    "P5E_HOSTED_RUNNER",
    "actualCheckoutSha",
    "eventMergeSha",
    "checkRunId",
    "jobAttempt",
    "workflowRerunCount",
    "P5_SANITIZED_EVIDENCE_JSON=",
    "Windows Server 2025",
    "$sourceHeadSha = $pullRequest.headSha",
    "$actualCheckoutSha -cne $eventMergeSha",
    "$repository -cne [string]$event.repository.full_name",
    "$pullRequest.baseRepository -cne $repository",
    "[int]$os.ProductType -ne 3"
  ]) {
    if (!provenanceSources.includes(invariant)) {
      errors.push(`P5E_RUNNER_WRITER_INVARIANT:${invariant}`);
    }
  }
}
if (
  runnerEvidenceSchema?.properties?.schemaVersion?.const !== "p5-runner-evidence-v2" ||
  gateEvidenceSchema?.properties?.schemaVersion?.const !== "p5-gate-evidence-v1" ||
  hostedHarvestSchema?.properties?.schemaVersion?.const !== "p5-hosted-harvest-v1"
) {
  errors.push("P5E_HOSTED_EVIDENCE_SCHEMA: versioned runner and gate schemas are required");
}
if (evidence && schema) {
  errors.push(...validateJsonSchema(evidence, schema, "P5 evidence"));
  errors.push(...validateP5Evidence(evidence, profiles));
}
if (sourceErratum && sourceErratumSchema) {
  errors.push(
    ...validateJsonSchema(
      sourceErratum,
      sourceErratumSchema,
      "P4 source-binding erratum"
    )
  );
}
if (
  sourceErratum?.schemaVersion !== "p5-p4-source-binding-erratum-v1" ||
  sourceErratum?.id !== "P5-P4-SOURCE-BINDING-ERRATUM-20260807" ||
  sourceErratum?.subject?.p4FinalCommit !== P4_FINAL ||
  sourceErratum?.subject?.recordedSourceCommit !== RECORDED_P4_SOURCE ||
  sourceErratum?.subject?.actualSourceCommit !== ACTUAL_P4_SOURCE ||
  sourceErratum?.correction?.actualSourceCommit !== ACTUAL_P4_SOURCE ||
  sourceErratum?.correction?.relationship !== "first-parent-of-p4-final" ||
  sourceErratum?.correction?.disposition !== "corrected-append-only" ||
  sourceErratum?.correction?.immutableP4EvidenceRewritten !== false ||
  sourceErratum?.verification?.recordedSourceResolvable !== false ||
  sourceErratum?.verification?.actualSourceResolvable !== true ||
  sourceErratum?.verification?.actualSourceIsFirstParent !== true ||
  JSON.stringify(sourceErratum?.supersedesClaimsIn) !==
    JSON.stringify([
      "docs/baselines/2026-07-31-p4-contract-baseline.md",
      "evidence/ledgers/p4-attempts.json",
      "evidence/manifests/p4/p4-contract-baseline-20260731.json"
    ])
) {
  errors.push("P5E_P4_SOURCE_ERRATUM");
}
if (ledger) errors.push(...validateAttemptLedger(ledger));
if (
  !ledger?.attempts?.some(
    (attempt) =>
      attempt.id === "p5-red-001" &&
      attempt.executionStatus === "executed-fail" &&
      attempt.rawExitCode === 1 &&
      attempt.retryCount === 0
  )
) {
  errors.push("P5E_LEDGER_RED: meaningful RED must remain in the ordered ledger");
}
const validationHead = resolveValidationHead();
const boundSource = evidence?.source?.sourceCommit ?? "";
const boundSourceType = spawnSync("git", ["cat-file", "-t", boundSource], {
  cwd: ROOT,
  encoding: "utf8",
  shell: false,
  windowsHide: true
});
const p4ToSource = spawnSync(
  "git",
  ["merge-base", "--is-ancestor", P4_FINAL, boundSource],
  { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true }
);
const sourceToHead = spawnSync(
  "git",
  ["merge-base", "--is-ancestor", boundSource, validationHead],
  { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true }
);
const baseline = fs.existsSync(baselinePath)
  ? fs.readFileSync(baselinePath, "utf8")
  : "";
if (
  boundSourceType.status !== 0 ||
  boundSourceType.stdout.trim() !== "commit" ||
  p4ToSource.status !== 0 ||
  sourceToHead.status !== 0 ||
  ledger?.sourceCommit !== boundSource ||
  !baseline.includes(`Source commit: \`${boundSource}\``)
) {
  errors.push(
    "P5E_SOURCE_BINDING: manifest, ledger, baseline, resolvable source commit, and P4 ancestry must agree"
  );
}
const evidenceOnlyFiles = new Set([
  "docs/baselines/2026-07-31-p5-matrix-profile-bootstrap.md",
  "evidence/ledgers/p5-attempts.json"
]);
const evidenceOnlyPrefixes = ["evidence/manifests/p5/"];
const isEvidenceOnlyPath = (relativePath) =>
  evidenceOnlyFiles.has(relativePath) ||
  evidenceOnlyPrefixes.some((allowedPath) => relativePath.startsWith(allowedPath));
const uncommittedPaths = [
  ...gitLines(["diff", "--name-only"]),
  ...gitLines(["diff", "--name-only", "--cached"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"])
];
const bootstrapContext = {
  boundSource,
  evidenceRebindParents: commitParents(P5_BOOTSTRAP_FRONTIER.evidenceRebindCommit),
  windowsFixParents: commitParents(P5_BOOTSTRAP_FRONTIER.windowsFixCommit),
  evidenceRebindPaths: commitPaths(P5_BOOTSTRAP_FRONTIER.evidenceRebindCommit),
  windowsFixPaths: commitPaths(P5_BOOTSTRAP_FRONTIER.windowsFixCommit),
  policyCommitParents: commitParents(P5_BOOTSTRAP_FRONTIER.policyCommit),
  policyCommitPaths: commitPaths(P5_BOOTSTRAP_FRONTIER.policyCommit),
  uncommittedPaths
};
const headParents = commitParents(validationHead);
const exactBootstrap = isExactP5BootstrapCheckout(
  headParents,
  [validationHead, ...headParents].map((candidate) => ({
    ...bootstrapContext,
    headParents: commitParents(candidate),
    policyPaths: commitPaths(candidate)
  }))
);
const validationHeadSha = git(["rev-parse", validationHead]);
const exactRepairCommit = (commit) =>
  commitParents(commit).length === 1 &&
  commitParents(commit)[0] === P4_SOURCE_ERRATUM_REPAIR_BASE &&
  samePathSet(commitPaths(commit), P4_SOURCE_ERRATUM_REPAIR_PATHS);
const attemptedMainSync =
  headParents.length === 2 && headParents[1] === INTEGRATION_MAIN;
const exactMainSync =
  attemptedMainSync &&
  uncommittedPaths.length === 0 &&
  exactRepairCommit(headParents[0]) &&
  samePathSet(
    gitLines(["diff", "--name-only", `${headParents[0]}..${validationHead}`]),
    INTEGRATION_MAIN_PATHS
  ) &&
  INTEGRATION_MAIN_PATHS.every(
    (relativePath) =>
      git(["rev-parse", `${validationHead}:${relativePath}`]) ===
      git(["rev-parse", `${INTEGRATION_MAIN}:${relativePath}`])
  );
if (attemptedMainSync && !exactMainSync) {
  errors.push("P5E_INTEGRATION_MAIN");
}
const exactIntegrationRepair = exactMainSync || P5_INTEGRATION_REPAIRS.some(
  ({ base, paths }) =>
    (validationHeadSha === base && samePathSet(uncommittedPaths, paths)) ||
    (uncommittedPaths.length === 0 &&
      headParents.length === 1 &&
      headParents[0] === base &&
      samePathSet(commitPaths(validationHead), paths))
);
const postSourcePaths = [
  ...gitLines(["diff", "--name-only", `${boundSource}..${validationHead}`]),
  ...uncommittedPaths
]
  .filter(Boolean);
for (const relativePath of new Set(postSourcePaths)) {
  if (!exactBootstrap && !exactIntegrationRepair && !isEvidenceOnlyPath(relativePath)) {
    errors.push(`P5E_POST_SOURCE_CHANGE:${relativePath}`);
  }
}
if (
  inventory?.source?.handoffCommit !== P4_FINAL ||
  inventory?.source?.actualP4SourceCommit !== ACTUAL_P4_SOURCE ||
  inventory?.source?.recordedP4SourceResolvable !== false ||
  inventory?.source?.sourceBindingDisposition !== "blocked-with-evidence"
) {
  errors.push("P5E_INVENTORY: exact prechange handoff and source-binding blocker required");
}
for (const authored of [inventory, ledger, evidence, sourceErratum, profiles, scenarios]) {
  if (authored) errors.push(...validateP5Privacy(authored, "authoredEvidence"));
}

if (git(["rev-parse", `${P4_FINAL}^`]) !== ACTUAL_P4_SOURCE) {
  errors.push("P5E_P4_PARENT: exact P4 final parent changed");
}
const recordedType = spawnSync(
  "git",
  ["cat-file", "-t", RECORDED_P4_SOURCE],
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
  const diff = git([
    "diff",
    "--name-only",
    `${P4_FINAL}..${validationHead}`,
    "--",
    immutablePath
  ]);
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

const changed = [
  ...gitLines(["diff", "--name-only", `${P4_FINAL}..${validationHead}`]),
  ...uncommittedPaths
];
for (const relativePath of new Set(changed)) {
  if (
    !isP5AllowedPath(relativePath) &&
    !(exactMainSync && INTEGRATION_MAIN_PATHS.includes(relativePath))
  ) {
    errors.push(`P5E_SCOPE: path outside P5 allowlist: ${relativePath}`);
  }
}
const binary = [
  git(["diff", "--numstat", `${P4_FINAL}..${validationHead}`]),
  git(["diff", "--numstat", validationHead])
]
  .join("\n")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("-\t-\t"));
if (binary.length > 0) errors.push("P5E_BINARY: committed binary additions are forbidden");
// PORTABILITY_CONTINUATION_BEGIN
if (
  gitProbe([
    "merge-base",
    "--is-ancestor",
    "099afca5946debe5620411f2ab1d4aec388918ca",
    validationHead
  ]).status === 0
) {
  const {
    filterLegacyP5ContinuationErrors,
    validatePortabilityRepository
  } = await import(
    "./lib/portability-continuity.mjs"
  );
  const portabilityErrors = validatePortabilityRepository(ROOT, validationHead);
  if (portabilityErrors.length === 0) {
    const allowedPaths = [
      ...gitLines([
        "diff",
        "--name-only",
        `${boundSource}..099afca5946debe5620411f2ab1d4aec388918ca`
      ]),
      ...gitLines([
        "diff",
        "--name-only",
        `099afca5946debe5620411f2ab1d4aec388918ca..${validationHead}`
      ]),
      ...uncommittedPaths
    ];
    const remainingErrors = filterLegacyP5ContinuationErrors(errors, allowedPaths);
    errors.length = 0;
    errors.push(...remainingErrors);
  }
  errors.push(...portabilityErrors);
}
// PORTABILITY_CONTINUATION_END

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
