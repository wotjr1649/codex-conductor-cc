import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "../fake-codex-fixture.mjs";
import { initGitRepo, listCreatedTempDirs, makeTempDir, run } from "../helpers.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "companion-characterization-baseline.json"
);
const UPDATING = process.env.CODEX_CHARACTERIZATION_UPDATE === "1";

// Every ambient variable the runtime reads is an input to this capture, so a characterization
// harness has to own them rather than inherit them. Measured the hard way: the first version of
// this file inherited `buildEnv`'s spread of process.env and passed from a shell with none of
// these set, then failed from a shell inside a Claude Code session, because
// CODEX_COMPANION_SESSION_ID makes `cancel` say "for this session". These are the complete set
// the runtime reads, from `plugins/codex/scripts`; PATH, PATHEXT, SystemRoot and ComSpec are
// deliberately left alone because the child cannot start without them.
const AMBIENT_INPUTS = [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE"
];

// `codex-companion.mjs` is 1,317 lines and is deliberately NOT being split: its call graph is a
// DAG whose largest closed single-door set is 38 lines, so no turn-capture-shaped extraction
// exists here. This harness is the alternative — it pins observable behaviour so the file can be
// changed safely without being restructured. Every shape records exit status, stdout and stderr;
// a change to any byte has to be re-recorded deliberately, and that diff is the review.
//
// What it does and does not do, measured rather than assumed:
//
//   - It pins the background lane end to end — launch, wait, read — which nothing else did.
//     `tests/runtime.test.mjs` drives `--background` too, but asserts selected fields; an
//     unasserted change in that lane's output passed unnoticed before this.
//   - It catches a broken worker path. Forcing the preflight token check to fail made the
//     `task-background-then-status-then-result` shape fail with `Phase: failed` and the real
//     message, which is the verification this repository requires: mutate what it should reject.
//   - It does NOT raise coverage of the worker cluster. Measured with the harness alone:
//     spawnDetachedTaskWorker 41 percent uncovered, enqueueBackgroundTask 41, handleTaskWorker 54
//     — identical to the full suite without it. These shapes execute the lines `runtime.test.mjs`
//     already executed; what they add is byte-exact output pinning, not reach.
//   - It therefore does NOT catch worker-internal writes that never surface. Changing
//     `updateWorkerStatus`'s `phase` (around line 1006) passed undetected, because `runTrackedJob`
//     owns the terminal status this lane reports. Raising that needs unit tests of the worker's
//     branches, not more end-to-end shapes.
const SHAPES = [
  { id: "setup-json", args: ["setup", "--json"] },
  { id: "setup-json-logged-out", args: ["setup", "--json"], behavior: "logged-out" },
  { id: "setup-json-provider-no-auth", args: ["setup", "--json"], behavior: "provider-no-auth" },
  { id: "setup-json-env-key-provider", args: ["setup", "--json"], behavior: "env-key-provider" },
  { id: "setup-json-api-key-account-only", args: ["setup", "--json"], behavior: "api-key-account-only" },
  { id: "setup-json-refreshable-auth", args: ["setup", "--json"], behavior: "refreshable-auth" },
  { id: "status", args: ["status"] },
  { id: "status-json", args: ["status", "--json"] },
  { id: "result-no-jobs", args: ["result"] },
  { id: "cancel-nothing-running", args: ["cancel"] },
  // The session-scoped branch of the same command. This is the fork in behaviour that made the
  // first version of this harness environment-dependent, so it is characterized rather than
  // merely neutralized.
  { id: "cancel-nothing-running-in-session", args: ["cancel"], sessionId: "characterization-session" },
  { id: "task-resume-candidate-json", args: ["task-resume-candidate", "--json"] },
  { id: "review-wait", args: ["review", "--wait"], seed: true },
  { id: "review-wait-json", args: ["review", "--wait", "--json"], seed: true },
  { id: "adversarial-review-wait", args: ["adversarial-review", "--wait"], seed: true },
  { id: "task-wait", args: ["task", "--wait", "explain the seed file"], seed: true },
  { id: "task-wait-json", args: ["task", "--wait", "--json", "explain the seed file"], seed: true },
  // The background lane, which nothing else characterizes. One workspace, three commands: the
  // launch goes through enqueueBackgroundTask and spawnDetachedTaskWorker, the detached process
  // runs handleTaskWorker, and the wait and read prove it reached a terminal state with its
  // output intact.
  {
    id: "task-background-then-status-then-result",
    seed: true,
    steps: [
      { args: () => ["task", "--background", "explain the seed file"] },
      { args: (prior) => ["status", jobIdOf(prior[0].raw), "--wait"] },
      { args: (prior) => ["result", jobIdOf(prior[0].raw)] }
    ]
  },
  {
    id: "task-background-then-status-json",
    seed: true,
    steps: [
      { args: () => ["task", "--background", "--json", "explain the seed file"] },
      { args: (prior) => ["status", jobIdOf(prior[0].raw), "--wait", "--json"] }
    ]
  }
];

function jobIdOf(text) {
  return /\b(task-[A-Za-z0-9]+-[A-Za-z0-9]+)\b/.exec(String(text ?? ""))?.[1] ?? "unresolved-job-id";
}

after(async () => {
  for (const directory of listCreatedTempDirs()) {
    const session = loadBrokerSession(directory);
    if (!session) {
      continue;
    }
    if (session.endpoint) {
      await sendBrokerShutdown(session.endpoint);
    }
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: session.pid ?? null,
      killProcess: terminateProcessTree
    });
    clearBrokerSession(directory);
  }
});

// Job ids and elapsed times are generated per run; the Node and npm versions setup reports vary by
// host, each scoped to its own key so the Codex detail beside them is untouched. Paths are
// replaced by longest-first so a nested root cannot be shadowed by its parent.
function normalize(text, replacements) {
  let normalized = String(text ?? "");
  for (const [from, to] of [...replacements].sort((a, b) => b[0].length - a[0].length)) {
    if (from) {
      normalized = normalized.split(from).join(to);
    }
  }
  return normalized
    .replace(/\b(task|review)-[A-Za-z0-9]+-[A-Za-z0-9]+\b/g, "<job-id>")
    .replace(/\b(Elapsed|Duration):\s*\d+(?:\.\d+)?s\b/g, "$1: <duration>")
    // The same two values again in `--json` form. Missing these made two recordings differ by
    // "1s" against "2s" — caught only by recording from two shells, because two runs in one shell
    // happened to take the same wall-clock second.
    .replace(/("(?:elapsed|duration)":\s*")\d+(?:\.\d+)?s(")/g, "$1<duration>$2")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
    // The per-workspace state directory is `<workspace basename>-<16 hex of its canonical path>`,
    // so it survives replacing the directories themselves.
    .replace(/codex-plugin-test-[A-Za-z0-9]+-[0-9a-f]{16}/g, "<workspace-state>")
    .replace(/("node":\s*\{[^}]*?"detail":\s*")[^"]*(")/g, "$1<node-version>$2")
    .replace(/("npm":\s*\{[^}]*?"detail":\s*")[^"]*(")/g, "$1<npm-version>$2")
    .replace(/\r\n/g, "\n");
}

function captureShape(shape) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, shape.behavior);
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const codexHome = makeTempDir();
  initGitRepo(workspace);
  if (shape.seed) {
    fs.writeFileSync(path.join(workspace, "seed.txt"), "alpha\n");
    run("git", ["add", "-A"], { cwd: workspace });
    run("git", ["commit", "-m", "seed"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "seed.txt"), "alpha\nbeta\n");
  }

  const env = buildEnv(binDir);
  for (const name of AMBIENT_INPUTS) {
    delete env[name];
  }
  env.CLAUDE_PLUGIN_DATA = pluginData;
  env.CODEX_HOME = codexHome;
  if (shape.sessionId) {
    env.CODEX_COMPANION_SESSION_ID = shape.sessionId;
  }

  // Three spellings of every root reach stdout: native, forward-slash, and — inside `--json`
  // payloads — JSON-escaped with doubled backslashes. The third is why an earlier version of this
  // left absolute paths in the recorded baseline.
  const replacements = [];
  for (const [directory, label] of [
    [workspace, "<workspace>"],
    [pluginData, "<plugin-data>"],
    [codexHome, "<codex-home>"],
    [binDir, "<bin>"]
  ]) {
    replacements.push(
      [directory, label],
      [directory.replace(/\\/g, "/"), label],
      [directory.replace(/\\/g, "\\\\"), label]
    );
  }

  // The recorded form has the job id normalized away, so a later step cannot read the id out of
  // it. Chaining uses the raw output and only the recorded copy is normalized.
  const capture = (args) => {
    const result = run("node", [SCRIPT, ...args], { cwd: workspace, env, timeoutMs: 120_000 });
    return {
      raw: String(result.stdout ?? ""),
      recorded: {
        status: result.status,
        stdout: normalize(result.stdout, replacements),
        stderr: normalize(result.stderr, replacements)
      }
    };
  };

  if (!shape.steps) {
    return capture(shape.args).recorded;
  }
  const captured = [];
  for (const step of shape.steps) {
    captured.push(capture(step.args(captured)));
  }
  return { steps: captured.map((entry) => entry.recorded) };
}

test("codex-companion command surface matches its recorded characterization", (t) => {
  // The baseline is recorded on the declared primary runtime. It is not portable: the background
  // lane routes through `supportsWorkerControl`, which is true on POSIX and false on win32, and
  // the state root is `CLAUDE_PLUGIN_DATA` on win32 but a uid-scoped runtime tree on POSIX. A
  // second, POSIX-recorded baseline is the way to cover that, and it needs a POSIX host to record.
  if (process.platform !== "win32") {
    t.skip("characterization baseline is recorded on win32; POSIX needs its own");
    return;
  }

  const observed = {};
  for (const shape of SHAPES) {
    observed[shape.id] = captureShape(shape);
  }

  if (UPDATING) {
    fs.writeFileSync(
      BASELINE,
      `${JSON.stringify({ schemaVersion: "companion-characterization-v1", shapes: observed }, null, 2)}\n`,
      "utf8"
    );
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  assert.equal(baseline.schemaVersion, "companion-characterization-v1");
  assert.deepEqual(
    Object.keys(observed).sort(),
    Object.keys(baseline.shapes).sort(),
    "the characterized shape set changed; add or remove shapes deliberately"
  );
  for (const shape of SHAPES) {
    assert.deepEqual(
      observed[shape.id],
      baseline.shapes[shape.id],
      `${shape.id} no longer behaves the way the baseline records; if the change is intended, ` +
        "re-record with CODEX_CHARACTERIZATION_UPDATE=1 and review that diff as the change"
    );
  }
});
