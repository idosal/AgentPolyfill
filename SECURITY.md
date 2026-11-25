# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host, the host's version and your operating system, what you did
and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex | Pi | OpenCode | Antigravity |
|---|---|---|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) | [SECURITY.md](polyfills/events/pi/SECURITY.md) | [SECURITY.md](polyfills/events/opencode/SECURITY.md) | [SECURITY.md](polyfills/events/antigravity/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available | not available | not available | no form; the App shows MCP Apps itself |
| Skills | no polyfill: built into Claude Code, in beta from 2.1.332 | [SECURITY.md](polyfills/skills/codex/SECURITY.md) | [SECURITY.md](polyfills/skills/pi/SECURITY.md) | [SECURITY.md](polyfills/skills/opencode/SECURITY.md) | [SECURITY.md](polyfills/skills/antigravity/SECURITY.md) |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](polyfills/server-cards/opencode/SECURITY.md) | [SECURITY.md](polyfills/server-cards/antigravity/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) | [SECURITY.md](polyfills/ard/pi/SECURITY.md) | [SECURITY.md](polyfills/ard/opencode/SECURITY.md) | [SECURITY.md](polyfills/ard/antigravity/SECURITY.md) |

In T3 Code, which runs Codex, Claude Code, OpenCode and other agents for
you, the plugins above run as they do in those hosts (checked with Codex). Events has a form of its own there, for Codex
threads: [mcp-events for T3 Code](polyfills/events/t3/SECURITY.md). It is an
MCP server Codex starts, and a watcher process that keeps running after T3
Code closes, until no thread has a watch, and wakes a thread with T3 Code's
`t3 thread send`. The turn it starts runs in the thread's own permission
mode. It reads no stored credentials, Codex's or T3 Code's.

These are third-party plugins and extensions that run with your permissions
in each host. They have been reviewed by an AI reviewer that did not build
them, and not audited by a person. The Antigravity forms' review is in
progress.

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

Each Antigravity polyfill puts its own actions to you in Antigravity's
approval card, through `force_ask`: an Events watch, a new or changed skill
load, a server addition or a registry search. None auto-approves. The App
greys out the card's "always allow" choices; the CLI's card still lists them.
The other Events tools, an approved unchanged skill load and skill file reads
pass with a ticket and then get Antigravity's usual MCP question, which
allow rules can skip. By default that question is asked: unconfigured MCP
tools default to Ask, the interactive CLI starts in auto mode, where an MCP
tool call still asks, and headless `agy -p` reports `request-review` and
denies a call nobody answers. Whether `--dangerously-skip-permissions` also
skips `force_ask` hasn't been checked. In CLI 1.5.17 a `PreToolUse` hook
that fails makes the call fail. Skills doesn't meet X8: its hook asks before
another server's resource read while a served skill is loaded, but
Antigravity (CLI 1.5.17, App 2.35.1) ignores that question and the read goes
ahead. The IDE
documents no plugin hooks, so the forms aren't supported there, and their
gated calls are refused. The forms read
`~/.gemini/config/mcp_config.json`, which can hold API keys in headers, but
never log or show those values, and never open
`~/.gemini/antigravity/mcp_oauth_tokens.json` or any other sign-in store.
Antigravity's approval system remains the boundary.
