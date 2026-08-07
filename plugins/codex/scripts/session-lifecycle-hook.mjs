#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  loadState,
  readJobFile,
  removeSessionJobArtifacts,
  resolveJobFile,
  resolveStateFile,
  saveState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { assertSupportedRuntime } from "./lib/platform-policy.mjs";
import { sendWorkerCancel, validateWorkerControllerDescriptor } from "./lib/worker-control.mjs";

assertSupportedRuntime();

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return [];
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return [];
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return [];
  }

  if (process.platform !== "win32") {
    const unresolved = [];
    for (const job of removedJobs) {
      if (job.status !== "queued" && job.status !== "running" && job.status !== "cancel_requested") continue;
      let outcome = "indeterminate";
      try {
        outcome = await sendWorkerCancel(workspaceRoot, validateWorkerControllerDescriptor(job.controller));
      } catch {
        outcome = "indeterminate";
      }
      if (outcome === "accepted") {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const current = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
          if (current && !["queued", "running", "cancel_requested"].includes(current.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const current = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
        if (current && !["queued", "running", "cancel_requested"].includes(current.status)) continue;
      }
      const currentFile = resolveJobFile(workspaceRoot, job.id);
      const current = fs.existsSync(currentFile) ? readJobFile(currentFile) : job;
      const patch = {
        status: "indeterminate",
        phase: "indeterminate",
        pid: null,
        errorMessage: "Session ended before authenticated worker shutdown was confirmed."
      };
      writeJobFile(workspaceRoot, job.id, { ...current, ...patch });
      upsertJob(workspaceRoot, { id: job.id, ...patch });
      unresolved.push(job.id);
    }
    return unresolved;
  }

  removeSessionJobArtifacts(workspaceRoot, removedJobs, sessionId);
  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during Windows session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
  return [];
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.platform === "win32" && process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  const unresolvedJobs = await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  if (process.platform !== "win32" && unresolvedJobs.length > 0) {
    if (brokerSession) saveBrokerSession(cwd, { ...brokerSession, phase: "indeterminate" });
    throw new Error(`Authenticated worker shutdown is indeterminate for ${unresolvedJobs.length} job(s).`);
  }

  let brokerStopped = false;
  if (brokerEndpoint) {
    try {
      brokerStopped = await sendBrokerShutdown(brokerSession);
    } catch (error) {
      if (process.platform !== "win32") {
        saveBrokerSession(cwd, { ...brokerSession, phase: "indeterminate" });
      }
      throw error;
    }
  }

  if (brokerEndpoint) {
    teardownBrokerSession({
      ...brokerSession,
      endpoint: brokerEndpoint,
      pidFile,
      logFile,
      sessionDir,
      pid,
      killProcess: terminateProcessTree,
      authenticated: brokerStopped
    });
  }
  if (!brokerEndpoint || brokerStopped) clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
