import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EXACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WINDOWS_PRIVATE_PATH_PATTERN =
  /(?:[A-Za-z]:\\Users\\[^\\\s"']+\\|\\\\[^\\\s"']+\\|\\\\[?.]\\|GLOBALROOT)/i;
const SECRET_KEY_PATTERN =
  /(?:authorization|bearer|credential|password|privatekey|secret|token)/i;
const PROMPT_KEY_PATTERN = /(?:^|_)(?:prompt|rawPrompt)(?:$|_)/i;
const ALLOWED_TOP_LEVEL = new Set([
  "$schema",
  "schemaVersion",
  "platform",
  "reviewPolicy",
  "tools",
  "actions",
  "specifications",
  "rejectedOrDeferred"
]);
const ALLOWED_TOOL_FIELDS = new Set([
  "id",
  "version",
  "purpose",
  "owner",
  "installable",
  "artifact",
  "signature",
  "source",
  "review"
]);
const ALLOWED_ARTIFACT_FIELDS = new Set([
  "kind",
  "url",
  "sha256",
  "executableRelativePath",
  "executableSha256",
  "installedExecutableName"
]);
const ALLOWED_SIGNATURE_FIELDS = new Set([
  "kind",
  "published",
  "verified",
  "signer",
  "authenticodeRequired"
]);
const ALLOWED_SOURCE_FIELDS = new Set([
  "releaseUrl",
  "tag",
  "commit",
  "releasedAt",
  "license",
  "licenseUrl"
]);
const ALLOWED_REVIEW_FIELDS = new Set([
  "reviewedAt",
  "expiresAt",
  "disposition"
]);

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(value, allowed, location, errors) {
  if (!ownObject(value)) {
    errors.push(`${location}: expected object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${location}: unknown field ${key}`);
    }
  }
}

function requireString(value, location, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${location}: non-empty string required`);
  }
}

function requireDate(value, location, errors) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    errors.push(`${location}: exact YYYY-MM-DD date required`);
    return;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    errors.push(`${location}: invalid date`);
  }
}

function validateReview(review, location, errors) {
  unknownFields(review, ALLOWED_REVIEW_FIELDS, location, errors);
  if (!ownObject(review)) return;
  requireDate(review.reviewedAt, `${location}.reviewedAt`, errors);
  requireDate(review.expiresAt, `${location}.expiresAt`, errors);
  requireString(review.disposition, `${location}.disposition`, errors);
  if (
    typeof review.reviewedAt === "string" &&
    typeof review.expiresAt === "string" &&
    review.expiresAt < review.reviewedAt
  ) {
    errors.push(`${location}: expiry precedes review`);
  }
}

function validateArtifact(artifact, installable, location, errors) {
  unknownFields(artifact, ALLOWED_ARTIFACT_FIELDS, location, errors);
  if (!ownObject(artifact)) return;
  if (!["file", "zip", "embedded"].includes(artifact.kind)) {
    errors.push(`${location}.kind: unsupported artifact kind`);
  }
  if (
    typeof artifact.url !== "string" ||
    !artifact.url.startsWith("https://") ||
    /\/(?:latest|stable)(?:\/|$)/i.test(artifact.url)
  ) {
    errors.push(`${location}.url: immutable HTTPS URL required`);
  }
  if (!SHA256_PATTERN.test(artifact.sha256 ?? "")) {
    errors.push(`${location}.sha256: lowercase SHA-256 required`);
  }
  requireString(
    artifact.executableRelativePath,
    `${location}.executableRelativePath`,
    errors
  );
  if (
    typeof artifact.executableRelativePath === "string" &&
    (path.win32.isAbsolute(artifact.executableRelativePath) ||
      artifact.executableRelativePath.split(/[\\/]/).includes(".."))
  ) {
    errors.push(`${location}.executableRelativePath: confined relative path required`);
  }
  if (installable && !SHA256_PATTERN.test(artifact.executableSha256 ?? "")) {
    errors.push(`${location}.executableSha256: installable tool needs SHA-256`);
  }
  if (
    artifact.executableSha256 !== null &&
    !SHA256_PATTERN.test(artifact.executableSha256 ?? "")
  ) {
    errors.push(`${location}.executableSha256: invalid SHA-256`);
  }
  if (
    installable &&
    (typeof artifact.installedExecutableName !== "string" ||
      !/\.exe$/i.test(artifact.installedExecutableName) ||
      /[\\/]/.test(artifact.installedExecutableName))
  ) {
    errors.push(`${location}.installedExecutableName: plain .exe name required`);
  }
}

function validateSignature(signature, location, errors) {
  unknownFields(signature, ALLOWED_SIGNATURE_FIELDS, location, errors);
  if (!ownObject(signature)) return;
  requireString(signature.kind, `${location}.kind`, errors);
  for (const key of ["published", "verified", "authenticodeRequired"]) {
    if (typeof signature[key] !== "boolean") {
      errors.push(`${location}.${key}: boolean required`);
    }
  }
  if (signature.verified && !signature.published) {
    errors.push(`${location}: verification cannot precede publication`);
  }
  if (
    signature.signer !== null &&
    (typeof signature.signer !== "string" || signature.signer.length === 0)
  ) {
    errors.push(`${location}.signer: string or null required`);
  }
  if ((signature.verified || signature.authenticodeRequired) && !signature.signer) {
    errors.push(`${location}.signer: signer required by policy`);
  }
}

function validateSource(source, location, errors) {
  unknownFields(source, ALLOWED_SOURCE_FIELDS, location, errors);
  if (!ownObject(source)) return;
  if (
    typeof source.releaseUrl !== "string" ||
    !source.releaseUrl.startsWith("https://")
  ) {
    errors.push(`${location}.releaseUrl: HTTPS URL required`);
  }
  requireString(source.tag, `${location}.tag`, errors);
  if (!COMMIT_PATTERN.test(source.commit ?? "")) {
    errors.push(`${location}.commit: full commit SHA required`);
  }
  requireDate(source.releasedAt, `${location}.releasedAt`, errors);
  requireString(source.license, `${location}.license`, errors);
  if (
    typeof source.licenseUrl !== "string" ||
    !source.licenseUrl.startsWith("https://")
  ) {
    errors.push(`${location}.licenseUrl: HTTPS URL required`);
  }
}

export function validateToolchain(manifest) {
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);
  unknownFields(manifest, ALLOWED_TOP_LEVEL, "toolchain", errors);
  if (!ownObject(manifest)) return errors;

  if (manifest.$schema !== "./evidence/schemas/toolchain-v1.schema.json") {
    errors.push("toolchain.$schema: unexpected schema path");
  }
  if (manifest.schemaVersion !== "toolchain-v1") {
    errors.push("toolchain.schemaVersion: unsupported version");
  }
  if (
    !ownObject(manifest.platform) ||
    manifest.platform.os !== "windows" ||
    manifest.platform.architecture !== "x64" ||
    manifest.platform.nodeRange !== ">=24.0.0" ||
    Object.keys(manifest.platform ?? {}).some(
      (key) => !["os", "architecture", "nodeRange"].includes(key)
    )
  ) {
    errors.push("toolchain.platform: exact Windows x64 product policy required");
  }

  const reviewPolicyFields = new Set([
    "reviewedAt",
    "expiresAt",
    "owner",
    "reviewer",
    "driftTriggers"
  ]);
  unknownFields(manifest.reviewPolicy, reviewPolicyFields, "reviewPolicy", errors);
  if (ownObject(manifest.reviewPolicy)) {
    requireDate(manifest.reviewPolicy.reviewedAt, "reviewPolicy.reviewedAt", errors);
    requireDate(manifest.reviewPolicy.expiresAt, "reviewPolicy.expiresAt", errors);
    requireString(manifest.reviewPolicy.owner, "reviewPolicy.owner", errors);
    requireString(manifest.reviewPolicy.reviewer, "reviewPolicy.reviewer", errors);
    if (
      typeof manifest.reviewPolicy.expiresAt === "string" &&
      manifest.reviewPolicy.expiresAt < today
    ) {
      errors.push("reviewPolicy.expiresAt: review snapshot has expired");
    }
    if (
      !Array.isArray(manifest.reviewPolicy.driftTriggers) ||
      manifest.reviewPolicy.driftTriggers.length === 0
    ) {
      errors.push("reviewPolicy.driftTriggers: non-empty array required");
    }
  }

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    errors.push("toolchain.tools: non-empty array required");
  } else {
    const ids = new Set();
    manifest.tools.forEach((tool, index) => {
      const location = `tools[${index}]`;
      unknownFields(tool, ALLOWED_TOOL_FIELDS, location, errors);
      if (!ownObject(tool)) return;
      requireString(tool.id, `${location}.id`, errors);
      if (ids.has(tool.id)) errors.push(`${location}.id: duplicate ${tool.id}`);
      ids.add(tool.id);
      if (!EXACT_VERSION_PATTERN.test(tool.version ?? "")) {
        errors.push(`${location}.version: exact numeric version required`);
      }
      requireString(tool.purpose, `${location}.purpose`, errors);
      requireString(tool.owner, `${location}.owner`, errors);
      if (typeof tool.installable !== "boolean") {
        errors.push(`${location}.installable: boolean required`);
      }
      validateArtifact(tool.artifact, tool.installable, `${location}.artifact`, errors);
      if (
        tool.artifact?.kind !== "embedded" &&
        typeof tool.artifact?.url === "string" &&
        typeof tool.version === "string" &&
        !tool.artifact.url.includes(tool.version)
      ) {
        errors.push(`${location}.artifact.url: selected version is not pinned in URL`);
      }
      validateSignature(tool.signature, `${location}.signature`, errors);
      validateSource(tool.source, `${location}.source`, errors);
      validateReview(tool.review, `${location}.review`, errors);
      if (
        typeof tool.review?.expiresAt === "string" &&
        tool.review.expiresAt < today
      ) {
        errors.push(`${location}.review.expiresAt: tool review has expired`);
      }
    });
  }

  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) {
    errors.push("toolchain.actions: non-empty array required");
  } else {
    for (const [index, action] of manifest.actions.entries()) {
      const location = `actions[${index}]`;
      const allowed = new Set(["id", "version", "commit", "license", "disposition"]);
      unknownFields(action, allowed, location, errors);
      if (!ownObject(action)) continue;
      for (const key of ["id", "version", "license", "disposition"]) {
        requireString(action[key], `${location}.${key}`, errors);
      }
      if (!COMMIT_PATTERN.test(action.commit ?? "")) {
        errors.push(`${location}.commit: full commit SHA required`);
      }
    }
  }

  if (!Array.isArray(manifest.specifications)) {
    errors.push("toolchain.specifications: array required");
  } else {
    for (const [index, specification] of manifest.specifications.entries()) {
      const location = `specifications[${index}]`;
      const allowed = new Set([
        "id",
        "version",
        "commit",
        "schemaUrl",
        "schemaSha256",
        "disposition"
      ]);
      unknownFields(specification, allowed, location, errors);
      if (!ownObject(specification)) continue;
      for (const key of ["id", "version", "schemaUrl", "disposition"]) {
        requireString(specification[key], `${location}.${key}`, errors);
      }
      if (!COMMIT_PATTERN.test(specification.commit ?? "")) {
        errors.push(`${location}.commit: full commit SHA required`);
      }
      if (
        typeof specification.schemaUrl !== "string" ||
        !specification.schemaUrl.startsWith("https://")
      ) {
        errors.push(`${location}.schemaUrl: HTTPS URL required`);
      }
      if (
        specification.schemaSha256 !== null &&
        !SHA256_PATTERN.test(specification.schemaSha256 ?? "")
      ) {
        errors.push(`${location}.schemaSha256: SHA-256 or null required`);
      }
    }
  }
  if (!Array.isArray(manifest.rejectedOrDeferred)) {
    errors.push("toolchain.rejectedOrDeferred: array required");
  } else {
    for (const [index, decision] of manifest.rejectedOrDeferred.entries()) {
      const location = `rejectedOrDeferred[${index}]`;
      unknownFields(decision, new Set(["id", "disposition"]), location, errors);
      if (!ownObject(decision)) continue;
      requireString(decision.id, `${location}.id`, errors);
      requireString(decision.disposition, `${location}.disposition`, errors);
    }
  }
  return errors;
}

function replacementForKey(key, value) {
  if (typeof value !== "string") return value;
  if (PROMPT_KEY_PATTERN.test(key)) return "[REDACTED:PROMPT]";
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED:SECRET]";
  if (/path/i.test(key) && WINDOWS_PRIVATE_PATH_PATTERN.test(value)) {
    return "[REDACTED:PRIVATE_PATH]";
  }
  return value;
}

export function redactEvidence(value, { seededSecrets = [] } = {}) {
  const counts = {
    seededSecretCount: 0,
    privatePathCount: 0,
    promptCount: 0,
    sensitiveFieldCount: 0
  };

  function visit(input, key = "") {
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (ownObject(input)) {
      const output = {};
      for (const [childKey, childValue] of Object.entries(input)) {
        const replaced = replacementForKey(childKey, childValue);
        if (replaced !== childValue) {
          if (PROMPT_KEY_PATTERN.test(childKey)) counts.promptCount += 1;
          else if (/path/i.test(childKey)) counts.privatePathCount += 1;
          else counts.sensitiveFieldCount += 1;
        }
        output[childKey] = visit(replaced, childKey);
      }
      return output;
    }
    if (typeof input !== "string") return input;

    let output = input;
    for (const secret of seededSecrets) {
      if (typeof secret === "string" && secret.length > 0 && output.includes(secret)) {
        counts.seededSecretCount += 1;
        output = output.split(secret).join("[REDACTED:SEEDED_SECRET]");
      }
    }
    if (WINDOWS_PRIVATE_PATH_PATTERN.test(output)) {
      counts.privatePathCount += 1;
      output = "[REDACTED:PRIVATE_PATH]";
    } else if (
      key &&
      PROMPT_KEY_PATTERN.test(key) &&
      !output.startsWith("[REDACTED:")
    ) {
      counts.promptCount += 1;
      output = "[REDACTED:PROMPT]";
    }
    return output;
  }

  const redacted = visit(value);
  if (!ownObject(redacted)) {
    return { value: redacted, redaction: counts };
  }
  return { ...redacted, redaction: counts };
}

export function validateEvidenceValue(value, { seededSecrets = [] } = {}) {
  const errors = [];

  function visit(input, location = "$", key = "") {
    if (Array.isArray(input)) {
      input.forEach((item, index) => visit(item, `${location}[${index}]`, key));
      return;
    }
    if (ownObject(input)) {
      for (const [childKey, childValue] of Object.entries(input)) {
        if (
          (SECRET_KEY_PATTERN.test(childKey) || PROMPT_KEY_PATTERN.test(childKey)) &&
          typeof childValue === "string" &&
          !childValue.startsWith("[REDACTED:")
        ) {
          errors.push(`${location}.${childKey}: sensitive raw field`);
        }
        visit(childValue, `${location}.${childKey}`, childKey);
      }
      return;
    }
    if (typeof input !== "string") return;
    for (const secret of seededSecrets) {
      if (secret && input.includes(secret)) {
        errors.push(`${location}: seeded secret present`);
      }
    }
    if (WINDOWS_PRIVATE_PATH_PATTERN.test(input)) {
      errors.push(`${location}: private or device path present`);
    }
    if (
      key &&
      PROMPT_KEY_PATTERN.test(key) &&
      !input.startsWith("[REDACTED:")
    ) {
      errors.push(`${location}: raw prompt present`);
    }
  }

  visit(value);
  return errors;
}

export function validateWorkflowText(workflow) {
  const errors = [];
  const required = [
    [/^\s+pull_request:\s*$/m, "pull_request event"],
    [/^\s+contents:\s+read\s*$/m, "read-only contents permission"],
    [/^\s+runs-on:\s+windows-2025\s*$/m, "fixed Windows 2025 runner"],
    [/^\s+node-version:\s+24\.18\.1\s*$/m, "exact Node.js version"],
    [/persist-credentials:\s+false/m, "checkout credential removal"],
    [/node\s+scripts\/validate-p3\.mjs/m, "P3 validator"]
  ];
  for (const [pattern, description] of required) {
    if (!pattern.test(workflow)) errors.push(`workflow: missing ${description}`);
  }
  const forbidden = [
    [/npm\s+install\s+-g/i, "global npm install"],
    [/id-token:\s+write/i, "OIDC write"],
    [/^\s*(pull_request_target|workflow_run|issue_comment):/m, "privileged event"],
    [/\bsecrets\./i, "secret reference"],
    [/actions\/(?:cache|upload-artifact)@/i, "PR cache or artifact"]
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(workflow)) errors.push(`workflow: forbidden ${description}`);
  }
  for (const match of workflow.matchAll(/^\s*uses:\s+([^@\s]+)@([^\s#]+)/gm)) {
    if (!COMMIT_PATTERN.test(match[2])) {
      errors.push(`workflow: mutable Action ${match[1]}@${match[2]}`);
    }
  }
  return errors;
}

export function validateMarkdownLinks(root, relativePaths) {
  const errors = [];
  const resolvedRoot = fs.realpathSync(root);
  for (const relativePath of relativePaths) {
    const sourcePath = path.resolve(resolvedRoot, relativePath);
    const markdown = fs.readFileSync(sourcePath, "utf8");
    for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const withoutFragment = target.split("#", 1)[0];
      if (!withoutFragment) continue;
      if (
        path.win32.isAbsolute(withoutFragment) ||
        withoutFragment.startsWith("\\\\") ||
        withoutFragment.startsWith("//")
      ) {
        errors.push(`${relativePath}: rooted link is forbidden: ${target}`);
        continue;
      }
      const resolvedTarget = path.resolve(path.dirname(sourcePath), withoutFragment);
      const relativeToRoot = path.relative(resolvedRoot, resolvedTarget);
      if (
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot)
      ) {
        errors.push(`${relativePath}: link escapes repository: ${target}`);
      } else if (!fs.existsSync(resolvedTarget)) {
        errors.push(`${relativePath}: missing local link: ${target}`);
      }
    }
  }
  return errors;
}

export function validateAttemptLedger(ledger) {
  const errors = [];
  if (
    !ownObject(ledger) ||
    ledger.schemaVersion !== "p3-attempt-ledger-v1" ||
    !Array.isArray(ledger.attempts) ||
    ledger.attempts.length === 0
  ) {
    return ["ledger: unsupported or empty"];
  }
  const statuses = new Set([
    "static-pass",
    "executed-pass",
    "executed-fail",
    "not-run",
    "blocked-with-evidence",
    "specified"
  ]);
  ledger.attempts.forEach((attempt, index) => {
    if (attempt.ordinal !== index + 1) {
      errors.push(`ledger.attempts[${index}]: ordinal must be contiguous`);
    }
    if (!statuses.has(attempt.status)) {
      errors.push(`ledger.attempts[${index}]: invalid status`);
    }
    if (!(Number.isInteger(attempt.rawExitCode) || attempt.rawExitCode === null)) {
      errors.push(`ledger.attempts[${index}]: rawExitCode required`);
    }
    if (!Number.isInteger(attempt.retryCount) || attempt.retryCount < 0) {
      errors.push(`ledger.attempts[${index}]: retryCount required`);
    }
    if (typeof attempt.id !== "string" || typeof attempt.diagnostic !== "string") {
      errors.push(`ledger.attempts[${index}]: id and diagnostic required`);
    }
  });
  if (!ledger.attempts.some((attempt) => attempt.status === "executed-fail")) {
    errors.push("ledger: baseline RED is missing");
  }
  if (!ledger.attempts.some((attempt) => attempt.status === "executed-pass")) {
    errors.push("ledger: correction or GREEN is missing");
  }
  return errors;
}
