# Security

This covers `mcp-apps-cli` for Claude Code.

This is third-party code that runs with your permissions, as every Claude Code
plugin does.

To report a security issue, see [Reporting](#reporting) at the end.

## Which MCP servers it uses

Claude Code doesn't give plugins a tool's UI metadata. So the plugin's helper
opens a connection of its own to the MCP server that owns a tool. It reads the
tool's UI from it, and calls the tools that only apps may call. It uses a
server only when both of these hold:

1. **Claude Code uses it.** Before the helper hears a server's name, the
   plugin asks Claude Code (`$.mcp.connect`). It goes on only if Claude Code
   says that server is connected in this session under exactly that name.
   - A server that is not approved, rejected, switched off, refused by policy,
     waiting for a sign-in or unknown to the session gets no app, and the
     helper is told nothing about it.
   - A claude.ai connector or a plugin's server gets no app either. Claude Code
     runs those under other names, and no config file the helper reads defines
     them.
2. **The helper finds the entry Claude Code would use,** in the files Claude
   Code reads, and refuses it otherwise:
   - With a managed MCP policy, or an allow or deny list for MCP servers in any
     settings file, it uses no server at all. It can't judge such a policy, and
     a policy in the Windows registry isn't visible to it.
   - A server switched off for the project stays off.
   - Local-scope servers and the project's `.mcp.json` are used only in a
     folder Claude Code trusts. A `.mcp.json` server is used only once it is
     approved, as Claude Code counts approval, and not rejected. Where the
     trust comes from a parent folder, the project's own settings files don't
     count as approval.
   - The entry picked by Claude Code's own order (local, then project, then
     user) decides. If that entry is refused, a lower scope's entry of the
     same name isn't used in its place, so a repository can't stand in for one
     of your servers.
   - Names beginning `claude_ai_` or `plugin_` are never taken from a file.
   - Servers given to `claude` with `--mcp-config` are used (only those, under
     `--strict-mcp-config`). But a name that is both there and in a config file
     is refused, because the helper can't be sure which one Claude Code uses.
   - `${VAR}` is expanded only in an entry that passed. A variable with a
     credential's name is never put into a remote server's address or
     headers: `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GITHUB_*`, `GH_*`, proxies
     and the rest of the list in `helper-rs/src/config.rs`. To send a token to
     a server, keep it in a variable with a name of your own.

### Each request waits for Claude Code's yes

Once a server's name has passed both checks, every request the helper sends to
it waits for Claude Code's yes, asked for that request. No yes is kept and
reused. That covers an app's own call or read, the connection's handshake, the
tool list, and a UI resource.

When Claude Code says no (you switched the server off in `/mcp`, or it
disconnected), the helper:

- fails what it has in flight to that server;
- closes its connection, and a stdio server it started stops;
- sends nothing more on a yes given before the no.

While a request to a server is in flight, Claude Code is asked again every half
second.

What this leaves:

- Claude Code's yes and the helper's sending of the request are one local round
  trip apart: a line on the helper's output, the plugin's question to Claude
  Code, and its answer to the helper. A server switched off within that moment
  still gets the request.
- A request already sent isn't unsent: the server may already have acted on
  it. Closing the connection is the only notice it gets, and for streamable
  HTTP that closing is itself one request (the session's `DELETE`).
- Within one request, what follows the server's own answers goes on the same
  yes: the second half of a connection's handshake, further pages of a tool
  list, and the HTTP event stream rmcp keeps open while the connection stands.
- A no is heard only when the plugin asks: at the next request to that server,
  or within half a second while one is in flight. An answer that arrives before
  then still reaches the app. A connection with nothing in flight (a stdio
  server the helper started, idle) stays open until then, or until the helper
  exits.
- An app's call of a tool the model also sees goes over Claude Code's own
  connection, which Claude Code itself decides about.

### Redirects and credentials

The helper's connections follow a redirect only within the server's own origin
(for streamable HTTP, a 307 or 308; for the older SSE transport, none). So a
server's headers never reach another host that way.

The plugin never reads Claude Code's stored credentials (the keychain, OAuth
tokens). It reads the same MCP configuration files Claude Code reads.

## What an app may do, and when you're asked

Each view runs in a sandboxed iframe in a dedicated headless Chrome, under the
app's Content Security Policy, one browser context per view. Chrome's own
sandbox is on, unless you turn it off with `MCP_APPS_CLI_NO_SANDBOX`.

- **Calling its server's tools.** An app may ask to run only a tool its server
  lists.
  - By default (the **App tool calls** setting, `rules`), your permission rules
    decide, as for Claude's own calls: what they allow runs, what they deny is
    refused, and you're asked where they would ask you.
  - Where Claude Code can't check its rules for a tool, you're asked whatever
    the setting.
  - `ask` always asks. `allow` runs an app's calls without asking unless your
    rules deny them, as Claude Desktop does.
  - When you're asked, you can allow that tool for the rest of the session.
- **Messages to Claude** are asked about by default, and links and saving files
  always are. A dialog shows an app's request as plain text. A link with
  control characters, bidi marks or spaces in it is refused before you're
  asked.
- **Files you save** go to your Downloads folder under names made safe. They
  are marked as downloaded from the internet, as browsers mark them: macOS's
  quarantine attribute, or Windows' `Zone.Identifier`. Linux has no such mark.
- **Network.** An app reaches what its CSP names, never a broad source. Broad
  sources are `*`, `https:`, a wildcard over fewer than two labels such as
  `*.com`, a wildcard over a shared suffix anyone can host under such as
  `*.workers.dev`, `*.github.io` or `*.co.uk`, and a wildcard port.
  - Chrome's local-network checks are on. They are what keeps a remote
    server's app from reaching this machine by fetch, WebSocket, image or
    frame, or through a public name that resolves to it.
  - A view of a server on your machine or your local network, or of a stdio
    server, may reach your local network, and that includes your own machine.
- **The helper** listens on a private Unix socket only you can open (on
  Windows, 127.0.0.1). It answers only requests that carry the token it gave
  the plugin. A request without the token is refused before its body is read.
  A connection that sends no request head within 2 seconds is closed, a
  request has 30 seconds to arrive whole, and at most 128 connections are
  open at once.
- **Each open of a view has its own generation.** What the page of an
  earlier open of the same tool call asks is refused for the view opened
  again in its place.

## What isn't protected

- **A folder you trust can already run code** through its own Claude Code
  hooks, and this plugin doesn't widen that. The helper finds Claude Code's
  files through `HOME` and `CLAUDE_CONFIG_DIR` as its environment has them.
- **App text reaches the model.** Context an app sets
  (`ui/update-model-context`) goes to Claude with your next prompt, without
  being shown to you. A message an app sends is asked about by default. This
  plugin names the app as the source of both. That wording is ours, not part
  of the MCP Apps spec, and it isn't a protection.
- **A server you approved is trusted with its own app.** Its page can send
  what it is given (the tool's input and result) to the sites its CSP names.
- **Wildcards over a shared suffix not on the plugin's list** still pass the
  CSP filter. The filter carries the most used such suffixes, not the whole
  public suffix list.
- **Over TCP** (Windows, or `MCP_APPS_CLI_TRANSPORT=tcp`), a local process
  that keeps opening connections can keep the plugin from its helper while it
  does so. It can't get past the token.
- **Chrome for Testing,** if you accept the download, comes from Google over
  HTTPS with no digest or signature check of the archive. It is updated daily
  without asking again.
- **Windows.** Not checked in a Claude Code session yet.

## Reporting

Please report security issues privately, through this repository's
**Security → Report a vulnerability** form on GitHub, rather than in a public
issue. Include what an attacker controls (an MCP server, an app's page, a
repository you open, another local program) and what they gain.
