# Security

Please report security problems privately, through **Report a vulnerability**
on this repository's Security tab, not in a public issue. If that button is not
there, open an issue that says only that you have a security report, with no
details, and you will be given a private way to send it. Say which polyfill
and which host, the host's version and your operating system, what you did
and what happened.

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against:

| Polyfill | Claude Code | Codex | Pi | OpenCode | Muse Code |
|---|---|---|---|---|---|
| Events | [SECURITY.md](polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](polyfills/events/codex/SECURITY.md) | [SECURITY.md](polyfills/events/pi/SECURITY.md) | [SECURITY.md](polyfills/events/opencode/SECURITY.md) | [SECURITY.md](polyfills/events/muse/SECURITY.md) |
| Apps | [SECURITY.md](polyfills/apps/claude-code/SECURITY.md) | not available | not available | not available | not available |
| Skills | no polyfill: built into Claude Code, in beta from 2.1.332 | [SECURITY.md](polyfills/skills/codex/SECURITY.md) | [SECURITY.md](polyfills/skills/pi/SECURITY.md) | [SECURITY.md](polyfills/skills/opencode/SECURITY.md) | [SECURITY.md](polyfills/skills/muse/SECURITY.md) |
| Server Cards | [SECURITY.md](polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](polyfills/server-cards/opencode/SECURITY.md) | [SECURITY.md](polyfills/server-cards/muse/SECURITY.md) |
| ARD | [SECURITY.md](polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](polyfills/ard/codex/SECURITY.md) | [SECURITY.md](polyfills/ard/pi/SECURITY.md) | [SECURITY.md](polyfills/ard/opencode/SECURITY.md) | [SECURITY.md](polyfills/ard/muse/SECURITY.md) |

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

OpenCode's shipped permission rules allow every action. Each OpenCode polyfill
puts its consequential step (a watch, a skill load, a registry search or a
server addition) to OpenCode's rules and makes it ask by default; a `deny` or
`ask` rule you write wins, and with nobody there to answer, OpenCode refuses.
None answers a question itself or reads OpenCode's stored credentials, OAuth
tokens included. OpenCode's rules remain the boundary. Skills also asks before
a cross-server read while a served skill is loaded, naming both servers
(SEP-2640 X8). OpenCode 2.4.1's TUI shows each of these questions only as
"Call tool `<action>`"; the details are on the model's call line just above
it.

**Muse Code offers plugins no approval dialog.** In Claude Code, Codex, Pi
and OpenCode, in a mode that asks, the polyfills ask through a prompt the host
draws itself, which the model can't answer (with approvals off in Claude Code
or Codex, a watch isn't asked). Muse's MCP client offers no elicitation, and a
tool call that isn't read-only, or a hook's "ask", goes to its approval judge,
a model that can approve with nobody asked. So no Muse polyfill leaves its
consequential step to that judge:
- **Events and Skills.** Consent is a phrase you type, checked by the plugin's
  `UserPromptSubmit` hook. Starting or stopping a watch, and loading a skill,
  wait for a phrase that names what it approves
  (`watch tickets ticket.created 4821`, `load github git-workflow 4821`). Only
  a message of your own satisfies it: Muse ran that hook for the messages you
  typed, and none of the ways a model can put text into a session (scheduled
  prompts, monitors, subagents, other sessions, goals, workflows) ran it when
  each was
  [checked](polyfills/events/muse/docs/live-run.md#what-can-send-the-phrase).
  Unlike a host's dialog, you read the question as the model relays it.
- **Server Cards and ARD.** An addition is a `muse mcp add` command you run
  yourself.
- **No search.** ARD has no registry search in Muse.

The Muse forms read Muse's MCP server list (`~/.config/muse/settings.json`),
which can hold header values you wrote, and never Muse's sign-in store. They
read no project's configuration. They reach no server where your organisation
manages Muse. While a plugin's MCP server is turned off in Muse, its hook does
nothing.

