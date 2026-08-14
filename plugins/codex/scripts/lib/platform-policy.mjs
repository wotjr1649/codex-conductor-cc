import process from "node:process";

export const SUPPORTED_RUNTIMES = Object.freeze([
  Object.freeze(["win32", "x64"]),
  Object.freeze(["linux", "x64"]),
  Object.freeze(["darwin", "x64"]),
  Object.freeze(["darwin", "arm64"])
]);

const SUPPORTED_KEYS = new Set(SUPPORTED_RUNTIMES.map(([platform, arch]) => `${platform}/${arch}`));

export function isSupportedRuntime({
  platform = process.platform,
  arch = process.arch,
  nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10)
} = {}) {
  return Number.isInteger(nodeMajor) && nodeMajor >= 24 && SUPPORTED_KEYS.has(`${platform}/${arch}`);
}

// POSIX gives every background worker an authenticated control socket; Windows has no equivalent
// and stops workers by process tree instead. Six call sites branch on that one capability, so it
// gets a name. The other platform branches in this runtime are deliberately left alone: they test
// the same variable but decide different things — process ownership, state layout, which
// environment variables may be trusted — and reading them as one switch is how the broker nearly
// lost the detached spawn it needs.
export function supportsWorkerControl(platform = process.platform) {
  return platform === "linux" || platform === "darwin";
}

export function assertSupportedRuntime(runtime) {
  const observed = runtime ?? {};
  const platform = observed.platform ?? process.platform;
  const arch = observed.arch ?? process.arch;
  const nodeMajor = observed.nodeMajor ?? Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!isSupportedRuntime({ platform, arch, nodeMajor })) {
    throw new Error(`Unsupported runtime: ${platform}/${arch} on Node ${nodeMajor}`);
  }
}
