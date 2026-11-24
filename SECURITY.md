# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host (Claude Code or Codex), the host's version and your operating
system, what you did and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex |
|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available |
| Skills | [SECURITY.md](polyfills/skills/claude-code/SECURITY.md) | [SECURITY.md](polyfills/skills/codex/SECURITY.md) |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) |
| Resource links | none needed: [SECURITY.md](polyfills/resource-links/claude-code/SECURITY.md) | [SECURITY.md](polyfills/resource-links/codex/SECURITY.md) |

These are third-party plugins that run in Claude Code or Codex with your
permissions. They have been reviewed by an AI reviewer that did not build
them, and not audited by a person.
