# P5 Windows x64 matrix/profile bootstrap

Date: 2026-07-31
Source commit: `4ad56ea41a479cae0950bce817760455d5fb87fc`
Handoff commit: `84515289913dfe8a7452754ad442d37873bdfd53`
Platform: Windows x64, exact Node.js 24.18.1 and npm 11.16.0

## Outcome

P5 defines a job-scoped pull-request workflow and validates its supported
profiles locally. The local bootstrap is `executed-pass`. Two authorized
natural GitHub-hosted pull-request attempts ran at heads `4eeeb17` and
`9d2422c`; both failed policy validation and terminal CI. The hosted gate is
therefore `executed-fail`, overall P5 is `blocked`, and P6 is no-go. This
baseline is not a hosted CI pass and is not release evidence.

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
the superseded v1 local-only bootstrap kept those fields null. The immutable
v2 schema remains unchanged. V3 binds both failed attempts, exact physical
jobs and steps, sanitized log projections, run-scoped artifact metadata, and
one current run-unattributed PR-ref cache snapshot. Blocking-job finalizers run
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

The portability-repair source also passed 17/17 targeted P5 and Windows
checks, five of five PowerShell parser checks, actionlint, offline pedantic
strict zizmor, OSV Scanner, gitleaks, clean install, and build. Bounded reviews
found no remaining actionable P0-P2 issue after fixed diagnostic tokens and
immediate temporary-directory cleanup were added. The v3 provenance-model
source `4ad56ea41a479cae0950bce817760455d5fb87fc` then passed bounded schema
and validator review after exact job-key, literal-log-code, trust-boundary,
and marker-absent runner provenance corrections. The inherited cancel race
remains a protected runtime observation under the approved local full-suite
waiver; it is distinct from both hosted failures.

On the v3 evidence worktree, exact P3 validation, five PowerShell parsers,
npm 11.16.0 clean install, build, actionlint, offline pedantic strict zizmor,
OSV Scanner, and gitleaks each passed once. The single targeted P5 plus
Windows invocation passed 15/17: a provisional canary disposition was
corrected, and the selected exact `node.exe` copy lacked adjacent `npm.cmd`
for the module probe. It was not rerun. A distinct full-suite invocation used
the npm-adjacent extracted runtime; all P5 tests passed there and the suite
finished 183/184 in 247523 milliseconds with only the unchanged
broker-cancel/taskkill race. Read-only follow-up found all three reported PIDs
absent, and the full suite was not rerun.

Two bounded evidence reviews then found no remaining actionable P0-P2 issue.
One reviewer objected that PR-ref cache metadata was outside scope; main-agent
adjudication rejected that claim because the current approval explicitly
authorizes read-only PR-ref Actions cache metadata and forbids only download
or deletion.

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

## Hosted observations

Draft pull request 2 binds P5 to exact P4 base
`84515289913dfe8a7452754ad442d37873bdfd53`. No rerun, dispatch, cancel,
settings change, ready/merge, tag/release, or P6 action occurred.

Run `30643349422`, run number 2 and attempt 1, bound source head
`4eeeb17b0ca3f2c248e7523dc65bddd69ca26f07` to merge/workflow commit
`de9c7dfc766716f53aa2dcc3c417d33fcb557bf2`. Run `30660084412`, run
number 3 and attempt 1, bound source head
`9d2422c4cdf1156008f7dbc744f1ebc4171febe5` to merge/workflow commit
`7a84c7cfd45c9f8f8f74fb5ac2106dec8d0904f7`. Both concluded failure.
Each exposed ten physical REST job records for twelve logical allocations:
Policy and terminal CI failed, Dependency review succeeded, four non-matrix
jobs were skipped, and Core, Claude, and canary remained zero-step literal
`${{ matrix.lane }}` placeholders. Run-1 skipped records preserve GitHub's
inverted timestamps (start one second after completion) as an observed API
anomaly rather than inventing zero duration.

The v3 observation preserves every physical job's status, conclusion, runner
name, and exact step list plus sanitized log facts. Run 1 policy passed 25 of
27 tests, failed literal `P5E_NODE_IDENTITY` plus a falsy assertion, then its
failure writer rejected null `FixtureIds`, so no policy marker exists. Run 2
policy passed 26 of 27 and failed only `P5E_NODE_IDENTITY`; its marker was
written. Both terminal gates emitted `P5E_BLOCKING_PROFILE_RESULT`.
Raw logs are not persisted.

Exact Git source-object bytes of `ci/scenario-registry-v1.json` have SHA-256
`28781c049eaeebcfe189b360d3f77583843c50ce08cbc073748537e84e9e6aa8`.
The runner markers for run-1 Dependency and run-2 Dependency/Policy instead
report CRLF digest
`854bb2937f087090ebebf8d03990ff1ee441e18bbcb006743cb29939f61fcb3a`.
V3 therefore retains those three records as
`rejected-untrusted-fragment` with
`P5E_RUNNER_EVIDENCE_IDENTITY`, read-only sanitized projections, and
`hostedGateInput:false`. Only the two terminal CI markers remain
`validated-rest-bound`; none is a pass or release-trust input. This corrects
v2's run-1 Dependency trust adjudication without modifying the v2 schema.

All six executed jobs directly prove runner 2.336.0, Windows Server 2025,
Node 24.18.1, npm 11.16.0, X64, and exact Node executable SHA-256
`ac51903c4c111815d52280b1fdcc8da067cbb37e2fe1a765097b85c3292c8582`.
The five jobs that emitted markers additionally prove NTFS and PowerShell
7.6.3 or 7.6.4. Run-1 Policy did not emit those two facts, so v3 records its
PowerShell and filesystem as `null/not-observed` rather than inferring them
from the image.

Read-only artifact metadata returned zero entries for each run. A separate
cache query for mutable `refs/pull/2/merge`, observed at
`2026-08-01T00:05:36Z` with current merge SHA `7a84c7c...`, returned zero
entries and empty inventory SHA-256
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
That cache snapshot is explicitly `not-observed` for either historical
execution window and is not duplicated into the run records. No artifact or
cache was downloaded or deleted.

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

The following remain false, skipped, or not run:

- hosted install/build, unit, Core current/previous, Windows integration,
  Claude minimum/current, and security success;
- aggregate required `CI` success;
- authenticated Claude lifecycle or paid inference;
- execution of the non-blocking next-Codex canary;
- disposable Windows 11 x64 runner evidence;
- a compiled native Windows capability artifact and C0 digest; and
- a shipping SQLite binding, DDL, migration, and D1 runtime.

Windows C0 and SQLite D1 remain `blocked-with-evidence` and deferred to v0.2.

## Hosted handoff

Any next remote action requires separate authorization. The portability repair,
v3 provenance-model source, and evidence-only rebind are local-only. No new
push or pull-request run has been performed after head `9d2422c`.
If authorized later, observe every blocking job and the terminal `CI` context. Record each
runner's actual image version, OS build, x64 architecture, NTFS filesystem,
exact tool identities, attempt number, timeout, raw exit code, and resource
postconditions using the sanitized writer. A cancelled run, a canary pass, a
YAML definition, or a local pass must not satisfy a hosted blocking profile.
The requested `windows-2025` label denotes a GitHub-hosted Windows Server 2025
x64 image, not Windows 11; Windows 11 remains an explicit disposable-runner
gap.
