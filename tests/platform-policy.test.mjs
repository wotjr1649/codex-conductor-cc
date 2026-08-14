import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { SUPPORTED_RUNTIMES } from "../plugins/codex/scripts/lib/platform-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the supported runtime is Windows x64 on Node.js 24 or later", () => {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.ok(
    Number.parseInt(process.versions.node.split(".", 1)[0], 10) >= 24,
    `Unsupported Node.js runtime: ${process.version}`
  );
});

test("package metadata enforces the supported platform", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const npmConfig = fs.readFileSync(path.join(ROOT, ".npmrc"), "utf8");

  assert.equal(packageJson.engines.node, ">=24.0.0");
  // Derived from SUPPORTED_RUNTIMES rather than repeated. The runtime declares four tuples and
  // assertSupportedRuntime enforces them on every invocation, so package.json has to describe
  // the same set. Pinning win32/x64 here contradicted the very module this file tests, and it
  // made `npm ci` refuse to install with EBADPLATFORM on three of the four platforms the
  // portability workflow runs -- which is how the contradiction was finally noticed.
  assert.deepEqual(packageJson.os, [...new Set(SUPPORTED_RUNTIMES.map(([platform]) => platform))]);
  assert.deepEqual(packageJson.cpu, [...new Set(SUPPORTED_RUNTIMES.map(([, arch]) => arch))]);
  assert.match(npmConfig, /^engine-strict=true\s*$/);
});
