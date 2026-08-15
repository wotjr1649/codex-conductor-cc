# Verification handoff

The previous handoff put protocol drift first because everything else was downstream of it. That is
answered, and answering it turned up more corrections to the record than new work. This file is the
entry point for whatever comes next.

Read `docs/superpowers/specs/2026-08-15-post-v0.3-decisions-design.md` for the evidence — every
measurement below is recorded there with its method. This file does not repeat it.

## Where the repository stands

Green, and further along than the record said. All three validators exit 0, including
`npm run validate:p3`, which the v0.3 document analyses at length as unable to pass. All five
baseline suites pass except two assertions that are host facts rather than defects. `npm test` is
0 failures on win32 and CI is green on all four platforms.

**And the two that were left "unverified" are gone.** The design document's remaining pair,
`Could not resolve the repository TypeScript compiler`, was attributed to an absent
`node_modules` with `npm ci` expected to clear it and unverified. `node_modules/typescript` is
present now and the full suite exits 0, so the expectation held.

**Which three, measured.** `validate-p3`, `validate-p5` and `validate-portability` exit 0.
`validate-p4` exits 1, and it exits 1 on a clean `HEAD` too — probed by stashing the working tree
and rerunning. Its complaints are `plugins/codex/agents`, `plugins/codex/skills`,
`package-lock.json`, the P2 schema digest, and sixteen test files outside the P4 allowlist,
several of which are committed on this branch while CI is green. That is not a contradiction:
`.github/workflows/pull-request-ci.yml:45` validates P4 through
`scripts/invoke-p4-validator-at-handoff.ps1`, which checks out the frozen commit pinned inside it
into a detached worktree **outside the repository**. CI's P4 step never reads the working tree.
Running `validate-p4.mjs` against the working tree is therefore a local-only signal; do not treat
its red as a regression.

The branch `codex/post-v0.3-toolchain-and-drift` adds six checks and one design document. It no
longer leaves the product runtime untouched — see the next section.

| check | what it protects |
| --- | --- |
| `tests/portability/app-server-drift.test.mjs` | The pinned protocol contract. Fails when a method the manifest promises disappears. |
| `tests/portability/companion-characterization.test.mjs` | 19 command shapes pinned byte-exactly, including the background lane. |
| `tests/portability/worker-preflight.test.mjs` | The `failPreflight` branches J1 fixed, which no test reached. |
| `tests/portability/state-path-performance.test.mjs` | The P1 memoization, as a cliff detector. |
| `tests/portability/process-shell.test.mjs` `P6-PROCESS-SHELL-002` | A `.cmd` shim still runs when `PATH` is past what `cmd.exe` can resolve. |
| `tests/portability/codex-availability.test.mjs` | An availability failure carries its reason to the user instead of a generic sentence. |

Every one was verified by mutating what it should reject, not by watching it pass.

## The `cmd.exe` PATH defect — closed

Both mitigations the design document named are now in the runtime. Reproduced first, fixed second,
and each check verified by mutating what it should reject.

### The mechanism is not what the record said

The record says the long `PATH` is *dropped* by `cmd.exe`. Re-measured here, that is an artefact of
the probe. `PATH` is **not dropped from the environment** — a child launched by absolute path from
inside the spawned `cmd.exe` reads the full oversized value. What is capped is `cmd.exe`'s own
variable expansion and command search, and the cliff is exact:

| PATH handed to `cmd.exe` | what a grandchild reads | `node --version` inside `cmd.exe` |
| --- | --- | --- |
| 8191 characters | 8191 characters | `v24.19.0` |
| 8192 characters | 8192 characters | not recognized, exit 1 |

`echo %PATH%` printed nothing at 8192 because the *expansion* is empty, not because the variable is
gone. The distinction decides the fix: there is nothing to restore, so `cmd.exe` must be handed a
shorter `PATH`. There is no third option — over the cap it resolves no bare name at all.

Reproduced through the product's own path before any edit: with a 14,511-character `PATH` and an
npm-shaped shim, `getCodexAvailability` returned `available: false` and a `detail` carrying
`'"node"' is not recognized`. After the fix, the same probe returns `available: true` and the real
version string.

### What changed

| file | change |
| --- | --- |
| `plugins/codex/scripts/lib/process.mjs` | `resolveCommandInvocation` now also returns an `env` — `null` unless it built a `cmd.exe` invocation whose `PATH` exceeds the cap, in which case a copy that fits |
| `plugins/codex/scripts/lib/process.mjs` | `runCommand` prefers that env |
| `plugins/codex/scripts/lib/app-server.mjs` | the app-server spawn prefers that env |
| `plugins/codex/scripts/lib/codex.mjs` | new exported `codexUnavailableError(detail)`; four generic throws now call it |
| `plugins/codex/scripts/codex-companion.mjs` | the fifth generic throw calls it |
| `tests/portability/process-shell.test.mjs` | `P6-PROCESS-SHELL-002`, the shim under an over-cap `PATH` |
| `tests/portability/codex-availability.test.mjs` | `P6-CODEX-AVAILABILITY-001`, the reason reaching the user |

`resolveCommandInvocation` is the single chokepoint: on win32 every `.cmd` the product runs passes
through it, and both spawn sites — the synchronous one and the long-lived app-server child — now
consume what it returns. The generic sentence was duplicated verbatim at five sites; it is one
function now, so the next caller cannot forget the reason.

The shortened `PATH` keeps as much of the original as fits, in order, and appends the directory of
the running interpreter **last**, with room reserved so it cannot be cut. Last rather than first
was the cross-model review's contribution: leading with it would let a same-named executable beside
`node.exe` shadow an entry the user put there deliberately. Appending shadows nothing and still
guarantees the shim finds its interpreter. Only whole entries survive the cut — a truncated
directory is not a directory, and an empty entry is the current one, so a `PATH` this code writes
can contain neither.

### Verified by mutation, not by watching it pass

| mutation | caught by |
| --- | --- |
| `runCommand` ignores the shortened env | `P6-PROCESS-SHELL-002` |
| cap off by one, 8191 → 8192 | `P6-PROCESS-SHELL-002` |
| truncate only, never append the interpreter | `P6-PROCESS-SHELL-002` |
| keep the entry the cut landed inside | `P6-PROCESS-SHELL-002` |
| the availability failure drops its detail | `P6-CODEX-AVAILABILITY-001` |

`P6-PROCESS-SHELL-002` builds a `PATH` of **exactly** 8192 characters with the interpreter at the
far end, which is why one test kills four mutants. The characterization baseline did not move:
every pinned shape reaches an available Codex, and only the failure sentence gained a reason, so
`CODEX_CHARACTERIZATION_UPDATE=1` was never needed.

### Decided

- **The trade is a shorter `PATH` over a tool that cannot run.** Entries past the cap are dropped,
  so a `.cmd` that reads `PATH` as data — or any grandchild of one, including Codex's own
  subprocesses — sees the shortened value rather than the full one it gets today. The cross-model
  review raised this and it is real. It is also unavoidable: `cmd.exe` resolves nothing over the
  cap, so the alternative is not a full `PATH`, it is no Codex. Recorded as a `ponytail:` comment
  at the site.
- **Declined from the same review:** the claim that a kept front entry could now shadow the
  intended binary in a dropped tail entry. `PATH` search is first-match, so the front entry already
  won before any truncation; dropping tail entries can turn a find into a not-found, never into a
  wrong-find.
- **Nothing was shortened on the healthy path.** Under the cap the function returns `null` and the
  environment is untouched, so hosts that never had the defect see no behaviour change at all.
- **The build tooling was already immune and stays untouched.**
  `scripts/generate-app-server-types.mjs:193-198` refuses a `.cmd` outright — *"Codex generator
  command must be an absolute non-shell executable."* — and builds its own two-entry `PATH` from
  the resolved command's directory and the interpreter's. This repository already knew the hazard
  in the build path; only the product runtime kept walking into it. Not changed here: it fails
  loudly at build time, which is a different defect from a silent misdiagnosis.
- **Put new checks in `tests/portability/`, not in `tests/`.** The first version of the reason
  assertion went into `tests/args.test.mjs` and cost `P5E_TEST_DIGEST` — that file is a registry-
  pinned inherited test, and the 2026-08-14 document records that this gate's local pass is not
  evidence. `tests/portability/` is outside the registry's non-recursive scan and outside the
  `npm test` file list that needs registration, so a file there costs nothing. Moved, and
  `tests/args.test.mjs` is byte-identical to `HEAD` again.

### Still information-blocked

1. **Whether the truncation ever bites a real user.** It needs a report from a host with an
   over-cap `PATH` and a `.cmd` that depends on a late entry. Not reproducible by reasoning, and
   not worth pre-solving.
2. **The app-server spawn site has no test.** `app-server.mjs` preferring `invocation.env` is a
   one-line symmetric change, reviewed by eye and not covered. Covering it means an end-to-end
   app-server start under an over-cap `PATH`; the fake-Codex fixture would carry it, but the cost
   is a whole harness for one `??`.
3. **The POSIX side is unchanged, and one of the two new checks has never run there.**
   `P6-PROCESS-SHELL-002` is win32-gated by construction — `cmd.exe` shims do not exist elsewhere —
   so it is a skip on POSIX, not a gap. `P6-CODEX-AVAILABILITY-001` is meant to run everywhere and
   has only been run here. Its POSIX safety is argued from the code rather than measured:
   `--background` reaches `ensureCodexAvailable` before anything touches the state tree, and on an
   empty `PATH` the failure detail is `spawnSync`'s `ENOENT` on every platform. That argument is
   why it invokes the background branch and pins no `CLAUDE_PLUGIN_DATA` — the foreground branch
   opens a job log first, which is the private uid-scoped root a CI temp directory does not
   satisfy. CI is the first POSIX evidence either way.

## The one dated obligation

`contracts/codex/contract-tools-v1.json` carries `expiresAt: 2026-08-31`. Its first drift trigger,
`new-stable-codex-release`, has fired, and its `rejectedOrDeferred` block defers `0.147.0-alpha.2`
for a reason — "official prerelease/alpha, not a stable blocking lane" — that expired when
`0.147.0` went stable on 2026-08-07.

Three things belong in that review because they need the same re-baseline:

- the `0.147.0` lane decision;
- the owner's Node policy, which is a supported range rather than a pinned interpreter. The
  repository already declares `nodeRange: ">=24.0.0"` and now checks it at runtime, but the
  toolchain identity is still a single exact version. Moving that to a table of accepted LTS
  releases means changing `node` from a schema `const` to an enum in at least four evidence
  schemas, and those are outside the allowlist;
- whether to re-snapshot the contract at all. Measured: a single file under
  `contracts/codex/snapshots/0.147.0/` raises `P6E_SCOPE` and `P5E_IMMUTABLE_PATH` and disables the
  continuation filter that would otherwise consume unrelated complaints.

## Open items

| Item | Why it is open | What would close it |
| --- | --- | --- |
| Tools-manifest review | Dated, see above. **Now the top item** | The review, before 2026-08-31 |
| `#499`/`#640` | Decided in substance: no `accept` path is safe at this protocol version, because `_meta` is written by the party being authorized and the params carry no tool identity. Both open upstream PRs ship that construction and are recorded as rejected | The maintainer choosing between closing it as decided and implementing the refusal side |
| `#382` | Fully specified. Narrow (`CODEX_SQLITE_HOME` + `log_dir`) is credential-safe and does not fix the reported symptom; Full (`CODEX_HOME` per workspace) fixes it and costs a seeding allowlist. Measured on this host: `auth.json` exists, so credentials do live under `CODEX_HOME` and Full is not free here | The maintainer's call. Deferral is the recommendation |
| C6 error paths | ~28 lines in `enqueueBackgroundTask` and `spawnDetachedTaskWorker`, all reachable only by provoking a write or spawn failure | Failure injection — making the jobs directory unwritable is the cheap route |
| POSIX branches | ~78 lines of the worker cluster are unreachable on win32, behind `supportsWorkerControl()`. `updateWorkerStatus` is dead code here for the same reason | A POSIX host, or collecting from the POSIX CI legs |
| POSIX half of the performance guard | The two state-seeding cases are gated to win32: on POSIX `ensurePrivateTree` rejects a CI temp directory, and the ceilings are sized for Windows' cost | A POSIX host to measure on — not a guess pushed to CI |
| `codex-companion.mjs` split | **Decided against**, with evidence, so it stops recurring. It had recurred three times | Nothing. Reopen only if a feature actually forces it |
| P0 absorption pipeline | The drift detector is the piece that got built. No translation ledger, no benchmark, no absorption process | Deliberate work — and there is no pressure: upstream has not moved since the pinned base, which *is* its current HEAD |
| P6 | Unblocked. `#468` may need zero runtime change — unknown model names already pass through | Reading the issue text before touching code |

## What is still information-blocked

Each was looked for and not found. Further research will not produce them.

1. **The provenance of `respond-once`, `latch-block`, `wait-for-terminal-or-teardown`.** Two
   exhaustive searches, inside the repository and across the upstream tracker, protocol source and
   open web, put them nowhere but the fixture that introduces them. They are not upstream
   vocabulary and not this codebase's. Ask whoever wrote the fixture, or delete the array and
   specify the surface in upstream's own terms.
2. **Whether the app-server can supply unforgeable approval provenance.** This decides whether
   `#499`/`#640` is fixable here at all. Reading how the upstream TUI validates these requests is
   the concrete next step.
3. **Whether the rest of `~/.codex` can be relocated.** No override was found for
   `.codex-global-state.json`, `sessions/`, `session_index.jsonl`, `models_cache.json`, `skills/`
   or `shell_snapshots/`, in the documentation or the installed binary's strings.
4. **Whether concurrent app-servers against one `CODEX_HOME` are supported.** Upstream is silent;
   `#382`'s premise rests on the reporter's inference from orphaned temp files.

## Suggested order

1. **The tools-manifest review**, before 2026-08-31. It is now the only deadline and the only item
   with a date. It needs the owner for all three of its parts.
2. **The two decisions**, `#499`/`#640` and `#382`. Both are the maintainer's, both are documented,
   and neither needs more research.
3. Then coverage: C6 error paths, then whatever a POSIX host makes reachable.

The `cmd.exe` PATH defect was item one and is closed; see above.

## What this session got wrong, and how each was caught

Recorded because the traps are specific to this repository and the corrections cost real time.

**A claim about coverage that measurement refuted.** The background-lane shapes were reported as
covering the worker cluster. They do not: measured with the harness alone, `handleTaskWorker` is 54
percent uncovered, identical to the full suite without it. Byte-exact pinning is not reach. The
preflight tests are what moved it, to 40 percent. **Measure the delta before claiming one.**

**A fix that silently broke a teardown.** Pinning each shape's `CLAUDE_PLUGIN_DATA` made the
harness deterministic and simultaneously invalidated its `after()` hook, because
`loadBrokerSession` resolves through `resolveStateDir`, which reads that same variable from
whichever process calls it. Fourteen processes leaked per run and the next full suite took 253
seconds against 159. **When a test pins an environment the product reads, check what else resolves
through it.**

**A timing regression blamed on the wrong thing.** That 165-to-253 second jump looked like the
performance guard committed just before it. The guard runs in 1.4 seconds. This is the same lesson
the v0.3 document closes with, and it was walked into again: a timing regression that no source
change explains is a workspace problem, and the workspace is where to look first.

**Two measurements that were right but measured the wrong shape.** The first performance probe
seeded records without `logFile`, which is the cheap shape — `assertManagedLogFile` returns early —
so it measured 0.49 ms where the real path is 1.90. And the first characterization recording
compared byte-identical only because two runs in one shell landed in the same wall-clock second;
recording from two shells exposed a duration field the normalizer missed. **Compare across
environments, not just across runs.**

**And one the host could not catch at all.** The performance guard passed everywhere here and
failed on all three POSIX legs, because writing state on POSIX goes through a private uid-scoped
runtime tree that a CI temp directory does not satisfy. CI found what this host cannot. That is an
argument for pushing early, and against fixing it by guessing at a platform you cannot run.

### Added by the session that closed the PATH defect

**A probe that named the wrong mechanism.** `echo %PATH%` printing nothing was recorded as
`cmd.exe` dropping the variable. It does not: the variable reaches the child's environment intact
and only `cmd.exe`'s own expansion is capped. The diagnosis pointed at the same fix by luck, and a
different symptom — a shim that reads `PATH` as data — would have been misdiagnosed by it.
**A probe that answers through a shell tells you about the shell, not about the environment.**

**A suite failure that was the machine, not the change.** One full-suite run failed on
`cancel sends turn interrupt to the shared app-server before killing a brokered task`
(`tests/runtime.test.mjs:1857`) with `Timed out waiting for condition`. That assertion is a
15-second wall-clock race: a detached worker must start, reach the app-server, open a thread and
start a turn, polled every 50 ms. It lost while 89 `node` processes were alive on the host. The
same file passed standalone immediately afterwards, and the full suite passed three times on this
tree — twice before the failure and once after, the last on a host carrying half the load.
The change could not have caused it, and that is provable rather than argued: `shortenedShellEnv`
returns `null` whenever `PATH` is at or under the cap, every `PATH` the suite builds is a bare
temp directory or `binDir` plus the host's 1,864-character one, and the sole exception is
`P6-PROCESS-SHELL-002`'s own isolated 8,192-character env. Below the cap the change is a no-op by
construction. **This suite has wall-clock assertions in it; measure the host's load before
attributing a timeout to a diff.**

**A red validator that meant nothing.** `validate-p4.mjs` exits 1 against the working tree and
exits 1 against a clean `HEAD`, because CI validates P4 from a frozen commit in a detached
worktree and never reads the tree at all. Half an hour went into telling "my change broke this"
apart from "this was already red", and the only thing that settled it was stashing and rerunning.
**Before attributing a gate's red to a change, run the gate without the change.**
