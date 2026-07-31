# P4 Codex contract baseline

Date: 2026-07-31

Platform: Windows x64, Node.js 24.18.1, npm 11.16.0

P3 base: `34559b5a55fbc3b171e3f472080729795632b74f`

Reviewed contract source: `843e679a90d4ef6946af251d36f43d257f8a5a10`

The final evidence commit adds only source binding and revalidation records on
top of that source.

## 1. Boundary and status model

P4 is a snapshot and characterization baseline. It does not replace the P2
generated consumer declaration and does not change the P2/P3 parser, queue,
approval, broker, job state, Stop hook, finalizer, guard, or recovery behavior.
Fixture execution status and characterized product behavior are separate:
`executed-pass` means the oracle ran successfully; it does not turn a `red`
runtime behavior into a safety claim.

The exact manifest is
[contract-tools-v1.json](../../contracts/codex/contract-tools-v1.json).
Build and current both use Codex 0.146.0, but the build lane retains its
regression/schema-generation role. Current 0.146.0 and previous 0.145.0 are
separate blocking stable lanes. Prerelease 0.147.0-alpha.2 is deferred;
mutable `latest` and ambient/global Codex are rejected.

## 2. Exact admissions

| Lane | Version | Release tag / commit | Windows x64 executable SHA-256 | Result |
| --- | --- | --- | --- | --- |
| build | 0.146.0 | `rust-v0.146.0` / `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` | `bc343ba420dc2e2e9f59e6fc5e5bf0aae1cd8c771fc319665241fc9c0271fddb` | accepted |
| current | 0.146.0 | `rust-v0.146.0` / `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` | `bc343ba420dc2e2e9f59e6fc5e5bf0aae1cd8c771fc319665241fc9c0271fddb` | accepted |
| previous | 0.145.0 | `rust-v0.145.0` / `25af12f7e61572b0bc18ddb1008be543b91519b0` | `83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c` | accepted |

Both ZIP and executable SHA-256 values were checked. Both executables returned
their exact versions and had a valid observed OpenAI OpCo, LLC Authenticode
signature with the exact reviewed leaf certificate. The official npm package
and platform-package integrity values and their empty lifecycle-script surfaces
are retained in the manifest. The exact installer writes only to a fresh
run-owned root outside the repository.

## 3. Versioned schema snapshots

The committed [snapshot manifest](../../contracts/codex/snapshots/snapshot-manifest.json)
covers these separate surfaces for both versions:

- stable TypeScript;
- stable JSON Schema;
- experimental TypeScript;
- experimental JSON Schema.

The combined snapshot contains 3,881 files and 13,852,289 bytes. Its canonical
tree digest is
`820456f8bdc229db1076604cafbddfd75974310e2fe0936136f6748dc8d21749`.
The digest frames each UTF-8-ordinal relative path, NUL, raw file bytes, and NUL;
only the root snapshot manifest and host metadata are excluded.

Two raw generator runs first exposed order drift in only
`codex_app_server_protocol.v2.schemas.json`. All other files were byte-identical,
and parsed paths, arrays, and scalar values matched. The generator therefore
recursively sorts object keys in that aggregate file only and preserves arrays
and scalar values. Two independent normalized run-owned roots then produced the
same canonical digest, and the committed snapshot had byte diff exit 0.

Stable method counts remain separate from Experimental:

| Version | Surface | client requests | server requests | notifications |
| --- | --- | ---: | ---: | ---: |
| 0.146.0 | stable | 90 | 10 | 70 |
| 0.146.0 | experimental | 127 | 11 | 70 |
| 0.145.0 | stable | 89 | 10 | 70 |
| 0.145.0 | experimental | 126 | 11 | 70 |

## 4. Protocol and lifecycle characterization

The dependency-free fixture parser in
[p4-jsonl-fixture.mjs](../../scripts/lib/p4-jsonl-fixture.mjs) preserves signed
64-bit integer lexemes and distinguishes numeric `1` from string `"1"`.
Positive fixtures cover LF, CRLF, multiple messages per chunk, arbitrary chunk
splits, multibyte UTF-8, minimum and maximum signed 64-bit IDs, and out-of-order
correlation. Negative fixtures reject duplicate keys, float/null/out-of-range
IDs, result-plus-error, invalid UTF-8, BOM, NUL, incomplete EOF, unknown
responses, and duplicate responses.

The lifecycle corpus requires response admission, root completion, and all
observed children before terminal state. It covers response/event reordering,
root/child ordering, duplicate and late completion, cancellation, and transport
EOF without root completion. It never treats interrupt acknowledgement or EOF
alone as success.

Both 0.146.0 and 0.145.0 executed direct and broker
`initialize → thread/start → turn/start → turn/completed → thread/resume`, plus
`turn/interrupt → turn/completed(interrupted)`, with automatic retry 0. Direct
initialize came from app-server. The current broker has no separate
`broker/hello`, returns `-32600`, synthesizes initialize, and swallows
initialized. Those runs are `executed-pass`; broker handshake conformance
remains `red`.

The [command manifest](../../contracts/codex/command-semantics-v1.json) binds
all eight protected user commands to argv classes, transport, outbound methods,
stdout/stderr, exit classes, and permitted dynamic normalization. Its companion
fixture runs the actual command entrypoints and compares their traffic to exact
ordered request DTOs, retaining static values while normalizing only paths,
IDs, fixture prompts, and output-schema bytes. It includes fresh/resume and
zero-transport commands. The stable server-request fixture matches the ten methods in both
supported snapshots; a spawned product-client probe preserves string and
numeric IDs, never auto-grants, and returns exact generic `-32601` responses.
The absent latch/interrupt/terminal confirmation remains `red`. Permission
fixtures distinguish absent, own-undefined, null, documented default, and
explicit nondefault forms.

The P4 validator applies both committed Draft 2020-12 evidence schemas through
nested objects and arrays, rejects unsupported validation keywords, recomputes
every JSON Schema method inventory from committed bytes, and binds snapshot
generation to Windows x64 and Node 24.18.1. A negative tree fixture confirms
that only the root `snapshot-manifest.json` is excluded.

## 5. F1–F12 and resource truth

The [F1–F12 registry](../../contracts/codex/finalizer-characterization-v1.json)
classifies every requirement as `red`, `runtimeImplemented: false`, and
`deferredPhase: v0.2`. Guard and recovery inputs are data-only corpora and are
never executed as destructive actions in P4.

The [resource candidates](../../contracts/codex/resource-candidates-v1.json)
are measurement candidates only. The final four lifecycle runs observed 27–29
protocol messages, 11,850–14,369 total protocol bytes, maximum message sizes of
1,686–3,116 bytes, zero server requests, and zero stderr bytes. P4 does not
install production line, depth, queue, stderr, workspace-size, or retention
limits.

## 6. Local validation

The exact install acquired 3 packages, audited 4, and reported zero
vulnerabilities. P4 targeted tests passed 40/40; the P3 validator and P3
targeted tests passed 11/11. The exact build Codex reproduced P2 generated
schema digest
`e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834`
and TypeScript compilation passed.

Actionlint 1.7.12, offline pedantic strict-collection Zizmor 1.28.0,
OSV-Scanner 2.4.0, and Gitleaks 8.30.1 passed. Claude 2.1.196 and 2.1.220
strict validation passed both marketplace root and plugin, 2/2 per lane.

The pre-final full serial trial passed 159/160 and retained the unchanged
Windows broker-cancel cleanup test's documented localized `taskkill` child-exit
race. The exact fixture passed 1/1 alone. The reviewed source
`a94232decb474de32e1b19a26764005ab9cada51` passed 160/160 before independent
review. The exact review-corrected source
`843e679a90d4ef6946af251d36f43d257f8a5a10` then passed 167/167 with zero failures,
cancellations, or skips, first trial, and retry 0. Earlier failures remain in
the attempt ledger and are not replaced by the final result.

## 7. Immutable readback and privacy

The following P2/P3 values remain exact:

- protected canonical digest:
  `b24fec394e331f6b550dfdb614be07ec19955c9f95288951afbcac4e4c8d0473`;
- generated consumer declaration:
  `c4d141174754e04ef1cd1b904cd800d05e3174a772f86f0fc9c3f4d30ec3daf5`;
- generated schema:
  `e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834`;
- P3 toolchain:
  `a6033a05ebecd4ff5bca3a5924ff06e55a2e2de9b41541da2c050642102dbb5d`;
- P3 security policy:
  `f4353ad5c207396f6c6c314aa522e16b556db81f2b0f18bb10741d5f4d8a9957`;
- lockfile:
  `db1fb9ad6eb54eaabddc2f138c48435bd04feb04079b51c37838375e2b3e4f8b`.

No P4 binary or downloaded archive is committed. Evidence contains no raw
model payload, live prompt, environment dump, credential, or private host path.
Remote CI, current/previous hosted matrix, dependency review, signing,
attestation, P5, P6, v0.2 runtime work, push, PR, tag, release, and publication
are `NOT-RUN` or deferred.

## 8. Attempts and review

The [attempt ledger](../../evidence/ledgers/p4-attempts.json) retains the
initial 0/18 RED, blocked-before-execution calls, PowerShell harness errors,
raw schema order drift, superseded digest framing, broker harness corrections,
the pre-final full-suite race, all eleven findings from two review passes, the
ephemeral-resume correction, raw exits, corrections, and retry counts.

The [evidence manifest](../../evidence/manifests/p4/p4-contract-baseline-20260731.json)
binds checks to the contract source, exact lanes, fixture IDs, execution status,
behavior status, runtime enforcement, artifacts, and deferral phase.
Two independent review passes reported eleven actionable findings in total;
all eleven were accepted, corrected, and revalidated.
