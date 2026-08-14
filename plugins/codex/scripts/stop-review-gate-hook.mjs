#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { terminateOwnedPosixProcess, terminateProcessTree } from "./lib/process.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { assertSupportedRuntime } from "./lib/platform-policy.mjs";

assertSupportedRuntime();

// Must match the Stop hook timeout in hooks/hooks.json. The review used to be given exactly
// that budget, leaving nothing to emit the decision with: the gate fell silent at the moment
// it was meant to speak, and a silent gate allows the stop.
const STOP_HOOK_TIMEOUT_MS = 900 * 1000;
const STOP_REVIEW_RESERVE_MS = 15 * 1000;
const STOP_REVIEW_MIN_BUDGET_MS = 60 * 1000;
const STOP_REVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STOP_REVIEW_REASON_LIMIT = 2000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

// Whatever goes into a block reason is shown to the user and travels back through the host, so
// it is bounded here rather than trusted to be small.
function shortenReason(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length <= STOP_REVIEW_REASON_LIMIT
    ? trimmed
    : `${trimmed.slice(0, STOP_REVIEW_REASON_LIMIT)}...`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = shortenReason(firstLine.slice("BLOCK:".length).trim() || text);
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function terminateReviewChild(child) {
  // The child starts an app-server of its own. Signalling only the direct child, which is what
  // a spawn timeout does, leaves that grandchild running.
  if (process.platform === "win32") {
    try {
      terminateProcessTree(child.pid);
    } catch {
      // Best effort: the gate still has a decision to emit.
    }
    return;
  }
  terminateOwnedPosixProcess(child).catch(() => {});
}

async function runStopReview(cwd, input = {}, budgetMs) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const child = spawn(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true
  });

  // Read the child's output with a cap instead of leaving it to a default buffer, which
  // overflowed into a null exit status that read as a failed review carrying a megabyte of
  // truncated JSON as its reason.
  let stdout = "";
  let stderr = "";
  let captured = 0;
  let truncated = false;
  const capture = (stream, append) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (captured >= STOP_REVIEW_MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      captured += Buffer.byteLength(chunk, "utf8");
      append(chunk);
    });
  };
  capture(child.stdout, (chunk) => {
    stdout += chunk;
  });
  capture(child.stderr, (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateReviewChild(child);
  }, budgetMs);

  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (status) => resolve({ status }));
  });
  clearTimeout(timer);

  if (timedOut) {
    return {
      ok: false,
      reason: `The stop-time Codex review task timed out after ${Math.round(budgetMs / 60000)} minutes. Run /codex:review --wait manually or bypass the gate.`
    };
  }

  if (outcome.error) {
    return {
      ok: false,
      reason: `The stop-time Codex review task could not be started: ${outcome.error.code ?? outcome.error.message}. Run /codex:review --wait manually or bypass the gate.`
    };
  }

  if (truncated) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task produced more output than the gate will read. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (outcome.status !== 0) {
    const detail = shortenReason(stderr || stdout);
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

function reviewBudgetMs() {
  // The host's clock started when it spawned this process, so spend from there and keep a
  // reserve for emitting the decision after the review ends.
  const elapsed = Math.round(process.uptime() * 1000);
  return Math.max(STOP_REVIEW_MIN_BUDGET_MS, STOP_HOOK_TIMEOUT_MS - elapsed - STOP_REVIEW_RESERVE_MS);
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = await runStopReview(cwd, input, reviewBudgetMs());
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
