# Repository security baseline

## Pull-request workflow

The PR workflow is intentionally unprivileged:

- event: `pull_request` only;
- token: `contents: read`;
- Windows 2025 x64 and exact Node.js from `toolchain.json`;
- Actions pinned to full commit SHA;
- checkout credentials are not persisted;
- no OIDC write, repository secrets, global package install, mutable tool
  channel, dependency cache, or uploaded artifact;
- a PR cache or artifact can never be a release input.

Dependency review is a separate read-only job. Local validation remains the
source of P3 evidence because this checkpoint does not activate or claim a
remote workflow run.

## Exact tool acquisition

`scripts/install-p3-tool.ps1` accepts a tool ID from `toolchain.json`, downloads
only its immutable URL into a caller-owned temporary root, verifies the
download digest, extracts within that root, verifies the selected executable,
and enforces the declared Authenticode policy. It never installs globally and
never trusts `PATH` to select a tool.

Unsigned open-source scanners are allowed only when their upstream release
commit, license, immutable URL, archive digest, and executable digest are all
recorded. “Signature published” and “signature verified” are different
states; P3 records them separately.

## Ownership and hosted settings

`CODEOWNERS` marks workflow, toolchain, policy, installer, validator, and
evidence schemas as security-sensitive. Read-only preflight found that the
public fork enables secret scanning, push protection, vulnerability alerts,
Dependabot security updates, private vulnerability reporting, SHA pinning,
and read-only default workflow permissions.

The same readback also found no repository ruleset, zero required approvals,
no required CODEOWNERS review, no administrator enforcement, and no required
commit signatures. These are observed hosted settings, not P3 GREEN controls.
No hosted setting was changed.

## Evidence policy

Evidence must use `evidence/schemas/p3-evidence-v1.schema.json`, explicit
execution statuses, sanitized environment classes, and an append-only ordered
attempt ledger. A blocked-before-execution attempt has `rawExitCode: null`.
Executed attempts keep the process's observed exit code; a PowerShell
nonterminating error can therefore be an `executed-fail` with exit code zero
only when the ledger explicitly marks that exit status as unreliable.
Failures are not overwritten by later corrections.

Raw secrets, bearer-like tokens, private user paths, and prompts are rejected.
The seeded-secret negative and redacted positive controls use the same
validator. Committed evidence stores only the seed fixture identity and digest,
never the generated marker.

## Review and drift

The current snapshot was reviewed on 2026-07-31 and expires on 2026-08-31.
Review occurs earlier when a Node 24 security release appears, a vendor key or
artifact changes, a relevant vulnerability lands, an Action changes runtime,
or a source/license/manifest identity drifts. Exact regression pins remain
immutable; only claims such as “current” expire.
