import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMethodInventory } from "../../scripts/lib/p4-snapshot.mjs";
import { binaryAvailable, runCommand } from "../../plugins/codex/scripts/lib/process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = path.join(
  repoRoot,
  "contracts",
  "codex",
  "snapshots",
  "snapshot-manifest.json"
);

const INVENTORY_KEYS = ["clientRequests", "serverRequests", "serverNotifications"];

function pinnedCurrentStableSurface() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const lane = manifest.versions.find((entry) => entry.lane === "current");
  const surface = lane.surfaces.find(
    (entry) => entry.mode === "stable" && entry.format === "json-schema"
  );
  return { version: lane.version, methods: surface.methods };
}

// The installed Codex reads `$CODEX_HOME/config.toml`, whose `[features]` section can gate
// which methods a surface reports. Point it at an empty directory so the comparison measures
// the release rather than this machine's configuration. `generate-p4-contracts.mjs` achieves
// the same thing by scrubbing the environment down to four variables; that route also drops
// PATH, which it can afford because it is handed an absolute executable and this test is not.
function isolatedEnv(codexHome) {
  return { ...process.env, CODEX_HOME: codexHome };
}

test("installed app-server still offers every method the pinned contract promises", async (t) => {
  if (!binaryAvailable("codex", ["--version"], { cwd: repoRoot }).available) {
    t.skip("codex is not installed on this host");
    return;
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-drift-"));
  const codexHome = path.join(workRoot, "codex-home");
  const surfaceRoot = path.join(workRoot, "stable-json-schema");
  fs.mkdirSync(codexHome);

  try {
    const env = isolatedEnv(codexHome);
    const version = runCommand("codex", ["--version"], { cwd: repoRoot, env }).stdout.trim();
    const generated = runCommand(
      "codex",
      ["app-server", "generate-json-schema", "--out", surfaceRoot],
      { cwd: repoRoot, env }
    );
    assert.equal(
      generated.status,
      0,
      `codex app-server generate-json-schema failed: ${generated.stderr.trim()}`
    );

    const pinned = pinnedCurrentStableSurface();
    const live = await readMethodInventory(surfaceRoot);
    t.diagnostic(`installed ${version} | pinned contract ${pinned.version}`);

    const removed = [];
    const added = [];
    for (const key of INVENTORY_KEYS) {
      for (const method of pinned.methods[key]) {
        if (!live[key].includes(method)) removed.push(`${key}/${method}`);
      }
      for (const method of live[key]) {
        if (!pinned.methods[key].includes(method)) added.push(`${key}/${method}`);
      }
    }

    // Additions cannot break a client that does not call them, so they are reported rather
    // than failed. Removals and renames are the shape that breaks one, and a rename shows up
    // here as a removal plus an addition.
    t.diagnostic(
      added.length
        ? `added since ${pinned.version}: ${added.join(", ")}`
        : `no methods added since ${pinned.version}`
    );
    assert.deepEqual(
      removed,
      [],
      `the installed app-server no longer offers methods pinned at ${pinned.version}; ` +
        "re-snapshot the contract or pin an older Codex before shipping against it"
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
