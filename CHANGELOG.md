# Changelog

## 0.2.0 — 2026-08-07

Personal-fork portability release.

- Added runtime support for Linux x64, macOS x64, and macOS arm64 while retaining Windows x64.
- Added private Unix sockets, derived runtime paths, atomic state writes, bounded socket paths, and strict owner/mode checks.
- Added mutual HMAC authentication for POSIX broker and worker control channels; unauthenticated readiness, shutdown, cancellation, and replay fail closed.
- Replaced persisted-PID authority on POSIX with retained process handles and authenticated worker self-cancellation.
- Removed Windows shell interpolation from product command execution while preserving constrained `.cmd` launcher compatibility.
- Added runtime jobs without Codex/Claude artifact acquisition for `windows-2025`, `ubuntu-24.04`, `macos-15-intel`, and `macos-15`, plus exact security scanning, dependency review, and an artifact compatibility catalog.
- Bound the Windows full-suite lane to lockfile-only, no-lifecycle dependency restore and a non-redirected ephemeral test root.
- Preserved the released v0.1/P5 Windows evidence body through an exact continuation gate and archived only its obsolete automatic PR trigger.

Unsupported tuples remain Windows arm64/ia32, Linux arm64, and Node.js below 24.

## 0.1.0 — 2026-08-07

- First personal-fork release based on the verified Windows x64 P5 contract baseline.
