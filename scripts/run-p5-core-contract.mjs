#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: node scripts/run-p5-core-contract.mjs --lane <current|previous> --codex <exe> --root <fresh-root>"
      );
    }
    result[key.slice(2)] = value;
  }
  if (!["current", "previous"].includes(result.lane)) {
    throw new Error("P5E_CODEX_LANE: current or previous is required");
  }
  if (!result.codex || !result.root) {
    throw new Error("P5E_CODEX_INPUT: exact executable and fresh root are required");
  }
  return result;
}

function parseSummary(stdout, transport) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`P5E_LIFECYCLE_OUTPUT:${transport}`);
  }
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error(`P5E_LIFECYCLE_JSON:${transport}`);
  }
}

const options = parseArguments(process.argv.slice(2));
const tools = JSON.parse(
  fs.readFileSync(path.join(root, "contracts", "codex", "contract-tools-v1.json"), "utf8")
);
const expectedLane = tools.lanes[options.lane];
const expectedArtifact = tools.artifacts.find(
  ({ id }) => id === expectedLane?.artifactId
);
if (!expectedLane || !expectedArtifact) {
  throw new Error("P5E_LIFECYCLE_ADMISSION: exact P4 lane is missing");
}

const runParent = path.resolve(options.root);
if (fs.existsSync(runParent)) {
  throw new Error("P5E_LIFECYCLE_ROOT: run parent must be new");
}
fs.mkdirSync(runParent);

const observed = [];
for (const transport of ["direct", "broker"]) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "run-p4-lifecycle.mjs"),
      "--codex",
      path.resolve(options.codex),
      "--version",
      expectedLane.version,
      "--transport",
      transport,
      "--root",
      path.join(runParent, transport)
    ],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `P5E_LIFECYCLE_EXIT:${transport}:${result.signal ?? result.status ?? "error"}`
    );
  }
  const summary = parseSummary(result.stdout, transport);
  if (
    summary.version !== expectedLane.version ||
    summary.transport !== transport ||
    summary.executableSha256 !== expectedArtifact.executableSha256 ||
    summary.executionStatus !== "executed-pass" ||
    summary.retryCount !== 0 ||
    summary.processExitCode !== 0 ||
    summary.normal?.threadStarted !== true ||
    summary.normal?.turnStarted !== true ||
    summary.normal?.terminalStatus !== "completed" ||
    summary.normal?.resumedThreadIdMatched !== true ||
    summary.cancellation?.threadStarted !== true ||
    summary.cancellation?.turnStarted !== true ||
    summary.cancellation?.interruptAcknowledged !== true ||
    summary.cancellation?.terminalStatus !== "interrupted" ||
    summary.traffic?.stderrBytes !== 0 ||
    summary.rawPromptCommitted !== false ||
    summary.privatePathCommitted !== false
  ) {
    throw new Error(`P5E_LIFECYCLE_ORACLE:${transport}`);
  }
  observed.push({
    lane: options.lane,
    version: expectedLane.version,
    transport,
    executableSha256: expectedArtifact.executableSha256,
    executionStatus: "executed-pass",
    retryCount: 0,
    timeout: false,
    rawExitCode: 0,
    normalTerminalStatus: "completed",
    cancelTerminalStatus: "interrupted",
    processExitCode: 0
  });
}

process.stdout.write(`${JSON.stringify({ schemaVersion: "p5-core-contract-result-v1", runs: observed })}\n`);
