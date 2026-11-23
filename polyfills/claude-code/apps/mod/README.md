# mcp-apps-cli

Renders MCP Apps, the interactive UIs that MCP servers ship, inline in the
terminal Claude Code CLI, under the tool call that produced them. Click into a
view to use it: clicks, drags and keys go to the app, and Esc gives the
keyboard back (ctrl+], or **esc** in the view's header, sends the app an
Escape). Existing MCP servers work unmodified.

Where the terminal shows images (iTerm2 3.5+, kitty, Ghostty), views are real
pixels; elsewhere they are block glyphs in the page's colours, with the
app's text, including chart labels, as real characters.

## Install

```
claude plugin marketplace add idosal/MCPolyfill
claude plugin install mcp-apps-cli@mcpolyfill
```

The package carries the helper for each platform it supports; nothing
else is downloaded or installed.

## Setup

Needs Google Chrome, or another Chromium-based browser (Edge, Chromium,
Brave). After installing the plugin, run `/tui fullscreen` once so Claude
Code receives the mouse, and turn on mouse reporting in your terminal
(iTerm2: Settings → Profiles → Terminal → Enable mouse reporting; tmux:
`set -g mouse on`).

Views are run by a small helper process, a Rust binary the plugin carries
for each platform: macOS (Apple Silicon, Intel), Linux (x64, Arm; static,
so any distribution) and Windows (x64, which Windows on Arm runs emulated;
new in this release). The one for
your machine runs; nothing is downloaded or installed for it, and nothing
needs Node. On a machine the plugin has no helper for, a toast says so and
views don't open. Without Chrome or another Chromium-based browser, the
plugin offers once to download Chrome for Testing's headless shell.
A view you scrolled away from and never
used sleeps after 10 minutes, freeing its memory, and wakes when it's back
in sight.

Then add MCP servers as usual. When Claude calls a tool that has an MCP App,
the app appears under the call, sized to fit the screen. For a tool your
permission rules allow outright, it appears as Claude starts writing the
call, and an app that draws its arguments (a 3D scene, a shader) builds up
as they're written. A call that waits to be allowed (you're asked, or auto
mode decides) loads its app early too, but the app gets the arguments only
once the call is allowed, and goes if it's denied. The app follows Claude Code's theme as you change it. A view taller than
its box scrolls with PgUp/PgDn. The view's header moves it: **fullscreen**
fills the terminal, **pane** puts it beside the chat where it keeps running,
**back to the chat** returns it. Apps that ask for those modes get them.

Consent, in `/config`: **App tool calls** run an app's calls to its own
server's tools by default, as Claude Desktop does (or follow your permission
rules, or always ask); your deny rules apply either way. **App messages** are
asked about by default, as in Claude Desktop (or put in your prompt to send,
or sent at once). Opening a link or saving a file from an app is asked too.

`MCP_APPS_CLI_MODE=cells|image` forces a drawing mode. Cell views are drawn
in exact colours in 24-bit terminals by default; `MCP_APPS_CLI_TRUECOLOR=0`
uses 16 levels a channel instead, for less CPU. Picture views carry the
app's text as their alt text, for screen readers. Servers that need
sign-in (OAuth) don't show apps yet. More:
https://github.com/idosal/MCPolyfill/tree/main/polyfills/claude-code/apps
