#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/p4-schema-validator.mjs";
import {
  validateP5GateEvidence,
  validateP5HostedHarvest,
  validateP5Privacy,
  validateP5RestJobBinding,
  validateP5RunnerEvidence
} from "./lib/p5-validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "P5_SANITIZED_EVIDENCE_JSON=";
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const EXPECTED_JOB_NAMES = [
  "Policy validation",
  "Install and build",
  "Unit tests",
  "Core contract / current",
  "Core contract / previous",
  "Windows integration",
  "Claude structural lifecycle / minimum",
  "Claude structural lifecycle / current",
  "Security",
  "Dependency review",
  "Non-blocking Codex canary / next",
  "CI"
];
const VALIDATION_SOURCE_PATHS = [
  "scripts/run-p5-hosted-evidence-collector.mjs",
  "scripts/lib/p5-validation.mjs",
  "scripts/lib/p4-schema-validator.mjs",
  "scripts/lib/p3-validation.mjs",
  "ci/matrix-profiles-v1.json",
  "ci/scenario-registry-v1.json",
  "toolchain.json",
  "evidence/schemas/p5-runner-evidence-v2.schema.json",
  "evidence/schemas/p5-gate-evidence-v1.schema.json",
  "evidence/schemas/p5-hosted-harvest-v1.schema.json"
];
const EXECUTABLE_VALIDATOR_PATHS = VALIDATION_SOURCE_PATHS.slice(0, 4);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("P5E_COLLECT_ARGUMENT: exact flag/value pairs are required");
    }
    if (values.has(key)) throw new Error(`P5E_COLLECT_ARGUMENT: duplicate ${key}`);
    values.set(key, value);
  }
  const repository = values.get("--repo") ?? "";
  const runId = Number(values.get("--run-id"));
  const runAttempt = Number(values.get("--run-attempt"));
  const sourceHeadSha = values.get("--source-sha") ?? "";
  const eventMergeSha = values.get("--merge-sha") ?? "";
  const workflowSha = values.get("--workflow-sha") ?? "";
  const outputPath = values.get("--output") ?? "";
  if (
    values.size !== 7 ||
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !SHA40.test(sourceHeadSha) ||
    !SHA40.test(eventMergeSha) ||
    !SHA40.test(workflowSha) ||
    outputPath.length === 0
  ) {
    throw new Error("P5E_COLLECT_ARGUMENT: repository, run, SHAs, and output must be exact");
  }
  return {
    repository,
    runId,
    runAttempt,
    sourceHeadSha,
    eventMergeSha,
    workflowSha,
    outputPath: path.resolve(outputPath)
  };
}

function ghJson(endpoint) {
  const result = spawnSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      endpoint
    ],
    { encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`P5E_COLLECT_GITHUB: read-only API request failed (${endpoint})`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`P5E_COLLECT_GITHUB: API response was not JSON (${endpoint})`);
  }
}

function repositoryFullName(repository) {
  if (REPOSITORY.test(repository?.full_name ?? "")) return repository.full_name;
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(repository?.url ?? "");
  return match?.[1] ?? "";
}

function gitResult(args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", ROOT, ...args], {
    encoding,
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`P5E_COLLECT_SOURCE: git ${args[0]} failed for validation source`);
  }
  return result.stdout;
}

function loadPinnedValidationSource(sourceHeadSha) {
  const objectType = String(
    gitResult(["cat-file", "-t", `${sourceHeadSha}^{commit}`])
  ).trim();
  if (objectType !== "commit") {
    throw new Error("P5E_COLLECT_SOURCE: source SHA is not a local commit object");
  }
  const blobs = new Map();
  const files = [];
  for (const relativePath of VALIDATION_SOURCE_PATHS) {
    const blob = gitResult(["show", `${sourceHeadSha}:${relativePath}`], null);
    blobs.set(relativePath, blob);
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(blob).digest("hex")
    });
  }
  for (const relativePath of EXECUTABLE_VALIDATOR_PATHS) {
    const committedObject = String(
      gitResult(["rev-parse", `${sourceHeadSha}:${relativePath}`])
    ).trim();
    const currentObject = String(
      gitResult(["hash-object", `--path=${relativePath}`, relativePath])
    ).trim();
    if (committedObject !== currentObject) {
      throw new Error(
        `P5E_COLLECT_SOURCE: executing validator differs from source commit (${relativePath})`
      );
    }
  }
  const json = (relativePath) => JSON.parse(blobs.get(relativePath).toString("utf8"));
  const scenarioBytes = blobs.get("ci/scenario-registry-v1.json");
  return {
    profiles: json("ci/matrix-profiles-v1.json"),
    scenarios: json("ci/scenario-registry-v1.json"),
    scenarioRegistrySha256: createHash("sha256").update(scenarioBytes).digest("hex"),
    toolchain: json("toolchain.json"),
    schemas: {
      runner: json("evidence/schemas/p5-runner-evidence-v2.schema.json"),
      gate: json("evidence/schemas/p5-gate-evidence-v1.schema.json"),
      harvest: json("evidence/schemas/p5-hosted-harvest-v1.schema.json")
    },
    validationSource: {
      sourceHeadSha,
      authority: "source-commit-git-objects-and-matched-executable",
      files
    }
  };
}

function parseGhLogLine(line) {
  const columns = line.split("\t");
  if (columns.length !== 3) return null;
  const timestampAndMessage = columns[2].replace(/^\uFEFF/, "");
  const match = /^(\S+)\s([\s\S]*)$/.exec(timestampAndMessage);
  if (!match) return null;
  const timestamp = match[1];
  if (!Number.isFinite(Date.parse(timestamp))) return null;
  return {
    jobName: columns[0],
    stepName: columns[1],
    timestamp,
    message: match[2]
  };
}

export function extractP5StepMarkers(lines, jobName, step) {
  const startedAt = Date.parse(step?.started_at);
  const completedAt = Date.parse(step?.completed_at);
  const markers = [];
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return markers;
  for (const line of lines) {
    const parsed = parseGhLogLine(line);
    if (
      !parsed ||
      parsed.jobName !== jobName ||
      parsed.stepName !== step?.name ||
      Date.parse(parsed.timestamp) < startedAt ||
      Date.parse(parsed.timestamp) > completedAt + 999
    ) {
      continue;
    }
    if (!parsed.message.startsWith(MARKER)) continue;
    markers.push(parsed.message.slice(MARKER.length).trim());
  }
  return markers;
}

async function readJobMarkers(repository, job, evidenceStep) {
  const child = spawn(
    "gh",
    ["run", "view", "--repo", repository, "--job", String(job.id), "--log"],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const markers = [];
  for await (const line of lines) {
    markers.push(...extractP5StepMarkers([line], job.name, evidenceStep));
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`P5E_COLLECT_LOG: read-only job log request failed (${job.id})`);
  }
  return markers;
}

function evidenceStepName(jobName) {
  if (jobName === "CI") return "Write sanitized terminal gate evidence";
  if (jobName === "Non-blocking Codex canary / next") {
    return "Write sanitized canary evidence";
  }
  if (jobName === "Windows integration") {
    return "Write sanitized runner and resource evidence";
  }
  return "Write sanitized runner evidence";
}

function stableRestStep(step) {
  return step
    ? {
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        startedAt: step.started_at,
        completedAt: step.completed_at
      }
    : null;
}

function stableRestJob(job, evidenceStep, integrityStep) {
  return {
    id: job.id,
    runId: job.run_id,
    runAttempt: job.run_attempt,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.url,
    runUrl: job.run_url,
    htmlUrl: job.html_url,
    checkRunUrl: job.check_run_url,
    headSha: job.head_sha,
    workflowName: job.workflow_name,
    labels: Array.isArray(job.labels) ? [...job.labels] : [],
    integrityStep: stableRestStep(integrityStep),
    evidenceStep: stableRestStep(evidenceStep)
  };
}

function consolidatedAttempt(job, fragment = null) {
  const startedAt = Date.parse(job?.started_at);
  const completedAt = Date.parse(job?.completed_at);
  return {
    authority: "attempt-scoped-rest-plus-validated-runner-fragment",
    runAttempt: job?.run_attempt,
    restJobId: job?.id,
    workflowRerunCount: Number.isSafeInteger(job?.run_attempt)
      ? job.run_attempt - 1
      : null,
    jobAttempt: null,
    jobAttemptStatus: "not-exposed-by-attempt-jobs-api",
    automaticRetryCount: null,
    automaticRetryStatus: "not-exposed-by-attempt-jobs-api",
    timeout:
      job?.status === "completed" && job?.conclusion !== null
        ? job.conclusion === "timed_out"
        : null,
    restConclusion: job?.conclusion ?? null,
    restStartedAt: job?.started_at ?? null,
    restCompletedAt: job?.completed_at ?? null,
    restWallTimeMs:
      Number.isFinite(startedAt) && Number.isFinite(completedAt)
        ? Math.max(0, completedAt - startedAt)
        : null,
    rawExitCode: fragment?.attempt?.rawExitCode ?? null,
    rawExitCodeSource: fragment?.attempt?.rawExitCodeSource ?? null,
    runnerObservedStatus: fragment?.attempt?.observedStatus ?? null,
    fragmentAuthority: fragment ? "validated-rest-bound" : "unavailable"
  };
}

function buildTrustReadback(options, jobs, artifactResponse, cacheResponse, errors) {
  const jobStarts = jobs.map((job) => Date.parse(job?.started_at)).filter(Number.isFinite);
  const jobEnds = jobs.map((job) => Date.parse(job?.completed_at)).filter(Number.isFinite);
  const attemptStartedAt = jobStarts.length > 0 ? Math.min(...jobStarts) : NaN;
  const attemptCompletedAt = jobEnds.length > 0 ? Math.max(...jobEnds) + 999 : NaN;
  const allArtifacts = Array.isArray(artifactResponse?.artifacts)
    ? artifactResponse.artifacts
    : [];
  if (
    artifactResponse?.total_count !== allArtifacts.length ||
    allArtifacts.length > 100 ||
    !Number.isFinite(attemptStartedAt) ||
    !Number.isFinite(attemptCompletedAt)
  ) {
    errors.push("P5E_COLLECT_ARTIFACTS: complete run artifact inventory is unavailable");
  }
  const currentArtifacts = [];
  let otherAttemptArtifactCount = 0;
  for (const artifact of allArtifacts) {
    const createdAt = Date.parse(artifact?.created_at);
    const expiresAt = Date.parse(artifact?.expires_at);
    if (createdAt < attemptStartedAt || createdAt > attemptCompletedAt) {
      otherAttemptArtifactCount += 1;
      continue;
    }
    const retentionMilliseconds = expiresAt - createdAt;
    const retentionDays = 1;
    if (
      !Number.isSafeInteger(artifact?.id) ||
      typeof artifact?.name !== "string" ||
      artifact.name.length === 0 ||
      !Number.isSafeInteger(artifact?.size_in_bytes) ||
      artifact.size_in_bytes < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact?.digest ?? "") ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      Math.abs(retentionMilliseconds - 86_400_000) > 1_000 ||
      artifact?.workflow_run?.id !== options.runId ||
      artifact?.workflow_run?.head_sha !== options.sourceHeadSha
    ) {
      errors.push(`P5E_COLLECT_ARTIFACT:${artifact?.id ?? "missing"}`);
      continue;
    }
    currentArtifacts.push({
      id: artifact.id,
      name: artifact.name,
      sizeBytes: artifact.size_in_bytes,
      digest: artifact.digest,
      expired: artifact.expired,
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
      expiresAt: artifact.expires_at,
      retentionDays,
      url: artifact.url
    });
  }
  if (options.runAttempt > 1 && currentArtifacts.length > 0) {
    errors.push(
      "P5E_COLLECT_ARTIFACT_ATTEMPT: run-scoped artifacts cannot be attributed exactly after a rerun"
    );
  }
  if (options.runAttempt === 1 && otherAttemptArtifactCount > 0) {
    errors.push(
      "P5E_COLLECT_ARTIFACT_ATTEMPT: first attempt contains an out-of-window run artifact"
    );
  }
  const caches = Array.isArray(cacheResponse?.actions_caches)
    ? cacheResponse.actions_caches
    : [];
  if (cacheResponse?.total_count !== caches.length || caches.length > 100) {
    errors.push("P5E_COLLECT_CACHES: complete PR-ref cache inventory is unavailable");
  }
  if (caches.some((cache) => typeof cache?.key !== "string" || cache.key.length === 0)) {
    errors.push("P5E_COLLECT_CACHES: PR-ref cache key metadata is missing");
  }
  const cacheEntries = caches
    .map((cache) => ({
      id: cache?.id,
      keySha256: createHash("sha256").update(String(cache?.key ?? "")).digest("hex"),
      sizeBytes: cache?.size_in_bytes,
      createdAt: cache?.created_at,
      lastAccessedAt: cache?.last_accessed_at
    }))
    .sort((left, right) => left.id - right.id);
  if (
    cacheEntries.some(
      (entry) =>
        !Number.isSafeInteger(entry.id) ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        !Number.isFinite(Date.parse(entry.lastAccessedAt)) ||
        Date.parse(entry.createdAt) > Date.parse(entry.lastAccessedAt)
    )
  ) {
    errors.push("P5E_COLLECT_CACHES: PR-ref cache metadata is invalid");
  }
  return {
    artifact: {
      authority: "run-artifacts-rest-plus-reviewed-workflow",
      endpoint: `/repos/${options.repository}/actions/runs/${options.runId}/artifacts`,
      repositoryAuthoredUpload: false,
      actionOwnedConditionalUploadPossible: true,
      observedUpload: currentArtifacts.length > 0,
      attemptAttribution:
        options.runAttempt === 1
          ? "exact-first-attempt-time-window"
          : currentArtifacts.length === 0
            ? "exact-empty-current-attempt-window"
            : "unavailable-run-scoped-after-rerun",
      otherAttemptArtifactCount,
      artifacts: currentArtifacts,
      readbackStatus:
        errors.some((entry) => entry.startsWith("P5E_COLLECT_ARTIFACT"))
          ? "incomplete-or-invalid"
          : "resolved",
      releaseTrustInput: false
    },
    cache: {
      authority: "pr-ref-cache-rest-plus-reviewed-workflow",
      ref: `refs/pull/${options.pullRequestNumber}/merge`,
      repositoryAuthoredCacheEnabled: false,
      packageManagerCacheEnabled: false,
      matchingRefCacheCount: cacheEntries.length,
      entries: cacheEntries,
      inventorySha256: createHash("sha256")
        .update(JSON.stringify(cacheEntries))
        .digest("hex"),
      readbackStatus: errors.some((entry) => entry.startsWith("P5E_COLLECT_CACHES"))
        ? "incomplete-or-invalid"
        : "resolved",
      releaseTrustInput: false
    }
  };
}

async function collectJob(
  repository,
  job,
  expected,
  profiles,
  toolchain,
  scenarios,
  schemas
) {
  const stepName = evidenceStepName(job.name);
  const evidenceSteps = Array.isArray(job.steps)
    ? job.steps.filter((step) => step?.name === stepName)
    : [];
  const evidenceStep = evidenceSteps[0] ?? null;
  const integritySteps = Array.isArray(job.steps)
    ? job.steps.filter((step) => step?.name === "Verify clean evidence source")
    : [];
  const integrityStep = integritySteps[0] ?? null;
  const record = {
    rest: stableRestJob(job, evidenceStep, integrityStep),
    consolidatedAttempt: consolidatedAttempt(job),
    fragmentStatus: "missing-runtime-fragment",
    markerCount: 0,
    markerSha256: null,
    fragmentSha256: null,
    validationErrors: [],
    fragment: null
  };
  if (evidenceSteps.length !== 1 || evidenceStep?.conclusion !== "success") {
    record.validationErrors.push("P5E_COLLECT_STEP: exact successful evidence step is absent");
    return record;
  }
  let markers;
  try {
    markers = await readJobMarkers(repository, job, evidenceStep);
  } catch {
    record.validationErrors.push("P5E_COLLECT_LOG: exact job log could not be read");
    return record;
  }
  record.markerCount = markers.length;
  if (markers.length !== 1) {
    record.validationErrors.push("P5E_COLLECT_MARKER: exact evidence step must contain one marker");
    return record;
  }
  record.markerSha256 = createHash("sha256").update(markers[0]).digest("hex");
  let fragment;
  try {
    fragment = JSON.parse(markers[0]);
  } catch {
    record.validationErrors.push("P5E_COLLECT_MARKER: marker payload is not JSON");
    return record;
  }
  const schema = fragment?.evidenceKind === "terminal-gate"
    ? schemas.gate
    : schemas.runner;
  try {
    record.validationErrors.push(
      ...validateJsonSchema(fragment, schema, `job:${job.id}`)
    );
  } catch {
    record.validationErrors.push("P5E_COLLECT_SCHEMA: marker schema validation failed closed");
  }
  record.validationErrors.push(
    ...(fragment?.evidenceKind === "terminal-gate"
      ? validateP5GateEvidence(fragment)
      : validateP5RunnerEvidence(
          fragment,
          profiles,
          toolchain,
          scenarios,
          schemas.scenarioRegistrySha256
        )),
    ...validateP5RestJobBinding(fragment, job, expected)
  );
  if (record.validationErrors.length === 0) {
    record.fragmentStatus = "validated-rest-bound";
    record.fragment = fragment;
    record.fragmentSha256 = createHash("sha256")
      .update(JSON.stringify(fragment))
      .digest("hex");
    record.consolidatedAttempt = consolidatedAttempt(job, fragment);
  } else {
    record.fragmentStatus = "rejected-untrusted-fragment";
  }
  return record;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (fs.existsSync(options.outputPath)) {
    throw new Error("P5E_COLLECT_OUTPUT: output must be a new file");
  }
  const pinned = loadPinnedValidationSource(options.sourceHeadSha);
  const runEndpoint = `/repos/${options.repository}/actions/runs/${options.runId}/attempts/${options.runAttempt}`;
  const run = ghJson(runEndpoint);
  const pullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  if (pullRequests.length !== 1 || !Number.isSafeInteger(pullRequests[0]?.number)) {
    throw new Error("P5E_COLLECT_RUN: exact pull request run identity is required");
  }
  const pull = pullRequests[0];
  const pullBaseRepository = repositoryFullName(pull?.base?.repo);
  const pullHeadRepository = repositoryFullName(pull?.head?.repo);
  if (
    run?.id !== options.runId ||
    run?.run_attempt !== options.runAttempt ||
    run?.event !== "pull_request" ||
    run?.name !== "Pull Request CI" ||
    run?.path !== ".github/workflows/pull-request-ci.yml" ||
    run?.head_sha !== options.sourceHeadSha ||
    run?.repository?.full_name !== options.repository ||
    run?.head_repository?.full_name !== pullHeadRepository ||
    pullBaseRepository !== options.repository ||
    pull?.head?.sha !== options.sourceHeadSha
  ) {
    throw new Error("P5E_COLLECT_RUN: workflow run and pull request metadata differ");
  }
  const endpoint = `/repos/${options.repository}/actions/runs/${options.runId}/attempts/${options.runAttempt}/jobs?per_page=100`;
  const response = ghJson(endpoint);
  const jobs = response?.jobs ?? [];
  const observedNames = jobs.map(({ name }) => name).sort();
  const expectedNames = [...EXPECTED_JOB_NAMES].sort();
  const collectionErrors = [];
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    collectionErrors.push("P5E_COLLECT_JOB_SET: exact attempt allocation set differs");
  }
  options.pullRequestNumber = pull.number;
  const artifactResponse = ghJson(
    `/repos/${options.repository}/actions/runs/${options.runId}/artifacts?per_page=100`
  );
  const cacheResponse = ghJson(
    `/repos/${options.repository}/actions/caches?ref=${encodeURIComponent(`refs/pull/${pull.number}/merge`)}&per_page=100`
  );
  const trustReadback = buildTrustReadback(
    options,
    jobs,
    artifactResponse,
    cacheResponse,
    collectionErrors
  );
  const { profiles, toolchain, scenarios, schemas } = pinned;
  schemas.scenarioRegistrySha256 = pinned.scenarioRegistrySha256;
  const expected = {
    runId: options.runId,
    runAttempt: options.runAttempt,
    sourceHeadSha: options.sourceHeadSha,
    eventMergeSha: options.eventMergeSha,
    workflowSha: options.workflowSha,
    repository: options.repository,
    workflowRef:
      `${options.repository}/.github/workflows/pull-request-ci.yml@` +
      `refs/pull/${pull.number}/merge`,
    pullRequest: {
      number: pull.number,
      baseRepository: options.repository,
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      headRepository: pullHeadRepository,
      headRef: pull.head.ref,
      headSha: pull.head.sha
    }
  };
  const records = [];
  for (const job of jobs) {
    if (EXPECTED_JOB_NAMES.includes(job.name)) {
      records.push(
        await collectJob(
          options.repository,
          job,
          expected,
          profiles,
          toolchain,
          scenarios,
          schemas
        )
      );
    }
  }
  for (const record of records) collectionErrors.push(...record.validationErrors);
  const harvest = {
    schemaVersion: "p5-hosted-harvest-v1",
    repository: options.repository,
    run: { id: options.runId, attempt: options.runAttempt },
    sourceHeadSha: options.sourceHeadSha,
    eventMergeSha: options.eventMergeSha,
    workflowSha: options.workflowSha,
    pullRequest: expected.pullRequest,
    validationSource: pinned.validationSource,
    trustReadback,
    extraction: {
      command: "gh run view --job --log",
      scope: "exact REST evidence-step name and immutable tabular log columns",
      rawLogsPersisted: false,
      markerPrefix: MARKER,
      markerCardinality: "exactly-one-per-successful-evidence-step"
    },
    collectionStatus: collectionErrors.length === 0 ? "validated" : "incomplete-or-invalid",
    collectionErrors,
    jobs: records
  };
  const privacyErrors = validateP5Privacy(harvest, "hostedHarvest");
  if (privacyErrors.length > 0) {
    throw new Error("P5E_COLLECT_PRIVACY: sanitized harvest failed privacy validation");
  }
  const harvestSchemaErrors = validateJsonSchema(
    harvest,
    schemas.harvest,
    "hostedHarvest"
  );
  if (harvestSchemaErrors.length > 0) {
    throw new Error("P5E_COLLECT_SCHEMA: hosted harvest failed its versioned schema");
  }
  const harvestSemanticErrors = validateP5HostedHarvest(harvest, {
    profiles,
    toolchain,
    scenarios,
    scenarioRegistrySha256: pinned.scenarioRegistrySha256,
    validationSource: pinned.validationSource,
    expected,
    schemas
  });
  if (harvestSemanticErrors.length > 0) {
    throw new Error("P5E_COLLECT_SEMANTIC: hosted harvest failed semantic validation");
  }
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(harvest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: harvest.schemaVersion,
      collectionStatus: harvest.collectionStatus,
      run: harvest.run,
      jobs: harvest.jobs.length,
      errors: collectionErrors.length,
      outputSha256: createHash("sha256")
        .update(fs.readFileSync(options.outputPath))
        .digest("hex")
    })}\n`
  );
  if (collectionErrors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
