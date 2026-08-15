import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import {
  CorrelationFixture,
  LosslessNumber,
  StrictJsonlFixture
} from "../scripts/lib/p4-jsonl-fixture.mjs";
import { LifecycleFixture } from "../scripts/lib/p4-lifecycle-fixture.mjs";
import {
  assertSnapshotHost,
  inspectSnapshotTree,
  readMethodInventory,
  sha256
} from "../scripts/lib/p4-snapshot.mjs";
import { validateJsonSchema } from "../scripts/lib/p4-schema-validator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function toFixtureId(value) {
  return typeof value === "string"
    ? value
    : new LosslessNumber(String(value));
}

function assertCode(expectedCode) {
  return (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  };
}

function makeP4TempRoot(label) {
  // Resolved, because the captured transcripts are normalized by string-matching this path and
  // the product reports whatever the OS canonicalizes it to. On a hosted Windows runner
  // os.tmpdir() comes back through a short 8.3 name, so the raw value never matched what the
  // CLI recorded and `cwd` survived normalization as a literal path. Local temp directories
  // happen not to differ, which is why this only ever failed where nothing ran it.
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `codex-p4-${label}-`)));
}

function installP4FakeCodex(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fixture = path.join(repoRoot, "tests", "contract", "p4-fake-app-server.mjs");
  const launcher = `#!/usr/bin/env node\nawait import(${JSON.stringify(new URL(`file:///${fixture.replaceAll("\\", "/")}`).href)});\n`;
  writeFileSync(path.join(bin, "codex"), launcher, { encoding: "utf8", mode: 0o755 });
  writeFileSync(
    path.join(bin, "codex.cmd"),
    `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
    "utf8"
  );
  return bin;
}

function fakeCodexEnv(bin, capturePath, extra = {}) {
  const environment = {
    ...process.env,
    PATH: `${bin};${process.env.PATH}`,
    P4_CAPTURE_PATH: capturePath,
    ...extra
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[key];
  }
  return environment;
}

async function withProcessEnvironment(environment, operation) {
  const previous = new Map();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function readCapturedMessages(capturePath) {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).message);
}

function normalizeCapturedValue(value, context, key = "") {
  if (key === "outputSchema" && value && typeof value === "object") {
    return {
      sha256: sha256(Buffer.from(JSON.stringify(value), "utf8"))
    };
  }
  if (key === "input" && Array.isArray(value)) {
    return value.map((item) => ({
      ...normalizeCapturedValue(item, context),
      text: "<prompt>"
    }));
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCapturedValue(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        normalizeCapturedValue(child, context, childKey)
      ])
    );
  }
  if (typeof value !== "string") return value;
  if (value === context.sourcePath) return "<source>";
  if (value === context.root) return "<cwd>";
  if (/^thr_/.test(value)) return "<thread-id>";
  if (/^turn_/.test(value)) return "<turn-id>";
  // The client announces the plugin's version in `initialize`, so a released transcript pinned
  // to a literal version stops matching the moment the plugin ships. Normalize it the way cwd
  // and thread ids are normalized; what the contract fixes is the shape and ordering, and the
  // version itself is asserted against the manifests by downstream-identity.
  if (key === "version" && value === context.pluginVersion) return "<version>";
  let normalized = value;
  normalized = normalized.replaceAll(
    context.root.replaceAll("\\", "/"),
    "<cwd>"
  );
  normalized = normalized.replaceAll(context.root, "<cwd>");
  for (const prompt of context.prompts) {
    normalized = normalized.replaceAll(prompt, "<prompt>");
  }
  return normalized;
}

function capturedTranscript(capturePath, context) {
  return readCapturedMessages(capturePath)
    .filter((message) => typeof message.method === "string")
    .map((message) => ({
      kind: message.id === undefined ? "notification" : "request",
      method: message.method,
      params: normalizeCapturedValue(message.params ?? {}, context)
    }));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("P4 fixture wait timed out");
}

const requiredRedArtifacts = [
  ["P4-RED-001", "exact build/current/previous manifest", "contracts/codex/contract-tools-v1.json"],
  ["P4-RED-002", "current stable TypeScript snapshot", "contracts/codex/snapshots/0.146.0/stable/typescript"],
  ["P4-RED-003", "current stable JSON Schema snapshot", "contracts/codex/snapshots/0.146.0/stable/json-schema"],
  ["P4-RED-004", "previous stable TypeScript snapshot", "contracts/codex/snapshots/0.145.0/stable/typescript"],
  ["P4-RED-005", "previous stable JSON Schema snapshot", "contracts/codex/snapshots/0.145.0/stable/json-schema"],
  ["P4-RED-006", "stable/experimental separation", "contracts/codex/snapshots/0.146.0/experimental"],
  ["P4-RED-007", "deterministic snapshot generator", "scripts/generate-p4-contracts.mjs"],
  ["P4-RED-008", "lossless JSONL fixture adapter", "scripts/lib/p4-jsonl-fixture.mjs"],
  ["P4-RED-009", "correlation fixture", "tests/contract/jsonl-cases-v1.json"],
  ["P4-RED-010", "broker/app-server handshake fixture", "tests/contract/handshake-cases-v1.json"],
  ["P4-RED-011", "lifecycle fixture", "tests/contract/lifecycle-cases-v1.json"],
  ["P4-RED-012", "server-request fail-closed fixture", "tests/contract/server-request-cases-v1.json"],
  ["P4-RED-013", "command semantic manifest", "contracts/codex/command-semantics-v1.json"],
  ["P4-RED-014", "permission absent/null/default matrix", "tests/contract/permission-cases-v1.json"],
  ["P4-RED-015", "F1-F12 status registry", "contracts/codex/finalizer-characterization-v1.json"],
  ["P4-RED-016", "traffic/resource candidate manifest", "contracts/codex/resource-candidates-v1.json"],
  ["P4-RED-017", "P4 evidence manifest", "evidence/manifests/p4/p4-contract-baseline-20260731.json"],
  ["P4-RED-018", "P4 attempt ledger", "evidence/ledgers/p4-attempts.json"],
  ["P4-RED-019", "current/previous direct/broker integration", "contracts/codex/lifecycle-integration-v1.json"],
  ["P4-RED-020", "captured command transcripts", "tests/contract/command-transcripts-v1.json"],
  ["P4-RED-021", "product-path server request probe", "tests/contract/p4-fake-app-server.mjs"]
];

for (const [fixtureId, description, relativePath] of requiredRedArtifacts) {
  test(`${fixtureId}: ${description} is present`, () => {
    assert.equal(
      existsSync(path.join(repoRoot, relativePath)),
      true,
      `missing ${relativePath}`
    );
  });
}

test("P4-PIN-001: exact build/current/previous lanes reject mutable identity", () => {
  const manifest = readJson("contracts/codex/contract-tools-v1.json");
  assert.equal(manifest.schemaVersion, "p4-contract-tools-v1");
  assert.deepEqual(Object.keys(manifest.lanes).sort(), ["build", "current", "previous"]);
  assert.equal(manifest.platform.os, "windows");
  assert.equal(manifest.platform.architecture, "x64");
  assert.equal(manifest.node.version, "24.18.1");
  assert.equal(manifest.node.npmVersion, "11.16.0");
  assert.match(manifest.node.archiveSha256, /^[0-9a-f]{64}$/);

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  assert.equal(artifacts.size, 2);
  for (const lane of Object.values(manifest.lanes)) {
    const artifact = artifacts.get(lane.artifactId);
    assert.ok(artifact);
    assert.equal(lane.version, artifact.version);
    assert.equal(artifact.releaseStatus, "stable");
    assert.match(artifact.peeledCommit, /^[0-9a-f]{40}$/);
    assert.match(artifact.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(artifact.executableSha256, /^[0-9a-f]{64}$/);
    assert.equal(artifact.authenticode.required, true);
    assert.equal(artifact.authenticode.observedStatus, "Valid");
    assert.deepEqual(artifact.npm.lifecycleScripts, []);
  }
  assert.equal(manifest.lanes.build.artifactId, manifest.lanes.current.artifactId);
  assert.notEqual(manifest.lanes.current.artifactId, manifest.lanes.previous.artifactId);
  assert.ok(
    manifest.rejectedOrDeferred.some(
      ({ candidate, disposition }) =>
        candidate === "@openai/codex@latest" && disposition === "rejected"
    )
  );
  assert.ok(
    manifest.rejectedOrDeferred.some(
      ({ candidate, disposition }) =>
        candidate === "0.147.0-alpha.2" && disposition === "deferred"
    )
  );
});

test("P4-PIN-002: generation host gate is exact and fail-closed", () => {
  assert.doesNotThrow(() => assertSnapshotHost());
  assert.doesNotThrow(() => assertSnapshotHost("win32", "x64", "24.18.1"));
  assert.throws(
    () => assertSnapshotHost("linux", "x64", "24.18.1"),
    /P4E_SNAPSHOT_HOST/
  );
  assert.throws(
    () => assertSnapshotHost("win32", "arm64", "24.18.1"),
    /P4E_SNAPSHOT_HOST/
  );
  assert.throws(
    () => assertSnapshotHost("win32", "x64", "24.19.0"),
    /P4E_SNAPSHOT_HOST/
  );
});

test("P4-SCHEMA-001: committed Draft 2020-12 schemas enforce nested constraints", () => {
  const toolsSchema = readJson("evidence/schemas/p4-contract-tools-v1.schema.json");
  const evidenceSchema = readJson("evidence/schemas/p4-evidence-v1.schema.json");
  const tools = readJson("contracts/codex/contract-tools-v1.json");
  const evidence = readJson(
    "evidence/manifests/p4/p4-contract-baseline-20260731.json"
  );

  assert.deepEqual(validateJsonSchema(tools, toolsSchema, "tools"), []);
  assert.deepEqual(validateJsonSchema(evidence, evidenceSchema, "evidence"), []);

  const unknownNested = structuredClone(tools);
  unknownNested.artifacts[0].authenticode.unreviewed = true;
  assert.match(
    validateJsonSchema(unknownNested, toolsSchema, "tools").join("\n"),
    /authenticode: unknown property unreviewed/
  );

  const wrongConst = structuredClone(evidence);
  wrongConst.localChecks[0].trial = 2;
  assert.match(
    validateJsonSchema(wrongConst, evidenceSchema, "evidence").join("\n"),
    /localChecks\[0\]\.trial: const mismatch/
  );

  const missingNested = structuredClone(evidence);
  delete missingNested.privacy.secretsPersisted;
  assert.match(
    validateJsonSchema(missingNested, evidenceSchema, "evidence").join("\n"),
    /privacy: missing required property secretsPersisted/
  );

  const unsupportedKeyword = structuredClone(toolsSchema);
  unsupportedKeyword.properties.platform.maxProperties = 3;
  assert.throws(
    () => validateJsonSchema(tools, unsupportedKeyword, "tools"),
    /P4E_SCHEMA_KEYWORD/
  );

  const invalidCalendarDate = structuredClone(tools);
  invalidCalendarDate.reviewPolicy.expiresAt = "2026-02-30";
  assert.match(
    validateJsonSchema(invalidCalendarDate, toolsSchema, "tools").join("\n"),
    /reviewPolicy\.expiresAt: invalid date/
  );

  const missingTimezone = structuredClone(tools);
  missingTimezone.artifacts[0].releasedAt = "2026-07-29T01:42:51";
  assert.match(
    validateJsonSchema(missingTimezone, toolsSchema, "tools").join("\n"),
    /artifacts\[0\]\.releasedAt: invalid date-time/
  );
});

test("P4-SNAPSHOT-001: committed tree matches its byte-framed digest", async () => {
  const snapshotRoot = path.join(repoRoot, "contracts", "codex", "snapshots");
  const manifestPath = path.join(snapshotRoot, "snapshot-manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const observed = await inspectSnapshotTree(snapshotRoot);

  assert.equal(manifest.schemaVersion, "p4-codex-snapshot-manifest-v1");
  assert.deepEqual(manifest.platform, {
    os: "windows",
    architecture: "x64",
    node: "24.18.1"
  });
  assert.equal(manifest.toolsManifestSha256, sha256(
    readFileSync(path.join(repoRoot, "contracts", "codex", "contract-tools-v1.json"))
  ));
  assert.deepEqual(
    {
      fileCount: observed.fileCount,
      totalBytes: observed.totalBytes,
      treeSha256: observed.treeSha256
    },
    manifest.combined
  );
  assert.equal(manifest.combined.treeSha256, "820456f8bdc229db1076604cafbddfd75974310e2fe0936136f6748dc8d21749");
  assert.deepEqual(
    manifest.versions.map(({ lane, version }) => ({ lane, version })),
    [
      { lane: "current", version: "0.146.0" },
      { lane: "previous", version: "0.145.0" }
    ]
  );
  for (const version of manifest.versions) {
    assert.deepEqual(
      version.surfaces.map(({ mode, format }) => `${mode}/${format}`),
      [
        "stable/typescript",
        "stable/json-schema",
        "experimental/typescript",
        "experimental/json-schema"
      ]
    );
  }
});

test("P4-SNAPSHOT-002: stable and experimental inventories remain separate", async () => {
  const manifest = readJson("contracts/codex/snapshots/snapshot-manifest.json");
  for (const version of manifest.versions) {
    const stable = version.surfaces.find(
      ({ mode, format }) => mode === "stable" && format === "json-schema"
    );
    const experimental = version.surfaces.find(
      ({ mode, format }) => mode === "experimental" && format === "json-schema"
    );
    assert.ok(stable);
    assert.ok(experimental);
    assert.equal(stable.methods.serverRequests.length, 10);
    assert.equal(stable.methods.serverNotifications.length, 70);
    assert.equal(experimental.methods.serverRequests.length, 11);
    assert.equal(experimental.methods.serverNotifications.length, 70);
    assert.ok(experimental.methods.clientRequests.length > stable.methods.clientRequests.length);
    assert.notEqual(experimental.treeSha256, stable.treeSha256);
    for (const surface of [stable, experimental]) {
      const observed = await readMethodInventory(
        path.join(
          repoRoot,
          "contracts",
          "codex",
          "snapshots",
          version.version,
          surface.mode,
          surface.format
        )
      );
      assert.deepEqual(surface.methods, observed, `${version.version}/${surface.mode}`);
    }
  }
  assert.equal(
    manifest.normalization.path,
    "**/json-schema/codex_app_server_protocol.v2.schemas.json"
  );
  assert.match(manifest.normalization.operation, /preserve arrays and scalar values/);
});

test("P4-SNAPSHOT-003: only the root manifest is excluded from tree identity", async () => {
  const root = makeP4TempRoot("snapshot-exclusion");
  try {
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "snapshot-manifest.json"), "root metadata\n");
    writeFileSync(
      path.join(root, "nested", "snapshot-manifest.json"),
      "contract payload\n"
    );
    const observed = await inspectSnapshotTree(root);
    assert.equal(observed.fileCount, 1);
    assert.equal(observed.files[0].path, "nested/snapshot-manifest.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P4-JSONL-001: framing corpus preserves IDs and rejects malformed input", () => {
  const corpus = readJson("tests/contract/jsonl-cases-v1.json");
  for (const fixture of corpus.positive) {
    const framer = new StrictJsonlFixture();
    const observed = fixture.chunksHex.flatMap((chunk) =>
      framer.push(Buffer.from(chunk, "hex"))
    );
    framer.finish();
    assert.equal(observed.length, fixture.expected.length, fixture.id);
    for (let index = 0; index < observed.length; index += 1) {
      const expected = fixture.expected[index];
      const actual = observed[index];
      assert.equal(actual.kind, expected.kind, fixture.id);
      if (expected.idType) {
        assert.equal(actual.id.type, expected.idType, fixture.id);
        assert.equal(actual.id.lexeme, expected.idLexeme, fixture.id);
      }
      if (expected.method) {
        assert.equal(actual.method, expected.method, fixture.id);
      }
    }
  }

  for (const fixture of corpus.negative) {
    assert.throws(() => {
      const framer = new StrictJsonlFixture();
      for (const chunk of fixture.chunksHex) {
        framer.push(Buffer.from(chunk, "hex"));
      }
      if (fixture.finish) {
        framer.finish();
      }
    }, assertCode(fixture.error), fixture.id);
  }
});

test("P4-JSONL-002: candidate line byte boundary is measured exactly", () => {
  for (const size of [65_535, 65_536]) {
    const framer = new StrictJsonlFixture({ maxLineBytes: 65_536 });
    assert.deepEqual(framer.push(Buffer.concat([Buffer.alloc(size, 0x20), Buffer.from("\n")])), []);
    assert.equal(framer.observedLineBytes.at(-1), size);
    framer.finish();
  }
  const rejected = new StrictJsonlFixture({ maxLineBytes: 65_536 });
  assert.throws(
    () => rejected.push(Buffer.concat([Buffer.alloc(65_537, 0x20), Buffer.from("\n")])),
    assertCode("P4E_LINE_LIMIT")
  );
});

test("P4-CORRELATION-001: response order and string/number identity are independent", () => {
  const corpus = readJson("tests/contract/jsonl-cases-v1.json");
  for (const fixture of corpus.correlation) {
    const correlation = new CorrelationFixture();
    for (const id of fixture.pending) {
      correlation.add(toFixtureId(id));
    }
    const observed = fixture.responses.map((id) =>
      correlation.resolve({ id: toFixtureId(id), result: {} }).id.correlationKey
    );
    assert.deepEqual(observed, fixture.expectedOrder, fixture.id);
  }

  const duplicate = new CorrelationFixture();
  duplicate.add(new LosslessNumber("7"));
  const response = { id: new LosslessNumber("7"), result: {} };
  duplicate.resolve(response);
  assert.throws(() => duplicate.resolve(response), assertCode("P4E_DUPLICATE_RESPONSE"));

  const unknown = new CorrelationFixture();
  assert.throws(
    () => unknown.resolve({ id: new LosslessNumber("8"), result: {} }),
    assertCode("P4E_UNKNOWN_RESPONSE")
  );
});

test("P4-LIFECYCLE-001: terminal state requires response, root completion, and children", () => {
  const corpus = readJson("tests/contract/lifecycle-cases-v1.json");
  assert.deepEqual(corpus.versions, ["0.146.0", "0.145.0"]);
  for (const fixture of corpus.cases) {
    const lifecycle = new LifecycleFixture();
    fixture.events.forEach((event, index) => {
      const state = lifecycle.apply(event);
      if (fixture.terminalStates) {
        assert.equal(state.terminal, fixture.terminalStates[index], `${fixture.id}/${index + 1}`);
      }
      if (fixture.notTerminalAfterEvent === index + 1) {
        assert.equal(state.terminal, false, fixture.id);
      }
    });
    const state = lifecycle.snapshot();
    assert.equal(state.terminal, fixture.terminal, fixture.id);
    if (fixture.duplicates !== undefined) {
      assert.equal(state.duplicates, fixture.duplicates, fixture.id);
    }
    if (fixture.lateEvents !== undefined) {
      assert.equal(state.lateEvents, fixture.lateEvents, fixture.id);
    }
    if (fixture.cancelAcknowledged !== undefined) {
      assert.equal(state.cancelAcknowledged, fixture.cancelAcknowledged, fixture.id);
    }
  }
  assert.ok(corpus.cases.some(({ id }) => id === "PROTO-LIFECYCLE-LATE-CHILD-001"));
  assert.ok(
    corpus.cases.some(({ id }) => id === "PROTO-LIFECYCLE-LATE-WRONG-COMPLETION-001")
  );
  assert.ok(
    corpus.cases.some(({ id }) => id === "PROTO-LIFECYCLE-COMPLETION-BEFORE-INTERRUPT-001")
  );
});

test("P4-HANDSHAKE-001: broker hello and app-server initialize are not conflated", () => {
  const fixture = readJson("tests/contract/handshake-cases-v1.json");
  const brokerSource = readFileSync(
    path.join(repoRoot, "plugins", "codex", "scripts", "app-server-broker.mjs"),
    "utf8"
  );
  assert.equal(fixture.required.brokerHelloMaySatisfyInitialize, false);
  assert.ok(fixture.required.broker.includes("broker:broker/hello"));
  assert.equal(fixture.observedProduct.broker.behaviorStatus, "red");
  assert.match(brokerSource, /message\.method === "initialize"/);
  // v0.2 gave the POSIX broker its own authenticated handshake, so `broker/hello` is a method
  // the broker genuinely handles now and asserting its absence stopped describing anything.
  // What the contract actually requires is that the two are not conflated, and they are not:
  // each is matched in its own branch, `broker/hello` opens the capability exchange, and
  // `initialize` is answered by the broker itself rather than satisfied by a hello.
  assert.match(brokerSource, /message\.method === "broker\/hello"/);
  // Each answers with its own thing, which is what "not conflated" means here: the hello opens
  // the capability exchange, and initialize returns the broker's identity. Comparing the two
  // offsets instead -- as an earlier version of this did -- can never fail, because two distinct
  // literals never share an index, so it passed even for a broker that let one satisfy the other.
  assert.match(brokerSource, /message\.method === "broker\/hello"[\s\S]{0,600}createBrokerAuthChallenge/);
  assert.match(brokerSource, /message\.method === "initialize"[\s\S]{0,300}userAgent/);
});

test("P4-INTEGRATION-001: both stable lanes execute direct and broker core lifecycle", () => {
  const integration = readJson("contracts/codex/lifecycle-integration-v1.json");
  const tools = readJson("contracts/codex/contract-tools-v1.json");
  const artifacts = new Map(tools.artifacts.map((artifact) => [artifact.id, artifact]));
  assert.equal(integration.runs.length, 4);
  assert.deepEqual(
    integration.runs.map(({ version, transport }) => `${version}/${transport}`).sort(),
    [
      "0.145.0/broker",
      "0.145.0/direct",
      "0.146.0/broker",
      "0.146.0/direct"
    ]
  );
  for (const run of integration.runs) {
    const lane = tools.lanes[run.lane];
    const artifact = artifacts.get(lane.artifactId);
    assert.equal(run.version, lane.version);
    assert.equal(run.executableSha256, artifact.executableSha256);
    assert.equal(run.executionStatus, "executed-pass");
    assert.equal(run.retryCount, 0);
    assert.equal(run.normalTerminalStatus, "completed");
    assert.equal(run.resumedThreadIdMatched, true);
    assert.equal(run.cancelTerminalStatus, "interrupted");
    assert.equal(run.interruptAcknowledged, true);
    assert.equal(run.traffic.stderrBytes, 0);
    assert.ok(run.traffic.messageCount > 0);
    if (run.transport === "broker") {
      assert.equal(run.initialize.brokerSynthetic, true);
      assert.equal(run.brokerHello.attempted, true);
      assert.equal(run.brokerHello.supported, false);
    } else {
      assert.equal(run.initialize.brokerSynthetic, false);
      assert.equal(run.brokerHello.attempted, false);
    }
  }
  assert.equal(integration.admission.stableCoreLifecycleBlocking, true);
  assert.equal(integration.admission.brokerHandshakeConformant, false);
  assert.equal(integration.admission.brokerHandshakeBehaviorStatus, "red");
  assert.ok(integration.requiredLifecycle.includes("thread/resume"));
  assert.equal(integration.characterizationFixture.rootAndChildCompletion, true);
  assert.equal(integration.characterizationFixture.responseEventReordering, true);
  assert.equal(integration.characterizationFixture.lateAndDuplicateTerminalEvents, true);
});

test("P4-SERVER-REQUEST-001: stable allowlist matches both snapshots and never auto-grants", () => {
  const fixture = readJson("tests/contract/server-request-cases-v1.json");
  const manifest = readJson("contracts/codex/snapshots/snapshot-manifest.json");
  const expectedMethods = fixture.stableMethods.map(({ method }) => method);
  for (const version of manifest.versions) {
    const stable = version.surfaces.find(
      ({ mode, format }) => mode === "stable" && format === "json-schema"
    );
    assert.deepEqual(stable.methods.serverRequests, expectedMethods, version.version);
  }
  assert.ok(fixture.stableMethods.every(({ automaticGrant }) => automaticGrant === false));
  assert.equal(fixture.unknownMethod.automaticGrant, false);
  assert.equal(fixture.observedProduct.grants, 0);
  assert.equal(fixture.observedProduct.behaviorStatus, "red");
});

test("P4-SERVER-REQUEST-002: product client preserves IDs and rejects every server request", async () => {
  const root = makeP4TempRoot("server-request");
  const capturePath = path.join(root, "capture.jsonl");
  const bin = installP4FakeCodex(root);
  const env = fakeCodexEnv(bin, capturePath, {
    P4_SERVER_REQUEST_PROBE: "1",
    CODEX_COMPANION_APP_SERVER_ENDPOINT: undefined
  });
  let client;
  try {
    client = await CodexAppServerClient.connect(root, {
      disableBroker: true,
      env
    });
    const responses = await waitFor(() => {
      const observed = readCapturedMessages(capturePath).filter(
        (message) => message.id === "p4-known" || message.id === 7
      );
      return observed.length === 2 ? observed : null;
    });
    assert.deepEqual(responses, [
      {
        id: "p4-known",
        error: {
          code: -32601,
          message:
            "Unsupported server request: item/commandExecution/requestApproval"
        }
      },
      {
        id: 7,
        error: {
          code: -32601,
          message: "Unsupported server request: future/unknown"
        }
      }
    ]);
    assert.ok(responses.every((response) => !Object.hasOwn(response, "result")));
  } finally {
    await client?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("P4-PERMISSION-001: absent, undefined, null, and explicit defaults remain distinct", () => {
  const fixture = readJson("tests/contract/permission-cases-v1.json");
  assert.deepEqual(
    fixture.forms.map(({ form }) => form),
    ["absent", "undefined", "null", "documented-default", "explicit-nondefault"]
  );
  assert.equal(JSON.stringify({ value: undefined }), "{}");
  assert.equal(JSON.stringify({ value: null }), "{\"value\":null}");

  const schemaFiles = new Map([
    ["thread/start", "ThreadStartParams.json"],
    ["thread/resume", "ThreadResumeParams.json"],
    ["thread/fork", "ThreadForkParams.json"],
    ["turn/start", "TurnStartParams.json"],
    ["review/start", "ReviewStartParams.json"]
  ]);
  const permissionKeys = new Set([
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "sandboxPolicy"
  ]);
  for (const version of fixture.versions) {
    for (const method of fixture.methods) {
      const schema = readJson(
        `contracts/codex/snapshots/${version}/stable/json-schema/v2/${schemaFiles.get(method.method)}`
      );
      const observed = Object.keys(schema.properties).filter((key) => permissionKeys.has(key)).sort();
      assert.deepEqual(observed, [...method.exactSchemaKeys].sort(), `${version}/${method.method}`);
    }
  }
});

test("P4-COMMAND-001: command manifest covers protected entrypoints and outbound methods", () => {
  const manifest = readJson("contracts/codex/command-semantics-v1.json");
  const transcripts = readJson(manifest.transcriptFixture);
  const commandNames = readdirSync(
    path.join(repoRoot, "plugins", "codex", "commands"),
    { withFileTypes: true }
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `/codex:${entry.name.slice(0, -3)}`)
    .sort();
  assert.deepEqual(manifest.commands.map(({ command }) => command).sort(), commandNames);
  assert.equal(manifest.environmentPolicy.ambientCodexAllowed, false);
  assert.equal(manifest.normalization.rawPromptCommitted, false);
  assert.equal(manifest.normalization.rawTranscriptCommitted, false);
  assert.deepEqual(
    [...new Set(transcripts.commands.map(({ command }) => command))].sort(),
    commandNames
  );

  const codexSource = readFileSync(
    path.join(repoRoot, "plugins", "codex", "scripts", "lib", "codex.mjs"),
    "utf8"
  );
  const methods = new Set(
    manifest.commands.flatMap((command) => [
      ...(command.outbound ?? []),
      ...(command.outboundFresh ?? []),
      ...(command.outboundResume ?? [])
    ])
  );
  for (const method of methods) {
    if (method !== "initialize" && method !== "initialized") {
      assert.ok(codexSource.includes(`"${method}"`), method);
    }
  }
});

test("P4-COMMAND-002: captured product traffic matches exact ordered command DTOs", async () => {
  const fixture = readJson("tests/contract/command-transcripts-v1.json");
  const root = makeP4TempRoot("command-transcripts");
  const bin = installP4FakeCodex(root);
  const codexHome = path.join(root, "codex-home");
  const pluginData = path.join(root, "plugin-data");
  mkdirSync(codexHome);
  const projectDir = path.join(root, ".claude", "projects", "-fixture");
  mkdirSync(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, "session.jsonl");
  writeFileSync(sourcePath, "{}\n", "utf8");
  writeFileSync(path.join(root, "README.md"), "P4 fixture\n", "utf8");
  const cli = path.join(
    repoRoot,
    "plugins",
    "codex",
    "scripts",
    "codex-companion.mjs"
  );

  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "P4 Fixture"],
    ["config", "user.email", "p4@example.invalid"],
    ["config", "commit.gpgsign", "false"],
    ["add", "README.md"],
    ["commit", "-m", "fixture"]
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const runCli = (args, env, expectedStatus = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    return result;
  };

  const operations = {
    setup: (env) => runCli(["setup", "--json"], env),
    review: (env) => runCli(["review"], env),
    adversarial: (env) =>
      runCli(["adversarial-review", "P4 adversarial fixture"], env),
    "rescue-fresh": (env) =>
      runCli(["task", "--fresh", "P4 rescue fixture"], env),
    "rescue-resume": (env) =>
      runCli(["task", "--resume", "P4 resume fixture"], env),
    transfer: (env) => {
      const result = runCli(
        ["transfer", "--source", sourcePath, "--json"],
        env,
        1
      );
      assert.match(result.stderr, /did not record an imported thread/);
    },
    status: (env) => runCli(["status", "--json"], env),
    result: (env) => runCli(["result", "--json"], env),
    cancel: (env) => {
      const stateDir = resolveStateDir(root);
      const jobsDir = path.join(stateDir, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      const logFile = path.join(jobsDir, "p4-live.log");
      writeFileSync(logFile, "", "utf8");
      writeFileSync(
        path.join(jobsDir, "p4-live.json"),
        `${JSON.stringify({
          id: "p4-live",
          status: "running",
          title: "Codex Task",
          threadId: "thr_cancel",
          turnId: "turn_cancel",
          logFile
        }, null, 2)}\n`,
        "utf8"
      );
      writeFileSync(
        path.join(stateDir, "state.json"),
        `${JSON.stringify({
          version: 1,
          config: { stopReviewGate: false },
          jobs: [{
            id: "p4-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            threadId: "thr_cancel",
            turnId: "turn_cancel",
            pid: null,
            logFile,
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:01.000Z"
          }]
        }, null, 2)}\n`,
        "utf8"
      );
      const result = runCli(["cancel", "p4-live", "--json"], env);
      assert.equal(JSON.parse(result.stdout).turnInterrupted, true);
    }
  };

  try {
    for (const scenario of fixture.commands) {
      const capturePath = path.join(root, `${scenario.scenario}.jsonl`);
      const needsDirectFallback = [
        "review",
        "adversarial",
        "rescue-fresh",
        "rescue-resume"
      ].includes(scenario.scenario);
      const env = fakeCodexEnv(bin, capturePath, {
        CODEX_HOME: codexHome,
        HOME: root,
        USERPROFILE: root,
        CLAUDE_PLUGIN_DATA: pluginData,
        CODEX_COMPANION_APP_SERVER_ENDPOINT: needsDirectFallback
          ? `pipe:\\\\.\\pipe\\p4-missing-${scenario.scenario}`
          : undefined
      });
      await withProcessEnvironment(
        {
          PATH: env.PATH,
          P4_CAPTURE_PATH: env.P4_CAPTURE_PATH,
          CODEX_HOME: env.CODEX_HOME,
          HOME: env.HOME,
          USERPROFILE: env.USERPROFILE,
          CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA,
          CODEX_COMPANION_APP_SERVER_ENDPOINT:
            env.CODEX_COMPANION_APP_SERVER_ENDPOINT
        },
        () => operations[scenario.scenario](env)
      );
      assert.deepEqual(
        capturedTranscript(capturePath, {
          root,
          sourcePath,
          pluginVersion: readJson("plugins/codex/.claude-plugin/plugin.json").version,
          prompts: [
            "P4 adversarial fixture",
            "P4 rescue fixture",
            "P4 resume fixture"
          ]
        }),
        [
          ...(scenario.prefix === null
            ? []
            : fixture.prefixes[scenario.prefix]),
          ...scenario.transcript
        ],
        scenario.scenario
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P4-FINALIZER-001: F1-F12 registry is complete, negative, and fixture-only", () => {
  const registry = readJson("contracts/codex/finalizer-characterization-v1.json");
  assert.equal(registry.runtimeImplemented, false);
  assert.equal(registry.deferredPhase, "v0.2");
  assert.equal(registry.experimentalAggregationAllowed, false);
  assert.deepEqual(
    registry.requirements.map(({ requirement }) => requirement),
    Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
  );
  assert.ok(registry.requirements.every(({ behaviorStatus }) => behaviorStatus === "red"));
  assert.ok(registry.requirements.every(({ runtimeEnforced }) => runtimeEnforced === false));
  assert.equal(registry.guardCorpus.executionPolicy, "data-only-never-execute-in-p4");
  assert.equal(registry.snapshotCorpus.executionPolicy, "data-only-no-restore-in-p4");
});

test("P4-RESOURCE-001: measured values are candidates, never runtime enforcement", () => {
  const resources = readJson("contracts/codex/resource-candidates-v1.json");
  assert.equal(resources.status, "measurement-candidates-only");
  assert.equal(resources.runtimeEnforced, false);
  assert.equal(resources.trafficBaseline.valuesPendingActualIntegration, false);
  assert.equal(resources.trafficBaseline.observedRuns, 4);
  assert.deepEqual(resources.trafficBaseline.messageCountRange, [27, 29]);
  assert.deepEqual(resources.trafficBaseline.totalBytesRange, [11850, 14369]);
  assert.deepEqual(resources.trafficBaseline.maxMessageBytesRange, [1686, 3116]);
  assert.deepEqual(resources.trafficBaseline.modelRequestBodyBytesRange, [42931, 46049]);
  assert.equal(resources.trafficBaseline.rawPromptOrPayloadCommitted, false);
  assert.equal(resources.trafficBaseline.runtimeEnforced, false);
  assert.equal(resources.protocol.automaticRetryCount.releaseCorrectnessCandidate, 0);
});
