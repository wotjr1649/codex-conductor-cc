# Runtime and gates handoff

Supersedes `2026-08-15-verification-handoff.md`, which is now stale in four places — they are
corrected below rather than edited there, because that file records what was true when it was
written. Read this one first. The measurements it rests on are in
`docs/superpowers/specs/2026-08-15-post-v0.3-decisions-design.md` except where stated.

The previous handoff opened by saying the branch "changes no product runtime file." That is the
line this session set out to stop being true, and it is no longer true.

## What landed

| PR | merge | what |
| --- | --- | --- |
| #11 | `c375e1a` | A long `PATH` made a working Codex install report as not installed. Fixed at the single `.cmd` chokepoint |
| #12 | closed | Tried to move the review expiry date. Four reviews found it falsifies a dated attestation |
| #13 | `0cc3ccd` | Removed the expiry clock instead. The 2026-09-01 CI deadline is gone permanently |
| #14 | `0b282fd` | `gpt-5.4` → `gpt-5.6-sol`, `gpt-5.4-mini` → `gpt-5.6-luna` before the 2026-08-31 cutoff |
| #15 | `7588932` | Reasoning effort: the accepted set was wrong, and a default can now be bound per model |

Four product runtime files, two commands, two skills, one agent, three test suites, one validator.
`main` is clean; `validate-p3`, `validate-p5` and `validate-portability` all exit 0 on it.

## What to do next, in order

### 1. The three local test failures

```
✖ status shows phases, hints, and the latest finished job
✖ status preserves adversarial review kind labels
✖ result returns the stored output for the latest finished job by default
```

All three in `tests/runtime.test.mjs`, all three failing with *"No finished Codex jobs found for
this repository yet."* They reproduce on a clean `main` and pass on all four CI legs.

**This is first because it is the primary feedback loop, and because this session dismissed it three
separate times as "host noise" without diagnosing it.** Each dismissal cost ten minutes of proving
it pre-existing, and one of those dismissals is how two real failures got missed — see the tail trap
below. A local suite that always shows three failures is a suite whose output nobody reads
carefully.

Two hypotheses were tested and refuted, so do not retest them:

- **`CLAUDE_PLUGIN_DATA`.** CI runs with it unset, this host has it set to a real directory. Running
  the suite with `env -u CLAUDE_PLUGIN_DATA` fails identically.
- **State-directory divergence.** The test seeds `resolveStateDir(workspace)` and the CLI resolves
  from `cwd`. Probed directly: `resolveWorkspaceRoot` returns the temp directory unchanged and both
  paths agree.

What is still unexplored: what the CLI actually reads when it reports no finished jobs. The tests
seed `state.json` and a `jobs/` directory by hand, then run the CLI as a child. Instrument the child
rather than the parent.

A leftover app-server broker is a *separate* and now-understood problem that produces five
additional `setup` failures. `loadBrokerSession(cwd)` records a broker for this workspace, and
`runtime.test.mjs`'s setup tests run with `cwd: ROOT`, so they talk to the real broker instead of
the fake. Tear it down with `teardownBrokerSession` + `clearBrokerSession` before trusting a local
run. It came back twice in one session.

### 2. Resolve past the shim instead of going through `cmd.exe`

#11 stopped the bleeding by handing `cmd.exe` a `PATH` it can use. The better shape is not to invoke
`cmd.exe` at all: `npm install -g` writes a `.cmd` whose body runs `node <entry>.js`, and both are
knowable, so the runtime could spawn `process.execPath` against the entry script directly.

`scripts/generate-app-server-types.mjs:193-198` already does exactly this in the build path — it
refuses a `.cmd` outright with *"Codex generator command must be an absolute non-shell executable."*
and builds its own two-entry `PATH`. The runtime is the half that never got it.

What it buys: no interpreter, no 8191-character cap, no execution policy, no quoting layer, and it
removes the truncation trade #11 had to accept. What it costs: resolving the npm layout robustly,
plus a fallback for installs that are not npm's.

### 3. Then choose deliberately

- **Audit the apparatus.** Measured this session: product runtime is 5,673 lines; the gate
  validators are 11,282 and their tests 4,399; `contracts/codex/snapshots/` is 3,882 files;
  `validate-p4` reports **116 errors on a clean `main`** and is run by no workflow. All of it was
  created on 2026-07-31, in one day, by this repository's owner — none of it comes from upstream.
  This is a session-sized piece and should be chosen, not drifted into.
- **`plugins/codex/skills/gpt-5-4-prompting/`.** Seven mentions of a retiring model, all
  descriptive rather than instructions to select it, so nothing breaks on the cutoff. Renaming
  changes a user-visible skill name and needs an immutable-path admission.

### Explicitly not recommended

**A Codex version range.** The ask was "0.146 or newer should just work," in the shape of the Node
policy. Measured: the product runtime never checks a Codex version at all. Its three `codex`
invocations resolve the bare name from `PATH` and never parse `--version`
(`codex.mjs:406`, `:411`, `app-server.mjs:254`); capability differences are negotiated at runtime
through `unknown method` and JSON-RPC `-32601`, which is a direct test rather than a version proxy.
**It already behaves the way the ask wants.**

And the Node precedent is not worth copying. `nodeRange: ">=24.0.0"` is declared in four manifests,
`const`-pinned in two schemas, and compared by **string equality** in all four readers — nothing
parses it as a range, and `security/p3-policy.json:7` holds a copy no code reads. Exactly one place
compares Node to the live runtime, and the product's own check does not read `nodeRange` at all.
Copying that shape for Codex would replicate the half that does nothing while every exact pin stays.

**Dependabot for `github-actions`.** Attempted and abandoned with evidence. One `actions/checkout`
bump requires the same SHA in eight places, including `.github/workflows/pull-request-ci.yml`, which
is byte-frozen by a test named *"refuses any change to the already archived workflow"*, and two
dated evidence inventories, which is the falsification #12 was blocked for. The bot would produce
pull requests that cannot honestly be made green.

**A `codex --version` floor warning.** Proposed, then argued against by the same reasoning as the
version range: a version is a proxy for a capability, and the runtime already tests the capability.

## Traps this session paid for

**`plugins/codex/{commands,agents,skills,hooks}` are pinned three ways, by a suite `npm test` does
not run.** `tests/downstream-identity.test.mjs` holds a blob hash per file, a tree hash per
directory, and one canonical digest over the whole path-and-blob list. It runs only in the win32 CI
leg's `Run baseline suites` step, alongside four other files that `npm test` also skips. **Any change
under those four directories must run those five files deliberately.** This cost two CI rounds.

**That CI job stops at the first failing step.** `Run current Windows suite` precedes `Run baseline
suites`, so a failure in the former hides the latter entirely. A green second step is not evidence
until the first one passes.

**Updating those pins has an ordering trap.** The blob assertions hash the *working tree*
(`git hash-object`); the tree assertions read the *commit* (`git rev-parse HEAD:<path>`). Commit the
content change first, then read the tree hashes, then fix the pins. Let the test compute the
canonical digest — extracting the blob map by regex silently misses the multi-line entries.

**A truncated tail is not a failure list.** The full suite was read through `tail -25`, which showed
the three known job-state failures and hid two real ones above them. Use `grep -E '^✖'`. This is how
the P2 pin failures reached CI.

**A registry-pinned test costs a digest.** `tests/commands.test.mjs`, `tests/args.test.mjs` and
`tests/downstream-identity.test.mjs` are in `ci/scenario-registry-v1.json`'s `inheritedTests`.
Changing one requires updating its `sha256` **canonically** — CRLF folded to LF — because the
validator accepts either form and LF is what a runner checks out. Verify in a
`git -c core.autocrlf=false clone --no-local` before pushing; that check is the one whose absence
previously failed all four legs. `tests/portability/**` is outside the registry's non-recursive
scan, so a new check placed there costs nothing.

**Editing tools write LF.** Several files in this repository are CRLF in the working copy under
`core.autocrlf=true`. Git normalizes on commit so the diff stays clean, but re-record and edit
operations leave the working copy mixed. Check and restore.

## Corrections to the previous handoff

1. **`pull-request-ci.yml` does not validate anything.** The previous handoff cited
   `.github/workflows/pull-request-ci.yml:45` as where P4 is validated. That workflow was archived
   in v0.2 — its trigger was replaced with `workflow_dispatch`, and
   `tests/portability/p5-continuity.test.mjs:90-98`, *"P6-CONTINUITY-003 refuses any change to the
   already archived workflow"*, refuses to restore it. Dispatching it fails on
   `P5E_PULL_REQUEST_EVENT` before it evaluates anything, because its jobs require a `pull_request`
   payload it can no longer receive. The conclusion drawn from it — that `validate-p4`'s local red
   is not a CI gate — is *strengthened*: nothing validates P4 in CI at all.
2. **The tools-manifest expiry is inert.** It was listed as "the one dated obligation" and "the only
   deadline." Measured: `contracts/codex/contract-tools-v1.json` has no `expiresAt < today` check
   anywhere, and `ci/matrix-profiles-v1.json`'s dates are compared by exact string equality at
   `scripts/lib/p5-validation.mjs:348-349`. Only `toolchain.json` ever had a clock, and #13 removed
   it. Nothing expires on any date now.
3. **The `cmd.exe` PATH item is closed**, and the mechanism it recorded was wrong. `PATH` is not
   dropped by `cmd.exe` — it reaches the child intact and only `cmd.exe`'s own expansion is capped,
   at exactly 8191 characters. The old reading came from probing with `echo %PATH%`, which reports
   the expansion rather than the variable.
4. **The branch changes product runtime files.** Four of them, plus commands, skills and an agent.

## Still open, still unknown

- **The three local failures.** Item 1 above. Not diagnosed.
- **`app-server.mjs` preferring `invocation.env` has no test.** A one-line symmetric change from
  #11, reviewed by eye. Covering it means starting an app-server end to end under an over-cap `PATH`.
- **Whether #11's truncation ever bites.** Entries past the cap are dropped, so a `.cmd` reading
  `PATH` as data, or a grandchild of one, sees the shortened value. Unavoidable — `cmd.exe` resolves
  nothing over the cap — but a report from a real over-cap host would tell us whether it matters.
- **`max` at the backend.** Codex 0.147.0 advertises `max` for sol, terra and luna through
  `model/list`, and the protocol enum names it, but an open upstream issue reports the backend
  rejecting `reasoning.effort=max` with a 400 while other reports say it works. The plugin now
  passes it through; if it 400s, the error comes from the server with its own list.
- **P0 absorption, `#499`/`#640`, `#382`, C6 error paths, POSIX branches.** Unchanged from the
  previous handoff. None acquired new evidence this session.

## One capability worth remembering

`model/list` is a pinned contract method, and Codex answers it with more than a model list: per
model, `supportedReasoningEfforts`, `defaultReasoningEffort`, `isDefault`, and `upgrade` naming the
replacement for a model being retired. Asked of the installed 0.147.0 it returns `gpt-5.4 →
gpt-5.6-terra` and `gpt-5.4-mini → gpt-5.6-luna` as live data.

`/codex:setup` uses it now, and it is the durable answer to model-name churn — measured at a
retirement every seven to thirteen weeks, with notice as short as six days and no published
minimum-notice policy for Codex sign-in availability. Anything that would otherwise hard-code a
model name or an effort level should ask instead.
