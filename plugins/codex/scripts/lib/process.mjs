import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SAFE_CMD_ARGUMENT = /^[A-Za-z0-9_./:=+@-]+$/;
const CMD_META = /[\r\n"&|<>^%]/;

// cmd.exe expands a variable through an 8191-character buffer. A longer PATH still reaches the
// child's environment intact, but cmd.exe itself can no longer resolve any bare command name —
// and a bare command name is the entire body of the `.cmd` shim `npm install -g` writes for a
// Node CLI (`node "%~dp0entry" %*`). Measured on Windows 11 26200: 8191 resolves, 8192 does not.
// Without this, `/codex:setup` reports a working Codex install as missing.
const CMD_PATH_LIMIT = 8191;

// where.exe costs a process launch, and every git or codex call pays it. Cache per process,
// keyed by everything the lookup depends on: the command, the directory where.exe searches
// first, and the search variables. Successful lookups only — an absent binary can appear
// while the process runs, which is exactly what `/codex:setup` does when it installs Codex
// and rechecks, while a binary that resolved does not move.
const resolvedExecutables = new Map();

function whereCacheKey(command, options, env) {
  return [
    command,
    options.cwd ?? "",
    env.PATH ?? "",
    env.Path ?? "",
    env.PATHEXT ?? env.Pathext ?? ""
  ].join("\u0000");
}

function resolveWithWhere(command, options) {
  const env = options.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) return null;
  const cacheKey = whereCacheKey(command, options, env);
  const cached = resolvedExecutables.get(cacheKey);
  if (cached !== undefined) return cached;
  const whereExe = path.join(systemRoot, "System32", "where.exe");
  const result = spawnSync(whereExe, [command], {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0) return null;
  const resolved = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /\.(?:exe|com|cmd|bat)$/i.test(value) && fs.existsSync(value)) ?? null;
  if (resolved) resolvedExecutables.set(cacheKey, resolved);
  return resolved;
}

// Null when the environment already carries a PATH cmd.exe can use, so the healthy case is
// untouched. Otherwise a copy whose PATH fits: as much of the original as the cap allows, then
// the directory of the interpreter running this process, because the shim looks its interpreter
// up by bare name and this is that interpreter. Last, not first — room is reserved for it so it
// cannot be cut, and every original entry still outranks it, so it shadows nothing.
//
// ponytail: entries past the cap are dropped, so a `.cmd` that reads PATH as data, or a
// grandchild of one, sees the shortened value rather than the full one it gets today. That is
// unavoidable here — cmd.exe resolves no bare name at all while PATH is over the cap, so the
// real choice is a shortened PATH or a tool that cannot run. Revisit only if a caller needs the
// untruncated value downstream.
function shortenedShellEnv(env) {
  const current = String(env.PATH ?? env.Path ?? "");
  if (current.length <= CMD_PATH_LIMIT) return null;
  const interpreter = path.dirname(process.execPath);
  const head = current.slice(0, CMD_PATH_LIMIT - interpreter.length - 1);
  // Complete entries only, separators included. A truncated directory is not a directory, and an
  // empty entry is the current one, so neither may survive the cut.
  const kept = `${head.slice(0, head.lastIndexOf(";") + 1)}${interpreter}`;
  const shortened = { ...env };
  for (const name of Object.keys(shortened)) {
    if (name.toUpperCase() === "PATH") delete shortened[name];
  }
  shortened.PATH = kept;
  return shortened;
}

export function resolveCommandInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  if (options.shell) throw new Error("Shell command execution is disabled.");
  if (platform !== "win32") return { command, args, shell: false, windowsVerbatimArguments: false, env: null };

  const resolved = /[\\/]/.test(command) ? path.resolve(command) : resolveWithWhere(command, options);
  if (!resolved || !/\.(?:cmd|bat)$/i.test(resolved)) {
    return { command: resolved ?? command, args, shell: false, windowsVerbatimArguments: false, env: null };
  }
  if (CMD_META.test(resolved) || args.some((value) => !SAFE_CMD_ARGUMENT.test(String(value)))) {
    throw new Error("Unsafe Windows command invocation.");
  }
  const env = options.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const commandShell =
    env.ComSpec ??
    env.COMSPEC ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    (systemRoot ? path.join(systemRoot, "System32", "cmd.exe") : null);
  if (!commandShell) throw new Error("Windows command shell is unavailable.");
  const commandLine = `""${resolved}"${args.length ? ` ${args.join(" ")}` : ""}"`;
  return {
    command: commandShell,
    args: ["/d", "/s", "/c", commandLine],
    shell: false,
    windowsVerbatimArguments: true,
    env: shortenedShellEnv(env)
  };
}

export function runCommand(command, args = [], options = {}) {
  const invocation = resolveCommandInvocation(command, args, options);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: invocation.env ?? options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform !== "win32") {
    return { attempted: false, delivered: false, method: "unowned-posix-pid" };
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && (result.status === 128 || looksLikeMissingProcessMessage(combinedOutput))) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    try {
      killImpl(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "taskkill", result };
      }
    }

    throw new Error(formatCommandFailure(result));
  }

}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    timer.unref?.();
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

export async function terminateOwnedPosixProcess(child, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Owned POSIX termination is unavailable on ${platform}.`);
  }
  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.off !== "function" ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    child.pid === process.pid
  ) {
    throw new Error("A retained child process handle is required.");
  }
  if (childExited(child)) return { attempted: false, delivered: false, phase: "exited" };

  const gracefulMs = options.gracefulMs ?? 50;
  const termMs = options.termMs ?? 2000;
  const killMs = options.killMs ?? 1000;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  if (await waitForChildExit(child, gracefulMs)) {
    return { attempted: false, delivered: false, phase: "graceful" };
  }

  killImpl(-child.pid, "SIGTERM");
  if (await waitForChildExit(child, termMs)) {
    return { attempted: true, delivered: true, phase: "terminated" };
  }

  killImpl(-child.pid, "SIGKILL");
  if (!(await waitForChildExit(child, killMs))) {
    throw new Error("Owned POSIX process group did not exit after SIGKILL.");
  }
  return { attempted: true, delivered: true, phase: "killed" };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
