import assert from "node:assert/strict";
import test from "node:test";

import { terminateProcessTree } from "../../plugins/codex/scripts/lib/process.mjs";

function failedTaskkill() {
  return {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    status: 255,
    signal: null,
    stdout: "localized failure",
    stderr: "",
    error: null
  };
}

test("P6-PROCESS-RACE-001 accepts taskkill failure only after PID absence is proved", () => {
  const stopped = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl: failedTaskkill,
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(stopped.attempted, true);
  assert.equal(stopped.delivered, false);
  assert.equal(stopped.method, "taskkill");

  assert.throws(
    () => terminateProcessTree(1234, {
      platform: "win32",
      runCommandImpl: failedTaskkill,
      killImpl(pid, signal) {
        assert.equal(pid, 1234);
        assert.equal(signal, 0);
      }
    }),
    /taskkill/
  );
});
