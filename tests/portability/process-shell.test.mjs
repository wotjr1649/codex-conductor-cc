import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../plugins/codex/scripts/lib/process.mjs";
import { makeTempDir } from "../helpers.mjs";

test("P6-PROCESS-SHELL-001 does not reinterpret arguments through a shell", () => {
  const marker = "safe & echo not-invoked";
  const result = runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, marker);
});

// `npm install -g` publishes a Node CLI on Windows as a `.cmd` shim, and the shim's whole body is
// a bare-name `node` lookup. Measured on Windows 11 26200: cmd.exe resolves bare names with a
// PATH of 8191 characters and resolves none at 8192, while passing the full value through to its
// children untouched. So a shim reached through cmd.exe reports a working install as missing on
// any host with a long PATH, which is what `/codex:setup` tells users to create.
test(
  "P6-PROCESS-SHELL-002 runs a .cmd shim under a PATH longer than cmd.exe can resolve",
  { skip: process.platform !== "win32" ? "cmd.exe shims are Windows-only" : false },
  () => {
    const binDir = makeTempDir("codex-long-path-");
    fs.writeFileSync(path.join(binDir, "probe.js"), 'process.stdout.write("probe-ran");\n');
    fs.writeFileSync(path.join(binDir, "probe.cmd"), '@echo off\r\nnode "%~dp0probe.js" %*\r\n');

    // Exactly one character past what cmd.exe can carry, so an off-by-one in the cap shows up
    // here. Everything the shim needs is present and reachable; only the length is hostile —
    // and the interpreter sits at the far end, where a cap that merely truncates would lose it.
    const tail = `;${path.dirname(process.execPath)}`;
    const absent = ";C:\\codex-conductor-absent".padEnd(96, "x");
    const budget = 8192 - binDir.length - tail.length;
    const filled = absent.repeat(Math.floor(budget / absent.length));
    const longPath = `${binDir}${filled}${"x".repeat(budget - filled.length)}${tail}`;
    assert.equal(longPath.length, 8192);

    const result = runCommand("probe", [], { env: { ...process.env, PATH: longPath } });

    assert.equal(result.status, 0, `${result.stderr}${result.error?.message ?? ""}`);
    assert.equal(result.stdout, "probe-ran");
  }
);
