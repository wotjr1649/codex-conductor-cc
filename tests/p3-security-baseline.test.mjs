import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
      validateGitleaksConfig: () => [],
      validateMarkdownLinks: () => [],
      validateP3EvidenceManifest: () => [],
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
    structuredClone(manifest),
    structuredClone(manifest),
    structuredClone(manifest)
  ];
  mutations[1].tools[0].version = "latest";
  mutations[2].tools[0].artifact.sha256 = "not-a-digest";
  delete mutations[3].tools[0].owner;
  delete mutations[4].tools[0].review.expiresAt;
  mutations[5].tools[0].artifact.executableRelativePath = "../outside.exe";
  mutations[6].tools.find(
    (tool) => tool.id === "codex-regression-only"
  ).signature.authenticodeThumbprint = "not-a-thumbprint";

  for (const mutation of mutations) {
    assert.ok(
      validateToolchain(mutation).length > 0,
      "unsafe toolchain mutation must fail closed"
    );
  }
});

test("PR workflow rejects mutable tools and privileged untrusted execution", async () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pull-request-ci.yml"),
    "utf8"
  );
  const manifest = readJson("toolchain.json");
  const { validateWorkflowText } = await loadValidationModule();
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
  // v0.2 moved the pull-request workflow to portability-ci.yml and archived this one to
  // workflow_dispatch, so the trigger complaint is that archival rather than drift. Expecting
  // exactly it keeps every other check in this validator live against the archived graph.
  const archivedErrors = validateWorkflowText(workflow, manifest.actions);
  assert.deepEqual(archivedErrors, ["workflow: trigger set must be exactly pull_request"]);

  const unsafeMutations = [
    // The trigger mutation that used to lead this list is gone. The validator already refuses
    // this workflow's trigger set, so adding another trigger produces no new error and the
    // negative proved nothing. Live pull-request triggers are checked by
    // validatePortabilityWorkflow against portability-ci.yml instead.
    workflow.replace("  contents: read", "  contents: write"),
    workflow.replace(
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      "actions/checkout@0000000000000000000000000000000000000000"
    ),
    `${workflow}\n# negative fixture\nuses: docker://synthetic:latest\n`,
    `${workflow}\n# negative fixture\nuses: ./synthetic-local-action\n`
  ];
  for (const mutation of unsafeMutations) {
    // Measured against the archived baseline, not against zero: with one error already
    // expected, `length > 0` would have passed for a mutation the validator ignored.
    assert.ok(
      validateWorkflowText(mutation, manifest.actions).length > archivedErrors.length,
      mutation.slice(0, 80)
    );
  }
});

test("repository validation is wired without changing the product support range", () => {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.engines.node, ">=24.0.0");
  assert.equal(packageJson.scripts["validate:p3"], "node scripts/validate-p3.mjs");
  requireFile("scripts/validate-p3.mjs");
  requireFile("scripts/install-p3-tool.ps1");
});

test("secret-scan allowlist is exact and rejects broad mutations", async () => {
  const { validateGitleaksConfig } = await loadValidationModule();
  const config = fs.readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8");

  assert.deepEqual(validateGitleaksConfig(config), []);
  for (const mutation of [
    config.replace('condition = "AND"', 'condition = "OR"'),
    config.replace("paths = ['''^toolchain\\.json$''']", "paths = ['''.*''']"),
    config.replace(
      'targetRules = ["generic-api-key"]',
      'targetRules = ["generic-api-key", "private-key"]'
    ),
    config.replace(
      `authenticodeThumbprint": "(?:0B7C30C11BF7250EC1ECD3254AC781D9E13D62F8|0D7581D2C51C59DF686C3000C70BF543F9F6C6CB)"`,
      '.*'
    )
  ]) {
    assert.ok(validateGitleaksConfig(mutation).length > 0);
  }
});

test("tool installer rejects workspace, reparse, and pre-existing tool roots", () => {
  const powershell = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const installer = path.join(ROOT, "scripts", "install-p3-tool.ps1");
  const invokeInstaller = (destination) =>
    spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-ToolId",
        "actionlint",
        "-DestinationRoot",
        destination
      ],
      { cwd: ROOT, encoding: "utf8", shell: false }
    );

  const workspaceResult = invokeInstaller(path.join(ROOT, ".p3-tools"));
  assert.notEqual(workspaceResult.status, 0);
  assert.match(
    `${workspaceResult.stdout}${workspaceResult.stderr}`,
    /P3E_WORKSPACE_DESTINATION/
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p3-installer-"));
  try {
    const realRoot = path.join(fixtureRoot, "real");
    const junctionRoot = path.join(fixtureRoot, "junction");
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, junctionRoot, "junction");
    const junctionResult = invokeInstaller(junctionRoot);
    assert.notEqual(junctionResult.status, 0);
    assert.match(
      `${junctionResult.stdout}${junctionResult.stderr}`,
      /P3E_REPARSE_PATH/
    );

    const existingRoot = path.join(fixtureRoot, "existing");
    fs.mkdirSync(path.join(existingRoot, "actionlint-1.7.12"), {
      recursive: true
    });
    const existingResult = invokeInstaller(existingRoot);
    assert.notEqual(existingResult.status, 0);
    assert.match(
      `${existingResult.stdout}${existingResult.stderr}`,
      /P3E_TOOL_ROOT_EXISTS/
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local documentation links are confined to the repository", async () => {
  const { validateMarkdownLinks } = await loadValidationModule();
  assert.deepEqual(
    validateMarkdownLinks(ROOT, [
      "SECURITY.md",
      "docs/security/THREAT_MODEL.md",
      "docs/security/REPOSITORY_SECURITY.md"
    ]),
    []
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p3-links-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "docs"));
    fs.writeFileSync(
      path.join(fixtureRoot, "docs", "unsafe.md"),
      "[escape](../../outside.md)\n[root](C:\\\\Users\\\\synthetic\\\\file.md)\n",
      "utf8"
    );
    assert.equal(
      validateMarkdownLinks(fixtureRoot, ["docs/unsafe.md"]).length,
      2
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
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

  for (const privatePath of [
    "D:/synthetic/private-worktree",
    "/home/synthetic/private-worktree",
    "\\\\wsl$\\Synthetic\\private-worktree"
  ]) {
    assert.ok(validateEvidenceValue({ privatePath }).length > 0);
  }
});

test("evidence manifest and attempt ledger preserve execution truth", async () => {
  requireFile("evidence/schemas/p3-evidence-v1.schema.json");
  requireFile("evidence/manifests/p3/p3-threat-toolchain-20260731.json");
  requireFile("evidence/ledgers/p3-attempts.json");

  const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  const toolchainDigest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(TOOLCHAIN_PATH))
    .digest("hex");
  const { validateP3EvidenceManifest } = await loadValidationModule();
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
  assert.equal(evidence.toolchain.sha256, toolchainDigest);
  assert.equal(evidence.attestation.status, "not-run");
  assert.equal(evidence.sbom.scope, "spike-only");
  assert.deepEqual(validateP3EvidenceManifest(evidence), []);
  assert.ok(ledger.attempts.some((attempt) => attempt.status === "executed-fail"));
  assert.ok(ledger.attempts.some((attempt) => attempt.status === "executed-pass"));
  assert.ok(
    ledger.attempts.every(
      (attempt) =>
        Number.isInteger(attempt.rawExitCode) ||
        attempt.rawExitCode === null
    )
  );

  const evidenceMutations = [
    { ...structuredClone(evidence), unexpected: true },
    structuredClone(evidence),
    structuredClone(evidence),
    structuredClone(evidence),
    structuredClone(evidence),
    structuredClone(evidence),
    structuredClone(evidence)
  ];
  delete evidenceMutations[1].remoteExecution;
  const x7 = evidenceMutations[2].requirementResults.find(
    (result) => result.requirementId === "X7"
  );
  x7.status = "static-pass";
  x7.deferredPhase = null;
  evidenceMutations[3].evidenceId = "";
  evidenceMutations[4].requirementResults[0].proofKind = "unbounded-claim";
  evidenceMutations[5].requirementResults[0].deferredPhase = {};
  evidenceMutations[6].localChecks = [evidenceMutations[6].localChecks[0]];
  for (const mutation of evidenceMutations) {
    assert.ok(validateP3EvidenceManifest(mutation).length > 0);
  }
});

test("P3 preserves immutable P2 product identities", () => {
  const packageJson = readJson("package.json");
  const downstream = readJson("downstream.json");
  const plugin = readJson("plugins/codex/.claude-plugin/plugin.json");

  assert.equal(packageJson.name, "codex-conductor-cc");
  assert.equal(plugin.name, "codex");
  // The identity that has to hold is that the two manifests agree, not that they hold the
  // version this file was written against. Pinning the literal made the check fail on the
  // release it was meant to survive; downstream-identity asserts the same relation across all
  // six places bump-version updates.
  assert.match(plugin.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(packageJson.version, plugin.version);
  assert.equal(
    downstream.upstreamBase,
    "db52e28f4d9ded852ab3942cea316258ae4ef346"
  );
});
