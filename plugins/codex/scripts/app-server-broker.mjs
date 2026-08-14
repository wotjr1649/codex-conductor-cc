#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import {
  createBrokerAuthChallenge,
  createBrokerAuthReady,
  createBrokerOperationAck,
  verifyBrokerAuthProof
} from "./lib/broker-auth.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { assertSupportedRuntime } from "./lib/platform-policy.mjs";
import {
  ensurePrivateDirectory,
  ensurePrivateTree,
  resolvePosixRuntimeRoot,
  runtimeScopeId
} from "./lib/runtime-paths.mjs";

assertSupportedRuntime();

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const AUTH_OPERATIONS = new Set(["connect", "ready", "shutdown"]);
const MAX_AUTH_FRAME_BYTES = 4096;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_AUTHENTICATED_NONCES = 4096;
const MAX_SOCKET_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;
const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
// Above the longest budget any client grants itself -- the two-minute transcript import -- so the
// client's deadline is always the one that decides. See where it is passed.
const BROKER_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  // Nothing here waits for drain, so a client that stops reading would inflate the broker's
  // write buffer without bound. Drop that connection instead: a lost connection now fails the
  // client's turn rather than hanging it.
  if (socket.writableLength > MAX_SOCKET_WRITE_BUFFER_BYTES) {
    socket.destroy();
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["auth-fd", "broker-id", "cwd", "generation", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  let brokerAuth = null;
  if (listenTarget.kind === "unix") {
    const authFd = Number(options["auth-fd"]);
    if (!Number.isSafeInteger(authFd) || authFd < 3 || !options["broker-id"] || !options.generation) {
      throw new Error("POSIX broker authentication material is required.");
    }
    try {
      brokerAuth = {
        brokerId: String(options["broker-id"]),
        generation: String(options.generation),
        capability: fs.readFileSync(authFd, "utf8").trim()
      };
    } finally {
      fs.closeSync(authFd);
    }
  }
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  if (listenTarget.kind === "unix") {
    const uid = process.getuid?.();
    const root = resolvePosixRuntimeRoot({ uid });
    const runs = ensurePrivateTree(root, [runtimeScopeId(cwd), "runs"], { uid });
    const sessionDir = ensurePrivateDirectory(path.join(runs, brokerAuth.brokerId), { uid });
    if (endpoint !== createBrokerEndpoint(sessionDir) || pidFile !== path.join(sessionDir, "broker.pid")) {
      throw new Error("POSIX broker runtime targets did not match their derived identity.");
    }
  }
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    // The broker must not give up before the client that asked it. A per-call timeoutMs does not
    // survive the hop -- the wire message carries method and params and nothing else -- so a
    // client granting itself two minutes for a transcript import was capped at this side's
    // sixty-second default. The client still enforces its own deadline; this only stops the
    // broker answering "timed out" first on a request the caller was still willing to wait for.
    requestTimeoutMs: BROKER_REQUEST_TIMEOUT_MS
  });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  const authenticatedConnections = new Set();
  const seenNonces = new Set();

  let idleTimer = null;

  function clearIdleShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Nothing else reclaims a broker whose session went away without stopping it — a crashed
  // host, a SessionEnd hook that ran out of budget, a workspace nobody returns to.
  function armIdleShutdown(target) {
    clearIdleShutdown();
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (sockets.size > 0) {
        return;
      }
      process.stderr.write("codex broker idle with no client; stopping.\n");
      await shutdown(target);
      process.exit(0);
    }, IDLE_SHUTDOWN_MS);
    idleTimer.unref?.();
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function releaseSocket(socket) {
    sockets.delete(socket);
    authenticatedConnections.delete(socket);
    clearSocketOwnership(socket);
    if (sockets.size === 0) {
      armIdleShutdown(server);
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    clearIdleShutdown();
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = listenTarget.kind === "pipe";
    let authenticatedOperation = authenticated ? "connect" : null;
    let authHello = null;
    let authChallenge = null;
    let authProof = null;

    // This handler awaits, so two chunks could interleave over the shared buffer and slice it
    // with a stale index. Serialize per connection rather than relying on no client ever
    // pipelining requests.
    let processing = Promise.resolve();
    const handleChunk = async (chunk) => {
      buffer += chunk;
      const frameLimit = authenticated ? MAX_FRAME_BYTES : MAX_AUTH_FRAME_BYTES;
      if (Buffer.byteLength(buffer) > frameLimit) {
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (!authenticated) {
          try {
            if (message.method === "broker/hello" && message.id !== undefined && !authHello) {
              const operation = message.params?.operation;
              if (!AUTH_OPERATIONS.has(operation)) {
                throw new Error("Broker authentication failed.");
              }
              authHello = message;
              authChallenge = createBrokerAuthChallenge(authHello, brokerAuth);
              send(socket, { id: message.id, result: authChallenge });
              continue;
            }
            if (message.method === "broker/auth" && message.id !== undefined && authHello && authChallenge && !authProof) {
              verifyBrokerAuthProof(message, authHello, authChallenge, brokerAuth, {
                operation: authHello.params.operation,
                seenNonces,
                maxSeenNonces: MAX_AUTHENTICATED_NONCES
              });
              authProof = message;
              authenticated = true;
              authenticatedOperation = authHello.params.operation;
              if (authenticatedOperation === "connect") authenticatedConnections.add(socket);
              send(socket, { id: message.id, result: createBrokerAuthReady(authProof, brokerAuth) });
              continue;
            }
          } catch {
            // Return one generic failure and close; never reveal capability or transcript details.
          }
          send(socket, {
            id: message.id ?? null,
            error: buildJsonRpcError(-32002, "Broker authentication failed.")
          });
          socket.end();
          return;
        }

        if (listenTarget.kind === "unix") {
          const allowed =
            authenticatedOperation === "connect"
              ? message.method !== "broker/shutdown"
              : authenticatedOperation === "shutdown"
                ? message.method === "broker/shutdown"
                : false;
          if (!allowed) {
            send(socket, { id: message.id ?? null, error: buildJsonRpcError(-32002, "Broker operation is not authorized.") });
            socket.end();
            return;
          }
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (authenticatedConnections.size > 0) {
            send(socket, { id: message.id, error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.") });
            continue;
          }
          send(socket, {
            id: message.id,
            result: listenTarget.kind === "unix" ? createBrokerOperationAck(authProof, brokerAuth, "stopped") : {}
          });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          // Only claim the stream if this socket is still the active requester. A socket that
          // closed during the await has already been released, and re-pinning it here made it
          // the stream owner forever: every other client then got BROKER_BUSY until the idle
          // timer fired half an hour later.
          if (isStreaming && activeRequestSocket === socket) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    };

    socket.on("data", (chunk) => {
      // Pause while this chunk waits its turn. Serializing alone kept every unread chunk alive
      // in the promise chain's closures, where the frame-size guard -- which only ever measures
      // `buffer` -- could not see them, so a client streaming into a broker stalled on a request
      // could queue without bound. Pausing pushes the backpressure onto the socket instead.
      socket.pause();
      processing = processing
        .then(() => handleChunk(chunk))
        .catch(() => {})
        .finally(() => {
          if (!socket.destroyed) socket.resume();
        });
    });

    socket.on("close", () => {
      releaseSocket(socket);
    });

    socket.on("error", () => {
      releaseSocket(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  // The broker multiplexes exactly one app-server. Once that app-server is gone the broker can
  // never answer again — writes to the dead child are discarded and every request stays pending
  // forever — so stop instead of holding client connections open.
  appClient.exitPromise
    .then(async () => {
      if (appClient.closed) {
        return;
      }
      process.stderr.write(
        `codex app-server exited; stopping the broker.${appClient.exitError ? ` ${appClient.exitError.message}` : ""}\n`
      );
      await shutdown(server);
      process.exit(1);
    })
    // A shutdown that throws here would surface as an unhandled rejection and leave the broker
    // running with a dead app-server behind it, which is the state this handler exists to end.
    .catch(() => process.exit(1));

  server.listen(listenTarget.path, () => {
    if (listenTarget.kind === "unix") fs.chmodSync(listenTarget.path, 0o600);
    armIdleShutdown(server);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
