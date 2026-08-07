# Codex Conductor v0.2 Portability Implementation Plan

> Execute in order with test-first changes. Stop on an unexpected base, frozen-file drift, unsupported artifact, or unprovable ownership.

**Goal:** Ship first-class Linux x64, macOS x64, and macOS arm64 support while preserving Windows x64 P5 exactly.

**Architecture:** A small P5 continuation gate protects the old evidence plane. A shared tuple policy, private POSIX runtime tree, authenticated Unix control sockets, and retained process handles provide the cross-platform runtime. A separate pinned portability workflow produces commit-bound evidence.

**Constraints:** Personal fork only; no upstream write, npm publish, central marketplace submission, force push, rerun, global install, new runtime dependency, or generic PID kill on POSIX.

---

## Phase 1 — P5-to-portability continuity

1. Add RED cases to `tests/p5-matrix-profile.test.mjs` for exact-base ancestry, frozen P5 drift, unauthorized paths, and a valid portability descendant.
2. Add the minimum continuation helper under `scripts/lib/` and `scripts/validate-portability.mjs`.
3. Add one guarded continuation call to `scripts/validate-p5.mjs`; leave its legacy validation path unchanged.
4. Run the focused P5 test and validator, inspect the diff, then run the full frozen Windows test command with pinned Node 24.18.1.

## Phase 2 — Explicit platform policy

1. Add RED tests under `tests/portability/` for the four allowed tuples and rejection of Windows arm64, Linux arm64, and unknown hosts.
2. Add one shared policy module under `plugins/codex/scripts/lib/` and call it before tool/process startup.
3. Update package OS/CPU metadata only as required for repository installation; keep runtime tuple validation authoritative.
4. Run the focused policy tests and existing Windows policy tests.

## Phase 3 — Private POSIX endpoints and atomic state

1. Add RED tests for derived socket paths, length bounds, `0700`/`0600` modes, traversal, symlink ancestors, type swaps, and corrupted state.
2. Extend `broker-endpoint.mjs` with Unix endpoint creation/parsing while preserving named-pipe behavior.
3. Add the smallest runtime-root helper using `node:fs`, `node:path`, `node:os`, and current-user ownership checks.
4. Change `state.mjs` to validate IDs, derive paths, and write atomically; cleanup must never unlink a stored path.
5. Run focused endpoint/state tests on Windows plus syntax checks for POSIX-only branches.

## Phase 4 — Owned POSIX process lifecycle

1. Add RED tests to `tests/portability/` for invalid PIDs, stale records that must not kill a sentinel, group `SIGTERM` then bounded `SIGKILL`, and already-exited children.
2. Add a retained-handle POSIX shutdown path in `process.mjs`; preserve the Windows tree-termination path.
3. Route direct app-server shutdown through the retained handle. Persisted POSIX PIDs remain diagnostic and never authorize a signal.
4. Run focused process tests and the existing Windows process suite.

## Phase 5 — Authenticated broker and background control

1. Add RED tests for false readiness, wrong capability, replay, generation mismatch, unauthenticated shutdown, and inaccessible control sockets.
2. Add a compact length-prefixed challenge/HMAC exchange using `node:crypto`; pass the broker capability through an inherited descriptor.
3. Require authenticated readiness and shutdown in `broker-lifecycle.mjs` and `app-server-broker.mjs`.
4. Give each POSIX background worker a derived authenticated control socket. Change cancel/session-end to request self-cancellation and fail closed when ownership cannot be proved.
5. Run focused broker/background tests, then direct and broker integration tests.

## Phase 6 — Pinned artifacts and separate CI

1. Add RED registry/schema tests for exact tuple coverage, literal runner labels, immutable versions, asset URLs, and digests.
2. Add `ci/portability-profiles-v1.json`, its schema, and a strict local validator.
3. Keep runtime CI free of Codex/Claude acquisition; allow only the existing digest-verifying installer to acquire exact security scanners, with no direct/fallback downloads, caches, or published artifacts.
4. Archive only the obsolete automatic trigger of the frozen P5 workflow, then add `.github/workflows/portability-ci.yml` with Windows plus three independent POSIX jobs, security and dependency-review jobs, and one terminal job.
5. Emit commit- and runner-bound portability evidence only after all tuple tests pass; treat the vendor artifact catalog as reviewed compatibility metadata, not CI trust input.

## Phase 7 — Full verification and personal v0.2 release

1. Run focused tests, the current Windows v0.2 suite with pinned Node 24.18.1, the portability validator, version checks, and workflow/schema validation. Keep historical v0.1 snapshots as validator inputs rather than executing them against v0.2.
2. Perform a security diff scan of runtime paths, authentication, process control, artifact extraction, and CI permissions. Fix every validated issue and rerun affected tests.
3. Update fork-owned docs, changelog, marketplace/plugin/package versions to 0.2.0; state the exact supported tuple list and unsupported tuples.
4. Review the final diff for unrelated changes, commit in logical units, and make one normal push to a new personal-fork branch.
5. Open a draft PR, observe only natural CI attempt 1 and all review threads, then mark ready and fast-forward merge only if clean.
6. Tag and publish personal GitHub Release v0.2.0. Verify tag target, release metadata, repository marketplace metadata, and absence of npm/upstream publication.
