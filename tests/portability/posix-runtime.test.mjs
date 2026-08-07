import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { installFakeCodex, buildEnv } from "../fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "../helpers.mjs";
import { CodexAppServerClient } from "../../plugins/codex/scripts/lib/app-server.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { resolvePosixRuntimeRoot, runtimeScopeId } from "../../plugins/codex/scripts/lib/runtime-paths.mjs";
import { resolveJobFile, resolveStateDir } from "../../plugins/codex/scripts/lib/state.mjs";

const POSIX = process.platform === "linux" || process.platform === "darwin";
const SCRIPT = path.resolve("plugins/codex/scripts/codex-companion.mjs");

async function waitFor(read, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for POSIX runtime state.");
}

function privateEnvironment() {
  const pluginData = makeTempDir("cxc-state-");
  fs.chmodSync(pluginData, 0o700);
  return { pluginData };
}

function withRuntimeEnv(values) {
  const previous = {
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR
  };
  process.env.CLAUDE_PLUGIN_DATA = values.pluginData;
  delete process.env.XDG_RUNTIME_DIR;
  return () => {
    if (previous.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous.CLAUDE_PLUGIN_DATA;
    if (previous.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous.XDG_RUNTIME_DIR;
  };
}

async function stopBroker(cwd) {
  const session = loadBrokerSession(cwd);
  if (!session) return;
  const stopped = await sendBrokerShutdown(session);
  teardownBrokerSession({ ...session, authenticated: stopped });
  clearBrokerSession(cwd);
}

test("P6-POSIX-RUNTIME-001 authenticates broker readiness and shutdown", { skip: !POSIX }, async (t) => {
  const cwd = makeTempDir("cxc-workspace-");
  const binDir = makeTempDir("cxc-bin-");
  const runtimeEnv = privateEnvironment();
  const restoreEnv = withRuntimeEnv(runtimeEnv);
  installFakeCodex(binDir);
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimeEnv.pluginData
  };
  delete env.XDG_RUNTIME_DIR;
  t.after(async () => {
    await stopBroker(cwd).catch(() => {});
    restoreEnv();
  });

  const session = await ensureBrokerSession(cwd, { env });
  assert.equal(session.phase, "ready");
  assert.equal(parseBrokerEndpoint(session.endpoint).kind, "unix");
  const stored = JSON.parse(fs.readFileSync(path.join(resolveStateDir(cwd), "broker.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["generation", "phase", "scopeId", "sessionId", "version"]);
  assert.equal(fs.statSync(session.sessionDir).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(session.sessionDir, "broker.cap")).mode & 0o077, 0);
  assert.equal(fs.statSync(parseBrokerEndpoint(session.endpoint).path).mode & 0o077, 0);

  await assert.rejects(
    () => CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint, env }),
    /authenticated broker state/
  );

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: parseBrokerEndpoint(session.endpoint).path });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`));
    socket.on("data", (chunk) => {
      try {
        assert.match(chunk, /authentication failed/i);
        socket.end();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("close", resolve);
    socket.on("error", reject);
  });
  assert.equal(await waitForBrokerEndpoint(session), true);

  const client = await CodexAppServerClient.connect(cwd, { brokerSession: session, env });
  await client.close();
  await stopBroker(cwd);
  assert.equal(fs.existsSync(session.sessionDir), false);
});

test("P6-POSIX-RUNTIME-002 cancels a worker through its authenticated controller", { skip: !POSIX }, async (t) => {
  const cwd = makeTempDir("cxc-workspace-");
  const binDir = makeTempDir("cxc-bin-");
  const runtimeEnv = privateEnvironment();
  const restoreEnv = withRuntimeEnv(runtimeEnv);
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(cwd);
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimeEnv.pluginData
  };
  delete env.XDG_RUNTIME_DIR;
  t.after(async () => {
    await stopBroker(cwd).catch(() => {});
    restoreEnv();
  });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "verify POSIX cancellation"], {
    cwd,
    env,
    shell: false
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateDir = resolveStateDir(cwd);
  const running = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    return state.jobs.find((job) => job.id === jobId && job.status === "running" && job.threadId && job.turnId) ?? null;
  });
  assert.deepEqual(Object.keys(running.controller).sort(), ["generation", "version", "workerId"]);
  assert.equal(Number.isSafeInteger(running.pid), true);
  assert.notEqual(running.pid, process.pid);

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd, env, shell: false });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).workerControlOutcome, "accepted");
  const terminal = await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(resolveJobFile(cwd, jobId), "utf8"));
    return job.status === "cancelled" ? job : null;
  });
  assert.equal(terminal.pid, null);

  const workersDir = path.join(resolvePosixRuntimeRoot(), runtimeScopeId(cwd), "workers");
  await waitFor(() => fs.existsSync(workersDir) && fs.readdirSync(workersDir).length === 0);
  await stopBroker(cwd);
});
