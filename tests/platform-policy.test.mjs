import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_RUNTIMES,
  isSupportedRuntime
} from "../plugins/codex/scripts/lib/platform-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the running host is one of the supported runtimes", () => {
  // Asks the module the question it exists to answer, rather than restating one of its four
  // tuples. Pinning win32/x64 here made this file fail on the three platforms `npm ci` was just
  // taught to install on -- and CI hid it, because the POSIX leg names its files individually
  // and this one was not among them.
  assert.equal(
    isSupportedRuntime(),
    true,
    `${process.platform}/${process.arch} on ${process.version}`
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

  // npm evaluates os and cpu independently, so this manifest admits the cross product and not
  // the tuple set: win32/arm64 and linux/arm64 install even though SUPPORTED_RUNTIMES omits
  // them. assertSupportedRuntime refuses them at the first command, which is where the real
  // boundary is. Narrowing either list to close the gap would refuse darwin/arm64, which is
  // supported, so the manifest cannot express this and the difference is recorded instead.
  const admittedByManifest = packageJson.os.flatMap((platform) =>
    packageJson.cpu.map((arch) => `${platform}/${arch}`)
  );
  const declaredTuples = SUPPORTED_RUNTIMES.map(([platform, arch]) => `${platform}/${arch}`);
  assert.deepEqual(
    admittedByManifest.filter((tuple) => !declaredTuples.includes(tuple)).sort(),
    ["linux/arm64", "win32/arm64"]
  );
  assert.match(npmConfig, /^engine-strict=true\s*$/);
});
