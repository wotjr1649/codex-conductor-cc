# P3 threat model

## Scope and trust boundaries

P3 protects the repository and its local validation evidence without changing
command or runtime behavior. The supported environment is a single repository
owner on Windows x64 with Node.js 24. The repository, checked-in policy, and
exactly verified run-owned tools are trusted only after validation.

Untrusted inputs include pull-request content, workspace files, executable
search paths, downloaded bytes before digest verification, mutable release
channels, model output, prompts, tool output, environment credentials, and
named-pipe clients. GitHub-hosted runners and vendor release services are
external systems, not local proof.

## Assets

- downstream source identity and P2 protected command/agent/skill/hook trees;
- repository and release credentials;
- user prompts, paths, tool output, and logs;
- approval decisions and process-control messages;
- evidence ordering, exact tool provenance, and validator results.

## Threats and required controls

| Threat | P3 control | P3 evidence | Runtime status |
| --- | --- | --- | --- |
| PATH shadowing or artifact replacement | versioned HTTPS URL, archive and executable SHA-256, run-owned extraction, signature policy | toolchain validator and acquisition script | product launch enforcement deferred |
| Malicious PR workflow | `pull_request`, read-only token, full Action SHA, no OIDC/secrets/cache/artifact release input | workflow validator and local scanners | remote run not executed |
| Mutable or expired tool selection | exact versions, owner/reviewer, review expiry, drift triggers | `toolchain.json` | enforced by P3 validator |
| Same-user/session pipe abuse | declare pipe non-boundary; require deny-by-default peer admission design | `SEC-BOUNDARY-001` | not observed; v0.2 |
| Unattended privilege/approval grant | deny or interrupt; no session/root/network/policy-amend auto-grant | `SEC-APPROVAL-002` | not observed; P4 |
| Secret or private-path disclosure | one validator for seeded negative and redacted positive controls | seeded-secret fixture and manifest | evidence path enforced; product logs deferred |
| Evidence rewriting or inflated GREEN | ordered attempts, explicit `not-run`, digests, protected-tree readback | attempt ledger | local Git anchored; remote immutability not run |
| Dependency vulnerability | lockfile OSV scan and PR dependency review | local OSV result; pinned Action | remote dependency review not run |

## Explicit non-claims

P3 does not claim that the Node named pipe authenticates or isolates users,
that the app-server executable is resolved canonically at runtime, that every
product log is redacted, that approval policy is runtime-enforced, or that a
release artifact is attested. Existing P2 code can use a bare `codex` command,
a Windows shell, an unauthenticated pipe, and persisted rendered output.
Those are inputs to P4/v0.2, not hidden GREEN results.

## Phase ownership

- P3: exact tool provenance, repository policy, static workflow gates, evidence
  redaction and negative controls.
- P4: approval admission and runtime contract/schema validation.
- P5: full compatibility matrix and repeated runtime trials.
- P6: signing, publishing, provenance/attestation, and public release gates.
- v0.2: same-user/session IPC and canonical executable enforcement.

## v0.2 portability overlay

The v0.2 runtime adds Linux x64, macOS x64, and macOS arm64. Workspace paths,
persisted state, environment-selected endpoints, numeric PIDs, socket peers,
control frames, and child processes are untrusted. The concrete abuse cases are
redirecting app-server traffic to an attacker socket, replaying shutdown or
cancel messages, deleting a path named by forged state, and signalling a reused
PID or unrelated process group.

POSIX runtime files are derived from validated opaque identifiers below a
current-UID `0700` root after rejecting non-sticky group/world-writable
ancestors. Capability files and sockets are `0600`. Broker and
worker connections require a per-generation mutual HMAC challenge; operation
and response proofs bind the current generation and one-use nonces. Persisted
POSIX PIDs are diagnostic only. Direct child groups are signalled only through
retained `ChildProcess` handles, while background cancellation is performed by
the authenticated worker itself. Uncertain authentication or shutdown becomes
`indeterminate`; it never falls back to an arbitrary PID or stored path.
State-index retention never authorizes file deletion. Explicit Windows session
cleanup requires an independent regular job file to match the session record
before any managed job or log artifact is removed.

The boundary protects against other users and attacker-controlled state,
environment, paths, and socket messages. Native code already running as the
same OS user can read the user's private capability files or process memory and
remains outside this boundary. Windows named-pipe and `taskkill` behavior stays
under the frozen P5 contract.
