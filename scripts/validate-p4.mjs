#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { digestGeneratedTree } from "./lib/generated-tree-transaction.mjs";
import {
  inspectSnapshotTree,
  readMethodInventory
} from "./lib/p4-snapshot.mjs";
import { validateJsonSchema } from "./lib/p4-schema-validator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "34559b5a55fbc3b171e3f472080729795632b74f";
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PRIVATE_PATH =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\(?:[?.]\\|wsl\$\\)|\/(?:home|Users)\/)/i;
const SECRET =
  /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{20,})/;
const errors = [];

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function shaFile(relativePath) {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest("hex");
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
  return result.stdout.replace(/\s+$/, "");
}

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, location) {
  if (!ownObject(value)) {
    errors.push(`${location}: object required`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${location}: exact fields required (${wanted.join(", ")})`);
  }
}

function requiredFiles(paths) {
  for (const relativePath of paths) {
    if (!fs.existsSync(path.join(ROOT, relativePath))) {
      errors.push(`${relativePath}: required file is missing`);
    }
  }
}

function p4PathAllowed(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized === ".gitattributes" ||
    normalized === "package.json" ||
    normalized.startsWith("contracts/codex/") ||
    normalized.startsWith("tests/contract/") ||
    normalized === "tests/p4-contract-baseline.test.mjs" ||
    normalized === "scripts/generate-p4-contracts.mjs" ||
    normalized === "scripts/install-p4-codex.ps1" ||
    normalized === "scripts/run-p4-lifecycle.mjs" ||
    normalized === "scripts/validate-p4.mjs" ||
    /^scripts\/lib\/p4-[^/]+\.mjs$/.test(normalized) ||
    /^evidence\/inventory\/p4-[^/]+\.json$/.test(normalized) ||
    /^evidence\/ledgers\/p4-[^/]+\.json$/.test(normalized) ||
    normalized.startsWith("evidence/manifests/p4/") ||
    /^evidence\/schemas\/p4-[^/]+\.json$/.test(normalized) ||
    /^docs\/baselines\/[^/]+-p4-[^/]+\.md$/.test(normalized)
  );
}

function validateScope() {
  const committed = git(["diff", "--name-only", `${BASE}..HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
  const working = git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1));
  for (const relativePath of new Set([...committed, ...working])) {
    if (!p4PathAllowed(relativePath)) {
      errors.push(`scope: path outside P4 allowlist: ${relativePath}`);
    }
  }
  const binaryLines = git(["diff", "--numstat", BASE])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("-\t-\t"));
  if (binaryLines.length > 0) {
    errors.push(`scope: binary additions are forbidden (${binaryLines.length})`);
  }
}

function validateProtectedReadback() {
  const expectedTrees = new Map([
    ["plugins/codex/commands", "01dee9ba76393439e179c5676ea92e538358d86b"],
    ["plugins/codex/agents", "e3d07a2c1a1acf9a986ecccd7e2b1c865b9da709"],
    ["plugins/codex/skills", "1272de32547df5bb365e114feb590bfa002e53c1"],
    ["plugins/codex/hooks", "39821e61e8b99bf415b7b05098b97d545fd377af"]
  ]);
  for (const [relativePath, expected] of expectedTrees) {
    const baseTree = git(["rev-parse", `${BASE}:${relativePath}`]);
    const headTree = git(["rev-parse", `HEAD:${relativePath}`]);
    if (baseTree !== expected || headTree !== expected) {
      errors.push(`${relativePath}: protected tree changed`);
    }
    if (git(["status", "--porcelain=v1", "--", relativePath])) {
      errors.push(`${relativePath}: protected working tree is dirty`);
    }
  }

  const expectedFiles = new Map([
    [
      "plugins/codex/scripts/lib/app-server-protocol.d.ts",
      "c4d141174754e04ef1cd1b904cd800d05e3174a772f86f0fc9c3f4d30ec3daf5"
    ],
    [
      "toolchain.json",
      "a6033a05ebecd4ff5bca3a5924ff06e55a2e2de9b41541da2c050642102dbb5d"
    ],
    [
      "security/p3-policy.json",
      "f4353ad5c207396f6c6c314aa522e16b556db81f2b0f18bb10741d5f4d8a9957"
    ],
    [
      "LICENSE",
      "5382d9ba43803da42433ae0025fe38d93c6e730d8824bd9e01af8e2f3c9c3833"
    ],
    [
      "NOTICE",
      "d8d0168f4940626032fe7a9d6e7a9b767b37f6c777a2140679e72e07afd1b8e0"
    ],
    [
      "package-lock.json",
      "db1fb9ad6eb54eaabddc2f138c48435bd04feb04079b51c37838375e2b3e4f8b"
    ]
  ]);
  for (const [relativePath, expected] of expectedFiles) {
    if (shaFile(relativePath) !== expected) {
      errors.push(`${relativePath}: immutable digest changed`);
    }
  }
}

function validateToolManifest() {
  const manifest = readJson("contracts/codex/contract-tools-v1.json");
  if (!manifest) return;
  if (
    manifest.schemaVersion !== "p4-contract-tools-v1" ||
    manifest.platform?.os !== "windows" ||
    manifest.platform?.architecture !== "x64" ||
    manifest.platform?.nodeRange !== ">=24.0.0" ||
    manifest.node?.version !== "24.18.1" ||
    manifest.node?.npmVersion !== "11.16.0"
  ) {
    errors.push("contract tools: exact Windows x64/Node 24 identity required");
  }
  if (!SHA256.test(manifest.node?.archiveSha256 ?? "")) {
    errors.push("contract tools: exact Node archive digest required");
  }
  if (
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 2 ||
    new Set(manifest.artifacts.map(({ id }) => id)).size !== 2
  ) {
    errors.push("contract tools: exactly two unique stable artifacts required");
    return;
  }
  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of manifest.artifacts) {
    if (
      artifact.releaseStatus !== "stable" ||
      !COMMIT.test(artifact.peeledCommit ?? "") ||
      !SHA256.test(artifact.archiveSha256 ?? "") ||
      !SHA256.test(artifact.executableSha256 ?? "") ||
      !artifact.archiveUrl?.startsWith("https://") ||
      artifact.archiveUrl.includes("/latest/") ||
      artifact.authenticode?.required !== true ||
      artifact.authenticode?.observedStatus !== "Valid" ||
      !Array.isArray(artifact.npm?.lifecycleScripts) ||
      artifact.npm.lifecycleScripts.length !== 0
    ) {
      errors.push(`contract tools: invalid artifact ${artifact.id}`);
    }
  }
  if (JSON.stringify(Object.keys(manifest.lanes).sort()) !== JSON.stringify([
    "build",
    "current",
    "previous"
  ])) {
    errors.push("contract tools: exact build/current/previous lanes required");
  } else {
    for (const [laneName, lane] of Object.entries(manifest.lanes)) {
      const artifact = artifacts.get(lane.artifactId);
      if (!artifact || artifact.version !== lane.version || lane.blocking !== true) {
        errors.push(`contract tools: invalid ${laneName} lane`);
      }
    }
    if (
      manifest.lanes.build.artifactId !== manifest.lanes.current.artifactId ||
      manifest.lanes.current.artifactId === manifest.lanes.previous.artifactId
    ) {
      errors.push("contract tools: lane identity relationship changed");
    }
  }
}

async function validateSnapshots() {
  const root = path.join(ROOT, "contracts", "codex", "snapshots");
  const manifest = readJson("contracts/codex/snapshots/snapshot-manifest.json");
  if (!manifest) return;
  const tools = readJson("contracts/codex/contract-tools-v1.json");
  const artifacts = new Map(
    (tools?.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  );
  const observed = await inspectSnapshotTree(root);
  if (
    manifest.combined?.fileCount !== observed.fileCount ||
    manifest.combined?.totalBytes !== observed.totalBytes ||
    manifest.combined?.treeSha256 !== observed.treeSha256
  ) {
    errors.push("snapshots: combined raw-byte tree digest mismatch");
  }
  if (
    manifest.toolsManifestSha256 !== shaFile("contracts/codex/contract-tools-v1.json")
  ) {
    errors.push("snapshots: tools manifest byte binding mismatch");
  }
  if (
    manifest.platform?.os !== "windows" ||
    manifest.platform?.architecture !== "x64" ||
    manifest.platform?.node !== "24.18.1"
  ) {
    errors.push("snapshots: exact win32/x64/Node 24.18.1 generation host required");
  }
  if (
    JSON.stringify(manifest.versions?.map(({ lane, version }) => `${lane}:${version}`)) !==
    JSON.stringify(["current:0.146.0", "previous:0.145.0"])
  ) {
    errors.push("snapshots: current/previous version set changed");
  }
  for (const version of manifest.versions ?? []) {
    const lane = tools?.lanes?.[version.lane];
    const artifact = artifacts.get(lane?.artifactId);
    if (
      lane?.version !== version.version ||
      artifact?.version !== version.version ||
      artifact?.executableSha256 !== version.executableSha256
    ) {
      errors.push(`snapshots: ${version.lane} executable is not bound to the tool manifest`);
    }
    const expectedSurfaces = [
      "stable/typescript",
      "stable/json-schema",
      "experimental/typescript",
      "experimental/json-schema"
    ];
    if (
      JSON.stringify(version.surfaces?.map(({ mode, format }) => `${mode}/${format}`)) !==
      JSON.stringify(expectedSurfaces)
    ) {
      errors.push(`snapshots: surface separation changed for ${version.version}`);
      continue;
    }
    for (const surface of version.surfaces) {
      const surfaceRoot = path.join(root, version.version, surface.mode, surface.format);
      const inspection = await inspectSnapshotTree(surfaceRoot);
      if (
        surface.fileCount !== inspection.fileCount ||
        surface.totalBytes !== inspection.totalBytes ||
        surface.treeSha256 !== inspection.treeSha256
      ) {
        errors.push(
          `snapshots: surface digest mismatch ${version.version}/${surface.mode}/${surface.format}`
        );
      }
      if (surface.format === "json-schema") {
        const observedMethods = await readMethodInventory(surfaceRoot);
        if (JSON.stringify(surface.methods) !== JSON.stringify(observedMethods)) {
          errors.push(
            `snapshots: method inventory mismatch ${version.version}/${surface.mode}/${surface.format}`
          );
        }
      } else if (surface.methods !== undefined) {
        errors.push(
          `snapshots: TypeScript surface must not claim methods ${version.version}/${surface.mode}`
        );
      }
    }
  }
}

function validateCommittedSchemas() {
  const pairs = [
    [
      "contracts/codex/contract-tools-v1.json",
      "evidence/schemas/p4-contract-tools-v1.schema.json"
    ],
    [
      "evidence/manifests/p4/p4-contract-baseline-20260731.json",
      "evidence/schemas/p4-evidence-v1.schema.json"
    ]
  ];
  for (const [documentPath, schemaPath] of pairs) {
    const document = readJson(documentPath);
    const schema = readJson(schemaPath);
    if (!document || !schema) continue;
    try {
      for (const error of validateJsonSchema(document, schema, documentPath)) {
        errors.push(`${schemaPath}: ${error}`);
      }
    } catch (error) {
      errors.push(`${schemaPath}: ${error.message}`);
    }
  }
}

function validateLedger() {
  const ledger = readJson("evidence/ledgers/p4-attempts.json");
  if (!ledger) return;
  exactKeys(
    ledger,
    [
      "schemaVersion",
      "sourceCommit",
      "defaultTrial",
      "deterministicRetryLimit",
      "entries"
    ],
    "attempt ledger"
  );
  if (
    ledger.schemaVersion !== "p4-attempt-ledger-v1" ||
    ledger.sourceCommit !== "843e679a90d4ef6946af251d36f43d257f8a5a10" ||
    ledger.defaultTrial !== 1 ||
    ledger.deterministicRetryLimit !== 0 ||
    !Array.isArray(ledger.entries) ||
    ledger.entries.length < 10
  ) {
    errors.push("attempt ledger: source/trial/entry contract changed");
    return;
  }
  const entryKeys = [
    "sequence",
    "attemptId",
    "fixtureId",
    "phase",
    "trial",
    "retryCount",
    "executionStatus",
    "rawExitCode",
    "timeout",
    "blockedBeforeExecution",
    "expected",
    "observed",
    "correction",
    "artifactSha256",
    "privatePathsPersisted",
    "rawPayloadPersisted"
  ];
  ledger.entries.forEach((entry, index) => {
    exactKeys(entry, entryKeys, `attempt ledger entry ${index}`);
    if (
      entry.sequence !== index + 1 ||
      entry.trial !== 1 ||
      entry.retryCount < 0 ||
      typeof entry.timeout !== "boolean" ||
      typeof entry.blockedBeforeExecution !== "boolean" ||
      entry.privatePathsPersisted !== false ||
      entry.rawPayloadPersisted !== false ||
      !["executed-pass", "executed-fail", "blocked-before-execution"].includes(
        entry.executionStatus
      ) ||
      (entry.blockedBeforeExecution && entry.rawExitCode !== null) ||
      (entry.artifactSha256 !== null && !SHA256.test(entry.artifactSha256))
    ) {
      errors.push(`attempt ledger entry ${index}: invalid truth fields`);
    }
  });
}

function validateEvidence() {
  const evidence = readJson(
    "evidence/manifests/p4/p4-contract-baseline-20260731.json"
  );
  if (!evidence) return;
  exactKeys(
    evidence,
    [
      "$schema",
      "schemaVersion",
      "evidenceId",
      "phase",
      "source",
      "environment",
      "admissions",
      "snapshot",
      "localChecks",
      "immutableReadback",
      "privacy",
      "remoteExecution",
      "review",
      "attemptLedger"
    ],
    "P4 evidence"
  );
  if (
    evidence.$schema !== "../../schemas/p4-evidence-v1.schema.json" ||
    evidence.schemaVersion !== "p4-evidence-v1" ||
    evidence.evidenceId !== "p4-contract-baseline-20260731" ||
    evidence.phase !== "P4" ||
    evidence.source?.baseCommit !== BASE ||
    evidence.source?.contractCommit !==
      "843e679a90d4ef6946af251d36f43d257f8a5a10" ||
    evidence.source?.branch !== "codex/p4-contract-baseline" ||
    evidence.remoteExecution !== "not-run"
  ) {
    errors.push("P4 evidence: identity or remote truth changed");
  }
  if (
    evidence.environment?.os !== "windows" ||
    evidence.environment?.architecture !== "x64" ||
    evidence.environment?.node !== "24.18.1" ||
    evidence.environment?.npm !== "11.16.0" ||
    evidence.environment?.privatePathsPersisted !== false
  ) {
    errors.push("P4 evidence: exact sanitized environment required");
  }
  if (
    !Array.isArray(evidence.admissions) ||
    JSON.stringify(evidence.admissions.map(({ lane }) => lane)) !==
      JSON.stringify(["build", "current", "previous"]) ||
    evidence.admissions.some(
      (admission) =>
        admission.status !== "accepted" ||
        admission.schemaExecution !== "executed-pass"
    )
  ) {
    errors.push("P4 evidence: exact lane admissions required");
  }
  const snapshot = readJson("contracts/codex/snapshots/snapshot-manifest.json");
  if (
    evidence.snapshot?.treeSha256 !== snapshot?.combined?.treeSha256 ||
    evidence.snapshot?.fileCount !== snapshot?.combined?.fileCount ||
    evidence.snapshot?.totalBytes !== snapshot?.combined?.totalBytes ||
    evidence.snapshot?.independentRoots !== 2 ||
    evidence.snapshot?.byteDiffExitCode !== 0 ||
    new Set(evidence.snapshot?.independentTreeSha256 ?? []).size !== 1
  ) {
    errors.push("P4 evidence: snapshot reproducibility claim is not byte-bound");
  }
  const requiredChecks = new Set([
    "p4-npm-ci",
    "p4-targeted-contract",
    "p4-current-previous-lifecycle",
    "p4-snapshot-reproduction",
    "p4-p3-validator",
    "p4-p3-targeted",
    "p4-full-regression",
    "p4-build-regression",
    "p4-claude-minimum-strict",
    "p4-claude-current-strict",
    "p4-actionlint",
    "p4-zizmor",
    "p4-osv-scanner",
    "p4-gitleaks",
    "p4-immutable-readback",
    "p4-hygiene"
  ]);
  const observedChecks = new Set(
    (evidence.localChecks ?? [])
      .filter(
        (check) =>
          check.executionStatus === "executed-pass" &&
          check.trial === 1 &&
          check.retryCount === 0 &&
          check.timeout === false &&
          check.rawExitCode === 0
      )
      .map(({ id }) => id)
  );
  for (const check of requiredChecks) {
    if (!observedChecks.has(check)) {
      errors.push(`P4 evidence: missing first-trial green check ${check}`);
    }
  }
  if (
    evidence.privacy?.privatePathsPersisted !== false ||
    evidence.privacy?.rawPayloadsPersisted !== false ||
    evidence.privacy?.rawPromptsPersisted !== false ||
    evidence.privacy?.secretsPersisted !== false ||
    evidence.privacy?.binaryArchivesPersisted !== false ||
    evidence.privacy?.redactionStatus !== "executed-pass"
  ) {
    errors.push("P4 evidence: privacy claims are not fail-closed");
  }
  if (
    evidence.review?.status !== "executed-pass" ||
    evidence.review?.findingCount !== 11 ||
    evidence.review?.disposition !==
      "all eleven findings from two independent review passes accepted, corrected, and revalidated"
  ) {
    errors.push("P4 evidence: independent review disposition is incomplete");
  }
}

function validateAuthoredPrivacy() {
  const relativePaths = [
    "evidence/inventory/p4-prechange-20260731.json",
    "evidence/ledgers/p4-attempts.json",
    "evidence/manifests/p4/p4-contract-baseline-20260731.json",
    "contracts/codex/lifecycle-integration-v1.json",
    "docs/baselines/2026-07-31-p4-contract-baseline.md"
  ];
  for (const relativePath of relativePaths) {
    const absolute = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, "utf8");
    if (PRIVATE_PATH.test(text)) {
      errors.push(`${relativePath}: private host path present`);
    }
    if (SECRET.test(text)) {
      errors.push(`${relativePath}: credential-shaped value present`);
    }
  }
}

requiredFiles([
  "contracts/codex/contract-tools-v1.json",
  "contracts/codex/snapshots/snapshot-manifest.json",
  "contracts/codex/command-semantics-v1.json",
  "contracts/codex/finalizer-characterization-v1.json",
  "contracts/codex/lifecycle-integration-v1.json",
  "contracts/codex/resource-candidates-v1.json",
  "tests/contract/command-transcripts-v1.json",
  "tests/contract/p4-fake-app-server.mjs",
  "evidence/inventory/p4-prechange-20260731.json",
  "evidence/ledgers/p4-attempts.json",
  "evidence/manifests/p4/p4-contract-baseline-20260731.json",
  "evidence/schemas/p4-contract-tools-v1.schema.json",
  "evidence/schemas/p4-evidence-v1.schema.json",
  "tests/p4-contract-baseline.test.mjs",
  "docs/baselines/2026-07-31-p4-contract-baseline.md"
]);

validateScope();
validateProtectedReadback();
validateToolManifest();
await validateSnapshots();
validateLedger();
validateEvidence();
validateCommittedSchemas();
validateAuthoredPrivacy();

const generatedDigest = await digestGeneratedTree(
  path.join(ROOT, "plugins", "codex", ".generated", "app-server-types"),
  { requireTypeScript: true }
);
if (
  generatedDigest !==
  "e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834"
) {
  errors.push("P2 generated app-server schema digest changed");
}

const packageJson = readJson("package.json");
if (
  packageJson?.name !== "codex-conductor-cc" ||
  // A relation, not a literal: the plugin manifest is the version of record and this must match
  // it. See validate-p3.mjs for why the literal could not survive a release.
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageJson?.version ?? "") ||
  packageJson?.version !== readJson("plugins/codex/.claude-plugin/plugin.json")?.version ||
  packageJson?.private !== true ||
  packageJson?.engines?.node !== ">=24.0.0" ||
  packageJson?.scripts?.["validate:p3"] !== "node scripts/validate-p3.mjs" ||
  packageJson?.scripts?.["validate:p4"] !== "node scripts/validate-p4.mjs"
) {
  errors.push("package.json: P2 identity or P3/P4 validation wiring changed");
}

if (errors.length > 0) {
  process.stderr.write(
    `P4 validation failed with ${errors.length} error(s):\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "P4 validation passed: exact Codex lanes, deterministic snapshots, characterization evidence, and immutable P2/P3 readbacks are internally consistent.\n"
  );
}
