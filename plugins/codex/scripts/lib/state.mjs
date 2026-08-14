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
const MAX_UPDATE_ATTEMPTS = 3;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROLLER_KEYS = ["generation", "version", "workerId"];
// The statuses that mean nothing will write to this job's files again. Everything else --
// including `indeterminate`, which means a cancellation could not be confirmed -- may still
// have a live worker behind it.
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

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

// The validators take an already-resolved jobs directory rather than a cwd. Resolving one
// spawns git and, on POSIX, creates directories; doing that once per record turned every
// state read into n+1 process launches and gave a validator a filesystem side effect.
function assertManagedLogFile(jobsDir, logFile) {
  if (logFile == null) return null;
  if (typeof logFile !== "string") throw new Error("Invalid state job log file.");
  const basename = path.basename(logFile);
  const stem = basename.endsWith(".log") ? basename.slice(0, -4) : "";
  if (path.dirname(logFile) !== jobsDir || !JOB_ID.test(stem)) {
    throw new Error("Invalid state job log file.");
  }
  return logFile;
}

function assertJobRecord(jobsDir, job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("Invalid state job record.");
  }
  assertJobId(job.id);
  assertManagedLogFile(jobsDir, job.logFile);
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

function assertJobRecords(jobsDir, jobs) {
  jobs.forEach((job) => assertJobRecord(jobsDir, job));
  const logs = jobs.map((job) => job.logFile).filter(Boolean);
  if (new Set(logs).size !== logs.length) throw new Error("Duplicate state job log file.");
}

function parseState(jobsDir, raw) {
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
  assertJobRecords(jobsDir, parsed.jobs);
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

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function loadState(cwd) {
  const stored = readFileOrNull(resolveStateFile(cwd));
  return stored === null ? defaultState() : parseState(resolveJobsDir(cwd), stored);
}

// A job dropped from the index is unreachable: every lookup goes through the index, so its files
// are a leak rather than a record. Observed in production as one workspace holding no indexed jobs
// and eight artifact files. Jobs that might still be written to are left alone, and orphans from
// prunes that already happened are not swept -- that needs a generation-bound sweep which would
// race a worker that has written its file but not yet indexed it.
//
// Call this only once the prune has been committed. See writeState.
function removePrunedJobArtifacts(jobsDir, prunedJobs) {
  for (const job of prunedJobs) {
    // An allowlist, not a denylist, so a status nobody thought about here keeps its files.
    // `indeterminate` is the case that made this matter: it means a cancellation could not be
    // confirmed, which is to say the worker may still be running and appending to that log.
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      continue;
    }
    for (const artifact of [path.join(jobsDir, `${job.id}.json`), path.join(jobsDir, `${job.id}.log`)]) {
      try {
        const stats = fs.lstatSync(artifact);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        fs.unlinkSync(artifact);
      } catch {
        // Already gone, or not an ordinary file this plugin wrote.
      }
    }
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

// `expected` opts a write into a compare-and-swap: the rename only happens if the file still
// holds the bytes the caller read. Omit it for an unconditional write.
function atomicWriteFile(filePath, content, expected) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // ponytail: optimistic, not locked. A writer that lands between this check and the rename
    // still wins; take a real lock file if contention ever shows up in practice.
    if (expected !== undefined && readFileOrNull(filePath) !== expected) {
      return false;
    }
    fs.renameSync(temporary, filePath);
    return true;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeState(cwd, state, expected) {
  ensureStateDir(cwd);
  if (!Array.isArray(state.jobs)) throw new Error("Invalid state jobs.");
  assertJobRecords(resolveJobsDir(cwd), state.jobs);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const written = atomicWriteFile(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, expected);
  if (!written) return null;

  // Deletion goes after the commit, because only a committed prune is a fact. Deleting first left
  // the files gone on an attempt that lost its compare-and-swap, while the index that won still
  // pointed at them -- the exact opposite of what this cleanup is for. Dying between the rename
  // and this leaves the files behind instead, which is the leak this replaced and is recoverable.
  const retained = new Set(nextJobs.map((job) => job.id));
  removePrunedJobArtifacts(
    resolveJobsDir(cwd),
    (state.jobs ?? []).filter((job) => !retained.has(job.id))
  );
  return nextState;
}

export function saveState(cwd, state) {
  // Reading the stored state back is the guard, not a leftover: it rejects any record whose
  // log file sits outside the managed jobs directory, and pruning plus session cleanup act on
  // those paths. Refuse to rewrite state that does not survive that read.
  loadState(cwd);
  return writeState(cwd, state);
}

export function updateState(cwd, mutate) {
  const stateFile = resolveStateFile(cwd);
  const jobsDir = resolveJobsDir(cwd);
  for (let attempt = 1; ; attempt += 1) {
    // One read per attempt: parsing the stored bytes is the same guard saveState applies.
    const stored = readFileOrNull(stateFile);
    const state = stored === null ? defaultState() : parseState(jobsDir, stored);
    mutate(state);
    // The atomic write makes the write atomic, not the transaction. Commit against the bytes
    // this attempt read so a concurrent writer's record is rebuilt on rather than overwritten.
    // The final attempt commits unconditionally, which is what every attempt used to do.
    const next = writeState(cwd, state, attempt < MAX_UPDATE_ATTEMPTS ? stored : undefined);
    if (next) return next;
  }
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
  assertJobRecord(resolveJobsDir(cwd), payload);
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
  const jobsDir = resolveJobsDir(cwd);
  assertJobRecords(jobsDir, jobs);
  const targets = [];
  for (const job of jobs) {
    if (job.sessionId !== sessionId) throw new Error("Session artifact identity mismatch.");
    const jobFile = resolveJobFile(cwd, job.id);
    if (!fs.existsSync(jobFile)) continue;
    const stats = fs.lstatSync(jobFile);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid session artifact file.");
    const stored = readJobFile(jobFile);
    assertJobRecord(jobsDir, stored);
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
    for (const filePath of files) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Every target was validated above; a failure here is the file already being gone or,
        // on Windows, a worker still holding its log open. Neither is worth aborting a session
        // teardown for, and the index has already been committed without these jobs.
      }
    }
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
