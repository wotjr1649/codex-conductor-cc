import path from "node:path";
import process from "node:process";

const MAX_UNIX_SOCKET_BYTES = 96;

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function posixSocketPath(value) {
  const sessionDir = String(value ?? "");
  if (
    !path.posix.isAbsolute(sessionDir) ||
    sessionDir.includes("\\") ||
    sessionDir.includes("\0") ||
    path.posix.normalize(sessionDir) !== sessionDir
  ) {
    throw new Error("Broker session directory must be a canonical absolute POSIX path.");
  }
  const socketPath = path.posix.join(sessionDir, "broker.sock");
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_BYTES) {
    throw new Error("Broker Unix socket path is too long.");
  }
  return socketPath;
}

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }
  if (platform === "linux" || platform === "darwin") {
    return `unix:${posixSocketPath(sessionDir)}`;
  }
  throw new Error(`Unsupported broker platform: ${platform}`);
}

export function parseBrokerEndpoint(endpoint, platform = process.platform) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (platform === "win32" && endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(pipePath)) {
      throw new Error("Broker pipe endpoint is invalid.");
    }
    return { kind: "pipe", path: pipePath };
  }
  if ((platform === "linux" || platform === "darwin") && endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (posixSocketPath(path.posix.dirname(socketPath)) !== socketPath) {
      throw new Error("Broker Unix endpoint is invalid.");
    }
    return { kind: "unix", path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
