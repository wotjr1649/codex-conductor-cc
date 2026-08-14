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

// win32 only: on POSIX the state root sits under the private runtime root, not the temp
// directory, and tests/portability covers that side.
test("resolveStateDir uses a temp-backed per-workspace directory", {
  skip: process.platform === "win32" ? false : "POSIX resolves the state root elsewhere"
}, () => {
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
    // The POSIX branch canonicalizes the plugin data directory before building under it, and on
    // macOS the temp directory is reached through the /var -> /private/var symlink, so the
    // expected root is the resolved one. Canonicalizing is the guard, not an accident.
    const expectedRoot = path.join(fs.realpathSync.native(pluginDataDir), "state");

    assert.equal(stateDir.startsWith(expectedRoot), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${expectedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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

test("saveState removes the artifacts of jobs it prunes from the index", () => {
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
  // A job dropped from the index can never be looked up again, so keeping its files only leaks
  // them. v0.2 retained them deliberately; v0.3 removes them as they are pruned.
  assert.equal(fs.existsSync(prunedJobFile), false);
  assert.equal(fs.existsSync(prunedLogFile), false);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("a write that loses its compare-and-swap leaves the winner's job artifacts alone", () => {
  const workspace = makeTempDir();
  const seed = (name, minute) => {
    const jobId = `job-${name}`;
    const at = new Date(Date.UTC(2026, 0, 1, 0, minute, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(resolveJobFile(workspace, jobId), JSON.stringify({ id: jobId }), "utf8");
    return { id: jobId, status: "completed", logFile, updatedAt: at, createdAt: at };
  };

  // Exactly the retention limit, so one more record prunes the oldest.
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: Array.from({ length: 50 }, (_, index) => seed(index, index))
  });

  let injected = false;
  updateState(workspace, (state) => {
    if (!injected) {
      injected = true;
      // A second process commits between this attempt's read and its write, and what it commits
      // touches the oldest job -- which is what a worker recording progress does. This attempt
      // loses its compare-and-swap and is abandoned.
      saveState(workspace, {
        version: 1,
        config: { stopReviewGate: false },
        jobs: loadState(workspace).jobs.map((job) =>
          job.id === "job-0"
            ? { ...job, updatedAt: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)).toISOString() }
            : job
        )
      });
    }
    state.jobs.unshift(seed("new", 59));
  });

  // job-0 survived the prune that actually committed, so nothing may have deleted its files.
  assert.equal(loadState(workspace).jobs.some((job) => job.id === "job-0"), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), true);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-0")), true);
});
