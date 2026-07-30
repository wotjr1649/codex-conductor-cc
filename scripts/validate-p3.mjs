import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  redactEvidence,
  validateAttemptLedger,
  validateEvidenceValue,
  validateMarkdownLinks,
  validateToolchain,
  validateWorkflowText
} from "./lib/p3-validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}
function requireFile(relativePath) {
  if (!fs.existsSync(path.join(ROOT, relativePath))) {
    errors.push(`${relativePath}: required file is missing`);
  }
}

const requiredFiles = [
  "SECURITY.md",
  "docs/security/THREAT_MODEL.md",
  "docs/security/REPOSITORY_SECURITY.md",
  ".github/CODEOWNERS",
  ".github/workflows/pull-request-ci.yml",
  "security/p3-policy.json",
  "toolchain.json",
  "evidence/schemas/toolchain-v1.schema.json",
  "evidence/schemas/p3-evidence-v1.schema.json",
  "evidence/manifests/p3/p3-threat-toolchain-20260731.json",
  "evidence/ledgers/p3-attempts.json"
];
requiredFiles.forEach(requireFile);

const toolchain = readJson("toolchain.json");
if (toolchain) errors.push(...validateToolchain(toolchain));

const workflowPath = path.join(ROOT, ".github", "workflows", "pull-request-ci.yml");
if (fs.existsSync(workflowPath)) {
  errors.push(...validateWorkflowText(fs.readFileSync(workflowPath, "utf8")));
}

const policy = readJson("security/p3-policy.json");
if (policy) {
  const sameUser = policy.proofs?.find(
    (proof) => proof.fixtureId === "SEC-BOUNDARY-001"
  );
  const approval = policy.proofs?.find(
    (proof) => proof.fixtureId === "SEC-APPROVAL-002"
  );
  if (
    sameUser?.status !== "specified" ||
    sameUser?.runtimeEnforced !== false ||
    sameUser?.claims?.sameUserIsolation !== "not-guaranteed" ||
    sameUser?.claims?.ipcSecurityBoundary !== false
  ) {
    errors.push("security/p3-policy.json: false same-user runtime claim");
  }
  if (
    approval?.status !== "specified" ||
    approval?.runtimeEnforced !== false ||
    approval?.claims?.unattendedApproval !== "deny-or-interrupt"
  ) {
    errors.push("security/p3-policy.json: false approval runtime claim");
  }
}

const evidence = readJson(
  "evidence/manifests/p3/p3-threat-toolchain-20260731.json"
);
if (evidence) {
  errors.push(...validateEvidenceValue(evidence));
  const allowedStatuses = new Set([
    "static-pass",
    "executed-pass",
    "executed-fail",
    "not-run",
    "blocked-with-evidence",
    "specified"
  ]);
  if (
    evidence.schemaVersion !== "p3-evidence-v1" ||
    evidence.remoteExecution !== "not-run" ||
    evidence.attestation?.status !== "not-run" ||
    evidence.sbom?.scope !== "spike-only" ||
    !Array.isArray(evidence.requirementResults) ||
    evidence.requirementResults.some((result) => !allowedStatuses.has(result.status))
  ) {
    errors.push("P3 evidence manifest: unsupported shape or inflated execution claim");
  }
}

const ledger = readJson("evidence/ledgers/p3-attempts.json");
if (ledger) {
  errors.push(...validateAttemptLedger(ledger));
  errors.push(...validateEvidenceValue(ledger));
}

const docs = [
  "SECURITY.md",
  "docs/security/THREAT_MODEL.md",
  "docs/security/REPOSITORY_SECURITY.md"
];
if (docs.every((relativePath) => fs.existsSync(path.join(ROOT, relativePath)))) {
  errors.push(...validateMarkdownLinks(ROOT, docs));
}

const packageJson = readJson("package.json");
if (packageJson) {
  if (
    packageJson.name !== "codex-conductor-cc" ||
    packageJson.version !== "0.1.0" ||
    packageJson.private !== true ||
    packageJson.engines?.node !== ">=24.0.0" ||
    packageJson.scripts?.["validate:p3"] !== "node scripts/validate-p3.mjs"
  ) {
    errors.push("package.json: P2 identity or P3 validation wiring changed");
  }
}

const plugin = readJson("plugins/codex/.claude-plugin/plugin.json");
const downstream = readJson("downstream.json");
if (
  plugin?.name !== "codex" ||
  plugin?.version !== "0.1.0" ||
  downstream?.upstreamBase !== "db52e28f4d9ded852ab3942cea316258ae4ef346"
) {
  errors.push("P2 plugin or downstream identity changed");
}

const codeownersPath = path.join(ROOT, ".github", "CODEOWNERS");
if (fs.existsSync(codeownersPath)) {
  const codeowners = fs.readFileSync(codeownersPath, "utf8");
  for (const line of [
    "/.github/workflows/ @wotjr1649",
    "/toolchain.json @wotjr1649",
    "/security/ @wotjr1649"
  ]) {
    if (!codeowners.includes(line)) errors.push(`CODEOWNERS: missing ${line}`);
  }
}

const seededSecret = `P3-SYNTHETIC-${crypto
  .createHash("sha256")
  .update("p3-redaction-negative-control-v1")
  .digest("hex")}`;
const negative = {
  diagnostic: `token=${seededSecret}`,
  privatePath: "C:\\Users\\synthetic-owner\\private-worktree",
  prompt: "synthetic raw prompt",
  safeCanary: "P3-SAFE-CANARY"
};
const privacyOptions = { seededSecrets: [seededSecret] };
if (validateEvidenceValue(negative, privacyOptions).length === 0) {
  errors.push("seeded-secret negative control was not rejected");
}
const positive = redactEvidence(negative, privacyOptions);
if (
  validateEvidenceValue(positive, privacyOptions).length > 0 ||
  JSON.stringify(positive).includes(seededSecret) ||
  positive.safeCanary !== "P3-SAFE-CANARY" ||
  positive.redaction.seededSecretCount !== 1
) {
  errors.push("redacted positive control did not preserve privacy invariants");
}

for (const schemaPath of [
  "evidence/schemas/toolchain-v1.schema.json",
  "evidence/schemas/p3-evidence-v1.schema.json"
]) {
  const schema = readJson(schemaPath);
  if (schema?.additionalProperties !== false) {
    errors.push(`${schemaPath}: root must reject unknown fields`);
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `P3 validation failed with ${errors.length} error(s):\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  assert.equal(errors.length, 0);
  process.stdout.write(
    "P3 validation passed: exact toolchain, repository policy, evidence ledger, and privacy controls are internally consistent.\n"
  );
}
