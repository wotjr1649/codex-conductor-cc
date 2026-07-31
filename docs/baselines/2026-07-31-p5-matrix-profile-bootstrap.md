# P5 Windows x64 matrix/profile bootstrap

Date: 2026-07-31
Source commit: `57e5b8881009fe799602aa4dab2c22db79d2473a`
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
the committed bootstrap keeps those fields null. Blocking-job finalizers run
after any non-cancelled outcome, distinguish a direct process exit from a
GitHub job-status normalization, and cannot turn a blocked or unimplemented
profile into an executed pass.

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

P5 adds 17 semantic/profile and independent Windows resource tests. The
resource oracle starts an exact owned root and child PID, proves an exclusive
file handle blocks rename, calls the exact `taskkill /PID <root> /T /F`
executable through a five-second bounded process, reads back that both PIDs are
gone, then proves rename/delete succeeds. This is not a native Job Object C0
claim.

The last wholly green exact-Node full regression passed 184/184 with zero
failure, cancel, or skip before the final collector-only provenance delta.
At source `57e5b8881009fe799602aa4dab2c22db79d2473a`, the final P5 and independent
Windows resource partition passed 17/17. Two subsequent full reruns each passed
183/184, and two isolated runs reproduced the sole inherited Windows
broker-cancel race: the turn interrupt completed and its worker tree exited
before `taskkill /T` read back already-ended descendants as exit 1. The P5
diff does not touch the fixture, broker, cancel, or process implementation;
the same race is retained in earlier P4 and P5 ledgers. All four new failures
remain ordered in the attempt ledger and are not rewritten as passes.

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
tools. The Claude checks are structural marketplace/plugin validation only;
they are not authenticated inference or install/update/rollback/uninstall
lifecycle evidence.

The final source also passed 17/17 targeted P5 and Windows checks, five of five
PowerShell parser checks, actionlint, offline pedantic strict zizmor, OSV
Scanner, gitleaks, clean install, and build. Four independent frozen-tree
reviews found no actionable P0-P2 issue in the workflow, PowerShell writers,
hosted collector, or protected-scope boundary. The inherited cancel race is a
local pre-push regression blocker unless a clean full run is observed or a
separately authorized product-scope repair is made; it is not represented as a
hosted failure because remote execution remains `NOT-RUN`.

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
  wrapper check was corrected;
- review hardening initially passed 13/14 because its validator required a
  literal pass status instead of the bounded dynamic failure finalizer; the
  validator was corrected and the same targeted set then passed 14/14; and
- a first full-suite invocation hit its 124-second local harness bound, after
  which only exact run-owned Node processes were stopped and a new 300-second
  invocation passed 181/181; and
- final evidence validation rejected a standard `anyOf` keyword that the
  repository's restricted schema engine does not implement; the equivalent
  null-or-SHA-256 constraint was re-encoded with a supported type array, and
  validation plus 181/181 tests passed at the new final source commit; and
- the final independent review found that the current-only P4 contract flag
  could be disabled without a validator error and that setup/Node failures
  could prevent failure JSON. Both P1 findings were reproduced, accepted, and
  fixed: the validator now pins the lane flags and exact conditional step, the
  clock starts immediately after checkout, failure-only Node identity can be
  nullable with an explicit status, and every passing record still requires
  exact Node/npm/x64 bytes; and
- the final fix review then demonstrated that a no-op could replace the P4
  contract invocation while retaining its path string. The P1 was reproduced
  and fixed by binding the exact single-line command and adding negative no-op
  and appended-success mutations. Its first boundary expression rejected the
  valid workflow's blank line (13/14); that RED is retained, and the corrected
  expression passed 14/14; and
- the bounded follow-up review found that an inert PowerShell here-string in a
  block-scalar step could still contain a decoy matching sequence. Main-agent
  reproduction produced 12/13 RED. The validator now requires one unique
  inline command at the exact YAML step/property indentation, the new decoy
  negative passed, and targeted validation returned 14/14. The first full run
  overlapped unrelated exact-lane checks and retained an inherited
  broker-cancel `taskkill` race at 180/181; after zero owned-process readback,
  the full suite ran alone and passed 181/181 at that source commit; and
- hosted provenance hardening added exact workflow-byte binding, failure-path
  clocks and writers, immutable run/PR/job/check provenance, exact source-object
  digests, nested fragment validation, and read-only artifact/cache trust
  readback. The hardened partition passed 17/17 at the new source commit; and
- two post-hardening full reruns retained the existing Windows broker-cancel
  race at 183/184, with two isolated 0/1 reproductions between them after related
  process count was zero. Independent diagnosis confirmed that the fixture
  emits turn completion before the interrupt RPC response and the protected
  localized `taskkill` handler treats this partial-success exit 1 as fatal.
  No product/runtime file was changed under the provenance-only authorization.

No failed or cancelled attempt was rewritten as a pass.

## Privacy and trust boundary

No secret, credential value, raw environment, raw prompt, raw command output,
private host path, downloaded binary, or archive is committed. Tool acquisition
and process fixtures use run-owned paths outside the repository. Workflow
caches and repository-authored artifact uploads are disabled. The pinned
dependency-review action can conditionally upload its own summary when rendered
content exceeds 1 MiB; that action-owned artifact has one-day retention and is
not a release-trust input. Authenticated Claude inference was not authorized
and was not run.

P5 adds repository ownership entries for the workflow, CI policy, P5 scripts,
tests, and evidence. The current remote protection snapshot requires the
legacy `CI` context and resolved conversations but does not demonstrate
CODEOWNERS review or administrator enforcement. P5 did not change those remote
settings.

## Explicit gaps

The following remain false or not run:

- GitHub-hosted `windows-2025` image/build/architecture/filesystem evidence;
- hosted dependency review and the aggregate required `CI` status;
- hosted confirmation that the fork pull-request dependency-review job can
  read its comparison in the workflow token context;
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
The requested `windows-2025` label denotes a GitHub-hosted Windows Server 2025
x64 image, not Windows 11; Windows 11 remains an explicit disposable-runner
gap.
