import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs, diagnostic) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(diagnostic);
}

test("P5-PROCESS-TREE-001 taskkill releases the exact child and retained file handle", async (t) => {
  assert.equal(process.platform, "win32", "P5E_WINDOWS_ONLY");

  const runRoot = mkdtempSync(path.join(os.tmpdir(), "codex-p5-resource-"));
  const heldPath = path.join(runRoot, "held.txt");
  const readyPath = path.join(runRoot, "ready.txt");
  const openReadyPath = path.join(runRoot, "open-ready.txt");
  const marker = `p5-resource-${process.pid}-${Date.now()}`;
  writeFileSync(heldPath, marker, "utf8");
  const psQuote = (value) => value.replaceAll("'", "''");
  const childCommand = [
    `$h=[IO.File]::Open('${psQuote(heldPath)}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)`,
    `[IO.File]::WriteAllText('${psQuote(openReadyPath)}',[string]$PID)`,
    "try { Start-Sleep -Seconds 300 } finally { $h.Dispose() }"
  ].join(";");
  const encodedCommand = Buffer.from(childCommand, "utf16le").toString("base64");
  const rootScript = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const [encoded,ready]=process.argv.slice(1);",
    "const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{stdio:'ignore'});",
    "fs.writeFileSync(ready,String(child.pid));",
    "setInterval(()=>{},1000);"
  ].join("");
  const root = spawn(process.execPath, [
    "-e",
    rootScript,
    encodedCommand,
    readyPath,
    marker
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  root.unref();

  let childPid = null;
  t.after(() => {
    if (processExists(root.pid)) {
      terminateProcessTree(root.pid);
    }
    rmSync(runRoot, { recursive: true, force: true });
  });

  await waitFor(
    () => {
      try {
        childPid = Number(readFileSync(readyPath, "utf8"));
        return (
          Number.isInteger(childPid) &&
          childPid > 0 &&
          readFileSync(openReadyPath, "utf8") === String(childPid)
        );
      } catch {
        return false;
      }
    },
    4000,
    "P5E_RESOURCE_CHILD_NOT_READY"
  );
  assert.equal(processExists(root.pid), true, "P5E_ROOT_NOT_RUNNING");
  assert.equal(processExists(childPid), true, "P5E_CHILD_NOT_RUNNING");

  const movedWhileOpen = path.join(runRoot, "moved-while-open.txt");
  assert.throws(
    () => renameSync(heldPath, movedWhileOpen),
    /EPERM|EBUSY|EACCES/,
    "P5E_OPEN_HANDLE_PROBE"
  );

  const outcome = terminateProcessTree(root.pid);
  assert.deepEqual(
    {
      attempted: outcome.attempted,
      delivered: outcome.delivered,
      method: outcome.method
    },
    { attempted: true, delivered: true, method: "taskkill" }
  );

  await waitFor(
    () => !processExists(root.pid) && !processExists(childPid),
    4000,
    "P5E_OWNED_PROCESS_ORPHAN"
  );

  const releasedPath = path.join(runRoot, "released.txt");
  renameSync(heldPath, releasedPath);
  rmSync(releasedPath);
  assert.equal(processExists(root.pid), false, "P5E_ROOT_RESIDUAL");
  assert.equal(processExists(childPid), false, "P5E_CHILD_RESIDUAL");
});
