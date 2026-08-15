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

The branch `codex/post-v0.3-toolchain-and-drift` adds four checks and one design document, and
changes no product runtime file.

| check | what it protects |
| --- | --- |
| `tests/portability/app-server-drift.test.mjs` | The pinned protocol contract. Fails when a method the manifest promises disappears. |
| `tests/portability/companion-characterization.test.mjs` | 19 command shapes pinned byte-exactly, including the background lane. |
| `tests/portability/worker-preflight.test.mjs` | The `failPreflight` branches J1 fixed, which no test reached. |
| `tests/portability/state-path-performance.test.mjs` | The P1 memoization, as a cliff detector. |

Every one was verified by mutating what it should reject, not by watching it pass.

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
| **`cmd.exe` PATH defect** | Every `.cmd` is invoked through `cmd.exe`; `npm install -g` produces such a shim; `/codex:setup` tells users to install that way. A long `PATH` is dropped by `cmd.exe`, so the shim cannot find `node` and the product reports Codex as not installed — from a working installation, with no diagnostic, because `getCodexAvailability` computes the real reason and every caller discards it | Surface `detail` when availability fails, and either resolve the interpreter absolutely or pass a short `PATH` when invoking a `.cmd` |
| Tools-manifest review | Dated, see above | The review, before 2026-08-31 |
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

1. **The `cmd.exe` PATH defect.** The only open item that affects users today, it is in the product
   runtime, and the safety net for it now exists — the characterization harness pins `setup` across
   six shapes, and `getCodexAvailability` is exactly the path `setup` exercises.
2. **The tools-manifest review**, before 2026-08-31. It is the only deadline.
3. **The two decisions**, `#499`/`#640` and `#382`. Both are the maintainer's, both are documented,
   and neither needs more research.
4. Then coverage: C6 error paths, then whatever a POSIX host makes reachable.

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
