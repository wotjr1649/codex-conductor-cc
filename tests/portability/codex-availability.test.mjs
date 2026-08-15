import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { listCreatedTempDirs, makeTempDir, run } from "../helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

after(() => {
  for (const directory of listCreatedTempDirs()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// `getCodexAvailability` computes why the probe failed and five callers threw a generic "not
// installed" instead. On a Windows host whose PATH is too long for cmd.exe to resolve, that reads
// as a missing install when Codex is installed and working, with nothing pointing at the cause.
// An empty PATH is the cheap way to make the probe fail with a reason on every platform.
//
// `--background` deliberately: on that branch `ensureCodexAvailable` is the first statement
// (codex-companion.mjs), so this never reaches the state tree. The foreground branch builds a job
// and opens a log first, and on POSIX that resolves through a private uid-scoped runtime root a
// CI temp directory does not satisfy.
test("P6-CODEX-AVAILABILITY-001 reports why the availability probe failed, not only that it did", () => {
  const workspace = makeTempDir("codex-availability-workspace-");
  const emptyBin = makeTempDir("codex-availability-nobin-");

  const result = run(process.execPath, [SCRIPT, "task", "--background", "no-op"], {
    cwd: workspace,
    env: { ...process.env, PATH: emptyBin }
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /Codex CLI is not installed/);
  assert.match(output, /is missing required runtime support \(not found\)/);
});
