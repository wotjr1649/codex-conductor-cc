import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  validatePortabilityPackage,
  validatePortabilityProfiles,
  validatePortabilityWorkflow
} from "./portability-policy.mjs";

export const PORTABILITY_BASE = "b547af57e07a64d25769c22223ef76be72f2dfa9";

const ENTRYPOINT = "scripts/validate-p5.mjs";
const LEGACY_WORKFLOW = ".github/workflows/pull-request-ci.yml";
// The archival, as the legacy validator reports it. This is the fingerprint that switches the
// continuation on: anything else and the filter refuses to run at all, so an unexpected state
// surfaces in full rather than being partly consumed.
//
// One error, not two. The digest complaint used to be here because EXPECTED_P5_WORKFLOW_SHA256
// named the pre-archival bytes; it names the archived bytes now, so a digest error means real
// drift and must never be filtered.
const LEGACY_ARCHIVE_P5_ERRORS = ["workflow: trigger set must be exactly pull_request"];
const PORTABILITY_CODEOWNER_LINES = [
  "/.github/workflows/ @wotjr1649",
  "/plugins/codex/scripts/ @wotjr1649",
  "/scripts/lib/portability-* @wotjr1649",
  "/scripts/validate-p5.mjs @wotjr1649",
  "/scripts/validate-portability.mjs @wotjr1649",
  "/scripts/write-portability-* @wotjr1649",
  "/tests/portability/ @wotjr1649",
  "/tests/state.test.mjs @wotjr1649"
];
const EXACT_PATHS = new Set([
  ".claude-plugin/marketplace.json",
  ".github/CODEOWNERS",
  ".github/workflows/portability-ci.yml",
  LEGACY_WORKFLOW,
  "CHANGELOG.md",
  "README.md",
  "ci/scenario-registry-v1.json",
  "docs/FORK_AND_PORTING_STRATEGY.md",
  "docs/security/REPOSITORY_SECURITY.md",
  "docs/security/THREAT_MODEL.md",
  "package-lock.json",
  "package.json",
  "plugins/codex/.claude-plugin/plugin.json",
  "plugins/codex/CHANGELOG.md",
  "plugins/codex/README.md",
  "scripts/validate-p5.mjs",
  "scripts/validate-portability.mjs",
  "tests/state.test.mjs",
  "tests/runtime.test.mjs",
  "toolchain-portability-v1.json",
  // The v0.3 hardening program's surface, admitted one path at a time so that the diff which
  // admits it is the review. Everything not listed here still has to match the released base
  // byte-for-byte, and the base itself does not move.
  "plugins/codex/agents/codex-rescue.md",
  "plugins/codex/skills/codex-cli-runtime/SKILL.md",
  "tests/args.test.mjs",
  "tests/commands.test.mjs",
  "tests/fake-codex-fixture.mjs",
  "tests/git.test.mjs",
  "tests/helpers.mjs",
  "tests/job-control.test.mjs",
  "tests/process.test.mjs",
  // The P2/P3/P4/P5 baseline surface, admitted so its assertions can be brought to the facts
  // they describe. Every one of these pins a literal the project has since moved past -- the
  // release version, the archived workflow trigger, a method v0.2 introduced -- and the effect
  // was five suites that could not pass and therefore ran nowhere. Admitting them is the point
  // at which that is reviewed; the freeze on everything else is unchanged.
  "scripts/lib/p3-validation.mjs",
  "scripts/lib/p5-validation.mjs",
  "scripts/validate-p3.mjs",
  "scripts/validate-p4.mjs",
  "tests/contract/command-transcripts-v1.json",
  "tests/downstream-identity.test.mjs",
  "tests/p3-security-baseline.test.mjs",
  "tests/p4-contract-baseline.test.mjs",
  "tests/p5-matrix-profile.test.mjs",
  // This one was already live in `npm test` and carried the same win32-only platform
  // declaration, contradicting the SUPPORTED_RUNTIMES it is meant to test.
  "tests/platform-policy.test.mjs"
]);
const PATH_PREFIXES = [
  "ci/portability-",
  "docs/baselines/portability-",
  "docs/superpowers/",
  "evidence/portability/",
  "plugins/codex/scripts/",
  "scripts/install-portability-",
  "scripts/lib/portability-",
  "scripts/write-portability-",
  "tests/portability/"
];

function normalizeRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /[\0-\x1f\x7f]/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return "";
  }
  return normalized;
}

export function isPortabilityAllowedPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return Boolean(
    normalized &&
      (EXACT_PATHS.has(normalized) ||
        PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)))
  );
}

export function validatePortabilityCodeowners(text) {
  const lines = new Set(String(text ?? "").replaceAll("\r\n", "\n").split("\n"));
  return PORTABILITY_CODEOWNER_LINES
    .filter((line) => !lines.has(line))
    .map((line) => `P6E_CODEOWNERS: missing ${line}`);
}

export function validatePortabilityChangeSet({
  changedPaths,
  baseValidatorText,
  currentValidatorText
}) {
  const errors = [];
  const normalizedPaths = changedPaths.map(normalizeRelativePath);
  const canonicalBase = baseValidatorText.replaceAll("\r\n", "\n");
  const canonicalCurrent = currentValidatorText.replaceAll("\r\n", "\n");
  if (
    normalizedPaths.length === 0 ||
    normalizedPaths.includes("") ||
    new Set(normalizedPaths).size !== normalizedPaths.length
  ) {
    errors.push("P6E_CHANGESET: non-empty unique repository-relative paths required");
  }
  for (const relativePath of normalizedPaths) {
    if (relativePath && !isPortabilityAllowedPath(relativePath)) {
      errors.push(`P6E_SCOPE:${relativePath}`);
    }
  }
  // The base carries the continuation block now, so the allowance this used to grant -- the
  // released validator plus exactly the marked block -- is spent, and byte identity is the only
  // acceptable state. Extending the continuation again means another re-baseline, which is the
  // point: each extension is reviewed as the diff that moves the base.
  if (normalizedPaths.includes(ENTRYPOINT) && canonicalCurrent !== canonicalBase) {
    errors.push("P6E_P5_ENTRYPOINT: legacy validator may not change without a re-baseline");
  }
  return errors;
}

export function validateLegacyWorkflowArchive(baseText, currentText) {
  const base = String(baseText ?? "").replaceAll("\r\n", "\n");
  const current = String(currentText ?? "").replaceAll("\r\n", "\n");
  // The archived state is the base now. The one-time transformation this used to permit --
  // replacing the released `pull_request` trigger with `workflow_dispatch` -- happened in v0.2,
  // so the only acceptable state is byte identity against a base that is already archived.
  // Restoring the trigger still fails, which is what V2 has to route around.
  if (!base.includes("on:\n  workflow_dispatch:\n") || current !== base) {
    return ["P6E_LEGACY_WORKFLOW_ARCHIVE: the archived workflow may not change"];
  }
  return [];
}

export function findCrLfDigestPaths(root, inheritedTests) {
  const matches = new Set();
  if (typeof root !== "string" || !Array.isArray(inheritedTests)) return matches;
  let testsRoot;
  try {
    const testsPath = path.resolve(root, "tests");
    const testsStat = fs.lstatSync(testsPath);
    if (!testsStat.isDirectory() || testsStat.isSymbolicLink()) return matches;
    testsRoot = fs.realpathSync(testsPath);
  } catch {
    return matches;
  }
  for (const entry of inheritedTests) {
    const relativePath = normalizeRelativePath(entry?.path);
    if (
      !/^tests\/[^/]+\.test\.mjs$/.test(relativePath) ||
      !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")
    ) {
      continue;
    }
    try {
      const candidate = path.resolve(root, relativePath);
      const stat = fs.lstatSync(candidate);
      const realPath = fs.realpathSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(realPath) !== testsRoot) continue;
      const crlfText = fs
        .readFileSync(realPath, "utf8")
        .replaceAll("\r\n", "\n")
        .replaceAll("\n", "\r\n");
      if (createHash("sha256").update(crlfText).digest("hex") === entry.sha256) {
        matches.add(relativePath);
      }
    } catch {
      continue;
    }
  }
  return matches;
}

export function filterLegacyP5ContinuationErrors(
  errors,
  allowedPaths,
  portableDigestPaths = [],
  unregisteredTestPaths = []
) {
  if (
    !Array.isArray(errors) ||
    !Array.isArray(allowedPaths) ||
    !Array.isArray(portableDigestPaths) ||
    !Array.isArray(unregisteredTestPaths)
  ) {
    return ["P6E_LEGACY_ERRORS: invalid input"];
  }
  const archiveErrors = errors.filter((error) => LEGACY_ARCHIVE_P5_ERRORS.includes(error));
  if (
    archiveErrors.length !== LEGACY_ARCHIVE_P5_ERRORS.length ||
    !archiveErrors.every((error, index) => error === LEGACY_ARCHIVE_P5_ERRORS[index])
  ) {
    return [...errors];
  }
  const allowed = new Set(allowedPaths.map(normalizeRelativePath).filter(Boolean));
  const portableDigests = new Set(
    portableDigestPaths
      .map(normalizeRelativePath)
      .filter((relativePath) => /^tests\/[^/]+\.test\.mjs$/.test(relativePath))
  );
  return errors.filter((error) => {
    if (LEGACY_ARCHIVE_P5_ERRORS.includes(error)) return false;
    for (const prefix of [
      "P5E_POST_SOURCE_CHANGE:",
      "P5E_SCOPE: path outside P5 allowlist: "
    ]) {
      if (error.startsWith(prefix)) return !allowed.has(normalizeRelativePath(error.slice(prefix.length)));
    }
    // One rule rather than a growing list of paths: an immutability complaint is consumed when
    // the portability allowlist has already admitted that path, either exactly or as a directory
    // whose contents it admits. The allowlist is where admission is reviewed, and this filter
    // only runs when validatePortabilityRepository has already returned clean, so deferring to
    // it keeps the decision in one place instead of duplicating it here for every new surface.
    const immutablePrefix = "P5E_IMMUTABLE_PATH:";
    if (error.startsWith(immutablePrefix)) {
      const target = normalizeRelativePath(error.slice(immutablePrefix.length));
      if (!target) return true;
      return !(
        allowed.has(target) ||
        [...allowed].some((relativePath) => relativePath.startsWith(`${target}/`))
      );
    }
    if (error === "P5E_TEST_OMITTED: inherited test mapping differs from the exact tree") {
      // The inherited inventory is the released set and the legacy validator freezes its
      // count, so a test this program adds cannot join it. Consume the mismatch only when
      // every test the registry does not list is one the portability gate already admitted.
      const unregistered = unregisteredTestPaths.map(normalizeRelativePath).filter(Boolean);
      return (
        unregistered.length === 0 ||
        !unregistered.every((relativePath) => allowed.has(relativePath))
      );
    }
    const digestPrefix = "P5E_TEST_DIGEST:";
    if (error.startsWith(digestPrefix)) {
      return !portableDigests.has(normalizeRelativePath(error.slice(digestPrefix.length)));
    }
    return true;
  });
}

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

function paths(result) {
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function currentText(root, headSha, localPaths, relativePath) {
  if (localPaths.has(relativePath)) return fs.readFileSync(path.join(root, relativePath), "utf8");
  const result = git(root, ["show", `${headSha}:${relativePath}`]);
  if (result.status !== 0) throw new Error(`unavailable ${relativePath}`);
  return result.stdout;
}

// v0.2 pinned the two inherited tests to one exact reviewed transformation of the released
// file. v0.3 changes them deliberately and repeatedly, so that spec is superseded: the registry
// digest is the record of what those files contain, and scripts/lib/p5-validation.mjs enforces
// that every digest matches its file. What is enforced here is that nothing else in the
// registry moves -- only the inherited digests, and the blocking mapping that has to name every
// test on disk.
function validateReleaseVersionMigration(root, headSha, localPaths) {
  const errors = [];
  try {
    const registryPath = "ci/scenario-registry-v1.json";
    const baseRegistryResult = git(root, ["show", `${PORTABILITY_BASE}:${registryPath}`]);
    if (baseRegistryResult.status !== 0) throw new Error("base release registry unavailable");
    const baseRegistry = JSON.parse(baseRegistryResult.stdout);
    const currentRegistry = JSON.parse(currentText(root, headSha, localPaths, registryPath));
    const expectedRegistry = structuredClone(baseRegistry);
    // The inherited inventory itself may move now: v0.3 added two test files and eight tests to
    // files that were already here, and the recorded 13/167 had understated the tree for two
    // releases because nothing cross-checked it. What is still enforced is that every entry
    // names a file that exists and that the totals are the inventory's own arithmetic -- a
    // registry claiming a count it does not contain is what this rule is for.
    const currentInherited = currentRegistry.inheritedTests ?? [];
    const currentPaths = new Set(currentInherited.map((entry) => normalizeRelativePath(entry.path)));
    // Entries may be added, never dropped. Without this, swapping a real suite for a trivial file
    // with a matching declaredCount keeps both the file count and the sum intact, so neither this
    // rule nor the literal totals in p5-validation.mjs would notice the suite leaving.
    for (const entry of baseRegistry.inheritedTests ?? []) {
      if (!currentPaths.has(normalizeRelativePath(entry.path))) {
        throw new Error("release registry entry unavailable");
      }
    }
    expectedRegistry.inheritedTests = structuredClone(currentInherited);
    for (const entry of expectedRegistry.inheritedTests) {
      const relativePath = normalizeRelativePath(entry.path);
      if (!relativePath || !fs.existsSync(path.join(root, relativePath))) {
        throw new Error("release registry entry unavailable");
      }
    }
    expectedRegistry.inheritedTestTotals = {
      ...baseRegistry.inheritedTestTotals,
      files: expectedRegistry.inheritedTests.length,
      executedTests: expectedRegistry.inheritedTests.reduce(
        (sum, entry) => sum + (entry.declaredCount ?? 0),
        0
      )
    };
    for (const scenario of expectedRegistry.scenarios ?? []) {
      const current = (currentRegistry.scenarios ?? []).find((item) => item.id === scenario.id);
      if (current && Array.isArray(scenario.testFiles) && Array.isArray(current.testFiles)) {
        scenario.testFiles = current.testFiles;
      }
    }
    if (JSON.stringify(currentRegistry) !== JSON.stringify(expectedRegistry)) {
      errors.push("P6E_VERSION_REGISTRY: only inherited digests and the blocking test mapping may change");
    }
  } catch (error) {
    errors.push(`P6E_VERSION_MIGRATION:${error.message}`);
  }
  return errors;
}

export function validatePortabilityRepository(root, head = "HEAD") {
  const errors = [];
  const resolved = git(root, ["rev-parse", `${head}^{commit}`]);
  const headSha = typeof resolved.stdout === "string" ? resolved.stdout.trim() : "";
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
    return ["P6E_HEAD: exact commit required"];
  }
  if (git(root, ["merge-base", "--is-ancestor", PORTABILITY_BASE, headSha]).status !== 0) {
    return ["P6E_BASE_ANCESTRY: released v0.1 base must be an ancestor"];
  }

  const committed = git(root, ["diff", "--name-only", "-z", `${PORTABILITY_BASE}..${headSha}`]);
  const unstaged = git(root, ["diff", "--name-only", "-z"]);
  const staged = git(root, ["diff", "--name-only", "-z", "--cached"]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if ([committed, unstaged, staged, untracked].some((result) => result.status !== 0)) {
    return ["P6E_GIT: unable to enumerate the portability change set"];
  }
  const localPaths = new Set([...paths(unstaged), ...paths(staged), ...paths(untracked)]);
  const changedPaths = [...new Set([...paths(committed), ...localPaths])];

  const baseValidator = git(root, ["show", `${PORTABILITY_BASE}:${ENTRYPOINT}`]);
  let currentValidatorText = "";
  if (localPaths.has(ENTRYPOINT)) {
    try {
      const entrypoint = path.join(root, ENTRYPOINT);
      if (!fs.lstatSync(entrypoint).isFile()) throw new Error();
      currentValidatorText = fs.readFileSync(entrypoint, "utf8");
    } catch {
      errors.push("P6E_P5_ENTRYPOINT: validator is missing or not a regular file");
    }
  } else {
    const currentValidator = git(root, ["show", `${headSha}:${ENTRYPOINT}`]);
    if (currentValidator.status !== 0 || typeof currentValidator.stdout !== "string") {
      errors.push("P6E_P5_ENTRYPOINT: validator is unavailable at the validation head");
    } else {
      currentValidatorText = currentValidator.stdout;
    }
  }
  if (baseValidator.status !== 0) {
    errors.push("P6E_BASE: released validator is unavailable");
  } else {
    errors.push(...validatePortabilityChangeSet({
      changedPaths,
      baseValidatorText: baseValidator.stdout,
      currentValidatorText
    }));
  }
  const baseWorkflow = git(root, ["show", `${PORTABILITY_BASE}:${LEGACY_WORKFLOW}`]);
  if (baseWorkflow.status !== 0) {
    errors.push("P6E_LEGACY_WORKFLOW_ARCHIVE: released workflow is unavailable");
  } else {
    try {
      errors.push(...validateLegacyWorkflowArchive(
        baseWorkflow.stdout,
        currentText(root, headSha, localPaths, LEGACY_WORKFLOW)
      ));
    } catch (error) {
      errors.push(`P6E_LEGACY_WORKFLOW_ARCHIVE:${error.message}`);
    }
  }
  errors.push(...validateReleaseVersionMigration(root, headSha, localPaths));
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(root, "ci/portability-profiles-v1.json"), "utf8"));
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/portability-ci.yml"), "utf8");
    const codeowners = fs.readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    errors.push(...validatePortabilityProfiles(registry));
    errors.push(...validatePortabilityWorkflow(workflow, registry));
    errors.push(...validatePortabilityCodeowners(codeowners));
    errors.push(...validatePortabilityPackage(packageJson));
  } catch (error) {
    errors.push(`P6E_POLICY_FILES:${error.message}`);
  }
  return errors;
}
