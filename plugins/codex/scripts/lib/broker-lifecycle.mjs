import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authenticateBrokerSocket,
  readBrokerJsonLine,
  verifyBrokerOperationAck
} from "./broker-auth.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import {
  ensurePrivateDirectory,
  ensurePrivateTree,
  isPrivateDirectoryMetadata,
  resolvePosixRuntimeRoot,
  runtimeScopeId
} from "./runtime-paths.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_CAPABILITY_FILE = "broker.cap";
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const POSIX_BROKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POSIX_BROKER_PHASES = new Set(["starting", "ready", "indeterminate"]);
const POSIX_BROKER_STATE_KEYS = ["generation", "phase", "scopeId", "sessionId", "version"];

export function validatePosixBrokerDescriptor(cwd, descriptor) {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    descriptor.version !== 1 ||
    Object.keys(descriptor).sort().join("\0") !== POSIX_BROKER_STATE_KEYS.join("\0") ||
    descriptor.scopeId !== runtimeScopeId(cwd) ||
    !POSIX_BROKER_ID.test(descriptor.sessionId) ||
    !POSIX_BROKER_ID.test(descriptor.generation) ||
    !POSIX_BROKER_PHASES.has(descriptor.phase)
  ) {
    throw new Error("Invalid POSIX broker state.");
  }
  return descriptor;
}

export function createPosixBrokerDescriptor(cwd, { sessionId, generation }, phase) {
  return validatePosixBrokerDescriptor(cwd, {
    version: 1,
    scopeId: runtimeScopeId(cwd),
    sessionId,
    generation,
    phase
  });
}

function isPosix(platform = process.platform) {
  return platform === "linux" || platform === "darwin";
}

function brokerCapabilityFile(sessionDir) {
  return path.join(sessionDir, BROKER_CAPABILITY_FILE);
}

function createBrokerAuth(sessionId, generation) {
  return {
    brokerId: sessionId,
    generation,
    capability: randomBytes(32).toString("base64url")
  };
}

function writeBrokerCapability(sessionDir, capability) {
  if (!CAPABILITY.test(capability)) throw new Error("Invalid broker capability.");
  const filePath = brokerCapabilityFile(sessionDir);
  fs.writeFileSync(filePath, `${capability}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (isPosix()) fs.chmodSync(filePath, 0o600);
  return filePath;
}

function readBrokerAuth(session) {
  const filePath = brokerCapabilityFile(session.sessionDir);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || fs.realpathSync.native(filePath) !== path.resolve(filePath)) {
    throw new Error("Invalid broker capability file.");
  }
  if (isPosix() && (stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)) {
    throw new Error("Invalid broker capability file.");
  }
  const capability = fs.readFileSync(filePath, "utf8").trim();
  if (!CAPABILITY.test(capability)) throw new Error("Invalid broker capability file.");
  return { brokerId: session.sessionId, generation: session.generation, capability };
}

export function createBrokerSessionDir(prefix = "cxc-", options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Unsupported broker platform: ${platform}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(prefix)) {
    throw new Error("Invalid broker directory prefix.");
  }
  const uid = options.uid ?? process.getuid?.();
  const root = resolvePosixRuntimeRoot({
    baseDir: options.runtimeBase,
    env: options.env ?? process.env,
    uid
  });
  const runs = ensurePrivateTree(root, [runtimeScopeId(options.cwd), "runs"], { uid });
  const sessionDir = options.sessionId
    ? path.join(runs, options.sessionId)
    : fs.mkdtempSync(path.join(runs, prefix));
  if (options.sessionId) {
    if (!POSIX_BROKER_ID.test(options.sessionId)) throw new Error("Invalid POSIX broker session id.");
    fs.mkdirSync(sessionDir, { mode: 0o700 });
  }
  fs.chmodSync(sessionDir, 0o700);
  return ensurePrivateDirectory(sessionDir, { uid });
}

function derivePosixBrokerSession(cwd, descriptor, options = {}) {
  validatePosixBrokerDescriptor(cwd, descriptor);
  const uid = options.uid ?? process.getuid?.();
  const root = resolvePosixRuntimeRoot({ env: options.env ?? process.env, uid });
  const runs = ensurePrivateTree(root, [descriptor.scopeId, "runs"], { uid });
  const sessionDir = path.join(runs, descriptor.sessionId);
  const stats = fs.lstatSync(sessionDir);
  if (!isPrivateDirectoryMetadata({
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    uid: stats.uid,
    mode: stats.mode,
    canonicalPath: fs.realpathSync.native(sessionDir),
    expectedPath: path.resolve(sessionDir),
    expectedUid: uid
  })) {
    throw new Error("Invalid POSIX broker session directory.");
  }
  return {
    ...descriptor,
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: null
  };
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

async function connectSocket(endpoint, timeoutMs) {
  const socket = connectToEndpoint(endpoint);
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Broker connection timed out."));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
}

export async function connectAuthenticatedBrokerSession(session, operation = "connect", timeoutMs = 1000) {
  const target = parseBrokerEndpoint(session?.endpoint);
  const socket = await connectSocket(session.endpoint, timeoutMs);
  if (target.kind === "pipe") return { socket, auth: null, transcript: null };
  try {
    const auth = readBrokerAuth(session);
    const transcript = await authenticateBrokerSocket(socket, auth, { operation, timeoutMs });
    return { socket, auth, transcript };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function waitForBrokerEndpoint(sessionOrEndpoint, timeoutMs = 2000) {
  const session = typeof sessionOrEndpoint === "string" ? { endpoint: sessionOrEndpoint } : sessionOrEndpoint;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await (async () => {
      try {
        const { socket } = await connectAuthenticatedBrokerSession(session, "ready", Math.min(500, timeoutMs));
        socket.end();
        return true;
      } catch {
        return false;
      }
    })();
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(sessionOrEndpoint) {
  const session = typeof sessionOrEndpoint === "string" ? { endpoint: sessionOrEndpoint } : sessionOrEndpoint;
  const target = parseBrokerEndpoint(session?.endpoint);
  if (target.kind === "pipe") {
    await new Promise((resolve) => {
      const socket = connectToEndpoint(session.endpoint);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
      });
      socket.on("data", () => {
        socket.end();
        resolve();
      });
      socket.on("error", resolve);
      socket.on("close", resolve);
    });
    return true;
  }

  const { socket, auth, transcript } = await connectAuthenticatedBrokerSession(session, "shutdown", 1000);
  try {
    const responsePromise = readBrokerJsonLine(socket, 1000);
    socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    const response = await responsePromise;
    if (response?.id !== 1 || !response.result) throw new Error("Broker shutdown was not acknowledged.");
    verifyBrokerOperationAck(response.result, transcript.proof, auth, "stopped");
    socket.end();
    return true;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, auth = null, env = process.env }) {
  const logFd = fs.openSync(logFile, "a", 0o600);
  const args = [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile];
  if (auth) {
    args.push("--auth-fd", "3", "--broker-id", auth.brokerId, "--generation", auth.generation);
  }
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    // Unlike the app-server spawn, which stays attached on Windows so its owner can kill the
    // tree, the broker has to outlive the command that starts it. Measured on win32: an
    // un-detached unref'd child dies with its parent, so this stays detached everywhere.
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: auth ? ["ignore", logFd, logFd, "pipe"] : ["ignore", logFd, logFd]
  });
  if (auth) {
    const control = /** @type {import("node:stream").Writable} */ (child.stdio[3]);
    control.on("error", () => {});
    control.end(`${auth.capability}\n`);
  }
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return isPosix() ? derivePosixBrokerSession(cwd, validatePosixBrokerDescriptor(cwd, stored)) : stored;
  } catch (error) {
    if (isPosix()) throw error;
    return null;
  }
}

function writeBrokerState(cwd, payload, { exclusive = false } = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = resolveBrokerStateFile(cwd);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (exclusive) {
    fs.writeFileSync(stateFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function saveBrokerSession(cwd, session, options = {}) {
  const payload = isPosix()
    ? createPosixBrokerDescriptor(cwd, session, session.phase)
    : session;
  writeBrokerState(cwd, payload, options);
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(session) {
  if (!session?.endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(session, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing))) {
    return existing;
  }

  if (existing) {
    if (isPosix()) {
      if (existing.phase !== "indeterminate") {
        saveBrokerSession(cwd, { ...existing, phase: "indeterminate" });
      }
      throw new Error("Existing POSIX broker identity could not be authenticated.");
    }
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionId = isPosix() ? `b-${randomBytes(8).toString("hex")}` : null;
  const generation = isPosix() ? `g-${randomBytes(16).toString("hex")}` : null;
  const sessionDir = createBrokerSessionDir("broker-", {
    platform: options.platform ?? process.platform,
    cwd,
    env: options.env ?? process.env,
    sessionId
  });
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  let endpoint;
  try {
    endpoint = endpointFactory(sessionDir, options.platform);
  } catch (error) {
    fs.rmdirSync(sessionDir);
    throw error;
  }
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const auth = isPosix() ? createBrokerAuth(sessionId, generation) : null;
  if (auth) writeBrokerCapability(sessionDir, auth.capability);
  let session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: null,
    ...(auth ? { sessionId, generation, phase: "starting" } : {})
  };

  if (auth) {
    try {
      saveBrokerSession(cwd, session, { exclusive: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      fs.unlinkSync(brokerCapabilityFile(sessionDir));
      fs.rmdirSync(sessionDir);
      const winner = loadBrokerSession(cwd);
      if (winner && (await waitForBrokerEndpoint(winner, options.timeoutMs ?? 2000))) return winner;
      throw new Error("Concurrent POSIX broker identity could not be authenticated.");
    }
  }

  let child;
  try {
    child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      auth,
      env: options.env ?? process.env
    });
  } catch (error) {
    if (auth) saveBrokerSession(cwd, { ...session, phase: "indeterminate" });
    throw error;
  }

  const ready = await waitForBrokerEndpoint(session, options.timeoutMs ?? 2000);
  if (!ready) {
    if (auth) {
      saveBrokerSession(cwd, { ...session, phase: "indeterminate" });
      throw new Error("New POSIX broker identity could not be authenticated.");
    }
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  session = { ...session, pid: child.pid ?? null, ...(auth ? { phase: "ready" } : {}) };
  saveBrokerSession(cwd, session);
  return session;
}

function unlinkExpected(filePath, expectedType) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const stats = fs.lstatSync(filePath);
  const valid = !stats.isSymbolicLink() && (expectedType === "socket" ? stats.isSocket() : stats.isFile());
  if (!valid) throw new Error("Unexpected POSIX broker artifact type.");
  fs.unlinkSync(filePath);
}

function cleanupAuthenticatedPosixBrokerSession(session) {
  const { endpoint, pidFile, logFile, sessionDir } = session;
  ensurePrivateDirectory(sessionDir, { uid: process.getuid?.() });
  if (
    endpoint !== createBrokerEndpoint(sessionDir) ||
    pidFile !== path.join(sessionDir, "broker.pid") ||
    logFile !== path.join(sessionDir, "broker.log")
  ) {
    throw new Error("Invalid POSIX broker cleanup target.");
  }
  unlinkExpected(pidFile, "file");
  unlinkExpected(logFile, "file");
  unlinkExpected(brokerCapabilityFile(sessionDir), "file");
  unlinkExpected(parseBrokerEndpoint(endpoint).path, "socket");
  fs.rmdirSync(sessionDir);
  return true;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null, authenticated = false, ...descriptor }) {
  if (isPosix()) {
    if (!authenticated) return false;
    return cleanupAuthenticatedPosixBrokerSession({ endpoint, pidFile, logFile, sessionDir, ...descriptor });
  }
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
  return true;
}
