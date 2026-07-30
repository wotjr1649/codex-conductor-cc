import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLCHAIN_PATH = path.join(ROOT, "toolchain.json");
const POLICY_PATH = path.join(ROOT, "security", "p3-policy.json");
const EVIDENCE_PATH = path.join(
  ROOT,
  "evidence",
  "manifests",
  "p3",
  "p3-threat-toolchain-20260731.json"
);
const LEDGER_PATH = path.join(
  ROOT,
  "evidence",
  "ledgers",
  "p3-attempts.json"
);
const VALIDATION_MODULE_PATH = path.join(
  ROOT,
  "scripts",
  "lib",
  "p3-validation.mjs"
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function requireFile(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  assert.equal(
    fs.existsSync(absolutePath),
    true,
    `required P3 artifact is missing: ${relativePath}`
  );
  return absolutePath;
}

async function loadValidationModule() {
  if (!fs.existsSync(VALIDATION_MODULE_PATH)) {
    return {
      redactEvidence: (value) => value,
      validateEvidenceValue: () => [],
      validateToolchain: () => []
    };
  }
  return import(pathToFileURL(VALIDATION_MODULE_PATH));
}

test("P3 has a self-contained security policy and ownership closure", () => {
  for (const relativePath of [
    "SECURITY.md",
    "docs/security/THREAT_MODEL.md",
    "docs/security/REPOSITORY_SECURITY.md",
    "security/p3-policy.json",
    ".github/CODEOWNERS"
  ]) {
    requireFile(relativePath);
  }

  const codeowners = fs.readFileSync(
    path.join(ROOT, ".github", "CODEOWNERS"),
    "utf8"
  );
  assert.match(codeowners, /\/\.github\/workflows\/\s+@wotjr1649/);
  assert.match(codeowners, /\/toolchain\.json\s+@wotjr1649/);
  assert.match(codeowners, /\/security\/\s+@wotjr1649/);
});

test("machine policy does not overclaim same-user or approval enforcement", () => {
  requireFile("security/p3-policy.json");
  const policy = readJson("security/p3-policy.json");
  const sameUser = policy.proofs.find(
    (proof) => proof.fixtureId === "SEC-BOUNDARY-001"
  );
  const approval = policy.proofs.find(
    (proof) => proof.fixtureId === "SEC-APPROVAL-002"
  );

  assert.deepEqual(
    {
      proofKind: sameUser?.proofKind,
      status: sameUser?.status,
      runtimeEnforced: sameUser?.runtimeEnforced,
      deferredPhase: sameUser?.deferredPhase,
      sameUserIsolation: sameUser?.claims?.sameUserIsolation,
      ipcPeerIdentity: sameUser?.claims?.ipcPeerIdentity,
      ipcSecurityBoundary: sameUser?.claims?.ipcSecurityBoundary
    },
    {
      proofKind: "policy",
      status: "specified",
      runtimeEnforced: false,
      deferredPhase: "v0.2",
      sameUserIsolation: "not-guaranteed",
      ipcPeerIdentity: "admission-signal",
      ipcSecurityBoundary: false
    }
  );
  assert.deepEqual(
    {
      proofKind: approval?.proofKind,
      status: approval?.status,
      runtimeEnforced: approval?.runtimeEnforced,
      deferredPhase: approval?.deferredPhase,
      unattendedApproval: approval?.claims?.unattendedApproval
    },
    {
      proofKind: "policy",
      status: "specified",
      runtimeEnforced: false,
      deferredPhase: "P4",
      unattendedApproval: "deny-or-interrupt"
    }
  );
});

test("toolchain manifest is exact and the validator rejects unsafe mutations", async () => {
  requireFile("toolchain.json");
  requireFile("evidence/schemas/toolchain-v1.schema.json");
  const manifest = readJson("toolchain.json");
  const { validateToolchain } = await loadValidationModule();

  assert.deepEqual(validateToolchain(manifest), []);

  const expectedVersions = {
    node: "24.18.1",
    npm: "11.16.0",
    "codex-regression-only": "0.146.0",
    "claude-minimum": "2.1.196",
    "claude-current": "2.1.220",
    actionlint: "1.7.12",
    zizmor: "1.28.0",
    "osv-scanner": "2.4.0",
    gitleaks: "8.30.1",
    syft: "1.50.0"
  };
  for (const [id, version] of Object.entries(expectedVersions)) {
    assert.equal(
      manifest.tools.find((tool) => tool.id === id)?.version,
      version,
      id
    );
  }

  const mutations = [
    { ...structuredClone(manifest), unexpected: true },
    structuredClone(manifest),
    structuredClone(manifest),
    structuredClone(manifest),
    structuredClone(manifest)
  ];
  mutations[1].tools[0].version = "latest";
  mutations[2].tools[0].artifact.sha256 = "not-a-digest";
  delete mutations[3].tools[0].owner;
  delete mutations[4].tools[0].review.expiresAt;

  for (const mutation of mutations) {
    assert.ok(
      validateToolchain(mutation).length > 0,
      "unsafe toolchain mutation must fail closed"
    );
  }
});

test("PR workflow rejects mutable tools and privileged untrusted execution", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pull-request-ci.yml"),
    "utf8"
  );
  assert.match(workflow, /^\s+node-version:\s+24\.18\.1\s*$/m);
  assert.doesNotMatch(workflow, /npm\s+install\s+-g/i);
  assert.doesNotMatch(workflow, /id-token:\s+write/i);
  assert.doesNotMatch(workflow, /^\s*(pull_request_target|workflow_run|issue_comment):/m);
  assert.doesNotMatch(workflow, /^\s+[^#\n]*uses:\s+[^@\s]+@(?![0-9a-f]{40}\b)/m);
  assert.match(
    workflow,
    /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294\s+#\s+v5\.0\.0/
  );
  assert.match(workflow, /node\s+scripts\/validate-p3\.mjs/);
});

test("repository validation is wired without changing the product support range", () => {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.engines.node, ">=24.0.0");
  assert.equal(packageJson.scripts["validate:p3"], "node scripts/validate-p3.mjs");
  requireFile("scripts/validate-p3.mjs");
  requireFile("scripts/install-p3-tool.ps1");
});

test("seeded-secret negative and redacted positive controls use one validator", async () => {
  const { redactEvidence, validateEvidenceValue } =
    await loadValidationModule();
  const seededSecret = `P3-SYNTHETIC-${crypto
    .createHash("sha256")
    .update("p3-redaction-negative-control-v1")
    .digest("hex")}`;
  const raw = {
    diagnostic: `token=${seededSecret}`,
    privatePath: "C:\\Users\\synthetic-owner\\private-worktree",
    prompt: "synthetic raw prompt"
  };
  const options = { seededSecrets: [seededSecret] };

  assert.ok(
    validateEvidenceValue(raw, options).length > 0,
    "unredacted negative control must be rejected"
  );
  const redacted = redactEvidence(raw, options);
  assert.equal(JSON.stringify(redacted).includes(seededSecret), false);
  assert.deepEqual(validateEvidenceValue(redacted, options), []);
  assert.equal(redacted.redaction.seededSecretCount, 1);
});

test("evidence manifest and attempt ledger preserve execution truth", () => {
  requireFile("evidence/schemas/p3-evidence-v1.schema.json");
  requireFile("evidence/manifests/p3/p3-threat-toolchain-20260731.json");
  requireFile("evidence/ledgers/p3-attempts.json");

  const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  const statuses = new Set([
    "static-pass",
    "executed-pass",
    "executed-fail",
    "not-run",
    "blocked-with-evidence",
    "specified"
  ]);

  assert.ok(evidence.requirementResults.length > 0);
  assert.ok(
    evidence.requirementResults.every((result) => statuses.has(result.status))
  );
  assert.equal(evidence.remoteExecution, "not-run");
  assert.equal(evidence.attestation.status, "not-run");
  assert.equal(evidence.sbom.scope, "spike-only");
  assert.ok(ledger.attempts.some((attempt) => attempt.status === "executed-fail"));
  assert.ok(ledger.attempts.some((attempt) => attempt.status === "executed-pass"));
  assert.ok(
    ledger.attempts.every(
      (attempt) =>
        Number.isInteger(attempt.rawExitCode) ||
        attempt.rawExitCode === null
    )
  );
});

test("P3 preserves immutable P2 product identities", () => {
  const packageJson = readJson("package.json");
  const downstream = readJson("downstream.json");
  const plugin = readJson("plugins/codex/.claude-plugin/plugin.json");

  assert.equal(packageJson.name, "codex-conductor-cc");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(plugin.name, "codex");
  assert.equal(plugin.version, "0.1.0");
  assert.equal(
    downstream.upstreamBase,
    "db52e28f4d9ded852ab3942cea316258ae4ef346"
  );
});
