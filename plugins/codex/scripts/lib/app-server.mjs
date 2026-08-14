/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import {
  connectAuthenticatedBrokerSession,
  ensureBrokerSession,
  loadBrokerSession
} from "./broker-lifecycle.mjs";
import {
  resolveCommandInvocation,
  terminateOwnedPosixProcess,
  terminateProcessTree
} from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Every request this client makes is control plane: a turn's work arrives as notifications, and
// turn/start answers as soon as the turn exists. Slow calls pass their own budget instead.
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
// How long after `exit` to keep waiting for `close`, which is what guarantees stdout has drained.
// Long enough for readline to emit what is already buffered, short enough that a `close` which
// will never come costs a fraction of a second instead of a request timeout.
const EXIT_DRAIN_GRACE_MS = 250;
const MAX_RETAINED_STDERR_BYTES = 64 * 1024;
const MAX_LINE_BUFFER_BYTES = 8 * 1024 * 1024;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Conductor",
  name: "codex_conductor",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      // A pending request used to settle only on a matching response or on process exit, so an
      // app-server that stayed alive and silent held it for the life of the process.
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        reject(createProtocolError(`codex app-server did not answer ${method} within ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });

      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  appendStderr(chunk) {
    this.stderr += chunk;
    // The broker's client lives as long as the broker, so retained stderr cannot be allowed to
    // grow with the child's chattiness. Keep the tail: it is what explains an exit.
    if (this.stderr.length > MAX_RETAINED_STDERR_BYTES) {
      this.stderr = this.stderr.slice(-MAX_RETAINED_STDERR_BYTES);
    }
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
    // What is left is one unterminated line. The socket side is capped and this was not.
    if (Buffer.byteLength(this.lineBuffer) > MAX_LINE_BUFFER_BYTES) {
      this.lineBuffer = "";
      // Mark the client closed as well as settling what is pending. handleExit alone left
      // request()'s guard passing, so a call made afterwards was added to `pending` that
      // handleExit -- already past its exitResolved check -- would never visit again, and it
      // hung to its own timeout against a transport nobody was reading.
      this.closed = true;
      this.handleExit(createProtocolError("codex app-server sent a line larger than this client will buffer."));
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const invocation = resolveCommandInvocation("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env
    });
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.appendStderr(chunk);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    // Prefer `close` over `exit`, but do not depend on it. `exit` fires when the process ends,
    // which can be before readline has emitted the lines still sitting in stdout's buffer, and a
    // turn whose `turn/completed` was in that buffer got reported as a lost connection instead of
    // the success it was. `close` waits for stdio to drain -- except that a grandchild which
    // inherited the pipes keeps it from ever firing, and then every pending request runs to its
    // own timeout. So `exit` arms a short drain window and whichever arrives first settles.
    let exitSettled = false;
    let drainTimer = null;
    const settleExit = (code, signal) => {
      if (exitSettled) return;
      exitSettled = true;
      if (drainTimer) clearTimeout(drainTimer);
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    };

    this.proc.on("exit", (code, signal) => {
      drainTimer = setTimeout(() => settleExit(code, signal), EXIT_DRAIN_GRACE_MS);
      drainTimer.unref?.();
    });
    this.proc.on("close", (code, signal) => settleExit(code, signal));

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      if (process.platform === "win32") {
        setTimeout(() => {
          if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
            // On Windows the retained child can be the constrained cmd.exe wrapper for a .cmd launcher.
            // Use terminateProcessTree to kill the entire tree including
            // the grandchild node process.
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          }
        }, 50).unref?.();
      } else {
        await terminateOwnedPosixProcess(this.proc);
      }
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.session = options.brokerSession;
    this.endpoint = this.session.endpoint;
  }

  async initialize() {
    const { socket } = await connectAuthenticatedBrokerSession(this.session, "connect", this.options.timeoutMs ?? 1000);
    this.socket = socket;
    this.socket.on("data", (chunk) => {
      this.handleChunk(chunk);
    });
    this.socket.on("error", (error) => {
      this.handleExit(error);
    });
    this.socket.on("close", () => {
      this.handleExit(this.exitError);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerSession = options.brokerSession ?? null;
    if (!options.disableBroker) {
      const rawEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerSession && rawEndpoint) {
        if (parseBrokerEndpoint(rawEndpoint).kind === "unix") {
          throw new Error("POSIX broker endpoints must come from authenticated broker state.");
        }
        brokerSession = { endpoint: rawEndpoint };
      }
      if (!brokerSession && options.reuseExistingBroker) {
        brokerSession = loadBrokerSession(cwd);
      }
      if (!brokerSession && !options.reuseExistingBroker) {
        brokerSession = await ensureBrokerSession(cwd, { env: options.env });
      }
    }
    const client = brokerSession
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerSession })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
