#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validatePortabilityRepository } from "./lib/portability-continuity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = validatePortabilityRepository(root, process.argv[2] ?? "HEAD");

if (errors.length > 0) {
  process.stderr.write(
    `Portability validation failed with ${errors.length} error(s):\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Portability validation passed: exact v0.1 ancestry, P5 continuity, and v0.2 scope are consistent.\n");
}
