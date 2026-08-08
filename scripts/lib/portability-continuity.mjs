import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  validatePortabilityPackage,
  validatePortabilityProfiles,
  validatePortabilityWorkflow
} from "./portability-policy.mjs";

export const PORTABILITY_BASE = "099afca5946debe5620411f2ab1d4aec388918ca";

const ENTRYPOINT = "scripts/validate-p5.mjs";
const LEGACY_WORKFLOW = ".github/workflows/pull-request-ci.yml";
const LEGACY_ARCHIVE_P5_ERRORS = [
  "workflow: trigger set must be exactly pull_request",
  "P5E_WORKFLOW_DIGEST: PR workflow differs from the reviewed P5 executable graph"
];
const BEGIN = "// PORTABILITY_CONTINUATION_BEGIN\n";
const END = "// PORTABILITY_CONTINUATION_END\n";
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
  "toolchain-portability-v1.json"
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

function stripContinuation(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, begin + BEGIN.length);
  if (
    begin < 0 ||
    end < 0 ||
    text.indexOf(BEGIN, begin + BEGIN.length) !== -1 ||
    text.indexOf(END, end + END.length) !== -1
  ) {
    return null;
  }
  return text.slice(0, begin) + text.slice(end + END.length);
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
  if (
    !normalizedPaths.includes(ENTRYPOINT) ||
    stripContinuation(canonicalCurrent) !== canonicalBase
  ) {
    errors.push("P6E_P5_ENTRYPOINT: legacy validator may contain only the marked continuation");
  }
  return errors;
}

export function validateLegacyWorkflowArchive(baseText, currentText) {
  const base = String(baseText ?? "").replaceAll("\r\n", "\n");
  const current = String(currentText ?? "").replaceAll("\r\n", "\n");
  const trigger = "on:\n  pull_request:\n";
  if (base.split(trigger).length !== 2 || current !== base.replace(trigger, "on:\n  workflow_dispatch:\n")) {
    return ["P6E_LEGACY_WORKFLOW_ARCHIVE: only the pull_request trigger may be archived"];
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
  portableDigestPaths = []
) {
  if (
    !Array.isArray(errors) ||
    !Array.isArray(allowedPaths) ||
    !Array.isArray(portableDigestPaths)
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
    if (error === "P5E_IMMUTABLE_PATH:package-lock.json") return !allowed.has("package-lock.json");
    if (error === "P5E_IMMUTABLE_PATH:plugins/codex/scripts") {
      return ![...allowed].some((relativePath) => relativePath.startsWith("plugins/codex/scripts/"));
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

function replaceExactOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`migration marker unavailable: ${before}`);
  return text.replace(before, after);
}

function validateReleaseVersionMigration(root, headSha, localPaths) {
  const errors = [];
  try {
    const runtimePath = "tests/runtime.test.mjs";
    const statePath = "tests/state.test.mjs";
    const registryPath = "ci/scenario-registry-v1.json";
    const baseRuntimeResult = git(root, ["show", `${PORTABILITY_BASE}:${runtimePath}`]);
    const baseStateResult = git(root, ["show", `${PORTABILITY_BASE}:${statePath}`]);
    const baseRegistryResult = git(root, ["show", `${PORTABILITY_BASE}:${registryPath}`]);
    if (
      baseRuntimeResult.status !== 0 ||
      baseStateResult.status !== 0 ||
      baseRegistryResult.status !== 0
    ) {
      throw new Error("base release files unavailable");
    }
    const baseRuntime = baseRuntimeResult.stdout.replaceAll("\r\n", "\n");
    const currentRuntime = currentText(root, headSha, localPaths, runtimePath).replaceAll("\r\n", "\n");
    const marker = '  version: "0.1.0"';
    const expectedRuntime = [
      [marker, '  version: "0.2.0"'],
      [
        '  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");\n  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");',
        `  fs.writeFileSync(completedJobFile, JSON.stringify({
    id: "review-completed",
    status: "completed",
    sessionId: "sess-current",
    logFile: completedLog
  }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({
    id: "review-other",
    status: "completed",
    sessionId: "sess-other",
    logFile: otherSessionLog
  }, null, 2), "utf8");`
      ],
      [
        '  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");',
        `  fs.writeFileSync(runningJobFile, JSON.stringify({
    id: "review-running",
    status: "running",
    sessionId: "sess-current",
    pid: sleeper.pid,
    logFile: runningLog
  }, null, 2), "utf8");`
      ]
    ].reduce((text, [before, after]) => replaceExactOnce(text, before, after), baseRuntime);
    if (currentRuntime !== expectedRuntime) {
      errors.push("P6E_VERSION_TEST: runtime contract may change only its client version and session cleanup fixture");
    }

    const baseState = baseStateResult.stdout.replaceAll("\r\n", "\n");
    const currentState = currentText(root, headSha, localPaths, statePath).replaceAll("\r\n", "\n");
    const expectedState = [
      [
        'test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {',
        'test("saveState prunes the index without deleting dropped job artifacts", () => {'
      ],
      [
        "  assert.equal(fs.existsSync(retainedLogFile), true);\n",
        "  assert.equal(fs.existsSync(retainedLogFile), true);\n  assert.equal(fs.existsSync(prunedJobFile), true);\n  assert.equal(fs.existsSync(prunedLogFile), true);\n"
      ],
      [
        "    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)",
        "    Array.from({ length: 51 }, (_, index) => `job-${index}`)"
      ]
    ].reduce((text, [before, after]) => replaceExactOnce(text, before, after), baseState);
    if (currentState !== expectedState) {
      errors.push("P6E_STATE_TEST: state retention test may change only its prune expectations");
    }

    const baseRegistry = JSON.parse(baseRegistryResult.stdout);
    const currentRegistry = JSON.parse(currentText(root, headSha, localPaths, registryPath));
    const expectedRegistry = structuredClone(baseRegistry);
    const entry = expectedRegistry.inheritedTests?.find((item) => item.path === runtimePath);
    const stateEntry = expectedRegistry.inheritedTests?.find((item) => item.path === statePath);
    if (!entry || !stateEntry) throw new Error("release registry entry unavailable");
    entry.sha256 = createHash("sha256").update(currentRuntime).digest("hex");
    stateEntry.sha256 = createHash("sha256").update(currentState).digest("hex");
    if (JSON.stringify(currentRegistry) !== JSON.stringify(expectedRegistry)) {
      errors.push("P6E_VERSION_REGISTRY: only the runtime test digest may change");
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
