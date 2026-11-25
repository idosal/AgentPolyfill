# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host, the host's version and your operating system, what you did
and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex | Pi | Copilot CLI |
|---|---|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) | [SECURITY.md](polyfills/events/pi/SECURITY.md) | [SECURITY.md](polyfills/events/copilot/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available | not available | built into Copilot for graphical hosts |
| Skills | [SECURITY.md](polyfills/skills/claude-code/SECURITY.md) | [SECURITY.md](polyfills/skills/codex/SECURITY.md) | [SECURITY.md](polyfills/skills/pi/SECURITY.md) | built into Copilot |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](polyfills/server-cards/copilot/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) | [SECURITY.md](polyfills/ard/pi/SECURITY.md) | [SECURITY.md](polyfills/ard/copilot/SECURITY.md) |

These are third-party plugins and extensions that run with your permissions
in each host. They have been reviewed by an AI reviewer that did not build
them, and not audited by a person.

Pi runs tool calls without asking unless a permission extension asks. Each
Pi polyfill asks before its consequential step: a watch, a skill load, a
registry search or a server addition. None auto-approves or reads Pi's
stored credentials (`mcp-auth.json`, `auth.json`). Pi's permissions remain
the boundary. Skills also asks before a cross-server read while a served
skill is loaded, naming both servers (SEP-2640 X8).

In Copilot, Copilot's own prompts are the boundary. Each Copilot polyfill's
tool that acts (`watch_event`, `unwatch_event`, `add_mcp_server`,
`ard_search`) goes through Copilot's tool prompt, and adding a server or
sending a registry search also asks in Copilot's form, which Copilot declines
where nobody can be asked. None auto-approves: the Events extension, once you
grant it elevated permissions, skips Copilot's prompt only for its four tools
that only read. Events uses only the servers Copilot enables for the session,
lets go of one you switch off, and runs no project's server Copilot wouldn't
run. None reads Copilot's stored credentials (the keychain,
`~/.copilot/mcp-oauth-config/`, signed-in accounts in `config.json`).
