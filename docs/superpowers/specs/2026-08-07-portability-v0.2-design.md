# Codex Conductor v0.2 Portability Design

**Status:** Approved for implementation on the personal public fork.

## Outcome

Add first-class support for these exact host tuples without weakening the released Windows contract:

- Windows x64
- Linux x64
- macOS x64
- macOS arm64

The release remains unofficial, fork-owned, repository-marketplace distributed, and unpublished to npm or any upstream/central marketplace.

## Boundaries

- Keep the Windows P3/P4/P5 workflow, profiles, evidence, and tests frozen.
- Continue from exact base `099afca5946debe5620411f2ab1d4aec388918ca`; history rewrites do not qualify.
- Add a separate portability validation plane and workflow.
- Use Node standard modules and installed dependencies; add no runtime dependency for sockets, authentication, archives, or process control.
- Never trust a persisted PID or persisted filesystem path as proof of process ownership.
- Never silently expand support to Windows arm64, Linux arm64, or other platforms.

## P5 continuity

`scripts/validate-p5.mjs` gets one small continuation branch. The legacy path remains intact for the released base and its historical repair commits. A descendant of the exact base may continue only when `scripts/validate-portability.mjs` succeeds.

The portability validator will:

1. require the exact base to be an ancestor of `HEAD`;
2. require frozen P5 files to match the base byte-for-byte, except the reviewed continuation entry point;
3. allow only the explicit v0.2 path set;
4. validate the new platform registry, pinned artifacts, workflow, tests, and evidence together.

New portability tests live below `tests/portability/`, outside the frozen P5 top-level test registry. The existing Windows workflow continues running its unchanged checks.

## Platform policy

One shared module exposes and validates the four supported `(platform, arch)` tuples. `package.json` may list the three operating systems and two architectures, but runtime validation remains authoritative because npm metadata cannot express tuple pairs. Unsupported cross-product entries fail before a tool or child process starts.

## POSIX runtime ownership

On Linux and macOS, all sockets and control files are derived from validated opaque IDs beneath a private runtime root:

`<runtime-root>/codex-conductor/<scope-id>/...`

The root and each ancestor used by the plugin must be absolute, owned by the current user, non-symlinked, and not group/world writable. Directories use mode `0700`; capability files use `0600`; Unix sockets are reduced to `0600` after bind. Paths are derived locally and are not persisted in session or job state.

State records contain only validated identifiers, generation values, status, and non-sensitive timestamps. Writes use a temporary file plus same-directory atomic rename. Corrupt, mismatched, or type-swapped state fails closed; cleanup never follows stored paths or symlinks.

Windows named-pipe behavior stays unchanged.

## Broker authentication

Opening a Unix socket is not readiness. A broker is ready only after a challenge/response authenticated with a random per-generation capability. The capability is never placed in argv, environment variables, logs, or durable session state.

- The broker receives its copy over an inherited pipe/file descriptor.
- The client reads its copy from a private `0600` file derived from validated identifiers.
- Requests bind the challenge, operation, broker ID, and generation with HMAC-SHA-256.
- Replay, generation mismatch, malformed frames, and unauthenticated shutdown are rejected.

Session teardown sends authenticated shutdown. If ownership cannot be proved, it records an indeterminate state and does not kill a numeric PID.

## Process shutdown

Direct children are started as their own POSIX process group and retained as live `ChildProcess` handles. Shutdown is bounded and handle-owned:

1. request graceful protocol shutdown;
2. send `SIGTERM` to the retained group;
3. after the bounded grace period, send `SIGKILL` to that same retained group.

PID validation rejects non-integers, non-positive values, the current process, and unowned records. Persisted PIDs are diagnostic only on POSIX.

Background workers expose a private authenticated control socket. Cancel and session-end ask the worker to cancel itself. Loss of the authenticated channel fails closed instead of falling back to a bare PID kill.

## Toolchain and CI

Add a versioned portability registry containing exact platform tuple, runner label, asset URL, and SHA-256 data. The initial runners are literal labels:

- `ubuntu-24.04`
- `macos-15-intel`
- `macos-15`

The separate portability workflow downloads only pinned official assets, verifies digests before extraction, rejects unsafe archive entries, and then verifies the platform-native trust signal available for that artifact. macOS jobs verify signing/notarization where supplied; Linux jobs verify signed checksum or Sigstore material where supplied. A failed or unavailable trust check blocks activation for that tuple.

No `*-latest` labels, package force flags, global installs, reruns, or fallback downloads are allowed.

## Verification and release

Tests are written RED first for tuple rejection, runtime-root permissions, path traversal/symlink attacks, broker impersonation/replay, stale PID safety, process-group escalation, background cancellation, and frozen P5 continuity. Windows contract tests must remain green.

Support is release-ready only after all four tuple jobs pass naturally, the portability evidence matches the exact commit and runner identities, review threads are clear, and a full security diff review finds no unresolved high-confidence issue. Then the personal fork may fast-forward merge and publish v0.2.0 with the exact supported tuple list.
