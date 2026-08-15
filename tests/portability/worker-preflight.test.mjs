import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "../fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, pinnedRuntimeEnv, run } from "../helpers.mjs";
import { resolveStateDir } from "../../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

// `handleTaskWorker` fails five ways before `runTrackedJob` owns the job's status, and this
// process writes its output to nowhere. That is finding J1: a bare throw here used to leave the
// job `queued` with `pid: null` forever, no explanation anywhere, and the worker's capability
// directory — which holds a credential file — still on disk. The fix marks the job failed instead.
//
// Nothing tested it. `task-worker` is invoked by no test in this repository; the only path that
// reaches these branches is the detached spawn behind `task --background`, which exercises the
// success case only. Measured: 54 percent of handleTaskWorker is uncovered, against 0-11 percent
// across the rest of the file, and 68 percent of this fork's changes to the file land in that
// cluster. J1 and J2 were both reviewed adversarially during v0.3 and both broke.
//
// These assert the contract rather than the bytes, because the contract is what regressed: the
// job must end `failed`, with an explanation, and the index must agree — not stay `queued`.
//
// These run on win32 only, and the reason is the same `supportsWorkerControl()` gate at
// codex-companion.mjs:977. On win32 it is false, so `task-worker` falls through to the job lookup
// and these cases reach the branches they name. On POSIX it is true, so every invocation without
// a valid `--control-fd` stops earlier at "did not receive its control capability" (:979) and
// never reaches them. That branch, and "controller identity did not match its state" (:1017), are
// the two of the five this file does not cover; both need a POSIX host and a real control fd.
const winOnly = process.platform === "win32" ? test : test.skip;

function storedJob(overrides = {}) {
  return {
    id: "task-preflight",
    kind: "task",
    kindLabel: "rescue",
    jobClass: "task",
    title: "Codex Task",
    summary: "Queued",
    status: "queued",
    phase: "queued",
    pid: null,
    write: false,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    request: {
      cwd: ".",
      prompt: "explain the seed file",
      write: false,
      resumeLast: false,
      jobId: "task-preflight"
    },
    ...overrides
  };
}

function workerFixture({ job } = {}) {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const codexHome = makeTempDir();
  initGitRepo(workspace);

  const env = pinnedRuntimeEnv(buildEnv(binDir), { pluginData, codexHome });
  // resolveStateDir reads CLAUDE_PLUGIN_DATA from whichever process calls it, so this one has to
  // agree with the child's pinned value or the test would seed a directory the worker never reads.
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  if (job) {
    fs.writeFileSync(
      path.join(jobsDir, `${job.id}.json`),
      `${JSON.stringify(job, null, 2)}\n`,
      "utf8"
    );
  }
  return { env, workspace, jobsDir };
}

function runWorker(fixture, args, options = {}) {
  return run("node", [SCRIPT, "task-worker", ...args], {
    cwd: fixture.workspace,
    env: fixture.env,
    timeoutMs: 60_000,
    ...options
  });
}

function readRecord(fixture, id) {
  return JSON.parse(fs.readFileSync(path.join(fixture.jobsDir, `${id}.json`), "utf8"));
}

function assertMarkedFailed(record, reason) {
  assert.equal(record.status, "failed", "the job must not be left queued");
  assert.equal(record.phase, "failed");
  assert.equal(record.pid, null);
  assert.match(String(record.errorMessage), reason);
}

winOnly("task-worker refuses to start without a job id", () => {
  const fixture = workerFixture();
  const result = runWorker(fixture, []);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required --job-id for task-worker\./);
});

winOnly("task-worker names the job it cannot find", () => {
  const fixture = workerFixture();
  const result = runWorker(fixture, ["--job-id", "task-absent"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No stored job found for task-absent\./);
});

winOnly("a stored job with no request payload is marked failed, not left queued", () => {
  const job = storedJob();
  delete job.request;
  const fixture = workerFixture({ job });

  const result = runWorker(fixture, ["--job-id", job.id]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is missing its task request payload\./);
  assertMarkedFailed(readRecord(fixture, job.id), /missing its task request payload/);
});

winOnly("a worker that never receives its start signal is marked failed, not left queued", () => {
  const job = storedJob();
  const fixture = workerFixture({ job });

  const result = runWorker(fixture, ["--job-id", job.id, "--start-after-stdin"], {
    input: "not-the-start-token"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not receive its start signal\./);
  assertMarkedFailed(readRecord(fixture, job.id), /did not receive its start signal/);
});

winOnly("status reports a preflight failure rather than a job that never moves", () => {
  const job = storedJob();
  delete job.request;
  const fixture = workerFixture({ job });

  runWorker(fixture, ["--job-id", job.id]);
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: fixture.workspace,
    env: fixture.env,
    timeoutMs: 60_000
  });

  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  const listed = [...(payload.running ?? []), payload.latestFinished]
    .filter(Boolean)
    .find((entry) => entry.id === job.id);
  assert.ok(listed, `status did not list ${job.id}: ${status.stdout}`);
  // The index is written separately from the record, and J2 is the finding that they could
  // disagree. A user reading status must not see "queued" for a job that already failed.
  assert.equal(listed.status, "failed");
});

