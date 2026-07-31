import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function ordinalCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function walkFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (relative !== "snapshot-manifest.json") {
        files.push({ absolute, relative });
      }
    } else {
      throw new Error(`P4E_SNAPSHOT_ENTRY: unsupported entry ${entry.name}`);
    }
  }
  return files.sort((left, right) => ordinalCompare(left.relative, right.relative));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSnapshotHost(platform = process.platform, architecture = process.arch, node = process.versions.node) {
  if (platform !== "win32" || architecture !== "x64" || node !== "24.18.1") {
    throw new Error(
      `P4E_SNAPSHOT_HOST: expected win32/x64/Node 24.18.1, observed ${platform}/${architecture}/Node ${node}`
    );
  }
}

export async function inspectSnapshotTree(root) {
  const tree = createHash("sha256");
  const files = [];
  let totalBytes = 0;
  for (const file of await walkFiles(root)) {
    const bytes = await readFile(file.absolute);
    const digest = sha256(bytes);
    totalBytes += bytes.length;
    files.push({
      path: file.relative,
      bytes: bytes.length,
      sha256: digest
    });
    tree.update(file.relative, "utf8");
    tree.update("\0");
    tree.update(bytes);
    tree.update("\0");
  }
  return {
    fileCount: files.length,
    totalBytes,
    treeSha256: tree.digest("hex"),
    files
  };
}

function collectMethods(value, result = new Set()) {
  if (!value || typeof value !== "object") {
    return result;
  }
  if (
    value.properties?.method &&
    Array.isArray(value.properties.method.enum)
  ) {
    for (const method of value.properties.method.enum) {
      if (typeof method === "string") {
        result.add(method);
      }
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectMethods(child, result);
  }
  return result;
}

export async function readMethodInventory(jsonSchemaRoot) {
  const mapping = {
    clientRequests: "ClientRequest.json",
    serverRequests: "ServerRequest.json",
    serverNotifications: "ServerNotification.json"
  };
  const inventory = {};
  for (const [key, file] of Object.entries(mapping)) {
    const document = JSON.parse(await readFile(path.join(jsonSchemaRoot, file), "utf8"));
    inventory[key] = [...collectMethods(document)].sort(ordinalCompare);
  }
  return inventory;
}
