---
description: mcp-apps-cli renders MCP Apps inline in the Claude Code terminal, with mouse and keyboard. Real pixels in iTerm2, kitty and Ghostty, character cells elsewhere.
---

# Apps

`mcp-apps-cli` brings MCP Apps to the Claude Code terminal. When Claude calls a
tool that ships an [MCP App](https://github.com/modelcontextprotocol/ext-apps),
the app's interface appears inline, under the tool call, and you can click,
drag and type into it. Existing MCP servers work unmodified. It implements MCP
Apps (`io.modelcontextprotocol/ui`) as published in `specification/2026-01-26`
(Stable), plus `ui/download-file` from the draft.

- **Real pixels** in terminals that show images: iTerm2 3.5+, kitty and Ghostty.
- **Character cells** everywhere else: Terminal.app, VS Code, tmux and so on.
  Text, including chart labels, stays real characters.

<Recording
  cut="apps"
  alt="In Claude Code, Play DOOM opens the game from the hosted arcade server under the tool call, and it is played. A system monitor app draws a live CPU chart with a tooltip under the pointer, and in a terminal with no image support it draws the chart in text. Then a 3D torus knot renders inline and turns when dragged."
  caption="A real session (19 s; waits sped up, with a badge saying how fast): DOOM from the hosted arcade server; a system monitor, drawn as a picture and, where the terminal shows none, in text; and a 3D scene, turned by dragging."
/>

## Install

```
/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill
```

Or in a terminal, `claude plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill`.
Start a new `claude` session for it to load.

Apps isn't in Codex yet. Codex gives a plugin no way to draw in its terminal,
and its terminal doesn't declare MCP Apps to servers, which no plugin can
change ([How it works](./how-it-works#how-a-plugin-plugs-in-today)).

Apps has no Pi form. Pi 1.6.0 leaves out `ui://` resources and tool `_meta`,
so an extension cannot get an App's UI through Pi. Pi's terminal could draw
one in principle, but no Pi Apps form is built or tested.

Apps has no OpenCode form. OpenCode 2.4.1 has no MCP Apps support of its own,
and its TUI draws only terminal text. OpenCode Desktop's experimental panels
can embed a web view, but a plugin can't read a `ui://` resource or a tool's
`_meta` over OpenCode's connection, and there is no place in the
conversation to draw a view. That was looked into, not built.

Apps has no Antigravity form. The Antigravity App renders MCP Apps itself
(v2.34.0 and later); the CLI and IDE show text only.

Apps has no Copilot form, because Copilot has MCP Apps built in where they
can be drawn: VS Code's Copilot harness turns them on (from its source; no app was drawn there). The Copilot CLI
terminal draws none and doesn't declare MCP Apps to servers, and Copilot's
extensions have no UI hooks like the ones this plugin uses in Claude Code
([why](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/README.md#skills-and-apps-in-copilot)).

Apps has no Hermes form yet.

The plugin is one zip, attached to a release of the repository and checked
against the SHA-256 in the repository's marketplace file before Claude Code
unpacks it. It carries a small helper program for each platform and needs
nothing else installed, not even Node.

## Try it

A hosted demo server serves classic shareware games from archive.org, played
in the app's view:

```bash
claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp
```

Start `claude` and ask:

> Find a shareware game in the arcade and load it.

Claude Code asks whether to allow the tool, as it does for any MCP tool, unless
your permission rules already allow it. The app appears under the call.

## From install to the first app

1. **Install.** Nothing is asked. The four settings below start at their
   defaults; the install's note that they are "not yet set" needs no action.
2. **Add an MCP server that has apps**, as you add any server.
3. **Start `claude` and ask** for something the server's app shows.

What else can come up, once each:

- **No Chromium browser installed.** The view says so, and the plugin offers to
  download Chrome for Testing's headless shell (about 100 MB, from Google). Say
  no and views stay closed: install Chrome, Edge, Chromium or Brave, or point
  `MCP_APPS_CLI_CHROME` at one, and the next view opens. The offer is not
  repeated.
- **Not in fullscreen.** After the first view appears, the plugin offers to
  switch Claude Code to its fullscreen layout, the only one that passes clicks
  and keys to a view (Claude Code restarts and resumes the conversation). Say
  no and views stay view-only; `/tui fullscreen` switches later. Not offered in
  tmux, or if you chose the main screen yourself (`CLAUDE_CODE_NO_FLICKER=0`).
- **Mouse reporting off in your terminal.** Clicks don't reach the view. Check
  iTerm2's Settings → Profiles → Terminal → Enable mouse reporting, and in tmux,
  `set -g mouse on`. A plugin cannot change a terminal's settings.
- **An app asks to send Claude a message, open a link or save a file.** You are
  asked, with a choice to allow that app's messages or links for the rest of
  the session. Say no and nothing is sent, opened or saved.

## Requirements

- **Claude Code** 2.1.329 or later (the version it is tested with).
- **macOS** (Apple Silicon or Intel), **Linux** (x64 or Arm64, any
  distribution) or **Windows** x64. Windows is new: its helper passes the same
  checks on GitHub's Windows machines, but it hasn't yet been used in a Claude
  Code session on Windows.
- **Chrome**, or another Chromium-based browser (Edge, Chromium, Brave). Views
  run in a headless copy of it.
- **Clicking into views** needs Claude Code's fullscreen layout, and mouse
  reporting on in your terminal. Outside fullscreen, views are view-only.

## Using it

When Claude calls a tool with an MCP App, the app appears under the call, sized
to fit. Click into it to use it; **Esc** gives the keyboard back (**ctrl+]**, or
**esc** in the view's header, sends the app an Escape). A view taller than its
box scrolls with PgUp/PgDn. The header moves the view: **fullscreen**, **pane**
(beside the chat, still running) or **back to the chat**. The app follows
Claude Code's theme.

## Settings

In `/config`:

| Setting | Default | Choices |
|---|---|---|
| App tool calls: an app calling its own server's tools | rules: what your permission rules allow runs, and you're asked where they would ask | rules, ask (always), allow (without asking, as Claude Desktop does) |
| App messages: an app sending Claude a message | ask, as Claude Desktop does | ask, fill (put it in your prompt), allow |
| Offer fullscreen | ask once | ask, never |
| Offer a browser download | ask once | ask, never |

Your deny rules apply to an app's tool calls in every mode, and where Claude
Code can't check its rules for a tool, you're asked whatever the setting. An app
may ask to run only a tool its server lists. Opening a link or saving a file
from an app always asks.

## Limits

- **Servers that need sign-in (OAuth) don't show apps yet.** Claude Code doesn't
  give plugins the UI metadata of a tool or of a resource, so the helper opens
  its own connection to each server, from your MCP config, and that connection
  can't sign in.
- **No apps from claude.ai connectors or plugins' servers**, nor from a server
  named both on `claude`'s command line (`--mcp-config`) and in a config file,
  nor any at all under a managed MCP policy.
- **Clicks and keys** reach a view only in the fullscreen layout. There's no
  mouse wheel over inline views (use PgUp/PgDn), and a paste goes to the prompt.
- **Memory:** Chrome takes about 260 MB while views are open, plus 120–350 MB
  per live view. At most 3 views stay live, and a view you scrolled away from and
  never used sleeps after 10 minutes.
- **Cells** are one character each: wide characters show as `?`.

### In T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) shows MCP Apps itself, for
Codex and for Claude Code 2.1.301 or newer, on desktop, web and phone. Don't
use this polyfill for Claude Code sessions run from T3 Code.

## Spec

Where it departs from MCP Apps 2026-01-26:

- **Default CSP.** When an app declares no `ui.csp`, views get basic-host's
  default policy, which allows `eval` and `blob:` and still opens no other
  domain, instead of the spec's `default-src 'none'`. Apps that run code they
  generate, like the three.js example, need it.
- **Display modes.** A terminal has no floating windows: fullscreen is a view as
  tall as the terminal, and picture-in-picture is a pane beside the chat.
- **`platform`** is sent as `"desktop"`; the spec has no value for a terminal.

[`docs/COMPLIANCE.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/docs/COMPLIANCE.md)
goes through the spec clause by clause (each MUST, SHOULD and MAY, with its
test), and says how the plugin is checked: a TLA+ model of which server a view's
app comes from and what it may make happen, checked with TLC within stated
bounds, the server gate checked over every case, and property-based tests.

## Security

- **Only servers Claude Code uses.** The helper opens its own connection to a
  tool's MCP server only when Claude Code says it is connected to that server
  in this session under that name, and only to the config entry Claude Code
  would use. Each request the helper then sends to a server waits for Claude
  Code's yes, asked for that request; when Claude Code stops using the server,
  what the helper has in flight to it is cancelled and its connection closed.
  Credentials in your environment (`ANTHROPIC_*`, `AWS_*`, `GITHUB_*` and the
  like) are never put into a remote server's address or headers.
- **An app's tool calls follow your permission rules** by default.
- **Each view runs in a sandboxed iframe** inside a dedicated headless Chrome,
  under the app's Content Security Policy, one browser context per view.
  Chrome's own sandbox and its local-network checks stay on; a view of a server
  on your machine or local network may reach that network.
- **A view's cookies and storage** are saved, readable only by you, in the
  plugin's data folder, and deleted after 30 days unused.
- **The plugin sends nothing anywhere.** Network traffic is the apps' own
  (limited by their CSP), the MCP servers Claude Code uses, and, if you accepted
  it, the Chrome download from Google and its update checks.
- **It never reads Claude Code's stored credentials.** The helper answers only
  requests that carry its per-session token, on a local endpoint only you can
  open.

[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/SECURITY.md)
lists what is checked and what isn't protected.

## When Claude Code supports MCP Apps itself

The plugin draws views only in an interactive terminal session. Claude Code's
desktop app renders MCP Apps itself, and `claude -p` and the Agent SDK are left
alone. In the terminal it cannot tell whether Claude Code has started rendering
MCP Apps natively, because a mod cannot see what Claude Code's own MCP client
supports. When it does, turn the plugin off:

```bash
claude plugin disable mcp-apps-cli@agent-polyfill
```

or remove it with `claude plugin uninstall mcp-apps-cli@agent-polyfill`.

## More

On GitHub, in [`polyfills/apps/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/apps/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/README.md),
how it works and how to build it from source.
