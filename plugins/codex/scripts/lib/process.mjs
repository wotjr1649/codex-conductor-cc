import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
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
