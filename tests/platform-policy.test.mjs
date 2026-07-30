import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

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
  assert.deepEqual(packageJson.os, ["win32"]);
  assert.deepEqual(packageJson.cpu, ["x64"]);
  assert.match(npmConfig, /^engine-strict=true\s*$/);
});
