import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "../helpers.mjs";
import { resolveCommandInvocation } from "../../plugins/codex/scripts/lib/process.mjs";
import {
  loadState,
  resolveJobsDir,
  resolveStateDir,
  upsertJob
} from "../../plugins/codex/scripts/lib/state.mjs";

// P1 memoized the state-path chain and measured the result: resolveStateDir went from 70.23 ms to
// 0.05, loadState at fifty records from 3,504 ms to 0.57, upsertJob from 10,555 ms to 1.87. The
// cause was process creation - `where.exe` resolving git, then git itself - not filesystem work
// or hashing. P0 called for a committed benchmark with thresholds and it was never built, so
// nothing would notice if a refactor undid any of that: the plugin would keep working and simply
// become a thousand times slower, on a path every hook and every command runs.
//
// These are cliff detectors, not benchmarks. Each ceiling sits roughly fifty times above what the
// path measures today and at least seven times below what it costs with the memo gone, so a
// loaded or slow runner cannot trip one and a collapsed memo cannot avoid one. They will not
// catch a two-fold regression, and they are not meant to.
//
// Two things they deliberately do not measure. The first resolution in a process is cold and
// costs about 73 ms once - that is process creation, unchanged by P1 and not a regression - so
// every case warms the path before timing it. And on POSIX the un-memoized cost is a single git
// spawn rather than Windows' `where.exe` plus git, so the margin below regression is thinner
// there; these ceilings are sized for the declared primary runtime.
// Sized against both ends, measured. With the caches neutralized these paths cost 45.5, 93.3,
// 209.8 and 630.3 ms respectively; with them in place they cost 0.003, 0.040, 0.469 and 1.902.
// Each ceiling therefore has at least sixty times headroom over the healthy measurement and at
// least six times margin under the broken one. Note the broken numbers are lower than v0.3's
// recorded 37.85 / 70.23 / 3,504 / 10,555, because neutralizing the caches reproduces only part
// of what P1 changed - F1 also moved the record validators onto an already-resolved jobs
// directory, which is structural rather than cached. A full regression overshoots by more.
const CEILINGS_MS = {
  resolveCommandInvocation: 5,
  resolveStateDir: 5,
  loadStateAtLimit: 30,
  upsertJobAtLimit: 100
};

const RECORD_COUNT = 50;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(operation, iterations) {
  operation(); // warm: the first resolution in a process pays cold process creation, once
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

// v0.3 established that the amplifier is record shape, not record count: assertManagedLogFile
// returns early when logFile is null, so fifty records without one cost 70 ms and make a single
// resolution instead of fifty-one. Tracked jobs do set logFile, so this seeds the shape production
// actually has - measuring the cheap shape would guard the wrong thing.
function seededWorkspace() {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

  const jobsDir = resolveJobsDir(workspace);
  fs.mkdirSync(jobsDir, { recursive: true });
  const ids = [];
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const id = `task-perf-${String(index).padStart(3, "0")}`;
    ids.push(id);
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, "seeded\n", "utf8");
    upsertJob(workspace, {
      id,
      status: "completed",
      kind: "task",
      logFile,
      createdAt: new Date(0).toISOString()
    });
  }
  return { workspace, jobsDir, ids };
}

function assertUnder(label, observedMs, ceilingMs, unmemoizedMs) {
  assert.ok(
    observedMs < ceilingMs,
    `${label} took ${observedMs.toFixed(3)} ms, over its ${ceilingMs} ms ceiling. ` +
      `This path costs about ${unmemoizedMs} ms with its memoization gone; check whether a change ` +
      "removed or invalidated the cache rather than raising the ceiling."
  );
}

test("executable resolution stays memoized", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);

  const observed = measure(
    () => resolveCommandInvocation("git", ["--version"], { cwd: workspace }),
    40
  );

  assertUnder(
    'resolveCommandInvocation("git")',
    observed,
    CEILINGS_MS.resolveCommandInvocation,
    37.85
  );
});

test("state directory resolution stays memoized", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

  const observed = measure(() => resolveStateDir(workspace), 40);

  assertUnder("resolveStateDir()", observed, CEILINGS_MS.resolveStateDir, 70.23);
});

test("reading a full job index stays memoized", () => {
  const { workspace } = seededWorkspace();
  assert.equal(
    loadState(workspace).jobs.filter((job) => job.logFile).length,
    RECORD_COUNT,
    "the seeded records must carry logFile, which is the shape that amplifies"
  );

  const observed = measure(() => loadState(workspace), 20);

  assertUnder(
    `loadState() at ${RECORD_COUNT} records`,
    observed,
    CEILINGS_MS.loadStateAtLimit,
    3504.62
  );
});

test("updating a job against a full index stays memoized", () => {
  const { workspace, jobsDir, ids } = seededWorkspace();

  const observed = measure(
    () =>
      upsertJob(workspace, {
        id: ids[0],
        status: "completed",
        kind: "task",
        logFile: path.join(jobsDir, `${ids[0]}.log`)
      }),
    20
  );

  assertUnder(
    `upsertJob() at ${RECORD_COUNT} records`,
    observed,
    CEILINGS_MS.upsertJobAtLimit,
    10555.18
  );
});
