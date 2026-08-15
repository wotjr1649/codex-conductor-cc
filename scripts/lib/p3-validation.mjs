import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EXACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE_PATH_PATTERN =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\(?:[?.]\\|wsl\$\\|[^\\\s"']+\\)|(?<![:/])\/(?:home|Users|mnt|tmp|var|workspace)(?:\/|\\)|GLOBALROOT)/i;
const SECRET_KEY_PATTERN =
  /(?:authorization|bearer|credential|password|privatekey|secret|token)/i;
const PROMPT_KEY_PATTERN = /(?:^|_)(?:prompt|rawPrompt)(?:$|_)/i;
const EXACT_GITLEAKS_CONFIG = [
  "[extend]",
  "useDefault = true",
  "",
  "[[allowlists]]",
  'description = "Reviewed public Authenticode leaf-certificate thumbprints"',
  'condition = "AND"',
  'regexTarget = "line"',
  'targetRules = ["generic-api-key"]',
  "paths = ['''^toolchain\\.json$''']",
  `regexes = ['''authenticodeThumbprint": "(?:0B7C30C11BF7250EC1ECD3254AC781D9E13D62F8|0D7581D2C51C59DF686C3000C70BF543F9F6C6CB)"''']`,
  ""
].join("\n");
const REQUIRED_LOCAL_CHECK_IDS = new Set([
  "p3-targeted-green",
  "p3-full-regression",
  "p3-build-regression",
  "p3-exact-acquisition",
  "p3-claude-minimum-strict",
  "p3-claude-current-strict",
  "p3-local-document-links",
  "p3-seeded-secret-controls",
  "p3-workflow-lint",
  "p3-workflow-security",
  "p3-lockfile-vulnerability-scan",
  "p3-secret-scan",
  "p3-sbom-spike",
  "p3-dependency-review-remote",
  "p3-external-link-check"
]);
const ALLOWED_TOP_LEVEL = new Set([
  "$schema",
  "schemaVersion",
  "platform",
  "installRecipe",
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
  "authenticodeRequired",
  "authenticodeSubject",
  "authenticodeThumbprint"
]);
const ALLOWED_SOURCE_FIELDS = new Set([
  "releaseUrl",
  "manifestUrl",
  "tag",
  "commit",
  "buildCommit",
  "buildDate",
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
  if (
    signature.authenticodeRequired &&
    (typeof signature.authenticodeSubject !== "string" ||
      signature.authenticodeSubject.length === 0 ||
      typeof signature.authenticodeThumbprint !== "string" ||
      !/^[0-9A-F]{40}$/.test(signature.authenticodeThumbprint))
  ) {
    errors.push(`${location}: exact Authenticode subject and thumbprint required`);
  }
  if (
    signature.authenticodeSubject !== undefined &&
    signature.authenticodeSubject !== null &&
    typeof signature.authenticodeSubject !== "string"
  ) {
    errors.push(`${location}.authenticodeSubject: string or null required`);
  }
  if (
    signature.authenticodeThumbprint !== undefined &&
    signature.authenticodeThumbprint !== null &&
    !/^[0-9A-F]{40}$/.test(signature.authenticodeThumbprint)
  ) {
    errors.push(`${location}.authenticodeThumbprint: uppercase SHA-1 required`);
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
  if (
    source.buildCommit !== undefined &&
    !COMMIT_PATTERN.test(source.buildCommit ?? "")
  ) {
    errors.push(`${location}.buildCommit: full vendor build commit required`);
  }
  if (
    source.buildDate !== undefined &&
    (typeof source.buildDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(source.buildDate))
  ) {
    errors.push(`${location}.buildDate: exact UTC timestamp required`);
  }
  if (
    source.manifestUrl !== undefined &&
    (typeof source.manifestUrl !== "string" ||
      !source.manifestUrl.startsWith("https://"))
  ) {
    errors.push(`${location}.manifestUrl: HTTPS URL required`);
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
  if (
    !ownObject(manifest.installRecipe) ||
    manifest.installRecipe.script !== "scripts/install-p3-tool.ps1" ||
    manifest.installRecipe.toolSelector !== "-ToolId <exact-id>" ||
    manifest.installRecipe.destinationPolicy !==
      "-DestinationRoot <run-owned-path-outside-repository>" ||
    manifest.installRecipe.globalInstall !== false ||
    manifest.installRecipe.pathLookup !== false ||
    Object.keys(manifest.installRecipe ?? {}).some(
      (key) =>
        ![
          "script",
          "toolSelector",
          "destinationPolicy",
          "globalInstall",
          "pathLookup"
        ].includes(key)
    )
  ) {
    errors.push("toolchain.installRecipe: exact run-owned acquisition policy required");
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
      if (
        tool.id?.startsWith("claude-") &&
        (!tool.source?.manifestUrl ||
          !tool.source?.buildCommit ||
          !tool.source?.buildDate ||
          tool.signature?.kind !== "authenticode")
      ) {
        errors.push(
          `${location}: Claude provenance must distinguish public tag, vendor build, and Authenticode verification`
        );
      }
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
  if (/path/i.test(key) && PRIVATE_PATH_PATTERN.test(value)) {
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
    if (PRIVATE_PATH_PATTERN.test(output)) {
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
    if (PRIVATE_PATH_PATTERN.test(input)) {
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

function yamlIndentedBlock(lines, startIndex) {
  const baseIndent = lines[startIndex].match(/^\s*/)[0].length;
  const block = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    block.push(line.trim());
  }
  return block;
}

// The workflow's trigger set, as a list. Exported because validateWorkflowText collapses every
// non-`pull_request` set into a single error, so callers that need to distinguish one archived
// trigger from that trigger plus a privileged one cannot get it from the error list.
export function workflowTriggers(workflow) {
  const lines = String(workflow ?? "").split(/\r?\n/);
  const eventIndex = lines.findIndex((line) => line === "on:");
  return eventIndex < 0 ? [] : yamlIndentedBlock(lines, eventIndex).map((entry) => entry.replace(/:$/, ""));
}

export function validateWorkflowText(workflow, admittedActions = []) {
  const errors = [];
  const lines = workflow.split(/\r?\n/);
  const required = [
    [/^\s+runs-on:\s+windows-2025\s*$/m, "fixed Windows 2025 runner"],
    [/^\s+node-version:\s+24\.18\.1\s*$/m, "exact Node.js version"],
    [/persist-credentials:\s+false/m, "checkout credential removal"],
    [/node\s+scripts\/validate-p3\.mjs/m, "P3 validator"]
  ];
  for (const [pattern, description] of required) {
    if (!pattern.test(workflow)) errors.push(`workflow: missing ${description}`);
  }

  const eventIndex = lines.findIndex((line) => line === "on:");
  const eventBlock = eventIndex >= 0 ? yamlIndentedBlock(lines, eventIndex) : [];
  if (
    eventIndex < 0 ||
    eventBlock.length !== 1 ||
    eventBlock[0] !== "pull_request:"
  ) {
    errors.push("workflow: trigger set must be exactly pull_request");
  }

  const permissionIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().startsWith("permissions:"));
  if (permissionIndexes.length === 0) {
    errors.push("workflow: explicit permissions block required");
  }
  for (const { line, index } of permissionIndexes) {
    if (line.trim() !== "permissions:") {
      errors.push("workflow: inline or shorthand permissions are forbidden");
      continue;
    }
    const permissionBlock = yamlIndentedBlock(lines, index);
    if (
      permissionBlock.length !== 1 ||
      permissionBlock[0] !== "contents: read"
    ) {
      errors.push("workflow: each permissions block must be exactly contents: read");
    }
  }

  const forbidden = [
    [/npm\s+install\s+-g/i, "global npm install"],
    [/^\s+[^#\n]+:\s+write\s*$/im, "write permission"],
    [/\bsecrets\./i, "secret reference"],
    [/actions\/(?:cache|upload-artifact)@/i, "PR cache or artifact"]
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(workflow)) errors.push(`workflow: forbidden ${description}`);
  }
  const observedActions = [];
  for (const match of workflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)) {
    const reference = match[1];
    const separator = reference.lastIndexOf("@");
    if (
      reference.startsWith("./") ||
      reference.startsWith("docker://") ||
      separator <= 0
    ) {
      errors.push(`workflow: unadmitted uses reference ${reference}`);
      continue;
    }
    const actionId = reference.slice(0, separator);
    const actionCommit = reference.slice(separator + 1);
    if (!COMMIT_PATTERN.test(actionCommit)) {
      errors.push(`workflow: mutable Action ${reference}`);
      continue;
    }
    observedActions.push(`${actionId}@${actionCommit}`);
  }
  if (admittedActions.length > 0) {
    const admitted = new Set(
      admittedActions.map((action) => `${action.id}@${action.commit}`)
    );
    for (const action of observedActions) {
      if (!admitted.has(action)) {
        errors.push(`workflow: Action is not admitted by toolchain.json: ${action}`);
      }
    }
    for (const action of admitted) {
      if (!observedActions.includes(action)) {
        errors.push(`workflow: admitted Action is not present: ${action}`);
      }
    }
  }
  const validatorIndex = workflow.indexOf("node scripts/validate-p3.mjs");
  const installIndex = workflow.indexOf("npm ci");
  if (validatorIndex < 0 || installIndex < 0 || validatorIndex > installIndex) {
    errors.push("workflow: dependency-free P3 validation must run before npm ci");
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

export function validateMarkdownStructure(root, relativePaths) {
  const errors = [];
  for (const relativePath of relativePaths) {
    const markdown = fs.readFileSync(path.join(root, relativePath), "utf8");
    if (markdown.includes("\0")) {
      errors.push(`${relativePath}: NUL byte is forbidden`);
    }
    let fence = null;
    markdown.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!match) return;
      const marker = match[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length, line: index + 1 };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length
      ) {
        fence = null;
      }
    });
    if (fence !== null) {
      errors.push(`${relativePath}:${fence.line}: unclosed Markdown fence`);
    }
  }
  return errors;
}

export function validateGitleaksConfig(config) {
  if (typeof config !== "string") {
    return [".gitleaks.toml: text required"];
  }
  const normalized = config.replaceAll("\r\n", "\n");
  return normalized === EXACT_GITLEAKS_CONFIG
    ? []
    : [
        ".gitleaks.toml: exact path, rule, AND condition, and reviewed-certificate regex required"
      ];
}

export function validateP3EvidenceManifest(manifest) {
  const errors = [];
  const statuses = new Set([
    "static-pass",
    "executed-pass",
    "executed-fail",
    "not-run",
    "blocked-with-evidence",
    "specified"
  ]);
  const topLevelFields = new Set([
    "schemaVersion",
    "evidenceId",
    "phase",
    "source",
    "environment",
    "executionContext",
    "toolchain",
    "localChecks",
    "requirementResults",
    "remoteExecution",
    "attestation",
    "sbom",
    "privacy",
    "attemptLedger"
  ]);
  unknownFields(manifest, topLevelFields, "evidence", errors);
  if (!ownObject(manifest)) return errors;

  const requiredTopLevel = [...topLevelFields];
  for (const field of requiredTopLevel) {
    if (!(field in manifest)) errors.push(`evidence.${field}: required`);
  }
  requireString(manifest.evidenceId, "evidence.evidenceId", errors);
  if (
    manifest.schemaVersion !== "p3-evidence-v1" ||
    manifest.phase !== "P3" ||
    manifest.remoteExecution !== "not-run" ||
    manifest.attemptLedger !== "evidence/ledgers/p3-attempts.json"
  ) {
    errors.push("evidence: fixed phase, schema, remote, or ledger identity mismatch");
  }

  unknownFields(
    manifest.source,
    new Set(["p2Base", "upstreamBase", "branch"]),
    "evidence.source",
    errors
  );
  if (
    !ownObject(manifest.source) ||
    !COMMIT_PATTERN.test(manifest.source.p2Base ?? "") ||
    !COMMIT_PATTERN.test(manifest.source.upstreamBase ?? "") ||
    manifest.source.branch !== "codex/p3-threat-toolchain-baseline"
  ) {
    errors.push("evidence.source: exact source lineage required");
  }

  unknownFields(
    manifest.environment,
    new Set(["os", "architecture", "filesystem", "privatePathsPersisted"]),
    "evidence.environment",
    errors
  );
  if (
    !ownObject(manifest.environment) ||
    manifest.environment.os !== "windows" ||
    manifest.environment.architecture !== "x64" ||
    manifest.environment.filesystem !== "NTFS" ||
    manifest.environment.privatePathsPersisted !== false
  ) {
    errors.push("evidence.environment: sanitized Windows x64 NTFS class required");
  }

  unknownFields(
    manifest.executionContext,
    new Set([
      "sourceCommit",
      "environmentClass",
      "defaultTrial",
      "deterministicRetryLimit",
      "outerTimeoutSeconds"
    ]),
    "evidence.executionContext",
    errors
  );
  if (
    !ownObject(manifest.executionContext) ||
    !COMMIT_PATTERN.test(manifest.executionContext.sourceCommit ?? "") ||
    manifest.executionContext.environmentClass !==
      "local-windows-x64-ntfs-run-owned" ||
    manifest.executionContext.defaultTrial !== 1 ||
    manifest.executionContext.deterministicRetryLimit !== 0 ||
    !Number.isInteger(manifest.executionContext.outerTimeoutSeconds) ||
    manifest.executionContext.outerTimeoutSeconds < 1
  ) {
    errors.push("evidence.executionContext: deterministic local context required");
  }

  unknownFields(
    manifest.toolchain,
    new Set(["manifest", "schema", "sha256", "validationStatus"]),
    "evidence.toolchain",
    errors
  );
  if (
    !ownObject(manifest.toolchain) ||
    manifest.toolchain.manifest !== "toolchain.json" ||
    manifest.toolchain.schema !== "evidence/schemas/toolchain-v1.schema.json" ||
    !SHA256_PATTERN.test(manifest.toolchain.sha256 ?? "") ||
    manifest.toolchain.validationStatus !== "executed-pass"
  ) {
    errors.push("evidence.toolchain: exact executed manifest binding required");
  }

  if (
    !Array.isArray(manifest.localChecks) ||
    manifest.localChecks.length !== REQUIRED_LOCAL_CHECK_IDS.size
  ) {
    errors.push("evidence.localChecks: exact required check set required");
  } else {
    const ids = new Set();
    const localFields = new Set([
      "id",
      "toolId",
      "version",
      "status",
      "rawExitCode",
      "scope",
      "summary",
      "artifactSha256"
    ]);
    manifest.localChecks.forEach((check, index) => {
      const location = `evidence.localChecks[${index}]`;
      unknownFields(check, localFields, location, errors);
      if (!ownObject(check)) return;
      for (const field of localFields) {
        if (!(field in check)) errors.push(`${location}.${field}: required`);
      }
      if (ids.has(check.id)) errors.push(`${location}.id: duplicate`);
      ids.add(check.id);
      for (const field of ["id", "toolId", "version", "scope", "summary"]) {
        requireString(check[field], `${location}.${field}`, errors);
      }
      if (!statuses.has(check.status)) errors.push(`${location}.status: invalid`);
      if (
        check.status === "executed-pass" &&
        check.rawExitCode !== 0
      ) {
        errors.push(`${location}: executed pass must exit zero`);
      }
      if (check.status === "not-run" && check.rawExitCode !== null) {
        errors.push(`${location}: not-run must have null exit`);
      }
      if (
        !(Number.isInteger(check.rawExitCode) || check.rawExitCode === null)
      ) {
        errors.push(`${location}.rawExitCode: integer or null required`);
      }
      if (
        check.artifactSha256 !== null &&
        !SHA256_PATTERN.test(check.artifactSha256 ?? "")
      ) {
        errors.push(`${location}.artifactSha256: SHA-256 or null required`);
      }
    });
    for (const required of REQUIRED_LOCAL_CHECK_IDS) {
      if (!ids.has(required)) {
        errors.push(`evidence.localChecks: missing ${required}`);
      }
    }
  }

  const requiredRequirements = new Set([
    "X3",
    "X4",
    "X7",
    "X8",
    "X9",
    "X12",
    "X14",
    "X15",
    "X17"
  ]);
  if (
    !Array.isArray(manifest.requirementResults) ||
    manifest.requirementResults.length !== requiredRequirements.size
  ) {
    errors.push("evidence.requirementResults: exact P3 requirement set required");
  } else {
    const observed = new Set();
    const resultFields = new Set([
      "requirementId",
      "status",
      "proofKind",
      "runtimeEnforcement",
      "deferredPhase",
      "evidence"
    ]);
    manifest.requirementResults.forEach((result, index) => {
      const location = `evidence.requirementResults[${index}]`;
      unknownFields(result, resultFields, location, errors);
      if (!ownObject(result)) return;
      for (const field of resultFields) {
        if (!(field in result)) errors.push(`${location}.${field}: required`);
      }
      observed.add(result.requirementId);
      if (!requiredRequirements.has(result.requirementId)) {
        errors.push(`${location}.requirementId: outside P3 set`);
      }
      if (!statuses.has(result.status)) errors.push(`${location}.status: invalid`);
      if (
        ![
          "policy",
          "validator-fixture",
          "runtime-fixture",
          "remote-readback",
          "attestation-verification"
        ].includes(result.proofKind)
      ) {
        errors.push(`${location}.proofKind: invalid`);
      }
      if (
        result.deferredPhase !== null &&
        (typeof result.deferredPhase !== "string" ||
          result.deferredPhase.length === 0)
      ) {
        errors.push(`${location}.deferredPhase: string or null required`);
      }
      if (
        !["observed", "not-observed", "not-applicable"].includes(
          result.runtimeEnforcement
        )
      ) {
        errors.push(`${location}.runtimeEnforcement: invalid`);
      }
      if (
        !Array.isArray(result.evidence) ||
        result.evidence.length === 0 ||
        result.evidence.some((item) => typeof item !== "string" || item.length === 0)
      ) {
        errors.push(`${location}.evidence: non-empty identifiers required`);
      }
      if (
        ["specified", "not-run", "blocked-with-evidence"].includes(result.status) &&
        (typeof result.deferredPhase !== "string" ||
          result.deferredPhase.length === 0)
      ) {
        errors.push(`${location}.deferredPhase: unresolved result needs owner`);
      }
    });
    for (const required of requiredRequirements) {
      if (!observed.has(required)) errors.push(`evidence.requirements: missing ${required}`);
    }
    const x7 = manifest.requirementResults.find(
      (result) => result.requirementId === "X7"
    );
    if (
      x7?.status !== "specified" ||
      x7?.deferredPhase !== "P6" ||
      !x7?.evidence?.includes("SEC-RELEASE-001")
    ) {
      errors.push("evidence.X7: release provenance must remain specified for P6");
    }
  }

  unknownFields(
    manifest.attestation,
    new Set(["status", "claim"]),
    "evidence.attestation",
    errors
  );
  if (
    !ownObject(manifest.attestation) ||
    manifest.attestation.status !== "not-run" ||
    manifest.attestation.claim !== "none"
  ) {
    errors.push("evidence.attestation: P3 must claim none/not-run");
  }

  unknownFields(
    manifest.sbom,
    new Set([
      "scope",
      "status",
      "format",
      "releaseInput",
      "artifactSha256",
      "artifactRetained"
    ]),
    "evidence.sbom",
    errors
  );
  if (
    !ownObject(manifest.sbom) ||
    manifest.sbom.scope !== "spike-only" ||
    manifest.sbom.status !== "executed-pass" ||
    manifest.sbom.format !== "SPDX-2.3-JSON" ||
    manifest.sbom.releaseInput !== false ||
    manifest.sbom.artifactRetained !== false ||
    !SHA256_PATTERN.test(manifest.sbom.artifactSha256 ?? "")
  ) {
    errors.push("evidence.sbom: exact ephemeral SPDX spike record required");
  }

  unknownFields(
    manifest.privacy,
    new Set([
      "validator",
      "seedFixtureId",
      "seedSha256",
      "trial",
      "retryCount",
      "seededSecretCount",
      "privatePathCount",
      "promptCount",
      "seededNegativeStatus",
      "redactedPositiveStatus",
      "privatePathsPersisted",
      "rawPromptsPersisted",
      "secretsPersisted"
    ]),
    "evidence.privacy",
    errors
  );
  if (
    !ownObject(manifest.privacy) ||
    manifest.privacy.validator !== "scripts/lib/p3-validation.mjs" ||
    manifest.privacy.seedFixtureId !== "p3-redaction-negative-control-v1" ||
    !SHA256_PATTERN.test(manifest.privacy.seedSha256 ?? "") ||
    manifest.privacy.trial !== 1 ||
    manifest.privacy.retryCount !== 0 ||
    manifest.privacy.seededSecretCount !== 1 ||
    manifest.privacy.privatePathCount !== 1 ||
    manifest.privacy.promptCount !== 1 ||
    manifest.privacy.seededNegativeStatus !== "executed-pass" ||
    manifest.privacy.redactedPositiveStatus !== "executed-pass" ||
    manifest.privacy.privatePathsPersisted !== false ||
    manifest.privacy.rawPromptsPersisted !== false ||
    manifest.privacy.secretsPersisted !== false
  ) {
    errors.push("evidence.privacy: executed negative/positive privacy proof required");
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
    if (attempt.blockedBeforeExecution === true && attempt.rawExitCode !== null) {
      errors.push(`ledger.attempts[${index}]: blocked attempt must have null exit`);
    }
    if (
      attempt.blockedBeforeExecution === false &&
      attempt.status === "executed-pass" &&
      attempt.rawExitCode !== 0
    ) {
      errors.push(`ledger.attempts[${index}]: passing execution must exit zero`);
    }
    if (
      attempt.blockedBeforeExecution === false &&
      attempt.status === "executed-fail" &&
      attempt.rawExitCode === null
    ) {
      errors.push(`ledger.attempts[${index}]: executed failure needs observed exit`);
    }
    if (
      attempt.status === "executed-fail" &&
      attempt.rawExitCode === 0 &&
      attempt.exitStatusReliable !== false
    ) {
      errors.push(
        `ledger.attempts[${index}]: zero-exit semantic failure must mark exit status unreliable`
      );
    }
    if (
      attempt.exitStatusReliable !== undefined &&
      typeof attempt.exitStatusReliable !== "boolean"
    ) {
      errors.push(`ledger.attempts[${index}]: exitStatusReliable must be boolean`);
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
