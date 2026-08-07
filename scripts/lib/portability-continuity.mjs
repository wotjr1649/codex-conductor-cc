import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PORTABILITY_BASE = "099afca5946debe5620411f2ab1d4aec388918ca";

const ENTRYPOINT = "scripts/validate-p5.mjs";
const BEGIN = "// PORTABILITY_CONTINUATION_BEGIN\n";
const END = "// PORTABILITY_CONTINUATION_END\n";
const EXACT_PATHS = new Set([
  ".claude-plugin/marketplace.json",
  ".github/workflows/portability-ci.yml",
  "CHANGELOG.md",
  "README.md",
  "docs/FORK_AND_PORTING_STRATEGY.md",
  "docs/security/REPOSITORY_SECURITY.md",
  "docs/security/THREAT_MODEL.md",
  "package-lock.json",
  "package.json",
  "plugins/codex/.claude-plugin/plugin.json",
  "plugins/codex/README.md",
  "scripts/validate-p5.mjs",
  "scripts/validate-portability.mjs",
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
  return errors;
}
