#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "ci/portability-profiles-v1.json"), "utf8"));
const profile = registry.profiles.find((item) => item.id === process.env.PORTABILITY_PROFILE);
if (
  !profile ||
  profile.platform !== process.env.EXPECTED_PLATFORM ||
  profile.architecture !== process.env.EXPECTED_ARCHITECTURE ||
  profile.runner !== process.env.EXPECTED_RUNNER ||
  process.platform !== profile.platform ||
  process.arch !== profile.architecture ||
  process.versions.node !== registry.nodeVersion
) {
  throw new Error("Portability runner identity did not match its reviewed profile.");
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "portability-runner-evidence-v1",
  profileId: profile.id,
  runner: profile.runner,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.versions.node,
  sourceCommit: process.env.GITHUB_SHA ?? null
})}\n`);
