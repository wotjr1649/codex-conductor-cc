import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  buildStatusSnapshot,
  readJobProgressPreview,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveStateDir, resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

// getCurrentSessionId falls back to the real environment, and a Claude Code session exports one,
// so the fixture has to name its own session rather than pass an empty env.
const SESSION_ID = "sess-job-control";
const SESSION_ENV = { [SESSION_ID_ENV]: SESSION_ID };

function seedWorkspace(jobs) {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const records = jobs.map((job, index) => {
    const logFile = path.join(jobsDir, `${job.id}.log`);
    fs.writeFileSync(logFile, `[2026-01-01T00:00:00.000Z] Starting ${job.id}.\n`, "utf8");
    const record = {
      title: "Codex Task",
      kind: "task",
      sessionId: SESSION_ID,
      ...job,
      logFile,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
    };
    fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  });

  fs.writeFileSync(
    resolveStateFile(workspace),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: records }, null, 2)}\n`,
    "utf8"
  );
  return workspace;
}

test("asking for the result of a running job says it is running", () => {
  const workspace = seedWorkspace([
    { id: "task-running", status: "running" },
    { id: "task-done", status: "completed" }
  ]);

  // The finished-job lookup finds nothing for this reference, and what the user needs to hear is
  // why -- not that a job they can see in status does not exist.
  assert.throws(() => resolveResultJob(workspace, "task-running"), /task-running is still running/);
  assert.equal(resolveResultJob(workspace, "task-done").job.id, "task-done");
  assert.throws(() => resolveResultJob(workspace, "task-absent"), /No finished job found for/);
});

test("the recent list survives a queue full of active jobs", () => {
  // The finished jobs are the older ones, which is the shape that matters: active jobs are the
  // newest, so they fill the cap and used to push every finished job out of the report.
  const jobs = [
    ...Array.from({ length: 3 }, (_, index) => ({ id: `task-old-${index}`, status: "completed" })),
    ...Array.from({ length: 9 }, (_, index) => ({ id: `task-active-${index}`, status: "running" }))
  ];
  const snapshot = buildStatusSnapshot(seedWorkspace(jobs), { env: SESSION_ENV });

  assert.equal(snapshot.running.length, 9);
  assert.ok(snapshot.latestFinished, "a finished job should still be reported");
  // Capping before the filter emptied this list whenever the cap was full of active jobs.
  assert.equal(snapshot.recent.length, 2);
});

test("the progress preview reads the tail of a log larger than its window", () => {
  const workspace = makeTempDir();
  const logFile = path.join(workspace, "big.log");
  const padding = Array.from(
    { length: 4000 },
    (_, index) => `[2026-01-01T00:00:00.000Z] Padding line ${index}.`
  ).join("\n");
  fs.writeFileSync(
    logFile,
    `[2026-01-01T00:00:00.000Z] First line.\n${padding}\n[2026-01-01T00:00:00.000Z] Last line.\n`,
    "utf8"
  );
  assert.ok(fs.statSync(logFile).size > 64 * 1024, "the log must exceed the tail window");

  // Ask for more lines than the window can hold. The answer is bounded by the tail read rather
  // than by the request, which is what keeps a two-second status poll off an unbounded log.
  const preview = readJobProgressPreview(logFile, 4000);
  assert.equal(preview.at(-1), "Last line.");
  assert.ok(preview.length > 0 && preview.length < 2000, `expected a bounded preview, got ${preview.length}`);
  assert.equal(preview.includes("First line."), false);
});
