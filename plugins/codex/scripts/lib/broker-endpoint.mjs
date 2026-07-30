import path from "node:path";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createBrokerEndpoint(sessionDir) {
  const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
  return `pipe:\\\\.\\pipe\\${pipeName}`;
}

export function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
