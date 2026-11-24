# mcp-apps-cli

MCP Apps are the interactive UIs that MCP servers ship. This plugin renders
them inline in the terminal Claude Code CLI, under the tool call that produced
them. Click into a view to use it: clicks, drags and keys go to the app. Esc
gives the keyboard back, and ctrl+], or **esc** in the view's header, sends the
app an Escape. Existing MCP servers work unmodified.

Where the terminal shows images (iTerm2 3.5+, kitty, Ghostty), views are real
pixels. Elsewhere they are block glyphs in the page's colours, with the app's
text, including chart labels, as real characters.

## Install

```
claude plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill
```

Or, at the prompt of a `claude` session,
`/plugin install mcp-apps-cli --marketplace idosal/AgentPolyfill`. Start a new
session for it to load.

The package carries the helper for each platform it supports. Nothing else is
downloaded or installed.

## Setup

It needs Google Chrome, or another Chromium-based browser (Edge, Chromium,
Brave). After installing the plugin, run `/tui fullscreen` once so Claude Code
receives the mouse. Then turn on mouse reporting in your terminal (iTerm2:
Settings → Profiles → Terminal → Enable mouse reporting; tmux:
`set -g mouse on`).

A small helper process runs the views. It is a Rust binary the plugin carries
for each platform:

- macOS (Apple Silicon, Intel);
- Linux (x64, Arm; static, so any distribution);
- Windows (x64, which Windows on Arm runs emulated; new in this release).

The one for your machine runs. Nothing is downloaded or installed for it, and
nothing needs Node. On a machine the plugin has no helper for, a toast says so
and views don't open. Without Chrome or another Chromium-based browser, the
plugin offers once to download Chrome for Testing's headless shell. A view you
scrolled away from and never used sleeps after 10 minutes, freeing its memory,
and wakes when it's back in sight.

Then add MCP servers as usual. When Claude calls a tool that has an MCP App,
the app appears under the call, sized to fit the screen.

- For a tool your permission rules allow outright, the app appears as Claude
  starts writing the call. An app that draws its arguments (a 3D scene, a
  shader) builds up as they're written.
- A call that waits to be allowed (you're asked, or auto mode decides) loads
  its app early too. But the app gets the arguments only once the call is
  allowed, and goes if it's denied.
- The app follows Claude Code's theme as you change it.
- A view taller than its box scrolls with PgUp/PgDn.
- The view's header moves it: **fullscreen** fills the terminal, **pane** puts
  it beside the chat where it keeps running, and **back to the chat** returns
  it. Apps that ask for those modes get them.

Consent is set in `/config`:

- **App tool calls** follow your permission rules by default, as Claude's own
  calls do: you're asked where they would ask. You can also have them always
  ask, or run without asking, as Claude Desktop does. Your deny rules apply in
  every mode.
- **App messages** are asked about by default, as in Claude Desktop. You can
  also have them put in your prompt to send, or sent at once.
- Opening a link or saving a file from an app is asked too.

The plugin reaches only MCP servers Claude Code itself uses in the session;
see SECURITY.md.

`MCP_APPS_CLI_MODE=cells|image` forces a drawing mode. Cell views are drawn in
exact colours in 24-bit terminals by default. `MCP_APPS_CLI_TRUECOLOR=0` uses
16 levels a channel instead, for less CPU. Picture views carry the app's text
as their alt text, for screen readers. Servers that need sign-in (OAuth) don't
show apps yet.

More: https://github.com/idosal/AgentPolyfill/tree/main/polyfills/apps/claude-code
