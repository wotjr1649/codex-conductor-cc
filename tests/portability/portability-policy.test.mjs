import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validatePortabilityPackage,
  validatePortabilityProfiles,
  validatePortabilityWorkflow
} from "../../scripts/lib/portability-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "ci/portability-profiles-v1.json"), "utf8"));
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/portability-ci.yml"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("P6-POLICY-001 requires the exact four immutable portability profiles", () => {
  assert.deepEqual(validatePortabilityProfiles(profiles), []);
  const mutableRunner = structuredClone(profiles);
  mutableRunner.profiles[0].runner = "ubuntu-latest";
  assert.match(validatePortabilityProfiles(mutableRunner).join("\n"), /runner/);

  const missingDigest = structuredClone(profiles);
  delete missingDigest.profiles[1].artifacts.codexCurrent.sha256;
  assert.match(validatePortabilityProfiles(missingDigest).join("\n"), /artifact/);
});

test("P6-POLICY-002 keeps portability CI read-only and rejects untrusted acquisition", () => {
  assert.deepEqual(validatePortabilityWorkflow(workflow, profiles), []);
  assert.match(validatePortabilityWorkflow(workflow.replace("contents: read", "contents: write"), profiles).join("\n"), /permissions/i);
  assert.match(validatePortabilityWorkflow(`${workflow}\n      - run: curl https://example.invalid/tool\n`, profiles).join("\n"), /acquisition/i);
  assert.match(
    validatePortabilityWorkflow(workflow.replace("- id: windows-x64", "- id: windows-arm64"), profiles).join("\n"),
    /profile/i
  );
  assert.match(
    validatePortabilityWorkflow(workflow.replace("npm test", "node --test tests/runtime.test.mjs"), profiles).join("\n"),
    /gate/i
  );
  assert.match(
    validatePortabilityWorkflow(workflow.replace("fail-fast: false", "fail-fast: true"), profiles).join("\n"),
    /gate/i
  );
  assert.match(
    validatePortabilityWorkflow(
      workflow.replace("    timeout-minutes: 25", "    timeout-minutes: 25\n    continue-on-error: true"),
      profiles
    ).join("\n"),
    /gate/i
  );
  assert.match(
    validatePortabilityWorkflow(
      workflow.replace("        run: npm test", "        continue-on-error: true\n        run: npm test"),
      profiles
    ).join("\n"),
    /gate/i
  );
  assert.match(
    validatePortabilityWorkflow(
      workflow.replace(
        "@('actionlint', 'zizmor', 'osv-scanner', 'gitleaks')",
        "@('actionlint', 'zizmor', 'osv-scanner', 'untrusted')"
      ),
      profiles
    ).join("\n"),
    /gate/i
  );
});

test("P6-POLICY-003 restores automatic security and dependency review", () => {
  assert.match(workflow, /^  security:\n    name: Security$/m);
  assert.match(workflow, /^  dependency-review:\n    name: Dependency review$/m);
  assert.match(workflow, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(workflow, /needs: \[runtime, security, dependency-review\]/);
});

test("P6-POLICY-004 binds npm test to the current v0.2 support suite", () => {
  assert.deepEqual(validatePortabilityPackage(packageJson), []);
  const legacyGlob = structuredClone(packageJson);
  legacyGlob.scripts.test = "node --test tests/*.test.mjs";
  assert.match(validatePortabilityPackage(legacyGlob).join("\n"), /test/i);
});
