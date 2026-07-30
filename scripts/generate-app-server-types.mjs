#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { publishGeneratedAppServerTypes } from "./lib/generated-tree-transaction.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CONSUMER_RELATIVE =
  "plugins/codex/scripts/lib/app-server-protocol.d.ts";
const CONSUMER_IMPORTS = [
  "../../.generated/app-server-types/index.js",
  "../../.generated/app-server-types/v2/index.js"
];

function regularFile(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function fileSha256(candidate) {
  return createHash("sha256")
    .update(fs.readFileSync(candidate))
    .digest("hex");
}

function resolveCodexPackage(root) {
  const packageJsonPath = regularFile(path.join(root, "package.json"));
  if (!packageJsonPath) {
    return null;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
  const bin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.codex;
  if (packageJson.name !== "@openai/codex" || typeof bin !== "string") {
    return null;
  }
  const candidate = path.resolve(root, bin);
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return regularFile(candidate);
}

export function resolveCodexInvocation({
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath
} = {}) {
  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.normalize(entry));

  if (platform === "win32") {
    for (const entry of pathEntries) {
      const executable = regularFile(path.join(entry, "codex.exe"));
      if (executable) {
        return {
          command: executable,
          prefixArgs: [],
          identitySha256: fileSha256(executable)
        };
      }
    }

    for (const entry of pathEntries) {
      if (!regularFile(path.join(entry, "codex.cmd"))) {
        continue;
      }
      const packageRoots = [
        path.join(entry, "node_modules", "@openai", "codex"),
        path.join(entry, "..", "@openai", "codex")
      ];
      for (const packageRoot of packageRoots) {
        const script = resolveCodexPackage(packageRoot);
        if (script) {
          return {
            command: path.resolve(nodeExecutable),
            prefixArgs: [script],
            identitySha256: fileSha256(script)
          };
        }
      }
    }
  } else {
    for (const entry of pathEntries) {
      const executable = regularFile(path.join(entry, "codex"));
      if (
        executable &&
        (fs.statSync(executable).mode & fs.constants.X_OK) !== 0
      ) {
        return {
          command: executable,
          prefixArgs: [],
          identitySha256: fileSha256(executable)
        };
      }
    }
  }

  throw new Error(
    "Could not resolve a shell-free Codex CLI executable from PATH."
  );
}

export function buildChildEnvironment({
  source = process.env,
  invocation,
  homeDirectory = null
}) {
  const result = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL"
  ]) {
    if (typeof source[key] === "string" && source[key].length > 0) {
      result[key] = source[key];
    }
  }
  result.CI = "1";
  result.NO_COLOR = "1";
  result.DISABLE_AUTOUPDATER = "1";
  result.DISABLE_UPDATES = "1";
  result.PATH = [
    path.dirname(invocation.command),
    path.dirname(process.execPath)
  ].join(path.delimiter);

  if (homeDirectory) {
    result.HOME = homeDirectory;
    result.USERPROFILE = homeDirectory;
    result.CODEX_HOME = path.join(homeDirectory, "codex-home");
    result.APPDATA = path.join(homeDirectory, "appdata");
    result.LOCALAPPDATA = path.join(homeDirectory, "localappdata");
  }
  return result;
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.stdio,
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${options.label} failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${path.basename(command)}`
        )
      );
    });
  });
}

export async function runCodexGenerator(outputDirectory, options = {}) {
  const invocation = options.invocation ?? resolveCodexInvocation(options);
  if (
    !path.isAbsolute(invocation.command) ||
    /\.(?:cmd|bat)$/i.test(invocation.command)
  ) {
    throw new Error("Codex generator command must be an absolute non-shell executable.");
  }

  const args = [
    ...invocation.prefixArgs,
    "app-server",
    "generate-ts",
    "--out",
    outputDirectory
  ];
  const homeDirectory = path.join(
    outputDirectory,
    `.generator-home-${randomUUID()}`
  );
  await fsp.mkdir(homeDirectory);
  try {
    await fsp.mkdir(path.join(homeDirectory, "codex-home"));
    await fsp.mkdir(path.join(homeDirectory, "appdata"));
    await fsp.mkdir(path.join(homeDirectory, "localappdata"));
    await runChild(invocation.command, args, {
      cwd: options.repoRoot ?? REPO_ROOT,
      env: buildChildEnvironment({
        source: options.env ?? process.env,
        invocation,
        homeDirectory
      }),
      stdio: "inherit",
      label: "Codex schema generator"
    });
  } finally {
    const stats = await fsp.lstat(homeDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Generator home changed type; refusing cleanup.");
    }
    await fsp.rm(homeDirectory, { recursive: true, force: false });
  }
}

export async function validateGeneratedTypes(outputDirectory, options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const tscScript = regularFile(
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc")
  );
  if (!tscScript) {
    throw new Error("Could not resolve the repository TypeScript compiler.");
  }

  const consumerPath = regularFile(
    options.consumerPath ?? path.join(repoRoot, ...CONSUMER_RELATIVE.split("/"))
  );
  if (!consumerPath) {
    throw new Error("Could not resolve the app-server protocol consumer declaration.");
  }
  let consumerSource = await fsp.readFile(consumerPath, "utf8");
  for (const specifier of CONSUMER_IMPORTS) {
    const occurrences = consumerSource.split(`"${specifier}"`).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `App-server protocol consumer must contain exactly one ${specifier} import.`
      );
    }
    const stagedSpecifier = `./${path.basename(outputDirectory)}/${specifier
      .slice("../../.generated/app-server-types/".length)}`;
    consumerSource = consumerSource.replace(
      `"${specifier}"`,
      `"${stagedSpecifier}"`
    );
  }

  const validationId = randomUUID();
  const validationParent = path.dirname(outputDirectory);
  const configPath = path.join(
    validationParent,
    `.app-server-types.validation-${validationId}.json`
  );
  const stagedConsumerPath = path.join(
    validationParent,
    `.app-server-types.consumer-${validationId}.ts`
  );
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      strict: false,
      noImplicitAny: false,
      useUnknownInCatchVariables: false,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(repoRoot, "node_modules", "@types")]
    },
    include: [
      `${outputDirectory.split(path.sep).join("/")}/**/*.ts`,
      stagedConsumerPath.split(path.sep).join("/")
    ]
  };

  try {
    await fsp.writeFile(stagedConsumerPath, consumerSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const invocation = {
      command: path.resolve(process.execPath),
      prefixArgs: [tscScript]
    };
    await runChild(invocation.command, [...invocation.prefixArgs, "-p", configPath], {
      cwd: repoRoot,
      env: buildChildEnvironment({
        source: options.env ?? process.env,
        invocation
      }),
      stdio: "inherit",
      label: "Generated schema TypeScript validation"
    });
  } finally {
    for (const [candidate, label] of [
      [configPath, "Validation config"],
      [stagedConsumerPath, "Staged consumer declaration"]
    ]) {
      let stats;
      try {
        stats = await fsp.lstat(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} changed type; refusing cleanup.`);
      }
      await fsp.unlink(candidate);
    }
  }
}

export async function generateAppServerTypes({
  repoRoot = REPO_ROOT,
  invocation
} = {}) {
  return publishGeneratedAppServerTypes({
    repoRoot,
    generate: (outputDirectory) =>
      runCodexGenerator(outputDirectory, { repoRoot, invocation }),
    validate: (outputDirectory) =>
      validateGeneratedTypes(outputDirectory, { repoRoot })
  });
}

async function main() {
  const result = await generateAppServerTypes();
  console.log(`Generated app-server TypeScript schema (${result.digest}).`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
