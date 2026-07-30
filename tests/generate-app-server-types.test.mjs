import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  GENERATED_TYPES_RELATIVE,
  digestGeneratedTree,
  publishGeneratedAppServerTypes,
  recoverGeneratedAppServerTypes
} from "../scripts/lib/generated-tree-transaction.mjs";
import {
  resolveCodexInvocation,
  runCodexGenerator,
  validateGeneratedTypes
} from "../scripts/generate-app-server-types.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRASH_FIXTURE = path.join(
  ROOT,
  "tests",
  "schema-generation-crash-fixture.mjs"
);
const TEMP_ROOTS = new Set();

function trackedTempDir(prefix) {
  const created = makeTempDir(prefix);
  TEMP_ROOTS.add(created);
  return created;
}

after(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function destinationFor(repoRoot) {
  return path.join(repoRoot, ...GENERATED_TYPES_RELATIVE.split("/"));
}

function transactionArtifacts(repoRoot) {
  const parent = path.dirname(destinationFor(repoRoot));
  if (!fs.existsSync(parent)) {
    return [];
  }
  return fs
    .readdirSync(parent)
    .filter((name) => name.startsWith(".app-server-types."))
    .sort();
}

function makeRepository({ withOldDestination = true, withSpaces = false } = {}) {
  const parent = trackedTempDir(
    withSpaces ? "codex schema fixture with spaces-" : "codex-schema-fixture-"
  );
  const repoRoot = path.join(parent, withSpaces ? "repository with spaces" : "repository");
  fs.mkdirSync(path.join(repoRoot, "plugins", "codex", ".generated"), {
    recursive: true
  });
  if (withOldDestination) {
    const destination = destinationFor(repoRoot);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(
      path.join(destination, "index.ts"),
      "export type Old = true;\n"
    );
    fs.writeFileSync(path.join(destination, "stale.ts"), "stale\n");
  }
  return repoRoot;
}

async function deterministicGenerator(outputDirectory) {
  fs.mkdirSync(path.join(outputDirectory, "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, "index.ts"),
    "export type Generated = { value: string };\n"
  );
  fs.writeFileSync(
    path.join(outputDirectory, "nested", "types.ts"),
    "export type Nested = number;\n"
  );
}

async function publish(repoRoot, options = {}) {
  return publishGeneratedAppServerTypes({
    repoRoot,
    runId: options.runId ?? `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    generate: options.generate ?? deterministicGenerator,
    validate: options.validate ?? (async () => {}),
    onBoundary: options.onBoundary ?? null
  });
}

async function expectedNewDigest() {
  const root = trackedTempDir("codex-schema-expected-");
  await deterministicGenerator(root);
  return digestGeneratedTree(root, { requireTypeScript: true });
}

test("staged publish removes stale files and produces a deterministic digest", async () => {
  const repoRoot = makeRepository();
  const destination = destinationFor(repoRoot);

  const first = await publish(repoRoot, { runId: "deterministic-first" });
  assert.equal(fs.existsSync(path.join(destination, "stale.ts")), false);
  assert.equal(
    first.digest,
    await digestGeneratedTree(destination, { requireTypeScript: true })
  );

  const second = await publish(repoRoot, { runId: "deterministic-second" });
  assert.equal(second.digest, first.digest);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("generator failure preserves the existing destination", async () => {
  const repoRoot = makeRepository();
  const destination = destinationFor(repoRoot);
  const before = await digestGeneratedTree(destination);

  await assert.rejects(
    publish(repoRoot, {
      runId: "generator-failure",
      generate: async (outputDirectory) => {
        fs.writeFileSync(path.join(outputDirectory, "partial.ts"), "partial\n");
        throw new Error("injected generator failure");
      }
    }),
    /injected generator failure/
  );

  assert.equal(await digestGeneratedTree(destination), before);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("successful generation with failed staged validation preserves the old tree", async () => {
  const repoRoot = makeRepository();
  const destination = destinationFor(repoRoot);
  const before = await digestGeneratedTree(destination);

  await assert.rejects(
    publish(repoRoot, {
      runId: "validation-failure",
      generate: async (outputDirectory) => {
        fs.writeFileSync(
          path.join(outputDirectory, "invalid.ts"),
          "export type = ;\n"
        );
      },
      validate: async () => {
        throw new Error("injected staged validation failure");
      }
    }),
    /injected staged validation failure/
  );

  assert.equal(await digestGeneratedTree(destination), before);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("the real staged TypeScript validator rejects invalid generated output", async () => {
  const outputDirectory = trackedTempDir("codex-schema-invalid-ts-");
  fs.writeFileSync(
    path.join(outputDirectory, "invalid.ts"),
    "export type = ;\n"
  );

  await assert.rejects(
    validateGeneratedTypes(outputDirectory, { repoRoot: ROOT }),
    /Generated schema TypeScript validation failed/
  );
});

test("consumer-contract validation rejects incomplete output and preserves the old tree", async () => {
  const repoRoot = makeRepository();
  const destination = destinationFor(repoRoot);
  const before = await digestGeneratedTree(destination);

  await assert.rejects(
    publish(repoRoot, {
      runId: "consumer-contract-failure",
      generate: async (outputDirectory) => {
        fs.mkdirSync(path.join(outputDirectory, "v2"));
        fs.writeFileSync(
          path.join(outputDirectory, "index.ts"),
          "export type Placeholder = true;\n"
        );
        fs.writeFileSync(
          path.join(outputDirectory, "v2", "index.ts"),
          "export type PlaceholderV2 = true;\n"
        );
      },
      validate: (outputDirectory) =>
        validateGeneratedTypes(outputDirectory, { repoRoot: ROOT })
    }),
    /Generated schema TypeScript validation failed/
  );

  assert.equal(await digestGeneratedTree(destination), before);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("staged publish works when the repository path contains spaces", async () => {
  const repoRoot = makeRepository({ withSpaces: true });
  const result = await publish(repoRoot, { runId: "spaces" });

  assert.equal(
    result.digest,
    await digestGeneratedTree(destinationFor(repoRoot), {
      requireTypeScript: true
    })
  );
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("destination links and junctions are rejected without touching their target", async () => {
  const repoRoot = makeRepository({ withOldDestination: false });
  const external = trackedTempDir("codex-schema-external-");
  const destination = destinationFor(repoRoot);
  fs.writeFileSync(path.join(external, "sentinel.txt"), "preserve\n");

  fs.symlinkSync(
    external,
    destination,
    process.platform === "win32" ? "junction" : "dir"
  );

  await assert.rejects(
    publish(repoRoot, { runId: "reject-link" }),
    /link|reparse|redirect/
  );
  assert.equal(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8"), "preserve\n");
});

test("an intermediate generated-path junction is rejected", async () => {
  const parent = trackedTempDir("codex-schema-parent-junction-");
  const repoRoot = path.join(parent, "repository");
  const external = trackedTempDir("codex-schema-parent-external-");
  fs.mkdirSync(path.join(repoRoot, "plugins", "codex"), { recursive: true });
  fs.writeFileSync(path.join(external, "sentinel.txt"), "preserve\n");
  fs.symlinkSync(
    external,
    path.join(repoRoot, "plugins", "codex", ".generated"),
    process.platform === "win32" ? "junction" : "dir"
  );

  await assert.rejects(
    publish(repoRoot, { runId: "reject-parent-link" }),
    /link|reparse|redirect/
  );
  assert.equal(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8"), "preserve\n");
});

test("tree digests use stable UTF-8 ordinal filename ordering", async () => {
  const first = trackedTempDir("codex-schema-order-first-");
  const second = trackedTempDir("codex-schema-order-second-");
  const names = ["A-one.ts", "a-two.ts", "é-three.ts", "e\u0301-four.ts", "中-five.ts"];
  for (const name of names) {
    fs.writeFileSync(path.join(first, name), `export type T = "${name}";\n`);
  }
  for (const name of [...names].reverse()) {
    fs.writeFileSync(path.join(second, name), `export type T = "${name}";\n`);
  }
  assert.equal(await digestGeneratedTree(first), await digestGeneratedTree(second));
});

test("thrown failures at rename and cleanup boundaries recover coherently", async () => {
  const boundaries = [
    "before_old_rename",
    "after_old_rename_before_marker",
    "before_new_rename",
    "after_new_rename_before_marker",
    "before_backup_remove",
    "after_backup_remove_before_marker"
  ];
  const newDigest = await expectedNewDigest();

  for (const boundary of boundaries) {
    const repoRoot = makeRepository();
    const oldDigest = await digestGeneratedTree(destinationFor(repoRoot));
    let injected = false;
    await assert.rejects(
      publish(repoRoot, {
        runId: `failure-${boundary.replaceAll("_", "-")}`,
        onBoundary: async (actual) => {
          if (!injected && actual === boundary) {
            injected = true;
            throw new Error(`injected failure at ${boundary}`);
          }
        }
      }),
      new RegExp(`injected failure at ${boundary}`)
    );
    assert.equal(injected, true);
    assert.equal(
      await digestGeneratedTree(destinationFor(repoRoot)),
      [
        "after_new_rename_before_marker",
        "before_backup_remove",
        "after_backup_remove_before_marker"
      ].includes(boundary)
        ? newDigest
        : oldDigest
    );
    assert.deepEqual(transactionArtifacts(repoRoot), []);
  }
});

test("crash boundaries recover on the next run with an existing destination", async () => {
  const cases = [
    ["after_marker_temp_sync_before_rename", "prepared", "old"],
    ["after_marker_prepared", "", "old"],
    ["after_old_rename_before_marker", "", "old"],
    ["after_marker_temp_sync_before_rename", "old_moved", "old"],
    ["after_marker_old_moved", "", "old"],
    ["after_new_rename_before_marker", "", "new"],
    ["after_marker_temp_sync_before_rename", "new_published", "new"],
    ["after_marker_new_published", "", "new"],
    ["after_backup_remove_before_marker", "", "new"],
    ["after_marker_temp_sync_before_rename", "committed", "new"],
    ["after_marker_committed", "", "new"]
  ];
  const newDigest = await expectedNewDigest();

  for (const [boundary, state, expected] of cases) {
    const repoRoot = makeRepository();
    const oldDigest = await digestGeneratedTree(destinationFor(repoRoot));
    const result = spawnSync(
      process.execPath,
      [CRASH_FIXTURE, repoRoot, boundary, state],
      {
        cwd: ROOT,
        env: process.env,
        encoding: "utf8",
        shell: false,
        windowsHide: true
      }
    );
    assert.equal(result.status, 86, `${boundary}: ${result.stderr}`);

    const recovery = await recoverGeneratedAppServerTypes({ repoRoot });
    assert.equal(recovery.recovered, true);
    assert.equal(
      recovery.digest,
      expected === "new" ? newDigest : oldDigest,
      `${boundary}:${state}`
    );
    assert.deepEqual(transactionArtifacts(repoRoot), [], `${boundary}:${state}`);

    await publish(repoRoot, {
      runId: `recovery-${boundary.replaceAll("_", "-")}`
    });
    assert.match(
      fs.readFileSync(path.join(destinationFor(repoRoot), "index.ts"), "utf8"),
      /Generated/
    );
    assert.deepEqual(transactionArtifacts(repoRoot), [], boundary);
  }
});

test("lock acquisition and release crash windows recover on the next run", async () => {
  const cases = [
    ["after_lock_owner_temp_created", false],
    ["after_lock_owner_temp_sync_before_publish", false],
    ["after_lock_owner_published", true],
    ["before_lock_release", true],
    ["after_lock_owner_removed", false]
  ];

  for (const [boundary, expectedRecoveryClaim] of cases) {
    const repoRoot = makeRepository();
    const result = spawnSync(
      process.execPath,
      [CRASH_FIXTURE, repoRoot, boundary],
      {
        cwd: ROOT,
        env: process.env,
        encoding: "utf8",
        shell: false,
        windowsHide: true
      }
    );
    assert.equal(result.status, 86, `${boundary}: ${result.stderr}`);

    const recovery = await recoverGeneratedAppServerTypes({ repoRoot });
    assert.equal(recovery.recovered, expectedRecoveryClaim, boundary);
    assert.deepEqual(transactionArtifacts(repoRoot), [], boundary);

    await publish(repoRoot, {
      runId: `lock-recovery-${boundary.replaceAll("_", "-")}`
    });
    assert.deepEqual(transactionArtifacts(repoRoot), [], boundary);
  }
});

test("a recovery release crash leaves a safely reclaimable claim", async () => {
  const repoRoot = makeRepository();
  const firstCrash = spawnSync(
    process.execPath,
    [CRASH_FIXTURE, repoRoot, "after_marker_prepared"],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    }
  );
  assert.equal(firstCrash.status, 86, firstCrash.stderr);

  const releaseCrash = spawnSync(
    process.execPath,
    [
      CRASH_FIXTURE,
      repoRoot,
      "after_lock_owner_removed",
      "",
      "recover"
    ],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    }
  );
  assert.equal(releaseCrash.status, 86, releaseCrash.stderr);

  const recovery = await recoverGeneratedAppServerTypes({ repoRoot });
  assert.equal(recovery.recovered, false);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
  await publish(repoRoot, { runId: "post-recovery-release-crash" });
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("a claim disappearing during fresh-owner acquisition is retried", async () => {
  const repoRoot = makeRepository();
  const firstCrash = spawnSync(
    process.execPath,
    [CRASH_FIXTURE, repoRoot, "after_marker_prepared"],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    }
  );
  assert.equal(firstCrash.status, 86, firstCrash.stderr);

  const releaseCrash = spawnSync(
    process.execPath,
    [
      CRASH_FIXTURE,
      repoRoot,
      "after_lock_owner_removed",
      "",
      "recover"
    ],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    }
  );
  assert.equal(releaseCrash.status, 86, releaseCrash.stderr);

  const claimPath = path.join(
    path.dirname(destinationFor(repoRoot)),
    ".app-server-types.publish.recovery-claim.json"
  );
  let removed = false;
  await publish(repoRoot, {
    runId: "claim-disappeared",
    onBoundary: async (boundary) => {
      if (
        !removed &&
        boundary === "after_fresh_owner_observed_recovery_claim"
      ) {
        fs.unlinkSync(claimPath);
        removed = true;
      }
    }
  });
  assert.equal(removed, true);
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("first-create crashes recover without requiring a backup", async () => {
  const boundaries = [
    "after_marker_old_moved",
    "after_new_rename_before_marker",
    "after_marker_new_published"
  ];
  const newDigest = await expectedNewDigest();

  for (const boundary of boundaries) {
    const repoRoot = makeRepository({ withOldDestination: false });
    const result = spawnSync(
      process.execPath,
      [CRASH_FIXTURE, repoRoot, boundary],
      {
        cwd: ROOT,
        env: process.env,
        encoding: "utf8",
        shell: false,
        windowsHide: true
      }
    );
    assert.equal(result.status, 86, `${boundary}: ${result.stderr}`);

    const recovery = await recoverGeneratedAppServerTypes({ repoRoot });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.digest, newDigest, boundary);
    assert.deepEqual(transactionArtifacts(repoRoot), [], boundary);

    await publish(repoRoot, {
      runId: `first-create-${boundary.replaceAll("_", "-")}`
    });
    assert.equal(fs.existsSync(destinationFor(repoRoot)), true);
    assert.deepEqual(transactionArtifacts(repoRoot), [], boundary);
  }
});

test("a live transaction lock rejects a concurrent publisher", async () => {
  const repoRoot = makeRepository();
  let releaseFirst;
  let markPrepared;
  const prepared = new Promise((resolve) => {
    markPrepared = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = publish(repoRoot, {
    runId: "concurrent-first",
    onBoundary: async (boundary) => {
      if (boundary === "after_marker_prepared") {
        markPrepared();
        await release;
      }
    }
  });
  await prepared;
  await assert.rejects(
    publish(repoRoot, { runId: "concurrent-second" }),
    /active schema publish transaction/
  );
  releaseFirst();
  await first;
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("a live lock initializer cannot be reclaimed by a concurrent publisher", async () => {
  const repoRoot = makeRepository();
  let releaseInitializer;
  let markInitializer;
  const initialized = new Promise((resolve) => {
    markInitializer = resolve;
  });
  const release = new Promise((resolve) => {
    releaseInitializer = resolve;
  });

  const first = publish(repoRoot, {
    runId: "initializer-first",
    onBoundary: async (boundary) => {
      if (boundary === "after_lock_owner_temp_sync_before_publish") {
        markInitializer();
        await release;
      }
    }
  });
  await initialized;
  await assert.rejects(
    publish(repoRoot, { runId: "initializer-second" }),
    /initializing the lock/
  );
  releaseInitializer();
  await first;
  assert.deepEqual(transactionArtifacts(repoRoot), []);
});

test("marker metadata conflicts fail closed before the first destination rename", async () => {
  const mutations = [
    ["owner", "foreign-owner"],
    ["destination", "../outside"],
    ["newDigest", "0".repeat(64)],
    ["state", "foreign-state"],
    ["transactionId", "foreign-transaction"]
  ];

  for (const [field, value] of mutations) {
    const repoRoot = makeRepository();
    const destination = destinationFor(repoRoot);
    const oldDigest = await digestGeneratedTree(destination);
    const markerPath = path.join(
      path.dirname(destination),
      ".app-server-types.publish.json"
    );

    await assert.rejects(
      publish(repoRoot, {
        runId: `marker-conflict-${field}`,
        onBoundary: async (boundary) => {
          if (boundary !== "after_marker_prepared") {
            return;
          }
          const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
          marker[field] = value;
          fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
        }
      }),
      /fail-closed/
    );
    assert.equal(await digestGeneratedTree(destination), oldDigest, field);
    assert.ok(transactionArtifacts(repoRoot).length > 0, field);
  }
});

test("Codex resolver ignores relative PATH entries and validates npm package metadata", () => {
  const root = trackedTempDir("codex-resolver-");
  const bin = path.join(root, "bin with spaces");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex.cmd"), "@echo off\r\n");
  const packageRoot = path.join(bin, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      bin: { codex: "bin/codex.js" }
    })
  );
  fs.writeFileSync(path.join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");

  const invocation = resolveCodexInvocation({
    env: { PATH: `relative-entry${path.delimiter}${bin}` },
    platform: "win32"
  });
  assert.equal(invocation.command, path.resolve(process.execPath));
  assert.equal(invocation.prefixArgs.length, 1);
  assert.match(invocation.prefixArgs[0], /codex\.js$/);

  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@not-openai/codex",
      bin: { codex: "bin/codex.js" }
    })
  );
  assert.throws(
    () =>
      resolveCodexInvocation({
        env: { PATH: `relative-entry${path.delimiter}${bin}` },
        platform: "win32"
      }),
    /shell-free Codex CLI/
  );
});

test("Codex generator receives exact argv and a credential-stripped allowlist", async () => {
  const outputDirectory = trackedTempDir("codex-generator-invocation-");
  const fixture = path.join(outputDirectory, "fake-codex.mjs");
  fs.writeFileSync(
    fixture,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const output = process.argv.at(-1);",
      "fs.writeFileSync(path.join(output, \"invocation.json\"), JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  envKeys: Object.keys(process.env).sort()",
      "}));"
    ].join("\n")
  );

  await runCodexGenerator(outputDirectory, {
    repoRoot: ROOT,
    invocation: {
      command: path.resolve(process.execPath),
      prefixArgs: [fixture],
      identitySha256: "0".repeat(64)
    },
    env: {
      ...process.env,
      OPENAI_API_KEY: "seeded-secret",
      ANTHROPIC_API_KEY: "seeded-secret",
      HTTPS_PROXY: "http://user:password@example.invalid",
      NODE_OPTIONS: "--trace-warnings"
    }
  });
  const observed = JSON.parse(
    fs.readFileSync(path.join(outputDirectory, "invocation.json"), "utf8")
  );
  assert.deepEqual(observed.args, [
    "app-server",
    "generate-ts",
    "--out",
    outputDirectory
  ]);
  for (const forbidden of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTPS_PROXY",
    "NODE_OPTIONS"
  ]) {
    assert.equal(observed.envKeys.includes(forbidden), false);
  }
});
