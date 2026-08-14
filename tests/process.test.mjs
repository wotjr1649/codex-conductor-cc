import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveCommandInvocation, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

test(
  "executable lookup caches what it resolved and nothing it failed to find",
  { skip: process.platform !== "win32" ? "the executable lookup is Windows-only" : false },
  () => {
    const binDir = makeTempDir();
    const command = "codex-conductor-lookup-probe";
    const probe = path.join(binDir, `${command}.exe`);
    const env = { ...process.env, PATH: `${binDir};${process.env.PATH}` };

    // A missing binary must stay missing in the cache: `/codex:setup` installs Codex and
    // rechecks availability inside one process.
    assert.equal(resolveCommandInvocation(command, [], { env }).command, command);

    fs.writeFileSync(probe, "");
    assert.equal(resolveCommandInvocation(command, [], { env }).command, probe);

    // A resolved binary is cached for the life of the process, so it does not move here.
    fs.rmSync(probe);
    assert.equal(resolveCommandInvocation(command, [], { env }).command, probe);
  }
);

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree recognizes taskkill's locale-independent missing-process exit code", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "오류: 프로세스를 찾을 수 없습니다.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
});
