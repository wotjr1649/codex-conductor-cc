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

export function assertSupportedRuntime(runtime) {
  const observed = runtime ?? {};
  const platform = observed.platform ?? process.platform;
  const arch = observed.arch ?? process.arch;
  const nodeMajor = observed.nodeMajor ?? Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!isSupportedRuntime({ platform, arch, nodeMajor })) {
    throw new Error(`Unsupported runtime: ${platform}/${arch} on Node ${nodeMajor}`);
  }
}
