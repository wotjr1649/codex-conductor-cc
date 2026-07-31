# P3 threat and toolchain baseline

## 1. Local 판정

P3 source와 local evidence는 complete다. Exact P2 final
`7c65444eb5c1b372b369f71e1d496eafa7a1fc92`에서 분기했고 command/runtime,
P2 identity, generated schema, protected trees, lockfile, LICENSE/NOTICE를
변경하지 않았다.

이 판정은 remote CI, branch protection enforcement, signing, attestation,
tag, release 또는 publication을 포함하지 않는다. 모두 `NOT-RUN REMOTELY`다.

## 2. Lineage와 logical commits

- base: `7c65444eb5c1b372b369f71e1d496eafa7a1fc92`
- upstream base: `db52e28f4d9ded852ab3942cea316258ae4ef346`
- branch: `codex/p3-threat-toolchain-baseline`
- policy commit: `6a1c5f40036c1a8ee3a6791bd06269030e719898`
- toolchain gate commit: `1c5870b0a9e24852417418ecd602977fafb4202d`
- independent-review hardening commit:
  `3a45a1a9dadeda40bf9753c6568728bd36b2708b`
- 이 문서와 final manifest/ledger는 마지막 local evidence commit에서 함께
  고정한다.

Planning lineage는 reference로만 읽었고 merge/cherry-pick하지 않았다.
Self-contained policy closure는 [SECURITY](../../SECURITY.md),
[threat model](../security/THREAT_MODEL.md),
[repository security](../security/REPOSITORY_SECURITY.md), 그리고
[machine policy](../../security/p3-policy.json)로 구성했다.

## 3. Requirement 연결

| Requirement | P3 artifact/evidence | 최종 상태 |
| --- | --- | --- |
| X3 unattended approval | `SEC-APPROVAL-002` | `specified`, P4 deferred |
| X4 same-user/IPC | `SEC-BOUNDARY-001` | `specified`, v0.2 deferred |
| X7 release provenance | `SEC-RELEASE-001` | `specified`, P6 deferred |
| X8 evidence truth | versioned schema, ordered attempt ledger, source-bound first trial | local `static-pass` |
| X9 data/log privacy | seeded negative + redacted positive | evidence pipeline pass; product logs P4 |
| X12 signing/attestation | explicit none/not-run | P6 deferred |
| X14 IPC/path boundary | policy + acquisition fixture | product runtime v0.2 deferred |
| X15 executable identity | exact run-owned installer | acquisition pass; product runtime v0.2 |
| X17 public artifact | no artifact and no publication | P6 deferred |

The existing named pipe is not an isolation boundary, peer identity is only
an admission signal, same-user isolation is not guaranteed, and unattended
approval must deny or interrupt. These are policy statements, not P2 runtime
GREEN claims.

## 4. Admitted exact toolchain

The canonical machine-readable record is [toolchain.json](../../toolchain.json),
SHA-256
`a6033a05ebecd4ff5bca3a5924ff06e55a2e2de9b41541da2c050642102dbb5d`.
All artifacts were acquired outside the repository and both archive/file and
selected executable digests were checked.

| ID | Version / source commit | Windows x64 identity | Signature status | License / disposition |
| --- | --- | --- | --- | --- |
| Node.js | 24.18.1 / `9623d9ad85d37d2f0610ec4a82b48182cf2c6061` | ZIP `ec56b8…3765`, exe `ac5190…8582` | signed checksums published, GPG not run | MIT, accepted security release |
| npm | 11.16.0 / `960135ad6e26b2b656e23848690c9cfe3cb3783b` | inherited exact Node archive | Node signature state inherited | Artistic-2.0, bundled only |
| Codex | 0.146.0 / `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` | exe `bc343b…fddb` | Authenticode exact subject/thumbprint valid | Apache-2.0, P2 regression only |
| Claude minimum | 2.1.196 / public `c80896…`, build `a4ca50…` | exe `180d7b…f09` | Authenticode exact subject/thumbprint valid; detached manifest signature not run | commercial terms, project floor |
| Claude current | 2.1.220 / public `7ef6ee…`, build `4073f5…` | exe `af5bf1…231` | Authenticode exact subject/thumbprint valid; detached manifest signature not run | commercial terms, current snapshot |
| actionlint | 1.7.12 / `914e7df21a07ef503a81201c76d2b11c789d3fca` | ZIP `6e7241…6e9`, exe `54ca21…718` | unavailable | MIT |
| Zizmor | 1.28.0 / `4381cc6339bb76a1004a99da929fe8f8f1143d94` | ZIP `06e5b2…c0f`, exe `607192…c0` | GitHub release attestation verified | MIT |
| OSV-Scanner | 2.4.0 / `b56b5191101d5f27d4787d5583d8d01e9518a7af` | exe `0cdd11…a37` | SLSA materials published, not verified | Apache-2.0 |
| Gitleaks | 8.30.1 / `83d9cd684c87d95d656c1458ef04895a7f1cbd8e` | ZIP `d29144…c4e`, exe `17157e…b7c` | unavailable | MIT |
| Syft | 1.50.0 / `16223e6dd7893fe578787658ceb876257483d404` | ZIP `815ee6…3be`, exe `98a377…398` | signed checksums published, not verified | Apache-2.0, spike only |

Reviewed Actions remain full-SHA pinned:

- checkout v6.0.2:
  `de0fac2e4500dabe0009e67214ff5f5447ce83dd`;
- setup-node v6.3.0:
  `53b83947a5a98c8d113130e565377fae1a50d02f`;
- dependency-review-action v5.0.0:
  `a1d282b36b6f3519aa1f3fc636f609c47dddb294`.

SPDX 2.3 is pinned to
`aadf3b0b8dbbabdb4d880b0fc714255fea436ff7`; SLSA 1.2 is reference-only at
`19e4e2f005f871270c4f555fc47afecfb37f3efe`. Node 24.18.0 was rejected as
superseded by the 24.18.1 security release. Mutable npm latest, global Codex,
unnecessary Action v7 upgrades, and P3 attestation were rejected or deferred.

Review date is 2026-07-31 and the current-label snapshot expires 2026-08-31.
A new Node 24 security release, signing-key or artifact change, relevant
vulnerability, license/source drift, or Action runtime change triggers earlier
review.

## 5. RED to GREEN and local execution

The initial targeted RED executed 8 tests: 1 passed and 7 failed for the
missing policy, exact toolchain, workflow, validator, installer, privacy, and
evidence controls. Final targeted execution contains 11 tests, including the
exact Gitleaks allowlist control and
adversarial workflow, evidence, link, reparse/tool-root, traversal, digest,
and signer-identity mutations; 11/11 passed.

| Validation | Final result |
| --- | --- |
| exact npm clean install | 3 packages installed, 4 audited, vulnerabilities 0 |
| repository P3 validator | pass |
| actionlint 1.7.12 | pass |
| Zizmor 1.28.0 | offline pedantic strict-collection, no findings |
| OSV-Scanner 2.4.0 | 3 locked packages, no issues |
| Gitleaks 8.30.1 | no leaks |
| Claude 2.1.196 | strict root/plugin 2/2 |
| Claude 2.1.220 | strict root/plugin 2/2 |
| Syft/SPDX spike | SPDX-2.3 JSON, CC0-1.0, 5 packages, 2 files |
| final targeted | 11/11 |
| final product suite | 127/127, no skip, first serial trial |
| exact Codex regression build | pass |
| generated schema | `e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834` |

The first final full suite was 125/126 because the unchanged Windows cancel
fixture hit the P2-documented `taskkill` child-exit race. The fixture passed
1/1 alone; the unchanged pre-final source retry passed 126/126. After
independent-review hardening, the final source passed 127/127 on its own first
serial trial.
Existing Node DEP0190 warnings from P2 shell-based child helpers remain
observed and were not introduced or hidden by P3.

The ephemeral final SPDX document digest is
`269aa7f5ad9a471f75fd078492d2918cb0d1deae90aaadebbec4bb036c609dc5`.
It is not retained in Git, is not a release SBOM, and is not an attestation.

## 6. P2 immutable readback

- package: `codex-conductor-cc` 0.1.0, private;
- upstream base: `db52e28f4d9ded852ab3942cea316258ae4ef346`;
- protected canonical inventory:
  `b24fec394e331f6b550dfdb614be07ec19955c9f95288951afbcac4e4c8d0473`;
- commands tree: `01dee9ba76393439e179c5676ea92e538358d86b`;
- agents tree: `e3d07a2c1a1acf9a986ecccd7e2b1c865b9da709`;
- skills tree: `1272de32547df5bb365e114feb590bfa002e53c1`;
- hooks tree: `39821e61e8b99bf415b7b05098b97d545fd377af`;
- root/plugin LICENSE:
  `5382d9ba43803da42433ae0025fe38d93c6e730d8824bd9e01af8e2f3c9c3833`;
- root/plugin NOTICE:
  `d8d0168f4940626032fe7a9d6e7a9b767b37f6c777a2140679e72e07afd1b8e0`.

Base-to-hardening diff has no protected runtime/plugin, downstream, lockfile,
LICENSE, NOTICE, or generated-schema changes. Direct and broker clientInfo
assertions remain in the passing product suite.

## 7. Attempt truth and independent review

The [attempt ledger](../../evidence/ledgers/p3-attempts.json) preserves
blocked-before-execution calls, initial RED, timeout 124, PowerShell harness
errors, exact corrections, Gitleaks certificate false positives, the Windows
cancel race, and test-owned broker cleanup. A zero process exit is never
silently treated as success when nonterminating PowerShell errors or residual
processes make the semantic result fail.

The unchanged pre-final source full-suite rerun is recorded as retry 1. The
final hardening source then passed its own first source-bound trial at ledger
attempt 50; that distinct result, not the earlier retry, supports X8.

The independent reviewer found and the main session fixed:

- stale toolchain/evidence digest binding and line-ending portability;
- incomplete evidence/privacy traversal;
- X7/P6 overclaim and ledger exit/status mismatch;
- workflow trigger, permission, Action allowlist, ordering, and strict Zizmor
  gaps;
- Claude public-tag/vendor-build ambiguity and incorrect SLSA commit;
- installer reparse ancestry, predictable existing root, ZIP traversal, and
  Authenticode substring checks;
- incomplete CODEOWNERS coverage and installer negative-test attribution;
- evidence field/set validation and exact Gitleaks allowlist enforcement.

The reviewer independently confirmed no P2 protected-surface regression and no
P4/P5/P6/v0.2 implementation scope intrusion.

## 8. Remote and deferred gates

- GitHub dependency review: pinned/static, `NOT-RUN REMOTELY`;
- branch/ruleset/CODEOWNERS enforcement: observed settings only, not enabled;
- signing and attestation: `not-run`, P6;
- current/previous Codex schema admission and lossless parser: P4;
- compatibility/repeat matrix: P5;
- tag/release/publication: P6;
- approval runtime enforcement and product-wide data redaction: P4/v0.2;
- same-user/session IPC and canonical product executable launch: v0.2.

No push, PR, workflow dispatch, hosted setting mutation, tag, release,
Marketplace/npm publication, signing, or attestation occurred.
