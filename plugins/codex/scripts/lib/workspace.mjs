import { ensureGitRepository } from "./git.mjs";

// Resolving a workspace root spawns git, and the state layer resolves it for every path it
// hands out, so a single command paid for dozens of process launches. Cache per requested
// cwd, per process: a repository boundary does not move under a running process, every
// companion invocation is short-lived, and the one long-lived process — the broker — serves
// a single fixed cwd and never calls this.
const workspaceRoots = new Map();

export function resolveWorkspaceRoot(cwd) {
  const cached = workspaceRoots.get(cwd);
  if (cached !== undefined) {
    return cached;
  }

  let workspaceRoot;
  try {
    workspaceRoot = ensureGitRepository(cwd);
  } catch {
    workspaceRoot = cwd;
  }
  workspaceRoots.set(cwd, workspaceRoot);
  return workspaceRoot;
}
