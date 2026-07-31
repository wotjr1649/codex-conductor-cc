#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  LosslessNumber,
  StrictJsonlFixture
} from "./lib/p4-jsonl-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: node scripts/run-p4-lifecycle.mjs --codex <exe> --version <version> --transport <direct|broker> --root <fresh-root>"
      );
    }
    options[key.slice(2)] = value;
  }
  for (const required of ["codex", "version", "transport", "root"]) {
    if (!options[required]) {
      throw new Error(`P4E_ARGUMENT: missing --${required}`);
    }
  }
  if (!["direct", "broker"].includes(options.transport)) {
    throw new Error("P4E_TRANSPORT: transport must be direct or broker");
  }
  return options;
}

function scalar(value) {
  return value instanceof LosslessNumber ? value.lexeme : value;
}

function withTimeout(promise, label, milliseconds = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`P4E_TIMEOUT: ${label}`)),
        milliseconds
      );
    })
  ]).finally(() => clearTimeout(timer));
}

function sseEvent(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

async function startLoopbackModel() {
  const requestBytes = [];
  let responseCount = 0;
  let heldResponse = null;
  const requestWaiters = [];
  const server = http.createServer((request, response) => {
    let bodyBytes = 0;
    request.on("data", (chunk) => {
      bodyBytes += chunk.length;
    });
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"object":"list","data":[]}');
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      requestBytes.push(bodyBytes);
      responseCount += 1;
      for (const waiter of requestWaiters.splice(0)) {
        waiter();
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close"
      });
      response.write(
        sseEvent("response.created", {
          type: "response.created",
          response: { id: `resp-p4-${responseCount}` }
        })
      );
      if (responseCount === 1) {
        response.end(
          sseEvent("response.completed", {
            type: "response.completed",
            response: {
              id: "resp-p4-1",
              usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
                total_tokens: 0
              }
            }
          })
        );
      } else {
        heldResponse = response;
        request.on("close", () => {
          heldResponse = null;
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBytes,
    waitForRequestCount(count) {
      if (requestBytes.length >= count) {
        return Promise.resolve();
      }
      return withTimeout(
        new Promise((resolve) => requestWaiters.push(resolve)),
        `model request ${count}`
      ).then(() => this.waitForRequestCount(count));
    },
    async close() {
      if (heldResponse) {
        heldResponse.end();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

class RpcClient {
  constructor(stream, processHandle) {
    this.stream = stream;
    this.processHandle = processHandle;
    this.framer = new StrictJsonlFixture({ maxLineBytes: 1_048_576 });
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.nextId = 1;
    this.stderrBytes = 0;
    this.messageCount = 0;
    stream.on("data", (chunk) => this.onData(chunk));
    processHandle?.stderr?.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
    });
  }

  onData(chunk) {
    let messages;
    try {
      messages = this.framer.push(chunk);
    } catch (error) {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      return;
    }
    for (const message of messages) {
      this.messageCount += 1;
      if (message.kind === "response") {
        const key = message.id.correlationKey;
        const pending = this.pending.get(key);
        if (!pending) {
          continue;
        }
        this.pending.delete(key);
        if (message.outcome === "error") {
          const error = new Error(message.value.error?.message ?? "RPC error");
          error.rpcCode = scalar(message.value.error?.code);
          pending.reject(error);
        } else {
          pending.resolve(message.value.result);
        }
      } else if (message.kind === "notification") {
        this.notifications.push(message.value);
        this.flushNotificationWaiters();
      } else {
        this.send({
          id: scalar(message.value.id),
          error: {
            code: -32601,
            message: `Unsupported server request: ${message.method}`
          }
        });
      }
    }
  }

  flushNotificationWaiters() {
    for (const waiter of [...this.notificationWaiters]) {
      const index = this.notifications.findIndex(waiter.predicate);
      if (index === -1) {
        continue;
      }
      const [message] = this.notifications.splice(index, 1);
      this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  send(message) {
    this.stream.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const key = `n:${id}`;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    this.send({ id, method, params });
    return withTimeout(promise, method);
  }

  waitForNotification(method, predicate = () => true) {
    const existingIndex = this.notifications.findIndex(
      (message) => message.method === method && predicate(message)
    );
    if (existingIndex !== -1) {
      return Promise.resolve(this.notifications.splice(existingIndex, 1)[0]);
    }
    return withTimeout(
      new Promise((resolve) => {
        this.notificationWaiters.push({
          predicate: (message) => message.method === method && predicate(message),
          resolve
        });
      }),
      method
    );
  }

  lineMetrics() {
    const values = this.framer.observedLineBytes;
    return {
      count: values.length,
      totalBytes: values.reduce((sum, value) => sum + value, 0),
      maxBytes: values.length ? Math.max(...values) : 0
    };
  }
}

async function connectPipe(pipeName) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: pipeName });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("P4E_BROKER_CONNECT: broker pipe did not become available");
}

async function waitForExit(child, label) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    `${label} exit`,
    5_000
  );
}

const options = parseArguments(process.argv.slice(2));
const runRoot = path.resolve(options.root);
await mkdir(runRoot, { recursive: false });
const codexHome = path.join(runRoot, "codex-home");
const appData = path.join(runRoot, "appdata");
const localAppData = path.join(runRoot, "localappdata");
const tempRoot = path.join(runRoot, "temp");
const workRoot = path.join(runRoot, "work");
for (const directory of [codexHome, appData, localAppData, tempRoot, workRoot]) {
  await mkdir(directory, { recursive: false });
}

const selectedCodex = path.resolve(options.codex);
const executableBytes = await import("node:fs/promises").then(({ readFile }) =>
  readFile(selectedCodex)
);
const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
const model = await startLoopbackModel();
await writeFile(
  path.join(codexHome, "config.toml"),
  [
    'model = "p4-fixture-model"',
    'model_provider = "p4-fixture"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "",
    "[model_providers.p4-fixture]",
    'name = "P4 Loopback"',
    `base_url = "${model.baseUrl}"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    ""
  ].join("\n"),
  "utf8"
);

const environment = {
  SYSTEMROOT: process.env.SYSTEMROOT,
  WINDIR: process.env.WINDIR,
  COMSPEC: process.env.COMSPEC,
  HOME: codexHome,
  USERPROFILE: codexHome,
  CODEX_HOME: codexHome,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  TEMP: tempRoot,
  TMP: tempRoot,
  PATH: path.dirname(selectedCodex),
  PATHEXT: ".COM;.EXE;.BAT;.CMD"
};

let child;
let stream;
let brokerHello = { attempted: false, supported: null, errorCode: null };
if (options.transport === "direct") {
  child = spawn(selectedCodex, ["app-server"], {
    cwd: workRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });
  stream = child.stdin;
} else {
  const nonce = `${process.pid}-${options.version.replaceAll(".", "-")}`;
  const pipeName = `\\\\.\\pipe\\codex-conductor-p4-${nonce}`;
  child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "plugins", "codex", "scripts", "app-server-broker.mjs"),
      "serve",
      "--endpoint",
      `pipe:${pipeName}`,
      "--cwd",
      workRoot,
      "--pid-file",
      path.join(runRoot, "broker.pid")
    ],
    {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    }
  );
  let brokerStdout = "";
  let brokerStderr = "";
  child.stdout.on("data", (chunk) => {
    brokerStdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    brokerStderr += chunk.toString("utf8");
  });
  try {
    stream = await connectPipe(pipeName);
  } catch (error) {
    const detail = `${brokerStdout}\n${brokerStderr}`.trim();
    if (child.exitCode === null) {
      child.kill();
      await waitForExit(child, "broker startup cleanup").catch(() => {});
    }
    await model.close();
    throw new Error(
      `${error.message}; brokerExit=${child.exitCode}; brokerOutput=${detail || "<empty>"}`
    );
  }
}

const readable = options.transport === "direct" ? child.stdout : stream;
const client = new RpcClient(readable, child);
if (options.transport === "direct") {
  client.stream = child.stdin;
} else {
  client.stream = stream;
  brokerHello.attempted = true;
  try {
    await client.request("broker/hello", {
      protocolVersion: 1,
      client: "p4-contract-fixture"
    });
    brokerHello.supported = true;
  } catch (error) {
    brokerHello.supported = false;
    brokerHello.errorCode = String(error.rpcCode ?? "unknown");
  }
}

let processExitCode = null;
try {
  const initialize = await client.request("initialize", {
    clientInfo: {
      name: "codex_conductor_p4_fixture",
      title: "Codex Conductor P4 Fixture",
      version: "0.1.0"
    },
    capabilities: { experimentalApi: false }
  });
  client.notify("initialized", {});

  const startThread = async () => {
    const response = await client.request("thread/start", {
      model: "p4-fixture-model",
      modelProvider: "p4-fixture",
      cwd: workRoot,
      ephemeral: true
    });
    return response.thread.id;
  };

  const normalThreadId = await startThread();
  const normalTurn = await client.request("turn/start", {
    threadId: normalThreadId,
    input: [{ type: "text", text: "P4 deterministic lifecycle fixture" }]
  });
  const normalTurnId = normalTurn.turn.id;
  const normalCompleted = await client.waitForNotification(
    "turn/completed",
    (message) =>
      message.params?.threadId === normalThreadId &&
      message.params?.turn?.id === normalTurnId
  );

  const cancelThreadId = await startThread();
  const cancelTurn = await client.request("turn/start", {
    threadId: cancelThreadId,
    input: [{ type: "text", text: "P4 deterministic cancellation fixture" }]
  });
  const cancelTurnId = cancelTurn.turn.id;
  await model.waitForRequestCount(2);
  await client.request("turn/interrupt", { threadId: cancelThreadId, turnId: cancelTurnId });
  const cancelCompleted = await client.waitForNotification(
    "turn/completed",
    (message) =>
      message.params?.threadId === cancelThreadId &&
      message.params?.turn?.id === cancelTurnId
  );

  const summary = {
    schemaVersion: "p4-lifecycle-integration-result-v1",
    version: options.version,
    transport: options.transport,
    executableSha256,
    executionStatus: "executed-pass",
    retryCount: 0,
    initialize: {
      resultKeys: Object.keys(initialize).sort(),
      brokerSynthetic: options.transport === "broker"
    },
    brokerHello,
    normal: {
      threadStarted: Boolean(normalThreadId),
      turnStarted: Boolean(normalTurnId),
      terminalStatus: normalCompleted.params.turn.status
    },
    cancellation: {
      threadStarted: Boolean(cancelThreadId),
      turnStarted: Boolean(cancelTurnId),
      interruptAcknowledged: true,
      terminalStatus: cancelCompleted.params.turn.status
    },
    traffic: {
      ...client.lineMetrics(),
      messageCount: client.messageCount,
      modelRequestCount: model.requestBytes.length,
      modelRequestBodyBytes: model.requestBytes,
      stderrBytes: client.stderrBytes
    },
    rawPromptCommitted: false,
    privatePathCommitted: false
  };

  if (options.transport === "broker") {
    await client.request("broker/shutdown", {});
    processExitCode = await waitForExit(child, "broker");
  } else {
    child.stdin.end();
    processExitCode = await waitForExit(child, "app-server");
  }
  summary.processExitCode = processExitCode;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await waitForExit(child, "forced cleanup").catch(() => {});
  }
  if (options.transport === "broker" && stream && !stream.destroyed) {
    stream.destroy();
  }
  await model.close();
}
