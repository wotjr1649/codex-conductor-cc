import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPosixBrokerDescriptor,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  validatePosixBrokerDescriptor,
  validateWindowsBrokerDescriptor
} from "../../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { getSessionRuntimeStatus } from "../../plugins/codex/scripts/lib/codex.mjs";
import { resolveStateDir } from "../../plugins/codex/scripts/lib/state.mjs";

const IDS = {
  sessionId: "broker-0123456789abcdef",
  generation: "generation-fedcba9876543210"
};
const WINDOWS_ONLY = process.platform !== "win32" ? "Windows broker state is Windows-only" : false;

function makeWindowsDescriptor() {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"));
  return {
    endpoint: createBrokerEndpoint(sessionDir, "win32"),
    logFile: path.join(sessionDir, "broker.log"),
    pid: 424242,
    pidFile: path.join(sessionDir, "broker.pid"),
    sessionDir
  };
}

test("P6-BROKER-STATE-001 persists only validated non-secret identifiers", () => {
  const descriptor = createPosixBrokerDescriptor(process.cwd(), IDS, "starting");
  assert.deepEqual(Object.keys(descriptor).sort(), ["generation", "phase", "scopeId", "sessionId", "version"]);
  assert.equal(validatePosixBrokerDescriptor(process.cwd(), descriptor), descriptor);

  assert.throws(
    () => validatePosixBrokerDescriptor(process.cwd(), { ...descriptor, endpoint: "unix:/tmp/attacker.sock" }),
    /broker state/
  );
  assert.throws(
    () => validatePosixBrokerDescriptor(process.cwd(), { ...descriptor, scopeId: "0000000000000000" }),
    /broker state/
  );
});

test("P6-BROKER-STATE-002 Windows broker state accepts only what the plugin could have written", { skip: WINDOWS_ONLY }, () => {
  const descriptor = makeWindowsDescriptor();
  assert.equal(validateWindowsBrokerDescriptor(descriptor), descriptor);

  for (const mutation of [
    { ...descriptor, extra: 1 },
    { ...descriptor, pidFile: path.join(os.tmpdir(), "broker.pid") },
    { ...descriptor, logFile: path.join(os.tmpdir(), "elsewhere", "broker.log") },
    { ...descriptor, sessionDir: path.join(descriptor.sessionDir, "..", "..") },
    { ...descriptor, endpoint: "pipe:\\\\.\\pipe\\attacker-chosen" },
    { ...descriptor, pid: 0 },
    { ...descriptor, pid: 1.5 },
    { ...descriptor, pid: process.pid }
  ]) {
    assert.throws(() => validateWindowsBrokerDescriptor(mutation), /Windows broker state/);
  }

  fs.rmSync(descriptor.sessionDir, { recursive: true, force: true });
});

test("P6-BROKER-STATE-003 Windows teardown acts only on paths it derives", { skip: WINDOWS_ONLY }, () => {
  const descriptor = makeWindowsDescriptor();
  const outside = path.join(os.tmpdir(), `broker-teardown-bystander-${path.basename(descriptor.sessionDir)}.txt`);
  fs.writeFileSync(outside, "keep\n", "utf8");

  // A rewritten state file naming somebody else's path gets no kill and no unlink.
  let killed = null;
  const refused = teardownBrokerSession({
    ...descriptor,
    pidFile: outside,
    killProcess: (pid) => {
      killed = pid;
    }
  });
  assert.equal(refused, false);
  assert.equal(killed, null);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");

  fs.writeFileSync(descriptor.pidFile, "424242\n", "utf8");
  fs.writeFileSync(descriptor.logFile, "log\n", "utf8");
  const removed = teardownBrokerSession({
    ...descriptor,
    killProcess: (pid) => {
      killed = pid;
    }
  });
  assert.equal(removed, true);
  assert.equal(killed, descriptor.pid);
  assert.equal(fs.existsSync(descriptor.sessionDir), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");

  fs.rmSync(outside, { force: true });
});

test("P6-BROKER-STATE-004 a shutdown nothing answers is not reported as stopped", { skip: WINDOWS_ONLY }, async () => {
  assert.equal(await sendBrokerShutdown("pipe:\\\\.\\pipe\\codex-conductor-absent-broker"), false);
});

test("P6-BROKER-STATE-005 rewritten Windows broker state is dropped, not adopted", { skip: WINDOWS_ONLY }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "broker-workspace-"));
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "broker.json"),
    `${JSON.stringify({
      endpoint: "pipe:\\\\.\\pipe\\attacker-chosen",
      logFile: path.join(os.homedir(), "notes.txt"),
      pid: 4,
      pidFile: path.join(os.homedir(), "secrets.txt"),
      sessionDir: os.homedir()
    })}\n`,
    "utf8"
  );

  try {
    assert.equal(loadBrokerSession(workspace), null);
    // Diagnostics keep working rather than adopting the endpoint or dying on the state file.
    assert.equal(getSessionRuntimeStatus({}, workspace).mode, "direct");
  } finally {
    // The state directory is not inside the workspace. With CLAUDE_PLUGIN_DATA set -- which this
    // plugin's own SessionStart hook exports -- it lives under the plugin data root, so removing
    // only the workspace left this hostile broker.json, which names the user's home directory as
    // its session directory, sitting in the real state root after the run.
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
