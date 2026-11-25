# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host, the host's version and your operating system, what you did
and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex | Pi | OpenCode | Copilot CLI |
|---|---|---|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) | [SECURITY.md](polyfills/events/pi/SECURITY.md) | [SECURITY.md](polyfills/events/opencode/SECURITY.md) | [SECURITY.md](polyfills/events/copilot/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available | not available | not available | no polyfill: built into Copilot for graphical hosts |
| Skills | no polyfill: built into Claude Code, in beta from 2.1.332 | [SECURITY.md](polyfills/skills/codex/SECURITY.md) | [SECURITY.md](polyfills/skills/pi/SECURITY.md) | [SECURITY.md](polyfills/skills/opencode/SECURITY.md) | no polyfill: built into Copilot |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](polyfills/server-cards/opencode/SECURITY.md) | [SECURITY.md](polyfills/server-cards/copilot/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) | [SECURITY.md](polyfills/ard/pi/SECURITY.md) | [SECURITY.md](polyfills/ard/opencode/SECURITY.md) | [SECURITY.md](polyfills/ard/copilot/SECURITY.md) |

In T3 Code, which runs Codex, Claude Code, OpenCode and other agents for
you, the plugins above run as they do in those hosts (checked with Codex). Events has a form of its own there, for Codex
threads: [mcp-events for T3 Code](polyfills/events/t3/SECURITY.md). It is an
MCP server Codex starts, and a watcher process that keeps running after T3
Code closes, until no thread has a watch, and wakes a thread with T3 Code's
`t3 thread send`. The turn it starts runs in the thread's own permission
mode. It reads no stored credentials, Codex's or T3 Code's.

These are third-party plugins and extensions that run with your permissions
in each host. They have been reviewed by an AI reviewer that did not build
them, and not audited by a person.

Pi runs tool calls without asking unless a permission extension asks. Each
Pi polyfill asks before its consequential step: a watch, a skill load, a
registry search or a server addition. None auto-approves or reads Pi's
stored credentials (`mcp-auth.json`, `auth.json`). Pi's permissions remain
the boundary. Skills also asks before a cross-server read while a served
skill is loaded, naming both servers (SEP-2640 X8).

OpenCode's shipped permission rules allow every action. Each OpenCode
polyfill puts its consequential step (a watch, a skill load, a registry
search or a server addition) to OpenCode's rules and makes it ask by
default; a `deny` or `ask` rule you write wins, and with nobody there to
answer, OpenCode refuses. None answers a question itself or reads
OpenCode's stored credentials, OAuth tokens included. OpenCode's rules
remain the boundary. Skills also asks before a cross-server read while a
served skill is loaded, naming both servers (SEP-2640 X8). OpenCode 2.4.1's
TUI shows each of these questions only as "Call tool `<action>`"; the details
are on the model's call line just above it.

In Copilot CLI, Copilot's own prompts are the boundary. In its default mode,
Copilot CLI 1.0.115 asked before each tool call, read-only ones included;
VS Code's Copilot harness ran a read-only tool without asking. Either can
approve a call without the person: in assisted mode (an LLM review, which an
organisation can make the default) or with everything allowed. So each Copilot polyfill asks before its
consequential step itself, after Copilot's tool prompt: a watch in the
extension's own dialog, a registry search or a server addition in the
plugin's form. Copilot declines those where nobody can be asked
(`copilot -p`, even with `--yolo`). Copilot's permission rules still apply to
every tool; only the Events extension's four read-only tools skip its prompt,
after you grant the extension elevated permissions. Events uses only the
servers Copilot enables for the session, lets go of one you switch off, and
runs no project's server Copilot wouldn't run. `ard_search` is marked not
read-only, so a host that runs read-only tools unasked, as VS Code's harness
did, doesn't run it unasked. None reads
Copilot's stored credentials (the keychain, `~/.copilot/mcp-oauth-config/`,
signed-in accounts in `config.json`).
