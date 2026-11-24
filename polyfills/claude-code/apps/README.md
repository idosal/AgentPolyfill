# mcp-apps-cli

MCP Apps in the Claude Code terminal. When Claude calls a tool that ships an
[MCP App](https://github.com/modelcontextprotocol/ext-apps), the app's
interface appears inline, under the tool call, and you can click, drag and
type into it. Existing MCP servers work unmodified.

- **Real pixels** in terminals that show images: iTerm2 3.5+, kitty and Ghostty.
- **Character cells** everywhere else: Terminal.app, VS Code, tmux and so on.
  Text, including chart labels, stays real characters.

![Real pixels on the left, character cells on the right](docs/demo-side-by-side.png)

The [video](https://github.com/idosal/MCPolyfill/releases/download/mcp-apps-cli-v0.1.0/mcp-apps-cli-demo.mp4) (57 s, MP4)
shows the same prompts in two terminals: pixels on the left, cells on the
right. It plays DOOM through an arcade MCP App, then a cohort heatmap, a
three.js scene Claude writes, and a live system monitor. Each side is one
real `claude` session.

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-apps-cli --marketplace idosal/MCPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-apps-cli --marketplace idosal/MCPolyfill
```

Either adds the [MCPolyfill](../../../README.md) marketplace and installs
the plugin in one step. Start a new `claude` session for it to load. With
the marketplace already added, `/plugin install mcp-apps-cli@mcpolyfill`
does the same; `/plugin install mcpolyfill --marketplace idosal/MCPolyfill`
installs every polyfill in the marketplace, this one included.

The plugin is one zip, attached to a release of this repository and checked
against the SHA-256 in the repository's marketplace file
([`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json))
before Claude Code unpacks it. It carries a small helper
program for each platform and needs nothing else installed, not even Node.

## From install to the first app

1. **Install** (above). Nothing is asked. The four settings below start at
   their defaults; the install's note that they are "not yet set" needs no
   action.
2. **Add an MCP server that has apps**, as you add any server. To try one:
   `claude mcp add --transport http arcade https://mcp-apps-arcade.idosalomon.workers.dev/mcp`.
3. **Start `claude` and ask** for something the server's app shows ("Find a
   shareware game in the arcade and load it"). Claude Code asks whether
   to allow the tool, as it does for any MCP tool, unless your permission
   rules already allow it. The app appears under the call.

What else can come up, once each:

- **No Chromium browser installed.** The view says so, and the plugin offers
  to download Chrome for Testing's headless shell (about 100 MB, from
  Google). Say no and views stay closed: install Chrome, Edge, Chromium or
  Brave, or point `MCP_APPS_CLI_CHROME` at one, and the next view opens. The
  offer is not repeated.
- **Not in fullscreen.** After the first view appears, the plugin offers to
  switch Claude Code to its fullscreen layout, the only one that passes
  clicks and keys to a view (Claude Code restarts and resumes the
  conversation). Say no and views stay view-only: you see them update but
  cannot click into them; `/tui fullscreen` switches later. Not offered in
  tmux, or if you chose the main screen yourself (`CLAUDE_CODE_NO_FLICKER=0`).
- **Mouse reporting off in your terminal.** Clicks don't reach the view.
  Most terminals have it on; check iTerm2's Settings → Profiles → Terminal
  → Enable mouse reporting, and in tmux, `set -g mouse on`. A plugin cannot
  change a terminal's settings.
- **An app asks to send Claude a message, open a link or save a file.** You
  are asked, with a choice to allow that app's messages or links for the
  rest of the session. Say no and nothing is sent, opened or saved. An app
  calling its own server's tools follows your permission rules: you're asked
  where Claude Code would ask (the `appToolCalls` setting changes this).

## Requirements

- **Claude Code** 2.1.329 or later (the version it is tested with); it runs
  as a mod, Claude Code's plugin hooks module.
- **macOS** (Apple Silicon or Intel), **Linux** (x64 or Arm64, any
  distribution) or **Windows** x64. Windows is new: its helper passes the
  same checks on GitHub's Windows machines, but it hasn't yet been used in
  a Claude Code session on Windows, so please report what you see.
- **Chrome**, or another Chromium-based browser (Edge, Chromium, Brave).
  Views run in a headless copy of it. If none is installed, the plugin
  offers, once, to download Chrome for Testing's headless shell from Google
  (about 100 MB, kept in the plugin's data folder).
- **Clicking into views** needs Claude Code's fullscreen layout. The first
  time a view opens, the plugin offers to switch (Claude Code restarts and
  resumes the conversation), or run `/tui fullscreen` yourself. Also turn on
  mouse reporting in your terminal (iTerm2: Settings → Profiles → Terminal;
  tmux: `set -g mouse on`). Outside fullscreen, views are view-only.

## Using it

Add MCP servers as usual. When Claude calls a tool with an MCP App, the app
appears under the call, sized to fit. Click into it to use it; **Esc** gives
the keyboard back (**ctrl+]**, or **esc** in the view's header, sends the app
an Escape). A view taller than its box scrolls with PgUp/PgDn. The header
moves the view: **fullscreen**, **pane** (beside the chat, still running) or
**back to the chat**. The app follows Claude Code's theme.

Settings, in `/config`:

| Setting | Default | Choices |
|---|---|---|
| App tool calls: an app calling its own server's tools | rules: what your permission rules allow runs, and you're asked where they would ask | rules, ask (always), allow (without asking, as Claude Desktop does) |
| App messages: an app sending Claude a message | ask, as Claude Desktop does | ask, fill (put it in your prompt), allow |
| Offer fullscreen | ask once | ask, never |
| Offer a browser download | ask once | ask, never |

Your deny rules apply to an app's tool calls in every mode, and where Claude
Code can't check its rules for a tool, you're asked whatever the setting.
When you're asked, you can allow that tool for the rest of the session. An
app may ask to run only a tool its server lists. Opening a link or saving a
file from an app always asks.

## Limits

- **Servers that need sign-in (OAuth) don't show apps yet.** Claude Code
  doesn't give plugins the UI metadata of a tool or of a resource, so the
  helper opens its own connection to each server, from your MCP config, and
  that connection can't sign in.
- **No apps from claude.ai connectors or plugins' servers**, nor from a
  server named both on `claude`'s command line (`--mcp-config`) and in a
  config file, nor any at all under a managed MCP policy: the helper can't
  find or judge those the way Claude Code does, so it leaves them alone.
- **Clicks and keys** reach a view only in the fullscreen layout. There's no
  mouse wheel over inline views (use PgUp/PgDn), and a paste goes to the
  prompt.
- **Memory:** Chrome takes about 260 MB while views are open, plus 120–350 MB
  per live view. At most 3 views stay live, and a view you scrolled away from
  and never used sleeps after 10 minutes.
- **Cells** are one character each: wide characters show as `?`.

[`docs/DESIGN.md`](docs/DESIGN.md) lists the rest, with what Claude Code
could add to remove each.

## Spec

It implements MCP Apps (`io.modelcontextprotocol/ui`) as published in
`specification/2026-01-26` (Stable), plus `ui/download-file` from the draft.
Where it departs from the spec:

- **Default CSP.** When an app declares no `ui.csp`, views get basic-host's
  default policy, which allows `eval` and `blob:` and still opens no other
  domain, instead of the spec's `default-src 'none'`. Apps that run code they
  generate, like the three.js example, need it.
- **Display modes.** A terminal has no floating windows: fullscreen is a view
  as tall as the terminal, and picture-in-picture is a pane beside the chat.
- **`platform`** is sent as `"desktop"`; the spec has no value for a terminal.

[docs/COMPLIANCE.md](docs/COMPLIANCE.md) goes through it clause by clause
(each MUST, SHOULD and MAY, with its test), and says how the plugin is checked:
a TLA+ model of which server a view's app comes from and what it may make
happen, checked with TLC within stated bounds, the server gate checked over
every case, and property-based tests.

## When Claude Code supports MCP Apps itself

The plugin draws views only in an interactive terminal session. Claude
Code's desktop app renders MCP Apps itself, and `claude -p` and the Agent
SDK are left alone. In the terminal it cannot tell whether Claude Code has
started rendering MCP Apps natively, because a mod cannot see what Claude
Code's own MCP client supports. When it does, turn the plugin off:

```bash
claude plugin disable mcp-apps-cli@mcpolyfill
```

or remove it with `claude plugin uninstall mcp-apps-cli@mcpolyfill`.

## Privacy and security

- **Only servers Claude Code uses.** The helper opens its own connection to a
  tool's MCP server only when Claude Code says it is connected to that
  server in this session under that name, and only to the config entry
  Claude Code would use: not a project server you haven't approved, not one
  in a folder you haven't trusted, not one that is switched off, and none
  at all under a managed MCP policy. Once a view is open, each of its app's
  calls and reads goes to its server only while Claude Code still uses that
  server, asked each time. Credentials in your environment
  (`ANTHROPIC_*`, `AWS_*`, `GITHUB_*` and the like) are never put into a
  remote server's address or headers.
- **An app's tool calls follow your permission rules** by default: what
  they allow runs, what they deny is refused, and you're asked where they
  would ask (see the setting above).
- Each view runs in a sandboxed iframe inside a dedicated headless Chrome,
  under the app's Content Security Policy, one browser context per view.
  Chrome's own sandbox and its local-network checks stay on; a view of a
  server on your machine or local network may reach that network.
- A view's cookies, localStorage and IndexedDB are saved, readable only by
  you, in the plugin's data folder, so a reopened view keeps its state.
  They're deleted after 30 days unused.
- The plugin sends nothing anywhere. Network traffic is the apps' own
  (limited by their CSP), the MCP servers Claude Code uses, and, if you
  accepted it, the Chrome download from Google and its update checks.
- The plugin never reads Claude Code's stored credentials. The helper
  answers only requests that carry its per-session token, on a local
  endpoint only you can open.

[SECURITY.md](SECURITY.md) lists what was reviewed, what is checked and
what isn't protected, and how to report a security issue.

## How it works

Claude Code runs the plugin's hooks module (`mod/hooks/`). When Claude calls
an MCP tool, the hooks start a helper for the session (`helper-rs/`, a Rust
binary, 8–10 MB). The helper reads the app's UI from its server, runs it in
headless Chrome behind an MCP Apps host page, and streams it back as pictures
or cells. Your clicks and keys go the other way.
[`docs/DESIGN.md`](docs/DESIGN.md) has the details and measurements;
[`helper-rs/PORT.md`](helper-rs/PORT.md) covers the helper.

### Building from source

From this folder (`polyfills/claude-code/apps` in the repository):

```bash
helper-rs/build-into-plugin.sh
```

```bash
package/package.sh
```

The first builds the helper for this machine into `mod/helper/bin/` (it
needs Rust, and several GB of disk for the build); the second packs the
plugin zip, and its entry for the repository's marketplace file, into
`package/dist/`. To try a local build, run `claude --plugin-dir mod`.
Releases are built on GitHub Actions
([`mcp-apps-cli-release.yml`](../../../.github/workflows/mcp-apps-cli-release.yml)):
see [Packaging and releasing](docs/DESIGN.md#packaging-and-releasing).

## Related

Part of [MCPolyfill](../../../README.md): MCP extensions for hosts that
haven't shipped them yet.

## License

Apache-2.0 ([LICENSE](../../../LICENSE)). The helper includes third-party crates and
npm packages under their own licenses:
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
