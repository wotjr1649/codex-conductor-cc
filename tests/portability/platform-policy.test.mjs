import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_RUNTIMES,
  assertSupportedRuntime,
  isSupportedRuntime
} from "../../plugins/codex/scripts/lib/platform-policy.mjs";

const supported = [
  ["win32", "x64"],
  ["linux", "x64"],
  ["darwin", "x64"],
  ["darwin", "arm64"]
];

test("P6-PLATFORM-001 accepts only the four released runtime tuples on Node 24+", () => {
  assert.deepEqual(SUPPORTED_RUNTIMES, supported);
  for (const [platform, arch] of supported) {
    assert.equal(isSupportedRuntime({ platform, arch, nodeMajor: 24 }), true);
    assert.doesNotThrow(() => assertSupportedRuntime({ platform, arch, nodeMajor: 25 }));
  }
  for (const [platform, arch, nodeMajor] of [
    ["win32", "arm64", 24],
    ["linux", "arm64", 24],
    ["darwin", "ia32", 24],
    ["freebsd", "x64", 24],
    ["linux", "x64", 23]
  ]) {
    assert.equal(isSupportedRuntime({ platform, arch, nodeMajor }), false);
    assert.throws(
      () => assertSupportedRuntime({ platform, arch, nodeMajor }),
      /Unsupported runtime:/
    );
  }
});
