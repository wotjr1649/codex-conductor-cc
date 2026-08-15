import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const createdTempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.add(directory);
  return directory;
}

export function listCreatedTempDirs() {
  return [...createdTempDirs];
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs,
    // No shell. Every command passed here is node or git, both of which spawn resolves from
    // PATH on its own. A shell re-parses the argument array — three call sites already opt out
    // for that reason — and on Windows it makes the whole suite depend on cmd.exe.
    shell: options.shell ?? false,
    windowsHide: true
  });
}

// Every ambient variable `plugins/codex/scripts` reads that changes what the product does. A test
// that compares output exactly has to own these rather than inherit them: the first version of
// the characterization harness inherited them, passed from a shell with none set, and failed from
// a shell inside a Claude Code session because CODEX_COMPANION_SESSION_ID makes `cancel` answer
// "for this session". PATH, PATHEXT, SystemRoot and ComSpec are deliberately absent — the child
// cannot start without them. This list is a contract with the runtime; keep it in step with what
// `grep -r 'process\.env' plugins/codex/scripts` reports.
export const AMBIENT_RUNTIME_INPUTS = [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE"
];

export function pinnedRuntimeEnv(baseEnv, { pluginData, codexHome, sessionId } = {}) {
  const env = { ...baseEnv };
  for (const name of AMBIENT_RUNTIME_INPUTS) {
    delete env[name];
  }
  if (pluginData) {
    env.CLAUDE_PLUGIN_DATA = pluginData;
  }
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  }
  if (sessionId) {
    env.CODEX_COMPANION_SESSION_ID = sessionId;
  }
  return env;
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
