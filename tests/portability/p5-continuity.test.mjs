import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PORTABILITY_BASE,
  findCrLfDigestPaths,
  filterLegacyP5ContinuationErrors,
  isPortabilityAllowedPath,
  validatePortabilityCodeowners,
  validateLegacyWorkflowArchive,
  validatePortabilityChangeSet
} from "../../scripts/lib/portability-continuity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const baseValidator = "before\nconst validationHead = resolveValidationHead();\nafter\n";
const continuation = [
  "// PORTABILITY_CONTINUATION_BEGIN",
  "await validate();",
  "// PORTABILITY_CONTINUATION_END",
  ""
].join("\n");
const currentValidator = baseValidator.replace("after\n", `${continuation}after\n`);
const legacyWorkflow = "name: Pull Request CI\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n";
const archivedWorkflow = legacyWorkflow.replace("on:\n  pull_request:\n", "on:\n  workflow_dispatch:\n");

test("P6-CONTINUITY-001 binds the released v0.1 base and explicit path scope", () => {
  assert.equal(PORTABILITY_BASE, "099afca5946debe5620411f2ab1d4aec388918ca");
  for (const relativePath of [
    "scripts/validate-p5.mjs",
    "scripts/validate-portability.mjs",
    "scripts/lib/portability-continuity.mjs",
    ".github/CODEOWNERS",
    "tests/state.test.mjs",
    "tests/portability/p5-continuity.test.mjs",
    "plugins/codex/CHANGELOG.md",
    "plugins/codex/scripts/lib/platform-policy.mjs",
    ".github/workflows/portability-ci.yml",
    ".github/workflows/pull-request-ci.yml",
    "ci/portability-profiles-v1.json",
    "docs/superpowers/specs/2026-08-07-portability-v0.2-design.md"
  ]) {
    assert.equal(isPortabilityAllowedPath(relativePath), true, relativePath);
  }
  for (const relativePath of [
    "scripts/lib/p5-validation.mjs",
    "tests/p5-matrix-profile.test.mjs",
    "evidence/manifests/p5/forged.json",
    "plugins/codex/hooks/hooks.json",
    "plugins/codex/CHANGELOG.md.bak",
    "tests/portability/../p5-matrix-profile.test.mjs",
    "tests/portability/forged\nname.test.mjs",
    "/tests/portability/absolute.test.mjs"
  ]) {
    assert.equal(isPortabilityAllowedPath(relativePath), false, relativePath);
  }
});

test("P6-CONTINUITY-001A requires ownership for every portability policy surface", () => {
  const codeowners = fs
    .readFileSync(path.join(ROOT, ".github/CODEOWNERS"), "utf8")
    .replaceAll("\r\n", "\n");
  assert.deepEqual(validatePortabilityCodeowners(codeowners), []);
  assert.match(
    validatePortabilityCodeowners(codeowners.replace("/scripts/lib/portability-* @wotjr1649\n", "")).join("\n"),
    /codeowners/i
  );
});

test("P6-CONTINUITY-001B runs continuation only at the final P5 frontier", () => {
  const validator = fs.readFileSync(path.join(ROOT, "scripts/validate-p5.mjs"), "utf8");
  const begin = validator.indexOf("// PORTABILITY_CONTINUATION_BEGIN");
  const end = validator.indexOf("// PORTABILITY_CONTINUATION_END");
  const binaryCheck = validator.indexOf('errors.push("P5E_BINARY:');
  const finalResult = validator.lastIndexOf("if (errors.length > 0)");
  assert.ok(binaryCheck >= 0 && binaryCheck < begin);
  assert.ok(begin < end && end < finalResult);
  assert.doesNotMatch(validator.slice(begin, end), /process\.exit/);
});

test("P6-CONTINUITY-003 archives only the legacy workflow trigger", () => {
  assert.deepEqual(validateLegacyWorkflowArchive(legacyWorkflow, archivedWorkflow), []);
  assert.match(
    validateLegacyWorkflowArchive(legacyWorkflow, legacyWorkflow).join("\n"),
    /archive/i
  );
  assert.match(
    validateLegacyWorkflowArchive(legacyWorkflow, `${archivedWorkflow}\n# drift\n`).join("\n"),
    /archive/i
  );
});

test("P6-CONTINUITY-004 consumes only exact final-frontier legacy errors", () => {
  const archiveErrors = [
    "workflow: trigger set must be exactly pull_request",
    "P5E_WORKFLOW_DIGEST: PR workflow differs from the reviewed P5 executable graph"
  ];
  const allowedPaths = ["plugins/codex/scripts/lib/runtime-paths.mjs", "package-lock.json"];
  const legacyErrors = [
    ...archiveErrors,
    "P5E_POST_SOURCE_CHANGE:plugins/codex/scripts/lib/runtime-paths.mjs",
    "P5E_SCOPE: path outside P5 allowlist: plugins/codex/scripts/lib/runtime-paths.mjs",
    "P5E_IMMUTABLE_PATH:plugins/codex/scripts",
    "P5E_IMMUTABLE_PATH:package-lock.json"
  ];
  assert.deepEqual(filterLegacyP5ContinuationErrors(legacyErrors, allowedPaths), []);
  assert.deepEqual(
    filterLegacyP5ContinuationErrors([...legacyErrors, "P5E_BINARY: unexpected"], allowedPaths),
    ["P5E_BINARY: unexpected"]
  );
  assert.deepEqual(
    filterLegacyP5ContinuationErrors(legacyErrors, ["package-lock.json"]),
    [
      "P5E_POST_SOURCE_CHANGE:plugins/codex/scripts/lib/runtime-paths.mjs",
      "P5E_SCOPE: path outside P5 allowlist: plugins/codex/scripts/lib/runtime-paths.mjs",
      "P5E_IMMUTABLE_PATH:plugins/codex/scripts"
    ]
  );
  assert.deepEqual(filterLegacyP5ContinuationErrors(legacyErrors.slice(1), allowedPaths), legacyErrors.slice(1));
  assert.deepEqual(
    filterLegacyP5ContinuationErrors(
      [...legacyErrors, "P5E_TEST_DIGEST:tests/broker-endpoint.test.mjs"],
      allowedPaths,
      ["tests/broker-endpoint.test.mjs"]
    ),
    []
  );
  assert.deepEqual(
    filterLegacyP5ContinuationErrors(
      [...legacyErrors, "P5E_TEST_DIGEST:tests/commands.test.mjs"],
      allowedPaths,
      ["tests/broker-endpoint.test.mjs"]
    ),
    ["P5E_TEST_DIGEST:tests/commands.test.mjs"]
  );
});

test("P6-CONTINUITY-005 recognizes only exact inherited CRLF text digests", () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, "ci", "scenario-registry-v1.json"), "utf8")
  );
  const paths = findCrLfDigestPaths(ROOT, registry.inheritedTests);
  assert.equal(paths.has("tests/broker-endpoint.test.mjs"), true);
  assert.equal(paths.has("tests/runtime.test.mjs"), false);
  const inherited = registry.inheritedTests.find(
    ({ path: relativePath }) => relativePath === "tests/broker-endpoint.test.mjs"
  );
  assert.equal(findCrLfDigestPaths(ROOT, [{ ...inherited, sha256: "0".repeat(64) }]).size, 0);
  assert.equal(
    findCrLfDigestPaths(ROOT, [{ ...inherited, path: "tests/../broker-endpoint.test.mjs" }])
      .size,
    0
  );
});

test("P6-CONTINUITY-002 accepts only the marked insertion in the legacy validator", () => {
  assert.deepEqual(
    validatePortabilityChangeSet({
      changedPaths: [
        "scripts/validate-p5.mjs",
        "scripts/validate-portability.mjs",
        "tests/portability/p5-continuity.test.mjs"
      ],
      baseValidatorText: baseValidator,
      currentValidatorText: currentValidator
    }),
    []
  );
  assert.deepEqual(
    validatePortabilityChangeSet({
      changedPaths: ["scripts/validate-p5.mjs"],
      baseValidatorText: baseValidator.replaceAll("\n", "\r\n"),
      currentValidatorText: currentValidator
    }),
    []
  );

  assert.ok(
    validatePortabilityChangeSet({
      changedPaths: ["scripts/validate-p5.mjs", "scripts/lib/p5-validation.mjs"],
      baseValidatorText: baseValidator,
      currentValidatorText: currentValidator
    }).some((entry) => entry.includes("P6E_SCOPE"))
  );

  assert.ok(
    validatePortabilityChangeSet({
      changedPaths: ["scripts/validate-p5.mjs"],
      baseValidatorText: baseValidator,
      currentValidatorText: `${currentValidator}unmarked change\n`
    }).some((entry) => entry.includes("P6E_P5_ENTRYPOINT"))
  );

  assert.ok(
    validatePortabilityChangeSet({
      changedPaths: ["scripts/validate-portability.mjs"],
      baseValidatorText: baseValidator,
      currentValidatorText: baseValidator
    }).some((entry) => entry.includes("P6E_P5_ENTRYPOINT"))
  );
});
