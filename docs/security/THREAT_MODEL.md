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
