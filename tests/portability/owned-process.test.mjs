import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  terminateOwnedPosixProcess,
  terminateProcessTree
} from "../../plugins/codex/scripts/lib/process.mjs";

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("P6-OWNED-PROCESS-001 refuses invalid or unowned numeric PIDs", () => {
  for (const pid of [Number.NaN, -1, 0, 1.5, process.pid]) {
    assert.equal(terminateProcessTree(pid).attempted, false);
  }
  let signalled = false;
  const result = terminateProcessTree(4321, {
    platform: "linux",
    killImpl() {
      signalled = true;
    }
  });
  assert.equal(result.attempted, false);
  assert.equal(result.method, "unowned-posix-pid");
  assert.equal(signalled, false);
});

test("P6-OWNED-PROCESS-002 waits for graceful exit before signalling", async () => {
  const child = fakeChild();
  setTimeout(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  }, 5);
  const signals = [];
  const result = await terminateOwnedPosixProcess(child, {
    platform: "linux",
    gracefulMs: 50,
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });
  assert.equal(result.phase, "graceful");
  assert.deepEqual(signals, []);
});

test("P6-OWNED-PROCESS-003 escalates one retained process group from TERM to KILL", async () => {
  const child = fakeChild();
  const signals = [];
  const result = await terminateOwnedPosixProcess(child, {
    platform: "darwin",
    gracefulMs: 0,
    termMs: 0,
    killMs: 20,
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }
    }
  });
  assert.equal(result.phase, "killed");
  assert.deepEqual(signals, [
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"]
  ]);
});
