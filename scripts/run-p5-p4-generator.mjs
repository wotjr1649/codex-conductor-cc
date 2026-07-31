#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: node scripts/run-p5-p4-generator.mjs --repo <detached-p4-root> --codex <exact-exe>"
      );
    }
    result[key.slice(2)] = value;
  }
  if (!result.repo || !result.codex) {
    throw new Error("P5E_P4_GENERATOR_INPUT: exact repository and Codex paths are required");
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
const repoRoot = path.resolve(options.repo);
const codexPath = path.resolve(options.codex);
const generatorPath = path.join(repoRoot, "scripts", "generate-app-server-types.mjs");
if (
  !fs.statSync(repoRoot).isDirectory() ||
  !fs.statSync(codexPath).isFile() ||
  !fs.statSync(generatorPath).isFile()
) {
  throw new Error("P5E_P4_GENERATOR_PATH: exact detached inputs are unavailable");
}

const outputDirectory = path.join(
  repoRoot,
  "plugins",
  "codex",
  ".generated",
  "app-server-types"
);
fs.mkdirSync(outputDirectory, { recursive: true });
const { runCodexGenerator } = await import(pathToFileURL(generatorPath).href);
await runCodexGenerator(outputDirectory, {
  repoRoot,
  invocation: {
    command: codexPath,
    prefixArgs: []
  }
});
