import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensurePrivateDirectory,
  isSafeRuntimeAncestorMetadata,
  isPrivateDirectoryMetadata,
  resolvePosixRuntimeRoot
} from "../../plugins/codex/scripts/lib/runtime-paths.mjs";
import { makeTempDir } from "../helpers.mjs";

test("P6-RUNTIME-ROOT-001 requires a canonical current-UID 0700 directory", () => {
  const valid = {
    isDirectory: true,
    isSymbolicLink: false,
    uid: 1000,
    mode: 0o40700,
    canonicalPath: "/run/user/1000/cxc-1000",
    expectedPath: "/run/user/1000/cxc-1000",
    expectedUid: 1000
  };
  assert.equal(isPrivateDirectoryMetadata(valid), true);
  for (const patch of [
    { isDirectory: false },
    { isSymbolicLink: true },
    { uid: 1001 },
    { mode: undefined },
    { mode: 0o40750 },
    { mode: 0o40707 },
    { canonicalPath: "/private/run/user/1000/cxc-1000" }
  ]) {
    assert.equal(isPrivateDirectoryMetadata({ ...valid, ...patch }), false);
  }
});

test("P6-RUNTIME-ROOT-001A rejects writable non-sticky ancestors", () => {
  const directory = { isDirectory: true, isSymbolicLink: false };
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: 0o40755 }), true);
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: 0o41777 }), true);
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: 0o40777 }), false);
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: 0o40775 }), false);
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: undefined }), false);
  assert.equal(isSafeRuntimeAncestorMetadata({ ...directory, mode: 0o40755, isSymbolicLink: true }), false);
});

test("P6-RUNTIME-ROOT-002 creates and validates the private POSIX root", {
  skip: process.platform === "win32"
}, () => {
  const baseDir = makeTempDir();
  fs.chmodSync(baseDir, 0o700);
  const uid = process.getuid();
  const root = resolvePosixRuntimeRoot({ baseDir, uid });
  assert.equal(root, path.join(fs.realpathSync.native(baseDir), `cxc-${uid}`));
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  assert.equal(ensurePrivateDirectory(root, { uid }), root);

  const unsafeAncestor = makeTempDir();
  const nestedBase = path.join(unsafeAncestor, "private");
  fs.mkdirSync(nestedBase, { mode: 0o700 });
  fs.chmodSync(unsafeAncestor, 0o777);
  assert.throws(
    () => resolvePosixRuntimeRoot({ baseDir: nestedBase, uid }),
    /unsafe writable ancestor/i
  );

  fs.chmodSync(root, 0o755);
  assert.throws(() => ensurePrivateDirectory(root, { uid }), /private runtime directory/i);
});

test("P6-RUNTIME-ROOT-003 rejects relative runtime bases", () => {
  assert.throws(
    () => resolvePosixRuntimeRoot({ baseDir: path.join("relative", os.platform()), uid: 1000 }),
    /absolute/i
  );
});
