import { ensureGitRepository } from "./git.mjs";

// Resolving a workspace root spawns git, and the state layer resolves it for every path it
// hands out, so a single command paid for dozens of process launches. Cache per requested
// cwd, per process: a repository boundary does not move under a running process, every
// companion invocation is short-lived, and the one long-lived process — the broker — serves
// a single fixed cwd and never calls this.
const workspaceRoots = new Map();
// A resolution that failed is remembered only briefly. ensureGitRepository throws on any non-zero
// git status -- an index.lock, dubious ownership, git momentarily unavailable -- not only on a
// genuine non-repository, and a spawn failure that is not ENOENT reaches it as an empty answer
// rather than a throw. Pinning either for the life of the process would send every later state
// path somewhere a sibling process never looks, so a job enqueued here would land in an index its
// own worker never reads. Forgetting it entirely costs a git spawn per resolved path, which is
// what this cache exists to avoid, so it is held just long enough to cover one command.
const FAILED_RESOLUTION_TTL_MS = 250;
const failedResolutions = new Map();

export function resolveWorkspaceRoot(cwd) {
  const cached = workspaceRoots.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const failedAt = failedResolutions.get(cwd);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_RESOLUTION_TTL_MS) {
    return cwd;
  }

  let workspaceRoot;
  try {
    workspaceRoot = ensureGitRepository(cwd);
  } catch {
    failedResolutions.set(cwd, Date.now());
    return cwd;
  }
  if (!workspaceRoot) {
    failedResolutions.set(cwd, Date.now());
    return cwd;
  }
  failedResolutions.delete(cwd);
  workspaceRoots.set(cwd, workspaceRoot);
  return workspaceRoot;
}
