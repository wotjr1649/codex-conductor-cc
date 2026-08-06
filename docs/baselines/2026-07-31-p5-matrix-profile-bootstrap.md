# P5 Windows x64 matrix/profile bootstrap

Date: 2026-07-31
Source commit: `0ff55c973540ff95028a7c9419e5fa5d81939b03`
Handoff commit: `84515289913dfe8a7452754ad442d37873bdfd53`
Platform: Windows x64, exact Node.js 24.18.1 and npm 11.16.0

## Outcome

P5 is `hosted-complete`. The exact local bootstrap is `executed-pass`, and the
ordered hosted record retains natural run numbers 2 through 9 without a rerun.
Runs 2 through 7 remain failures. Runs 8 and 9, both attempt 1, passed every
blocking job and terminal `CI`. Final run 9 bound source
`0ff55c973540ff95028a7c9419e5fa5d81939b03` to merge/workflow commit
`52c1dff2ff324f32d899adbf97f5ca448a8c130e`. P6 was not initiated and is
outside this closure.

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
v2 schema remains unchanged. V3 binds the exact eight-run sequence 2 through
9, physical jobs and steps, sanitized log projections, run-scoped artifact
metadata, and one current run-unattributed PR-ref cache snapshot. Blocking-job finalizers run
after any non-cancelled outcome, distinguish a direct process exit from a
GitHub job-status normalization, and cannot turn a blocked or unimplemented
profile into an executed pass.

Core contract jobs bind `TEMP` and `TMP` to a run-owned child of
`RUNNER_TEMP` before acquiring Codex, which prevents short/long Windows user
path spellings from changing the P4 transcript oracle. Windows integration
installs the exact lockfile with `npm ci --ignore-scripts` before tests so the
committed TypeScript validator is available without running package scripts.

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

P5 adds 20 semantic/profile tests and one independent Windows resource test,
for 188 total tests. The
resource oracle starts an exact owned root and child PID, proves an exclusive
file handle blocks rename, calls the exact `taskkill /PID <root> /T /F`
executable through a five-second bounded process, reads back that both PIDs are
gone, then proves rename/delete succeeds. This is not a native Job Object C0
claim.

At source `0ff55c973540ff95028a7c9419e5fa5d81939b03`, the exact
Node 24.18.1/npm 11.16.0 serial suite passed 188/188 with zero failure,
cancellation, or skip. The canonical Core job simulation passed the unchanged
P4 contract 40/40, and the Windows job simulation passed 87/87 after the exact
dependency install. Earlier broker-cancel race observations remain ordered in
the attempt ledger and are not rewritten as passes.

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

Predecessor closure source `97ecd4d684cff1f42ea3fe9cdea4b141ae9ed45a` passed the
exact P3 and P5 validators, detached P4 handoff validation, P5 20/20,
canonical-temp P4 40/40, Windows integration 87/87, the serial full suite
188/188, five PowerShell parser checks, exact clean install and build, and all
four admitted security tools. Actionlint and offline pedantic strict zizmor
reported no workflow finding, OSV reported no issue in three lockfile
packages, and gitleaks reported no leak.

Closure source `0ff55c973540ff95028a7c9419e5fa5d81939b03` first produced
meaningful RED at P5 17/20 for the seven-item schema ceiling, seven-run
closure binding, and source frontier. After the exact three-file correction,
P5 passed 20/20, P5 plus Windows passed 21/21, the generated build was clean,
the serial full suite passed 188/188, and post-commit P5 validation passed.

The first local source shape tried to normalize the P4 test itself; the P5
immutability and scope guards rejected it, so the P4 file and scenario digest
were restored byte-for-byte. A subsequent job-level `runner.temp` binding was
rejected by actionlint because that context is unavailable there. The accepted
workflow reuses the existing bounded PowerShell/GITHUB_ENV pattern with
`RUNNER_TEMP`. These failures remain ordered in the attempt ledger. Any older
paragraph below that calls a prior source “final” is a retained historical
observation, superseded by this closure update.

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

The v3 closure contains exactly eight ordered observations with run numbers
`[2, 3, 4, 5, 6, 7, 8, 9]`, all attempt 1 with zero rerun. Runs 2 through 6
failed policy/bootstrap admission and terminal CI at their exact recorded
heads. Run 7 admitted the matrix, then Core current failed on alias versus
canonical temporary-path spelling, Windows integration failed because the
TypeScript dependency was not installed, and terminal CI failed. The other
run-7 blocking allocations passed; the exact next-Codex result remained
non-blocking. Runs 8 and 9 passed all twelve jobs.

Natural run `31067303488`, number 8 and attempt 1, used source
`97ecd4d684cff1f42ea3fe9cdea4b141ae9ed45a` and merge/workflow SHA
`762fd212130c57dc5e709f6b3d9eb8362a536c51`. The twelve-job set was Policy,
Install/build, Unit, Core current, Core previous, Windows integration, Claude
minimum, Claude current, Security, Dependency review, next-Codex canary, and
terminal CI. All twelve REST jobs concluded success; all blocking projections
were `executed-pass`, the canary was `non-blocking-canary`, and terminal CI
passed. Twelve unique sanitized markers bind the source, merge, workflow,
job/check-run, exact Node identity, clocks, and privacy fields. The first
collector pass validated seven directly and conservatively reported its known
matrix marker-window limitation for five; marker-only memory filtering then
validated those five without persisting raw logs.

Read-only metadata observed zero run-8 artifacts and zero matching
`refs/pull/2/merge` caches at `2026-08-06T03:16:32.935Z`; neither was
downloaded or deleted.

Natural run `31069904369`, number 9 and attempt 1, used source
`0ff55c973540ff95028a7c9419e5fa5d81939b03`, merge/workflow SHA
`52c1dff2ff324f32d899adbf97f5ca448a8c130e`, and check suite
`84275777507`. All twelve REST jobs concluded success. The collector validated
seven sanitized markers directly; marker-only memory filtering validated the
five matrix markers without persisting raw logs. Read-only metadata observed
zero run-9 artifacts and zero matching PR-ref caches at
`2026-08-06T04:13:51.931Z`; neither was downloaded or deleted. The paragraphs
below retain the exact earlier run-2/3 history and trust-boundary rationale.

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

The following remain false, skipped, not run, or outside this closure:

- repair of the inherited P4 evidence source-binding defect;
- authenticated Claude lifecycle or paid inference;
- disposable Windows 11 x64 runner evidence;
- a compiled native Windows capability artifact and C0 digest;
- a shipping SQLite binding, DDL, migration, and D1 runtime;
- merge, release, tag, deployment, and P6 work; and
- the evidence-only successor run, which cannot be self-recorded by the commit
  that triggers it and must be observed separately.

Windows C0 and SQLite D1 remain `blocked-with-evidence` and deferred to v0.2.

## Hosted handoff

The closure commit is evidence-only: this baseline, the P5 attempt ledger, and
the P5 v3 manifest. Its bound source remains
`0ff55c973540ff95028a7c9419e5fa5d81939b03`; it does not claim its own
successor. After the authorized non-force push, observe only the natural
pull-request synchronize run at attempt 1. It must preserve the same source
binding while validating the evidence-only frontier and every blocking job,
including terminal `CI`. Do not rerun, dispatch, cancel, merge, change settings,
tag, release, deploy, begin P6, migrate the Node anchor, or repair P4 evidence.
