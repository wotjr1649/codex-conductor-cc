# Plugin Changelog Frontier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit the installed plugin changelog as one exact post-v0.2 portability path without widening the executable or prefix-based frontier.

**Architecture:** Reuse the existing `EXACT_PATHS` gate and its existing continuity test. Add one exact Markdown path, prove the intended path is accepted, and prove a lookalike path remains rejected; do not add a new prefix, helper, validator mode, or workflow exception.

**Tech Stack:** Node.js 24, `node:test`, Git, PowerShell.

## Global Constraints

- Personal public fork only; no upstream writes.
- Exact starting commit: `51aa48034e655aacce23938df792bc6da65b049f`.
- Branch: `codex/v0.2-changelog-frontier`.
- Trust boundary: pull-request-controlled changed paths are admitted to the protected portability continuation only through `isPortabilityAllowedPath`.
- Concrete abuse case: a prefix or broad directory allowance could admit executable or unrelated plugin changes and inflate the protected GREEN result.
- Mitigation: add only `plugins/codex/CHANGELOG.md` to `EXACT_PATHS`; keep all existing normalization, entrypoint binding, and negative-path behavior unchanged.
- A focused security diff review and adversarial review are required before any push authorization request.
- Do not change workflows, package metadata, runtime code, the changelog itself, path prefixes, source-binding logic, or any other test.
- Do not push, create or modify a PR, tag, release, publish, install, or change repository settings.
- Stage only the three paths explicitly named below and create at most one local implementation commit.

---

### Task 1: Admit only the exact plugin changelog path

**Files:**
- Modify: `scripts/lib/portability-continuity.mjs`
- Test: `tests/portability/p5-continuity.test.mjs`
- Include in commit: `docs/superpowers/plans/2026-08-08-plugin-changelog-frontier.md`

**Interfaces:**
- Consumes: `isPortabilityAllowedPath(relativePath)` and the existing `P6-CONTINUITY-001` exact-scope test.
- Produces: `true` only for the added exact plugin changelog path while a lookalike sibling remains `false`.

- [ ] **Step 1: Verify the exact isolated starting state**

```powershell
$ErrorActionPreference = 'Stop'
$base = '51aa48034e655aacce23938df792bc6da65b049f'
$planPath = 'docs/superpowers/plans/2026-08-08-plugin-changelog-frontier.md'
if ((git branch --show-current).Trim() -cne 'codex/v0.2-changelog-frontier') { throw 'wrong branch or worktree' }
if ((git rev-parse HEAD).Trim() -cne $base) { throw 'unexpected starting HEAD' }
$status = @(git status --short)
if ($status.Count -ne 1 -or $status[0] -cne "?? $planPath") { throw "unexpected initial scope: $($status -join ', ')" }
```

- [ ] **Step 2: Add the positive and negative regression cases first**

In `P6-CONTINUITY-001`, add this exact value to the accepted-path array:

```js
"plugins/codex/CHANGELOG.md",
```

Add this exact value to the rejected-path array:

```js
"plugins/codex/CHANGELOG.md.bak",
```

- [ ] **Step 3: Run the focused test and confirm RED**

```powershell
node --test --test-concurrency=1 tests/portability/p5-continuity.test.mjs
if ($LASTEXITCODE -eq 0) { throw 'expected exact plugin changelog path test to fail before implementation' }
```

Expected: `P6-CONTINUITY-001` fails because `plugins/codex/CHANGELOG.md` is still rejected. The `.bak` case must not be the failure.

- [ ] **Step 4: Implement the minimum exact-path allowance**

Add this single entry to `EXACT_PATHS`, adjacent to the existing plugin metadata paths:

```js
"plugins/codex/CHANGELOG.md",
```

Do not modify `PATH_PREFIXES` or any validator logic.

- [ ] **Step 5: Confirm focused GREEN**

```powershell
node --test --test-concurrency=1 tests/portability/p5-continuity.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'focused continuity test failed' }
```

Expected: all tests in the file pass with no warnings.

- [ ] **Step 6: Run the full local verification gate**

Run each command below in its own foreground invocation so every exit code and output is preserved. Use a 30-second bound for each validator and `git diff --check`; allow up to 10 minutes for the directly capped full test suite. Do not aggregate the commands into one bounded shell call.

The full suite requires the repository TypeScript compiler. Do not install packages. If this isolated worktree lacks it, the controller may provide a temporary ignored `node_modules/typescript` directory junction to an existing installation whose `package-lock.json` blob and TypeScript version exactly match this worktree. Verify the junction before testing and remove the junction plus its empty parent before staging.

```powershell
node scripts/validate-portability.mjs
if ($LASTEXITCODE -ne 0) { throw 'portability validator failed' }
node scripts/validate-p5.mjs
if ($LASTEXITCODE -ne 0) { throw 'P5 continuation validator failed' }
node scripts/bump-version.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'version validator failed' }
node --test --test-concurrency=1 --test-reporter=dot tests/broker-endpoint.test.mjs tests/bump-version.test.mjs tests/commands.test.mjs tests/generate-app-server-types.test.mjs tests/git.test.mjs tests/platform-policy.test.mjs tests/process.test.mjs tests/render.test.mjs tests/runtime.test.mjs tests/state.test.mjs tests/portability/*.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'full test suite failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'diff check failed' }
```

Expected: both validators, version check, and full test suite pass; `git diff --check` exits 0.

- [ ] **Step 7: Review exact scope, commit once, and verify the tree**

```powershell
$base = '51aa48034e655aacce23938df792bc6da65b049f'
$expected = @(
  'docs/superpowers/plans/2026-08-08-plugin-changelog-frontier.md',
  'scripts/lib/portability-continuity.mjs',
  'tests/portability/p5-continuity.test.mjs'
)
git add -- $expected
if ($LASTEXITCODE -ne 0) { throw 'staging failed' }
$staged = @(git diff --cached --name-only)
if (@(Compare-Object $expected $staged).Count -ne 0) { throw "unexpected staged scope: $($staged -join ', ')" }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'staged diff check failed' }
git diff --cached --
if ($LASTEXITCODE -ne 0) { throw 'staged diff review failed' }
git commit -m 'fix: allow plugin changelog portability updates'
if ($LASTEXITCODE -ne 0) { throw 'commit failed' }
$candidate = (git rev-parse HEAD).Trim()
if ((git rev-parse HEAD^).Trim() -cne $base) { throw 'candidate parent mismatch' }
$committed = @(git diff-tree --no-commit-id --name-only -r HEAD)
if (@(Compare-Object $expected $committed).Count -ne 0) { throw "unexpected committed scope: $($committed -join ', ')" }
if ((git status --porcelain=v1)) { throw 'worktree is not clean after commit' }
Write-Output "COMMIT_CANDIDATE=$candidate"
```

Expected: one local commit containing only the plan, the one-entry exact allowlist change, and the two regression-path cases. Stop without pushing.
