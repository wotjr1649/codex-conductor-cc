import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("updateState rebuilds on a competing write instead of overwriting it", () => {
  const workspace = makeTempDir();
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });

  let injected = false;
  updateState(workspace, (state) => {
    if (!injected) {
      injected = true;
      // Stand in for a second process committing between this attempt's read and its write.
      saveState(workspace, {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [{ id: "job-other", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }]
      });
    }
    state.jobs.push({ id: "job-mine", status: "queued", updatedAt: "2026-01-02T00:00:00.000Z" });
  });

  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id).sort(),
    ["job-mine", "job-other"]
  );
});

test("a write refuses stored state whose log file escapes the managed jobs directory", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const outside = path.join(workspace, "escape.log");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(outside, "keep\n", "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "job-escaped", status: "completed", logFile: outside }]
    })}\n`,
    "utf8"
  );

  // Reading the stored state back is what stops a rewrite from adopting an unmanaged path
  // that pruning and session cleanup would later act on. Both write paths apply it.
  assert.throws(() => saveState(workspace, { version: 1, config: {}, jobs: [] }), /log file/i);
  assert.throws(() => upsertJob(workspace, { id: "job-new", status: "queued" }), /log file/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
});

test("saveState prunes the index without deleting dropped job artifacts", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
  assert.equal(fs.existsSync(prunedJobFile), true);
  assert.equal(fs.existsSync(prunedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 51 }, (_, index) => `job-${index}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
