import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../../plugins/codex/scripts/lib/process.mjs";

test("P6-PROCESS-SHELL-001 does not reinterpret arguments through a shell", () => {
  const marker = "safe & echo not-invoked";
  const result = runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, marker);
});
