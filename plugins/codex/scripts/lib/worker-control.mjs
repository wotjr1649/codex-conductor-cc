import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { supportsWorkerControl } from "./platform-policy.mjs";

import {
  authenticateBrokerSocket,
  createBrokerAuthChallenge,
  createBrokerAuthReady,
  createBrokerOperationAck,
  readBrokerJsonLine,
  verifyBrokerAuthProof,
  verifyBrokerOperationAck
} from "./broker-auth.mjs";
import {
  ensurePrivateDirectory,
  ensurePrivateTree,
  isPrivateDirectoryMetadata,
  resolvePosixRuntimeRoot,
  runtimeScopeId
} from "./runtime-paths.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const DESCRIPTOR_KEYS = ["generation", "version", "workerId"];
const MAX_NONCES = 4096;
const OUTCOMES = new Set(["accepted", "indeterminate"]);
const CANCEL_ACK_TIMEOUT_MS = 15000;

export function validateWorkerControllerDescriptor(descriptor) {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    descriptor.version !== 1 ||
    Object.keys(descriptor).sort().join("\0") !== DESCRIPTOR_KEYS.join("\0") ||
    !ID.test(descriptor.workerId) ||
    !ID.test(descriptor.generation)
  ) {
    throw new Error("Invalid worker controller state.");
  }
  return descriptor;
}

export function createWorkerControllerDescriptor({ workerId, generation }) {
  return validateWorkerControllerDescriptor({ version: 1, workerId, generation });
}

function assertPosix() {
  if (!supportsWorkerControl()) {
    throw new Error("Worker control sockets require POSIX.");
  }
}

function controlPaths(cwd, descriptor, { create = false } = {}) {
  assertPosix();
  validateWorkerControllerDescriptor(descriptor);
  const uid = process.getuid?.();
  const root = resolvePosixRuntimeRoot({ uid });
  const workers = ensurePrivateTree(root, [runtimeScopeId(cwd), "workers"], { uid });
  const sessionDir = path.join(workers, descriptor.workerId);
  if (create) fs.mkdirSync(sessionDir, { mode: 0o700 });
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
    throw new Error("Invalid worker control directory.");
  }
  const socketPath = path.join(sessionDir, "control.sock");
  if (Buffer.byteLength(socketPath) > 96) throw new Error("Worker control socket path is too long.");
  return {
    sessionDir,
    socketPath,
    capabilityFile: path.join(sessionDir, "worker.cap")
  };
}

function assertCapabilityFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid?.() ||
    (stats.mode & 0o077) !== 0 ||
    fs.realpathSync.native(filePath) !== path.resolve(filePath)
  ) {
    throw new Error("Invalid worker capability file.");
  }
  const capability = fs.readFileSync(filePath, "utf8").trim();
  if (!CAPABILITY.test(capability)) throw new Error("Invalid worker capability file.");
  return capability;
}

function workerAuth(descriptor, capability) {
  return {
    brokerId: descriptor.workerId,
    generation: descriptor.generation,
    capability
  };
}

export function createWorkerController(cwd) {
  const descriptor = createWorkerControllerDescriptor({
    workerId: `w-${randomBytes(8).toString("hex")}`,
    generation: `g-${randomBytes(16).toString("hex")}`
  });
  const paths = controlPaths(cwd, descriptor, { create: true });
  const capability = randomBytes(32).toString("base64url");
  fs.writeFileSync(paths.capabilityFile, `${capability}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(paths.capabilityFile, 0o600);
  return { descriptor, ...paths, auth: workerAuth(descriptor, capability) };
}

// A worker that dies before it starts its control server leaves the directory the enqueue side
// created, credential file and all, with nobody holding the handle that would clean it up.
export function discardWorkerController(cwd, descriptor) {
  if (!supportsWorkerControl()) {
    return false;
  }
  try {
    const paths = controlPaths(cwd, descriptor);
    if (fs.existsSync(paths.socketPath)) fs.unlinkSync(paths.socketPath);
    if (fs.existsSync(paths.capabilityFile)) fs.unlinkSync(paths.capabilityFile);
    fs.rmdirSync(paths.sessionDir);
    return true;
  } catch {
    return false;
  }
}

export function discardUnstartedWorkerController(controller) {
  if (fs.existsSync(controller.socketPath)) throw new Error("Worker control socket already started.");
  if (fs.existsSync(controller.capabilityFile)) fs.unlinkSync(controller.capabilityFile);
  fs.rmdirSync(controller.sessionDir);
}

function loadWorkerController(cwd, descriptor) {
  const paths = controlPaths(cwd, descriptor);
  return {
    descriptor,
    ...paths,
    auth: workerAuth(descriptor, assertCapabilityFile(paths.capabilityFile))
  };
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export async function startWorkerControlServer(cwd, descriptor, capability, onCancel) {
  const controller = loadWorkerController(cwd, descriptor);
  const transferred = Buffer.from(String(capability));
  const stored = Buffer.from(controller.auth.capability);
  if (transferred.length !== stored.length || !timingSafeEqual(transferred, stored)) {
    throw new Error("Worker capability transfer did not match.");
  }
  if (fs.existsSync(controller.socketPath)) throw new Error("Worker control socket already exists.");
  const seenNonces = new Set();
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    void (async () => {
      try {
        if (seenNonces.size >= MAX_NONCES) throw new Error("Worker authentication capacity reached.");
        const hello = await readBrokerJsonLine(socket, 1000);
        if (hello?.id !== "broker-auth-hello" || hello?.params?.operation !== "worker-cancel") {
          throw new Error("Worker authentication failed.");
        }
        const challenge = createBrokerAuthChallenge(hello, controller.auth);
        send(socket, { id: hello.id, result: challenge });

        const proof = await readBrokerJsonLine(socket, 1000);
        if (proof?.id !== "broker-auth-proof") throw new Error("Worker authentication failed.");
        verifyBrokerAuthProof(proof, hello, challenge, controller.auth, {
          operation: "worker-cancel",
          seenNonces
        });
        send(socket, { id: proof.id, result: createBrokerAuthReady(proof, controller.auth) });

        const request = await readBrokerJsonLine(socket, 2000);
        if (request?.id === undefined || request.method !== "worker/cancel") {
          throw new Error("Worker control request is invalid.");
        }
        const outcome = await onCancel();
        if (!OUTCOMES.has(outcome)) throw new Error("Worker cancellation outcome is invalid.");
        send(socket, { id: request.id, result: createBrokerOperationAck(proof, controller.auth, outcome) });
        socket.end();
      } catch {
        send(socket, { id: null, error: { code: -32002, message: "Worker authentication failed." } });
        socket.end();
      }
    })();
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controller.socketPath, () => {
      server.off("error", reject);
      fs.chmodSync(controller.socketPath, 0o600);
      resolve();
    });
  });

  return {
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      let timeout;
      // Drain a valid acknowledgement without letting a stalled local client pin the worker.
      const graceful = await Promise.race([
        closed.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), 2000);
        })
      ]);
      clearTimeout(timeout);
      if (!graceful) {
        for (const socket of sockets) socket.destroy();
      }
      await closed;
      if (fs.existsSync(controller.socketPath)) fs.unlinkSync(controller.socketPath);
      if (fs.existsSync(controller.capabilityFile)) fs.unlinkSync(controller.capabilityFile);
      fs.rmdirSync(controller.sessionDir);
    }
  };
}

async function connectWorker(socketPath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    const connected = await new Promise((resolve) => {
      socket.once("connect", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (connected) return socket;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Worker control connection timed out.");
}

export async function sendWorkerCancel(cwd, descriptor, timeoutMs = 2000) {
  const controller = loadWorkerController(cwd, descriptor);
  const socket = await connectWorker(controller.socketPath, timeoutMs);
  try {
    const transcript = await authenticateBrokerSocket(socket, controller.auth, {
      operation: "worker-cancel",
      timeoutMs: 1000
    });
    // The worker's handler polls for thread identity and can spawn an app-server to interrupt the
    // turn, so a two-second window gave up before it could answer.
    const responsePromise = readBrokerJsonLine(socket, CANCEL_ACK_TIMEOUT_MS);
    socket.write(`${JSON.stringify({ id: 1, method: "worker/cancel", params: {} })}\n`);
    const response = await responsePromise;
    const outcome = response?.result?.outcome;
    if (response?.id !== 1 || !OUTCOMES.has(outcome)) throw new Error("Worker cancellation was not acknowledged.");
    verifyBrokerOperationAck(response.result, transcript.proof, controller.auth, outcome);
    socket.end();
    return outcome;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
