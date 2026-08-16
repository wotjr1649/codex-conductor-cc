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
That date is recorded, not enforced: validation checks the policy's shape, its
owner and reviewer, and that it declares drift triggers, and it does not fail on
the calendar. A date cannot know whether anything drifted, and enforcing one
stops unrelated work on a morning nobody chose. The triggers are what force a
review. Review occurs when a Node 24 security release appears, a vendor key or
artifact changes, a relevant vulnerability lands, an Action changes runtime,
or a source/license/manifest identity drifts. Exact regression pins remain
immutable; only claims such as “current” expire.

## Portability workflow

`.github/workflows/portability-ci.yml` is the read-only `pull_request`
workflow for Windows x64, Linux x64, macOS x64, and macOS arm64. It uses
literal runner labels, full-SHA checkout/setup actions, exact Node 24.18.1,
no persisted checkout credential, and runtime jobs that do not acquire Codex
or Claude artifacts. A separate Windows security job uses the existing
digest-verifying installer for the exact admitted actionlint, zizmor, OSV, and
gitleaks versions; dependency review uses its full-SHA Action. The terminal
gate requires the four runtime profiles plus both security jobs and rejects
`continue-on-error`. No job receives secrets, uses caches, or uploads release
artifacts. The Windows runtime lane restores only `package-lock.json`
dependencies through `npm ci --ignore-scripts --no-audit --no-fund`. It
validates the GitHub run IDs, creates a fresh non-reparse `C:\p6-temp-*`
directory on the ephemeral runner, and scopes `TEMP`/`TMP` to that directory
so path-safety tests do not inherit the hosted workspace redirect.

`ci/portability-profiles-v1.json` records reviewed Node, Codex, and Claude asset
metadata for the four supported tuples, but those records are compatibility
catalog entries rather than executable acquisition authority. Adding an
installer or automated native-signing admission later requires a separate
supply-chain threat review.

The released P5 workflow body remains byte-for-byte historical evidence. Its
automatic PR trigger is archived as `workflow_dispatch`, which this release
does not invoke; the portability continuation validator permits only that
exact trigger replacement. The continuation runs at the final P5 frontier,
after legacy source-binding, immutable-path, scope, privacy, and binary checks,
and consumes only the exact legacy errors tied to the reviewed base and
portability path set.
