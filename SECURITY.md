# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host, the host's version and your operating system, what you did
and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex | Pi | Antigravity |
|---|---|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) | [SECURITY.md](polyfills/events/pi/SECURITY.md) | [SECURITY.md](polyfills/events/antigravity/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available | not available | no form; the App shows MCP Apps itself |
| Skills | [SECURITY.md](polyfills/skills/claude-code/SECURITY.md) | [SECURITY.md](polyfills/skills/codex/SECURITY.md) | [SECURITY.md](polyfills/skills/pi/SECURITY.md) | [SECURITY.md](polyfills/skills/antigravity/SECURITY.md) |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](polyfills/server-cards/antigravity/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) | [SECURITY.md](polyfills/ard/pi/SECURITY.md) | [SECURITY.md](polyfills/ard/antigravity/SECURITY.md) |

These are third-party plugins and extensions that run with your permissions
in each host. They have been reviewed by an AI reviewer that did not build
them, and not audited by a person. The Antigravity forms are awaiting that
review.

Pi runs tool calls without asking unless a permission extension asks. Each
Pi polyfill asks before its consequential step: a watch, a skill load, a
registry search or a server addition. None auto-approves or reads Pi's
stored credentials (`mcp-auth.json`, `auth.json`). Pi's permissions remain
the boundary. Skills also asks before a cross-server read while a served
skill is loaded, naming both servers (SEP-2640 X8).

Each Antigravity polyfill puts its own actions to you in Antigravity's
approval card: a server addition, a registry search or a skill load. The card
can't be approved for good, and none auto-approves. Read-only tools and
Events watches go through Antigravity's usual MCP approval, which by default
asks before any MCP tool (the App's card; the CLI's default mode,
`request-review`). They read
`~/.gemini/config/mcp_config.json`, which can hold API keys in headers, but
never log or show those values, and never open
`~/.gemini/antigravity/mcp_oauth_tokens.json` or any other sign-in store.
Antigravity's approval system remains the boundary.
