# Upstream and release policy

Codex Conductor is an unofficial downstream fork of
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). It is maintained
independently by `wotjr1649` and is not affiliated with or endorsed by OpenAI or Anthropic.

## Version and provenance

- Downstream product version: `package.json` (`0.1.0` at the P2 checkpoint)
- Upstream repository: `openai/codex-plugin-cc`
- Upstream base: `db52e28f4d9ded852ab3942cea316258ae4ef346`
- Verified product baseline: `9be83f26780429cd693bef62a20eebc70f54cec1`
- Downstream provenance metadata: `downstream.json`

The downstream version and upstream base are intentionally independent. Updating one does not
imply that the other changed.

## Compatibility policy

The P2 checkpoint preserves the verified Windows x64 and Node.js 24-or-later runtime policy. It
also preserves the upstream command, agent, skill, hook, authentication, provider, transport, and
app-server capability contracts. The plugin keeps the internal name `codex` so existing slash
commands remain compatible.

## Sync and release policy

Upstream changes must be reviewed and validated against the protected command contract before
they are integrated. A public release is blocked until the maintainer rechecks marketplace and
package-name availability, trademark presentation, attribution, and release credentials. This
checkpoint does not publish a package, create a release, push a branch, or claim endorsement.

Codex Conductor is a drop-in replacement for the official `codex` plugin. Do not enable both at
the same time.
