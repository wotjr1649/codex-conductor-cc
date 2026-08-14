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
const SESSION_END_BUDGET_MS = 2500;

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
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") {
    return;
  }
  // SessionStart fires again on resume, clear and compact against the same env file, so a
  // plain append grows it without bound with lines the shell would only re-apply.
  const line = `export ${name}=${shellEscape(value)}\n`;
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  if (existing.includes(line)) {
    return;
  }
  fs.appendFileSync(envFile, line, "utf8");
}

function isJobSettled(job) {
  return Boolean(job) && !["queued", "running", "cancel_requested"].includes(job.status);
}

async function cleanupSessionJobs(cwd, sessionId, deadline) {
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
        const readCurrent = () => (fs.existsSync(jobFile) ? readJobFile(jobFile) : null);
        // One deadline shared by every job, not three seconds each: two unresolved jobs used
        // to outlast any budget the host allows this hook.
        let settled = isJobSettled(readCurrent());
        while (!settled && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          settled = isJobSettled(readCurrent());
        }
        if (settled) continue;
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
  // The host clamps a SessionEnd hook to about three seconds (upstream #582), and it starts
  // counting when it spawns this process, not when this function runs. Bound the work well
  // under that so cleanup finishes and reports instead of being killed part-way through.
  const deadline = Date.now() - Math.round(process.uptime() * 1000) + SESSION_END_BUDGET_MS;
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

  const unresolvedJobs = await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV], deadline);
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
