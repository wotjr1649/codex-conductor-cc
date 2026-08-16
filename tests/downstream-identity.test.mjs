import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_BASE = "9be83f26780429cd693bef62a20eebc70f54cec1";
const UPSTREAM_BASE = "db52e28f4d9ded852ab3942cea316258ae4ef346";
const DOWNSTREAM_MAINTAINER = {
  name: "wotjr1649",
  url: "https://github.com/wotjr1649"
};

const PROTECTED_TREES = {
  "plugins/codex/commands": "1e361db52c52f5043ae4c8a547d1a32fb9b0d232",
  "plugins/codex/agents": "273b8a3c016fed976081d1fd8c8750167ce0f689",
  "plugins/codex/skills": "e0ffe136304fed92507315ef66c401553b84d5c0",
  "plugins/codex/hooks": "39821e61e8b99bf415b7b05098b97d545fd377af"
};

const PROTECTED_BLOBS = new Map([
  // Updated in v0.3: the rescue contract gained the flag-ordering rule, without which a
  // write-capable rescue ran read-only and reported success. See tests/args.test.mjs.
  // Updated again for the 2026-08-31 cutoff: the sample slug named `gpt-5.4-mini`, which stops
  // working in Codex that day for anyone signed in with ChatGPT. It names `gpt-5.6-luna` now.
  ["plugins/codex/agents/codex-rescue.md", "c0c00a66750cf7a4a964c6d9ebf55e8f7e36dc9d"],
  ["plugins/codex/commands/adversarial-review.md", "da440ab4d397e3eee6b11ae5eac2ff92ef82e04e"],
  ["plugins/codex/commands/cancel.md", "a1472b836ad00084f1e56f8e8ebc0466cc59fac6"],
  // Updated for the effort vocabulary: the argument hint stopped at `xhigh` while the models
  // advertise `max` and `ultra`, so it told users a level was unavailable that their model takes.
  ["plugins/codex/commands/rescue.md", "2d610e7bee86f3e7b554a286973b68e1140ca105"],
  ["plugins/codex/commands/result.md", "3abc2d9312033a68979b6cccd33015f466e6380e"],
  ["plugins/codex/commands/review.md", "fb70a487654cde1a9aa9fa056b27d21344043cc4"],
  ["plugins/codex/commands/setup.md", "fb33a150ad3b7de403136a5b4bfa1156cda41795"],
  ["plugins/codex/commands/status.md", "8f70663d1a99ed871befa6120f4219971ba52469"],
  ["plugins/codex/commands/transfer.md", "42170e51d35ed6d2679418d0d7459c0c759b9e68"],
  ["plugins/codex/hooks/hooks.json", "19e33b818d143aa7bdb666ffc00f93de8f275eab"],
  // Same effort-vocabulary update: the runtime skill documented the accepted values and stopped
  // at `xhigh` too.
  ["plugins/codex/skills/codex-cli-runtime/SKILL.md", "a01bf3882463b2c12c617249b7b8fada0f55c581"],
  ["plugins/codex/skills/codex-result-handling/SKILL.md", "e1896548000387055a583e342467c9575b00bdaa"],
  ["plugins/codex/skills/gpt-5-4-prompting/SKILL.md", "16669d92d0116d8eaf705d58c58845cfa0bdccb1"],
  [
    "plugins/codex/skills/gpt-5-4-prompting/references/codex-prompt-antipatterns.md",
    "10a44d6b8cc4e33292b00d8a47a40ffedd79c8bd"
  ],
  [
    "plugins/codex/skills/gpt-5-4-prompting/references/codex-prompt-recipes.md",
    "7711de201d3e99fd967c89393538f4d41d7cd714"
  ],
  [
    "plugins/codex/skills/gpt-5-4-prompting/references/prompt-blocks.md",
    "cbf66940007c2eeefbc7d073867c85d77ed3a6ab"
  ]
]);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function git(args) {
  const result = run("git", args, { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function listFiles(relativeDirectory) {
  const files = [];

  function visit(relativePath) {
    for (const entry of fs.readdirSync(path.join(ROOT, relativePath), { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        files.push(child.replaceAll("\\", "/"));
      }
    }
  }

  visit(relativeDirectory);
  return files;
}

test("downstream manifests expose the fixed P2 identity", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const marketplacePlugin = marketplace.plugins.find((entry) => entry.name === "codex");
  const plugin = readJson("plugins/codex/.claude-plugin/plugin.json");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.equal(packageJson.name, "codex-conductor-cc");
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.packages[""].name, packageJson.name);

  // These six are exactly what scripts/bump-version.mjs updates in one pass, so the identity
  // P2 was protecting is that they never disagree -- not that they hold one literal. Pinning
  // the literal froze the release itself: every one of these went stale the moment v0.2
  // shipped, and the suite that would have said so had already lost its trigger.
  const version = plugin.version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(packageJson.version, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""].version, version);
  assert.equal(marketplace.metadata.version, version);
  assert.equal(marketplacePlugin.version, version);

  assert.equal(marketplace.name, "codex-conductor");
  assert.equal(marketplacePlugin.name, "codex");
  assert.equal(plugin.name, "codex");
  assert.deepEqual(marketplace.owner, DOWNSTREAM_MAINTAINER);
  assert.deepEqual(marketplacePlugin.author, DOWNSTREAM_MAINTAINER);
  assert.deepEqual(plugin.author, DOWNSTREAM_MAINTAINER);

  for (const description of [
    packageJson.description,
    marketplace.metadata.description,
    marketplacePlugin.description,
    plugin.description
  ]) {
    assert.match(description, /Codex Conductor/);
  }

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "Apache-2.0");
  assert.deepEqual(packageJson.engines, { node: ">=24.0.0" });
  // The four tuples ci/portability-profiles-v1.json declares runtime-supported, which the
  // workflow runs and the worker-control subsystem exists for. Declaring win32 alone made
  // `npm ci` refuse to install on the other three with EBADPLATFORM, so the portability legs
  // could not install what they were testing.
  assert.deepEqual(packageJson.os, ["win32", "linux", "darwin"]);
  assert.deepEqual(packageJson.cpu, ["x64", "arm64"]);
  assert.equal(packageLock.packages[""].license, packageJson.license);
  assert.deepEqual(packageLock.packages[""].engines, packageJson.engines);
  assert.deepEqual(packageLock.packages[""].os, packageJson.os);
  assert.deepEqual(packageLock.packages[""].cpu, packageJson.cpu);

  assert.match(readme, /unofficial downstream fork of `openai\/codex-plugin-cc`/i);
  assert.match(readme, /not affiliated with or endorsed by OpenAI or Anthropic/i);
  assert.match(readme, /Apache License 2\.0/i);
  assert.match(readme, /do not enable.*official.*at the same time/i);
  assert.match(readme, /\/plugin marketplace add wotjr1649\/codex-conductor-cc/);
  assert.match(readme, /\/plugin install codex@codex-conductor/);
});

test("downstream version and upstreamBase are independently readable", () => {
  const packageJson = readJson("package.json");
  const metadataPath = path.join(ROOT, "downstream.json");

  assert.ok(fs.existsSync(metadataPath), "downstream provenance metadata is required");
  const downstream = readJson("downstream.json");
  const identity = {
    version: packageJson.version,
    upstreamBase: downstream.upstreamBase
  };

  assert.deepEqual(identity, {
    version: readJson("plugins/codex/.claude-plugin/plugin.json").version,
    upstreamBase: UPSTREAM_BASE
  });
  assert.equal(downstream.upstreamRepository, "openai/codex-plugin-cc");
  assert.match(downstream.upstreamBase, /^[0-9a-f]{40}$/);
  assert.notEqual(downstream.upstreamBase, PRODUCT_BASE);
});

test("P2 preserves baseline command, agent, skill, and hook paths, blobs, and trees", () => {
  const currentFiles = Object.keys(PROTECTED_TREES).flatMap(listFiles).sort();
  const expectedFiles = [...PROTECTED_BLOBS.keys()].sort();
  assert.deepEqual(currentFiles, expectedFiles);

  for (const relativePath of currentFiles) {
    const blob = git(["hash-object", `--path=${relativePath}`, "--", relativePath]);
    assert.equal(blob, PROTECTED_BLOBS.get(relativePath), relativePath);
  }

  for (const [relativePath, tree] of Object.entries(PROTECTED_TREES)) {
    assert.equal(git(["rev-parse", `HEAD:${relativePath}`]), tree, relativePath);
  }

  const canonical = expectedFiles.map((relativePath) => `${relativePath}\t${PROTECTED_BLOBS.get(relativePath)}\n`).join("");
  assert.equal(
    crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
    "19bccaf4cce91815063cdbdcae63d1405beeac6f05aa1e153e66ce0079608f62"
  );
});
