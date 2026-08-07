import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createBrokerEndpoint,
  parseBrokerEndpoint
} from "../../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  saveState
} from "../../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir } from "../helpers.mjs";

test("P6-POSIX-ENDPOINT-001 accepts only bounded absolute Unix socket paths", () => {
  const sessionDir = "/tmp/codex-conductor/scope/runs/broker-1";
  const endpoint = createBrokerEndpoint(sessionDir, "linux");
  assert.equal(endpoint, `unix:${sessionDir}/broker.sock`);
  assert.deepEqual(parseBrokerEndpoint(endpoint, "linux"), {
    kind: "unix",
    path: `${sessionDir}/broker.sock`
  });
  assert.deepEqual(parseBrokerEndpoint(endpoint, "darwin"), {
    kind: "unix",
    path: `${sessionDir}/broker.sock`
  });

  for (const candidate of [
    "unix:relative/broker.sock",
    "unix:/tmp/scope/../outside/broker.sock",
    "unix:/tmp/scope\\outside/broker.sock",
    `unix:/tmp/${"x".repeat(100)}/broker.sock`,
    "pipe:\\\\.\\pipe\\foreign"
  ]) {
    assert.throws(() => parseBrokerEndpoint(candidate, "linux"));
  }
  assert.throws(() => createBrokerEndpoint("relative/session", "linux"));
});

test("P6-STATE-001 rejects path-shaped job IDs", () => {
  const workspace = makeTempDir();
  for (const jobId of ["", ".", "..", "../outside", "a/b", "a\\b", "/absolute", "x".repeat(129)]) {
    assert.throws(() => resolveJobFile(workspace, jobId), /job id/i);
    assert.throws(() => resolveJobLogFile(workspace, jobId), /job id/i);
  }
});

test("P6-STATE-002 corrupted or path-forged state fails closed", () => {
  const workspace = makeTempDir();
  const outside = path.join(makeTempDir(), "outside.log");
  const stateFile = resolveStateFile(workspace);
  const managed = path.join(path.dirname(stateFile), "jobs", "legacy-safe.log");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(outside, "keep\n", "utf8");
  fs.writeFileSync(stateFile, "{not json\n", "utf8");
  assert.throws(() => loadState(workspace), /state/i);

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "job-valid", status: "completed", logFile: managed }]
    })}\n`,
    "utf8"
  );
  assert.equal(loadState(workspace).jobs[0].logFile, managed);

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "job-valid", status: "completed", logFile: outside }]
    })}\n`,
    "utf8"
  );
  assert.throws(
    () => saveState(workspace, { version: 1, config: {}, jobs: [] }),
    /log file/i
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
});

test("P6-STATE-003 state replacement is complete and leaves no temporary file", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: []
  });
  const stateFile = resolveStateFile(workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), {
    version: 1,
    config: { stopReviewGate: true },
    jobs: []
  });
  assert.deepEqual(
    fs.readdirSync(path.dirname(stateFile)).filter((name) => name.includes(".tmp")),
    []
  );
});
