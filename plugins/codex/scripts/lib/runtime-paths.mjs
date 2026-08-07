import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isPrivateDirectoryMetadata({
  isDirectory,
  isSymbolicLink,
  uid,
  mode,
  canonicalPath,
  expectedPath,
  expectedUid
}) {
  return Boolean(
    isDirectory &&
      !isSymbolicLink &&
      Number.isSafeInteger(expectedUid) &&
      uid === expectedUid &&
      Number.isInteger(mode) &&
      (mode & 0o077) === 0 &&
      canonicalPath === expectedPath
  );
}

export function ensurePrivateDirectory(directory, { uid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Private runtime directory must be absolute.");
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stats = fs.lstatSync(directory);
  if (!isPrivateDirectoryMetadata({
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    uid: stats.uid,
    mode: stats.mode,
    canonicalPath: fs.realpathSync.native(directory),
    expectedPath: path.resolve(directory),
    expectedUid: uid
  })) {
    throw new Error("Private runtime directory ownership, mode, or path is invalid.");
  }
  return directory;
}

export function ensurePrivateTree(root, segments, options = {}) {
  let current = ensurePrivateDirectory(root, options);
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) throw new Error("Invalid private runtime path segment.");
    current = ensurePrivateDirectory(path.join(current, segment), options);
  }
  return current;
}

export function resolvePosixRuntimeRoot({
  baseDir,
  env = process.env,
  uid = process.getuid?.()
} = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("A valid current user id is required for the POSIX runtime root.");
  }
  const configuredBase = baseDir ?? env.XDG_RUNTIME_DIR ?? os.tmpdir();
  if (!path.isAbsolute(configuredBase) || configuredBase.includes("\0")) {
    throw new Error("POSIX runtime base must be absolute.");
  }
  const canonicalBase = fs.realpathSync.native(configuredBase);
  if (baseDir || env.XDG_RUNTIME_DIR) ensurePrivateDirectory(canonicalBase, { uid });
  return ensurePrivateDirectory(path.join(canonicalBase, `codex-conductor-${uid}`), { uid });
}

export function runtimeScopeId(cwd) {
  const canonical = fs.realpathSync.native(path.resolve(cwd));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
