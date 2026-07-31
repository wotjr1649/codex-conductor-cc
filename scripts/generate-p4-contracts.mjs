#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertSnapshotHost,
  inspectSnapshotTree,
  readMethodInventory,
  sha256
} from "./lib/p4-snapshot.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsPath = path.join(repoRoot, "contracts", "codex", "contract-tools-v1.json");

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: node scripts/generate-p4-contracts.mjs --codex-current <exe> --codex-previous <exe> --out <fresh-root>"
      );
    }
    options[key.slice(2)] = value;
  }
  for (const required of ["codex-current", "codex-previous", "out"]) {
    if (!options[required]) {
      throw new Error(`P4E_ARGUMENT: missing --${required}`);
    }
  }
  return options;
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    }
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `P4E_GENERATOR_EXIT: ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`
    );
  }
  return result.stdout.trim();
}

function ordinalCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortJsonObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonObjectKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort(ordinalCompare)
      .map((key) => [key, sortJsonObjectKeys(value[key])])
  );
}

async function canonicalizeAggregateBundle(output) {
  const bundlePath = path.join(output, "codex_app_server_protocol.v2.schemas.json");
  const document = JSON.parse(await readFile(bundlePath, "utf8"));
  await writeFile(
    bundlePath,
    `${JSON.stringify(sortJsonObjectKeys(document), null, 2)}\n`,
    "utf8"
  );
}

async function verifyExecutable(executable, artifact) {
  const bytes = await readFile(executable);
  const digest = sha256(bytes);
  if (digest !== artifact.executableSha256) {
    throw new Error(`P4E_CODEX_DIGEST: ${artifact.version} executable digest mismatch`);
  }
  const version = run(executable, ["--version"]);
  if (version !== `codex-cli ${artifact.version}`) {
    throw new Error(`P4E_CODEX_VERSION: expected ${artifact.version}, observed ${version}`);
  }
}

async function generateSurface(executable, versionRoot, mode, format) {
  const output = path.join(versionRoot, mode, format);
  await mkdir(output, { recursive: false });
  const subcommand = format === "typescript" ? "generate-ts" : "generate-json-schema";
  const args = ["app-server", subcommand, "--out", output];
  if (mode === "experimental") {
    args.push("--experimental");
  }
  run(executable, args);
  if (format === "json-schema") {
    await canonicalizeAggregateBundle(output);
  }
  const inspection = await inspectSnapshotTree(output);
  return {
    mode,
    format,
    ...inspection,
    methods: format === "json-schema"
      ? await readMethodInventory(output)
      : undefined
  };
}

assertSnapshotHost();
const options = parseArguments(process.argv.slice(2));
const outputRoot = path.resolve(options.out);
await mkdir(outputRoot, { recursive: false });

const toolsBytes = await readFile(toolsPath);
const tools = JSON.parse(toolsBytes.toString("utf8"));
const artifacts = new Map(tools.artifacts.map((artifact) => [artifact.id, artifact]));
const laneExecutables = {
  current: path.resolve(options["codex-current"]),
  previous: path.resolve(options["codex-previous"])
};

const versions = [];
for (const lane of ["current", "previous"]) {
  const laneRecord = tools.lanes[lane];
  const artifact = artifacts.get(laneRecord.artifactId);
  if (!artifact || artifact.version !== laneRecord.version) {
    throw new Error(`P4E_LANE_ARTIFACT: invalid ${lane} lane mapping`);
  }
  await verifyExecutable(laneExecutables[lane], artifact);
  const versionRoot = path.join(outputRoot, artifact.version);
  await mkdir(versionRoot, { recursive: false });
  const surfaces = [];
  for (const mode of ["stable", "experimental"]) {
    await mkdir(path.join(versionRoot, mode), { recursive: false });
    for (const format of ["typescript", "json-schema"]) {
      surfaces.push(
        await generateSurface(laneExecutables[lane], versionRoot, mode, format)
      );
    }
  }
  versions.push({
    lane,
    version: artifact.version,
    executableSha256: artifact.executableSha256,
    surfaces
  });
}

const combined = await inspectSnapshotTree(outputRoot);
const manifest = {
  schemaVersion: "p4-codex-snapshot-manifest-v1",
  sourceDate: "2026-07-31",
  platform: {
    os: "windows",
    architecture: "x64",
    node: process.versions.node
  },
  toolsManifestSha256: sha256(toolsBytes),
  digestAlgorithm: {
    ordering: "UTF-8 ordinal",
    separator: "/",
    record: "<relative-path> NUL <raw-file-bytes> NUL",
    excluded: ["snapshot-manifest.json"],
    hostMetadataIncluded: false
  },
  normalization: {
    path: "**/json-schema/codex_app_server_protocol.v2.schemas.json",
    operation: "recursively sort JSON object keys by UTF-8 ordinal; preserve arrays and scalar values",
    reason: "the upstream aggregate bundle uses nondeterministic map iteration while its per-definition files remain byte-identical"
  },
  versions,
  combined: {
    fileCount: combined.fileCount,
    totalBytes: combined.totalBytes,
    treeSha256: combined.treeSha256
  }
};

await writeFile(
  path.join(outputRoot, "snapshot-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

const manifestDigest = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({
    snapshotRoot: outputRoot,
    treeSha256: combined.treeSha256,
    manifestDigest
  })}\n`
);
