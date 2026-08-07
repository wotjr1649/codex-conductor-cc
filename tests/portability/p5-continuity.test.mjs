import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTABILITY_BASE,
  isPortabilityAllowedPath,
  validatePortabilityChangeSet
} from "../../scripts/lib/portability-continuity.mjs";

const baseValidator = "before\nconst validationHead = resolveValidationHead();\nafter\n";
const continuation = [
  "// PORTABILITY_CONTINUATION_BEGIN",
  "await validate();",
  "// PORTABILITY_CONTINUATION_END",
  ""
].join("\n");
const currentValidator = baseValidator.replace("after\n", `${continuation}after\n`);

test("P6-CONTINUITY-001 binds the released v0.1 base and explicit path scope", () => {
  assert.equal(PORTABILITY_BASE, "099afca5946debe5620411f2ab1d4aec388918ca");
  for (const relativePath of [
    "scripts/validate-p5.mjs",
    "scripts/validate-portability.mjs",
    "scripts/lib/portability-continuity.mjs",
    "tests/portability/p5-continuity.test.mjs",
    "plugins/codex/scripts/lib/platform-policy.mjs",
    ".github/workflows/portability-ci.yml",
    "ci/portability-profiles-v1.json",
    "docs/superpowers/specs/2026-08-07-portability-v0.2-design.md"
  ]) {
    assert.equal(isPortabilityAllowedPath(relativePath), true, relativePath);
  }
  for (const relativePath of [
    ".github/workflows/pull-request-ci.yml",
    "scripts/lib/p5-validation.mjs",
    "tests/p5-matrix-profile.test.mjs",
    "evidence/manifests/p5/forged.json",
    "plugins/codex/hooks/hooks.json",
    "tests/portability/../p5-matrix-profile.test.mjs",
    "tests/portability/forged\nname.test.mjs",
    "/tests/portability/absolute.test.mjs"
  ]) {
    assert.equal(isPortabilityAllowedPath(relativePath), false, relativePath);
  }
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
