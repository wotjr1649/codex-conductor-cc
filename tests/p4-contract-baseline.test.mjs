import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CorrelationFixture,
  LosslessNumber,
  StrictJsonlFixture
} from "../scripts/lib/p4-jsonl-fixture.mjs";
import { LifecycleFixture } from "../scripts/lib/p4-lifecycle-fixture.mjs";
import {
  inspectSnapshotTree,
  sha256
} from "../scripts/lib/p4-snapshot.mjs";

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
  ["P4-RED-019", "current/previous direct/broker integration", "contracts/codex/lifecycle-integration-v1.json"]
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

test("P4-SNAPSHOT-001: committed tree matches its byte-framed digest", async () => {
  const snapshotRoot = path.join(repoRoot, "contracts", "codex", "snapshots");
  const manifestPath = path.join(snapshotRoot, "snapshot-manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const observed = await inspectSnapshotTree(snapshotRoot);

  assert.equal(manifest.schemaVersion, "p4-codex-snapshot-manifest-v1");
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

test("P4-SNAPSHOT-002: stable and experimental inventories remain separate", () => {
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
  }
  assert.equal(
    manifest.normalization.path,
    "**/json-schema/codex_app_server_protocol.v2.schemas.json"
  );
  assert.match(manifest.normalization.operation, /preserve arrays and scalar values/);
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
      if (fixture.notTerminalAfterEvent === index + 1) {
        assert.equal(state.terminal, false, fixture.id);
      }
    });
    const state = lifecycle.snapshot();
    assert.equal(state.terminal, fixture.terminal, fixture.id);
    if (fixture.duplicates !== undefined) {
      assert.equal(state.duplicates, fixture.duplicates, fixture.id);
    }
  }
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
  assert.doesNotMatch(brokerSource, /broker\/hello/);
});

test("P4-INTEGRATION-001: both stable lanes execute direct and broker core lifecycle", () => {
  const integration = readJson("contracts/codex/lifecycle-integration-v1.json");
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
    assert.equal(run.executionStatus, "executed-pass");
    assert.equal(run.retryCount, 0);
    assert.equal(run.normalTerminalStatus, "completed");
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
  assert.equal(resources.trafficBaseline.rawPromptOrPayloadCommitted, false);
  assert.equal(resources.trafficBaseline.runtimeEnforced, false);
  assert.equal(resources.protocol.automaticRetryCount.releaseCorrectnessCandidate, 0);
});
