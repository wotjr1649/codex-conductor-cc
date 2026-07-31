# P5 Windows x64 matrix/profile bootstrap

Date: 2026-07-31
Source commit: `6fe4694018075782e9e80e7de9fe11a4b54c6dee`
Handoff commit: `84515289913dfe8a7452754ad442d37873bdfd53`
Platform: Windows x64, exact Node.js 24.18.1 and npm 11.16.0

## Outcome

P5 defines a job-scoped pull-request workflow and validates its supported
profiles locally. The local bootstrap is `executed-pass`. GitHub-hosted
execution was not authorized and is therefore `NOT-RUN`, so overall P5 status
is `partial`. This baseline is not a hosted CI pass and is not release
evidence.

The immutable P4 evidence separately retains a `blocked-with-evidence` source
binding defect because it records a source commit that does not resolve. The
actual parent of the P4 final commit is
`843e679936daba71a6c4c2fdd55fcade01b46b73`; the recorded value is
`843e679a90d4ef6946af251d36f43d257f8a5a10`. P5 does not rewrite P4 evidence.

## Workflow

The workflow uses `pull_request`, read-only contents permission, an exact
workflow/ref concurrency group, cancellation, job timeouts, and the mutable
`windows-2025` label. Every executable profile except GitHub's
dependency-review action has a sanitized runner-evidence step. The evidence
writer records the actual hosted image/build/filesystem only after a real run;
the committed bootstrap keeps those fields null.

The blocking profiles are:

- policy validation, including P3, the exact P4 handoff adapter, and P5;
- exact dependency install and generated TypeScript build;
- the unit partition;
- current/previous exact Codex contract and lifecycle lanes;
- serial Windows integration with a process-tree and exclusive-handle oracle;
- minimum/current exact Claude structural lanes without authentication;
- actionlint, zizmor, OSV Scanner, and gitleaks;
- GitHub dependency review; and
- the terminal legacy status context named `CI`.

The exact Codex `0.147.0-alpha.2` lane is isolated, non-blocking, and excluded
from the `CI` gate. No other job has `continue-on-error`.

## Test partition

All 13 inherited test files map to exactly one blocking profile. The committed
P4 total remains 167 tests with zero skip:

- policy: 11;
- unit: 30;
- P4 targeted contract: 40; and
- Windows integration: 86.

P5 adds semantic profile tests and an independent Windows resource oracle. The
resource oracle starts an exact owned root and child PID, proves an exclusive
file handle blocks rename, calls the existing `taskkill /PID <root> /T /F`
implementation, reads back that both PIDs are gone, then proves rename/delete
succeeds. This is not a native Job Object C0 claim.

The final exact-Node full regression passed 177/177 with zero failure and zero
skip at source `6fe4694018075782e9e80e7de9fe11a4b54c6dee`. An earlier source
revision's 176/177 broker-cancel race remains in the attempt ledger.

## Exact tools

Blocking lanes use the immutable admitted identities:

- Node.js 24.18.1 / npm 11.16.0;
- Codex current 0.146.0 and previous 0.145.0;
- Claude minimum 2.1.196 and current 2.1.220;
- actionlint 1.7.12, zizmor 1.28.0, OSV Scanner 2.4.0, and
  gitleaks 8.30.1; and
- full-commit pins for checkout v6.0.2, setup-node v6.3.0, and
  dependency-review v5.0.0.

The current v7 GitHub action tags were not admitted because P3 explicitly
deferred those upgrades and P5 found no compatibility or security requirement
that justified changing the immutable toolchain.

## Local observations

Exact local checks passed for clean install, P3 validation, detached P4
validation, targeted P4 tests, generated schema reproduction, TypeScript build,
current/previous direct and broker lifecycle, minimum/current Claude strict
plugin validation, Windows process/handle postconditions, and the four security
tools.

The ordered attempt ledger retains all material failures. In particular:

- the initial P5 test produced meaningful RED;
- zizmor found and drove removal of 24 direct template expansions in run
  blocks;
- the fresh P4 validator required exact generated-tree reproduction; the
  final adapter invokes only the dependency-free generation path before the
  repository clean install;
- an aggregate tool-acquisition call timed out while two Claude downloads were
  still in flight, after which their exact owned processes were stopped and
  the lanes were acquired sequentially;
- the first combined Windows profile saw one existing broker-cancel
  `taskkill` race, while the same exact serial command passed 87/87 alone; and
- the first P5 lifecycle wrapper incorrectly expected an uncontracted `lane`
  field; the unchanged P4 runner demonstrated correct CLI behavior and the
  wrapper check was corrected.

No failed or cancelled attempt was rewritten as a pass.

## Privacy and trust boundary

No secret, credential value, raw environment, raw prompt, raw command output,
private host path, downloaded binary, or archive is committed. Tool acquisition
and process fixtures use run-owned paths outside the repository. Workflow
caches and artifact uploads are disabled. Pull-request artifacts are not
release trust inputs. Authenticated Claude inference was not authorized and was
not run.

## Explicit gaps

The following remain false or not run:

- GitHub-hosted `windows-2025` image/build/architecture/filesystem evidence;
- hosted dependency review and the aggregate required `CI` status;
- authenticated Claude lifecycle or paid inference;
- the non-blocking next-Codex canary;
- disposable Windows 11 x64 runner evidence;
- a compiled native Windows capability artifact and C0 digest; and
- a shipping SQLite binding, DDL, migration, and D1 runtime.

Windows C0 and SQLite D1 remain `blocked-with-evidence` and deferred to v0.2.

## Hosted handoff

If remote execution is separately authorized, create or update a pull request
at the exact P5 source/evidence commits without changing repository settings,
then observe every blocking job and the terminal `CI` context. Record each
runner's actual image version, OS build, x64 architecture, NTFS filesystem,
exact tool identities, attempt number, timeout, raw exit code, and resource
postconditions using the sanitized writer. A cancelled run, a canary pass, a
YAML definition, or a local pass must not satisfy a hosted blocking profile.
