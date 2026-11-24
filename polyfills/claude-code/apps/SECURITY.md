# Security

Please report security issues privately, through this repository's
**Security → Report a vulnerability** form on GitHub, rather than in a
public issue. Include what an attacker controls (an MCP server, an app's
page, a repository you open, another local program) and what they gain.

This is third-party code that runs with your permissions, as every Claude
Code plugin does. It has had no audit by a person. The review described
below was done by an AI reviewer, outside the sessions that wrote the code.

## Which MCP servers it uses

Claude Code doesn't give plugins a tool's UI metadata, so the plugin's
helper opens a connection of its own to the MCP server that owns a tool,
reads the tool's UI from it, and calls the tools that only apps may call.
It uses a server only when both of these hold:

1. **Claude Code uses it.** Before the helper hears a server's name, the
   plugin asks Claude Code (`$.mcp.connect`), and goes on only if Claude
   Code says that server is connected in this session under exactly that
   name. A server that is not approved, rejected, switched off, refused by
   policy, waiting for a sign-in or unknown to the session gets no app, and
   the helper is told nothing about it. A claude.ai connector or a plugin's
   server gets no app either: Claude Code runs those under other names, and
   no config file the helper reads defines them.
2. **The helper finds the entry Claude Code would use,** in the files Claude
   Code reads, and refuses it otherwise:
   - with a managed MCP policy, or an allow or deny list for MCP servers in
     any settings file, it uses no server at all (it can't judge such a
     policy; a policy in the Windows registry isn't visible to it);
   - a server switched off for the project stays off;
   - local-scope servers and the project's `.mcp.json` are used only in a
     folder Claude Code trusts, and a `.mcp.json` server only once it is
     approved, as Claude Code counts approval, and not rejected. Where the
     trust comes from a parent folder, the project's own settings files
     don't count as approval;
   - the entry picked by Claude Code's own order (local, then project, then
     user) decides. If that entry is refused, a lower scope's entry of the
     same name is not used in its place, so a repository can't stand in for
     one of your servers;
   - names beginning `claude_ai_` or `plugin_` are never taken from a file;
   - servers given to `claude` with `--mcp-config` are used (only those,
     under `--strict-mcp-config`), but a name that is both there and in a
     config file is refused, because the helper can't be sure which one
     Claude Code uses;
   - `${VAR}` is expanded only in an entry that passed, and a variable with
     a credential's name (`ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GITHUB_*`,
     `GH_*`, proxies and the rest of the list in `helper-rs/src/config.rs`)
     is never put into a remote server's address or headers. To send a token
     to a server, keep it in a variable with a name of your own.

The helper's connections follow a redirect only within the server's own
origin (streamable HTTP: a 307 or 308; the older SSE transport: none), so
a server's headers never reach another host that way.

The plugin never reads Claude Code's stored credentials (the keychain,
OAuth tokens). It reads the same MCP configuration files Claude Code reads.

## What an app may do, and when you're asked

Each view runs in a sandboxed iframe in a dedicated headless Chrome, under
the app's Content Security Policy, one browser context per view. Chrome's
own sandbox is on, unless you turn it off with `MCP_APPS_CLI_NO_SANDBOX`.

- **Calling its server's tools.** An app may ask to run only a tool its
  server lists. By default (the **App tool calls** setting, `rules`) your
  permission rules decide, as for Claude's own calls: what they allow runs,
  what they deny is refused, and you're asked where they would ask you.
  Where Claude Code can't check its rules for a tool, you're asked whatever
  the setting. `ask` always asks; `allow` runs an app's calls without asking
  unless your rules deny them, as Claude Desktop does. When you're asked,
  you can allow that tool for the rest of the session.
- **Messages to Claude** are asked about by default, and links and saving
  files always are. A dialog shows an app's request as plain text: a link
  with control characters, bidi marks or spaces in it is refused before
  you're asked.
- **Files you save** go to your Downloads folder under names made safe,
  marked as downloaded from the internet, as browsers mark them (macOS's
  quarantine attribute, Windows' `Zone.Identifier`; Linux has no such
  mark).
- **Network.** An app reaches what its CSP names, never a broad source
  (`*`, `https:`, a wildcard over fewer than two labels such as `*.com`, a
  wildcard port). Chrome's local-network checks are on: in the review's
  test, a remote server's app couldn't reach this machine by fetch,
  WebSocket, image or frame, even through a public name that resolves to
  it. A view of a server on your machine or your local network, or of a
  stdio server, may reach your local network, and that includes your own
  machine.
- **The helper** listens on a private Unix socket only you can open (on
  Windows, 127.0.0.1), and answers only requests that carry the token it
  gave the plugin. A request without the token is refused before its body
  is read.

## The review of 24 November 2026

An AI reviewer read the code and ran reproductions. Its findings for this
plugin, and where they stand:

| | Finding | Now |
|---|---|---|
| A1 | The helper chose a server by name from config files, checking no trust, approval, switched-off list or policy: a repository's `.mcp.json` could make it run a command, or send environment credentials to an address of its own | Fixed: both checks above. Tests plant such a repository (`helper-rs/tests/gate.rs`, `bench/gate-check.mjs`) |
| A2 | An app's tool calls ran without asking by default, where Claude Code would have asked | Fixed: `rules` is the default |
| A3 | The helper's MCP client followed redirects to other hosts, carrying custom headers | Fixed in the Rust helper; the Node helper already refused them |
| A4 | The CSP filter let `http://*:*`, `https://*.com` and the like through; a local-network server's view can reach your machine | Broad sources fixed. A local-network server's view still gets local-network access, which includes your machine |
| A5 | Saved files carried no "downloaded" mark | Fixed |
| A6 | On Linux, the helper's temporary folder has a guessable name, and only the folders made inside it were checked | Fixed: the folder itself is checked |
| A7 | The helper read a request's body before checking the token (Windows, or `MCP_APPS_CLI_TRANSPORT=tcp`) | Fixed: the token is checked first; a 30-second read deadline; at most 128 connections |
| A8 | An app could put terminal control sequences into Claude Code's dialogs through a link or a tool name | Fixed |

## What isn't protected

- **A folder you trust can already run code** through its own Claude Code
  hooks; this plugin doesn't widen that. The helper finds Claude Code's
  files through `HOME` and `CLAUDE_CONFIG_DIR` as its environment has them.
- **App text reaches the model.** Context an app sets
  (`ui/update-model-context`) goes to Claude with your next prompt, labelled
  as the app's, without being shown to you. A message an app sends is asked
  about by default and labelled as the app's.
- **A server you approved is trusted with its own app.** Its page can send
  what it is given (the tool's input and result) to the sites its CSP
  names.
- **Wildcards over two-label public suffixes** (`*.co.uk`) still pass the
  CSP filter, which doesn't carry the public suffix list.
- **Chrome for Testing**, if you accept the download, comes from Google over
  HTTPS with no digest or signature check of the archive, and is updated
  daily without asking again.
- **Windows** hasn't been used in a real Claude Code session yet.

[docs/DESIGN.md](docs/DESIGN.md) describes the isolation in detail.
