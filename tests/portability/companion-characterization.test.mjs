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

// `codex-companion.mjs` is 1,317 lines and its clusters share helpers in both directions, so any
// split moves several at once. The v0.3 program made the `codex.mjs` -> `turn-capture.mjs` move
// safely by characterising nine command shapes before and after and requiring byte-identical
// output; this is that harness for the module that still has to be split. It records what the
// command surface prints today, without judging whether today is right. A refactor that changes
// any byte here has changed behaviour, and has to say so deliberately by updating the baseline.
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
  { id: "task-resume-candidate-json", args: ["task-resume-candidate", "--json"] },
  { id: "review-wait", args: ["review", "--wait"], seed: true },
  { id: "review-wait-json", args: ["review", "--wait", "--json"], seed: true },
  { id: "adversarial-review-wait", args: ["adversarial-review", "--wait"], seed: true },
  { id: "task-wait", args: ["task", "--wait", "explain the seed file"], seed: true },
  { id: "task-wait-json", args: ["task", "--wait", "--json", "explain the seed file"], seed: true }
];

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

// Only two values in the whole surface vary by host: the Node and npm versions `setup` reports.
// Both are scoped to their own key so the Codex detail beside them, which the fake pins, is left
// alone. Workspace paths are replaced because the temp directory changes per run.
function normalize(text, replacements) {
  let normalized = String(text ?? "");
  for (const [from, to] of replacements) {
    if (from) {
      normalized = normalized.split(from).join(to);
    }
  }
  return normalized
    .replace(/("node":\s*\{[^}]*?"detail":\s*")[^"]*(")/g, "$1<node-version>$2")
    .replace(/("npm":\s*\{[^}]*?"detail":\s*")[^"]*(")/g, "$1<npm-version>$2")
    .replace(/\r\n/g, "\n");
}

function captureShape(shape) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, shape.behavior);
  const workspace = makeTempDir();
  initGitRepo(workspace);
  if (shape.seed) {
    fs.writeFileSync(path.join(workspace, "seed.txt"), "alpha\n");
    run("git", ["add", "-A"], { cwd: workspace });
    run("git", ["commit", "-m", "seed"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "seed.txt"), "alpha\nbeta\n");
  }

  const result = run("node", [SCRIPT, ...shape.args], {
    cwd: workspace,
    env: buildEnv(binDir),
    timeoutMs: 120_000
  });

  const replacements = [
    [workspace, "<workspace>"],
    [workspace.replace(/\\/g, "/"), "<workspace>"],
    [binDir, "<bin>"],
    [binDir.replace(/\\/g, "/"), "<bin>"]
  ];
  return {
    status: result.status,
    stdout: normalize(result.stdout, replacements),
    stderr: normalize(result.stderr, replacements)
  };
}

test("codex-companion command surface matches its recorded characterization", () => {
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
