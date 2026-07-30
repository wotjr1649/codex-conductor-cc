# Security policy

## Supported baseline

The security baseline in this repository covers Windows x64 and Node.js 24.
The product support range remains `>=24.0.0`; P3 validation uses the exact
security release in `toolchain.json`. Linux, macOS, Windows Arm64/x86, and
Node.js before 24 are outside this baseline.

Version 0.1.0 is a private, source-only downstream checkpoint. It has no
public release artifact, supported distribution channel, or SLSA claim.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not put
secrets, personal paths, raw prompts, exploit payloads, or customer data in a
public issue. Include the affected commit, a minimal reproduction, impact,
and whether the behavior crosses the same-user boundary. The repository owner
coordinates acknowledgment, remediation, and disclosure.

## Security claims

P3 establishes fail-closed policy, exact tool acquisition, static workflow
checks, and secret-safe evidence controls. It does **not** retrofit the P2
runtime.

- The existing named pipe is not an isolation boundary. Same-user isolation
  is not guaranteed and peer identity is only an admission signal.
- Unattended approval must deny or interrupt, but runtime enforcement is
  deferred to P4/v0.2.
- Bare executable lookup, shell launch, canonical path enforcement, runtime
  log redaction, and IPC peer enforcement remain specified but not observed.
- `CODEOWNERS` records ownership; branch settings must independently require
  review before it is an enforced control.

The machine-readable source of these statements is
`security/p3-policy.json`. See `docs/security/THREAT_MODEL.md` and
`docs/security/REPOSITORY_SECURITY.md` for boundaries and repository controls.

## Dependency and tool updates

Security-sensitive tools and Actions must use the immutable identities in
`toolchain.json`. Mutable channels, global installs, unverified digest
changes, expired reviews, and unknown manifest fields fail validation. A new
Node 24 security release, vendor signing-key change, artifact replacement,
license change, or relevant tool vulnerability requires immediate review.
