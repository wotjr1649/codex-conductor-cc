import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensurePrivateDirectory,
  ensurePrivateTree,
  resolvePosixRuntimeRoot
} from "./runtime-paths.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROLLER_KEYS = ["generation", "version", "workerId"];

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (process.platform === "win32") {
    const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
    return path.join(stateRoot, `${slug}-${hash}`);
  }

  const uid = process.getuid?.();
  const stateRoot = pluginDataDir
    ? ensurePrivateTree(
        ensurePrivateDirectory(fs.realpathSync.native(pluginDataDir), { uid }),
        ["state"],
        { uid }
      )
    : ensurePrivateTree(resolvePosixRuntimeRoot({ uid }), ["state"], { uid });
  return ensurePrivateTree(stateRoot, [`${slug}-${hash}`], { uid });
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (process.platform === "win32") {
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  } else {
    ensurePrivateTree(path.dirname(jobsDir), [path.basename(jobsDir)], {
      uid: process.getuid?.()
    });
  }
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    throw new Error("Invalid job id.");
  }
  return jobId;
}

function jobArtifactPath(cwd, jobId, extension) {
  return path.join(resolveJobsDir(cwd), `${assertJobId(jobId)}.${extension}`);
}

function assertManagedLogFile(cwd, logFile) {
  if (logFile == null) return null;
  if (typeof logFile !== "string") throw new Error("Invalid state job log file.");
  const basename = path.basename(logFile);
  const stem = basename.endsWith(".log") ? basename.slice(0, -4) : "";
  if (path.dirname(logFile) !== resolveJobsDir(cwd) || !JOB_ID.test(stem)) {
    throw new Error("Invalid state job log file.");
  }
  return logFile;
}

function assertJobRecord(cwd, job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("Invalid state job record.");
  }
  assertJobId(job.id);
  assertManagedLogFile(cwd, job.logFile);
  if (job.controller != null) {
    const controller = job.controller;
    if (
      !controller ||
      typeof controller !== "object" ||
      Array.isArray(controller) ||
      controller.version !== 1 ||
      Object.keys(controller).sort().join("\0") !== CONTROLLER_KEYS.join("\0") ||
      !JOB_ID.test(controller.workerId) ||
      !JOB_ID.test(controller.generation)
    ) {
      throw new Error("Invalid worker controller state.");
    }
  }
}

function assertJobRecords(cwd, jobs) {
  jobs.forEach((job) => assertJobRecord(cwd, job));
  const logs = jobs.map((job) => job.logFile).filter(Boolean);
  if (new Set(logs).size !== logs.length) throw new Error("Duplicate state job log file.");
}

function parseState(cwd, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid state file.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== STATE_VERSION ||
    !parsed.config ||
    typeof parsed.config !== "object" ||
    Array.isArray(parsed.config) ||
    !Array.isArray(parsed.jobs)
  ) {
    throw new Error("Invalid state file.");
  }
  assertJobRecords(cwd, parsed.jobs);
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...parsed.config
    },
    jobs: parsed.jobs
  };
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  return parseState(cwd, fs.readFileSync(stateFile, "utf8"));
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function atomicWriteFile(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function saveState(cwd, state) {
  loadState(cwd);
  ensureStateDir(cwd);
  if (!Array.isArray(state.jobs)) throw new Error("Invalid state jobs.");
  assertJobRecords(cwd, state.jobs);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  // ponytail: retain unindexed artifacts; add generation-bound cleanup if disk usage matters.
  atomicWriteFile(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  if (payload?.id !== jobId) throw new Error("Job file id does not match its path.");
  assertJobRecord(cwd, payload);
  atomicWriteFile(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  const payload = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const jobId = path.basename(jobFile, ".json");
  if (payload?.id !== jobId) throw new Error("Job file id does not match its path.");
  if (
    payload.logFile != null &&
    (path.dirname(payload.logFile) !== path.dirname(jobFile) ||
      !JOB_ID.test(path.basename(payload.logFile, ".log")) ||
      path.extname(payload.logFile) !== ".log")
  ) {
    throw new Error("Invalid job log file.");
  }
  return payload;
}

export function removeSessionJobArtifacts(cwd, jobs, sessionId) {
  if (!Array.isArray(jobs) || typeof sessionId !== "string" || !JOB_ID.test(sessionId)) {
    throw new Error("Invalid session artifact cleanup request.");
  }
  assertJobRecords(cwd, jobs);
  const targets = [];
  for (const job of jobs) {
    if (job.sessionId !== sessionId) throw new Error("Session artifact identity mismatch.");
    const jobFile = resolveJobFile(cwd, job.id);
    if (!fs.existsSync(jobFile)) continue;
    const stats = fs.lstatSync(jobFile);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid session artifact file.");
    const stored = readJobFile(jobFile);
    assertJobRecord(cwd, stored);
    for (const key of ["id", "sessionId", "status", "pid", "logFile"]) {
      if (stored[key] !== job[key]) throw new Error("Session artifact identity mismatch.");
    }
    const files = [jobFile];
    if (stored.logFile && fs.existsSync(stored.logFile)) {
      const logStats = fs.lstatSync(stored.logFile);
      if (!logStats.isFile() || logStats.isSymbolicLink()) {
        throw new Error("Invalid session artifact file.");
      }
      files.push(stored.logFile);
    }
    targets.push(files);
  }
  for (const files of targets) {
    for (const filePath of files) fs.unlinkSync(filePath);
  }
  return targets.length;
}

export function resolveJobLogFile(cwd, jobId) {
  assertJobId(jobId);
  ensureStateDir(cwd);
  return jobArtifactPath(cwd, jobId, "log");
}

export function resolveJobFile(cwd, jobId) {
  assertJobId(jobId);
  ensureStateDir(cwd);
  return jobArtifactPath(cwd, jobId, "json");
}
