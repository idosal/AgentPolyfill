# Security

This covers mcp-server-cards for OpenCode. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The plugin" below means this OpenCode plugin: one bundled file
(`plugin/server.js`) that OpenCode loads into its own server, with the Server
Cards modules every form shares.

## What is trusted

- **You, and OpenCode's permission rules,** which decide every addition and
  removal. The plugin asks with `ctx.permission.assert` and never answers a
  prompt. By default it has them ask you (below).
- **OpenCode,** its MCP client and its sign-in, which connect what is added.
- **Not the publishers.** A catalog can list anything, and a card can claim
  anything. The SEP says a card is advisory and never authoritative for
  security decisions.
- **Not the model.** It decides when to call the tools and what to pass. A URL
  is never taken from it: only from a card a tool showed in this session.

## What the plugin does

### What it fetches, and where it won't go

As in the Codex form, with the same code (`../codex/src/fetch.ts` and the
shared modules): plain `GET`s with no cookies or credentials, bounded in
size and number; no step from a public catalog, card or redirect to a local or
private address; redirects followed by the plugin itself, each hop held to
the same rule; plain HTTP only from loopback to loopback. The Codex form's
[SECURITY.md](../codex/SECURITY.md#where-it-wont-go) has the full list.

### Text that displays as something else

The shared rules: a card with control characters or invisible marks is
refused; a URL must be printable ASCII, with no markup characters and no user
before its host; fixed header values hold no markup; everything shown passes
a plain-text filter.

### What it adds

One server at a time, to OpenCode's MCP servers, with `ctx.mcp.transform`:

- **Who decides:** OpenCode's rules for `mcp_server_cards_add` on
  `<name>=<url>`. The request carries the host, URL, headers, the card, where
  it was listed and how to undo it. Nothing is saved by "Allow always": each
  addition is asked about on its own. OpenCode's shipped default allows every
  action; for this plugin's two actions only, its `evaluate` hook turns that
  `allow` into `ask`, unless you set `askByDefault` to `false`. It never turns
  anything into `allow`, and a configured `deny` is settled before it runs.
  With nobody there to answer, OpenCode refuses the question.
- **Never over a server you have.** A name OpenCode's configuration already
  holds, from any source, is refused, before the request and again after.
- **Which server and URL:** only a card a tool showed in this session, and
  only if the URL in the call is the one that card gives.
- **Remotes:** a card from a public source may not name a private address. An
  SSE remote is refused.
- **What is kept:** the added servers' URL and fixed headers, in the plugin's
  OpenCode storage, one entry per project, added again whenever OpenCode
  loads the plugin in that project. So an addition one project's rules
  allowed doesn't reach another project. Each change reads the entry afresh
  and changes only that server, so a stale copy in another OpenCode window
  can't bring back a server you removed. Your configuration files aren't
  written.
- **Removal** is `mcp_server_cards_remove`, and only for a server this plugin
  added.

### Secrets

A secret never passes through the model or the plugin. A card that needs one
(in a header or the URL) isn't added: the answer gives the entry for
`opencode.json` with `{env:VAR}` where the secret goes, for you to add. A card
that sets a secret's value itself is refused.

### What it never does

It never reads OpenCode's stored credentials, runs no sign-in of its own, and
holds no token. A sign-in for an added server is OpenCode's
(`opencode mcp auth`).

## What it does not protect against

- **What OpenCode's TUI shows in the prompt.** OpenCode 2.4.1's TUI shows a
  request for this plugin's action as "Call tool mcp_server_cards_add",
  without the resource or metadata it carries. You read the name and URL on
  the model's call line above it; the plugin refuses a URL other than the one
  the card gives, so that is what is added. The headers and the undo aren't
  shown. OpenCode Desktop shows a plugin action's resource in its prompt
  (seen for Events and Skills; an addition there wasn't tried), here
  `<name>=<url>`; the headers and the undo are in the request's metadata.
- **Turning asking off.** With `askByDefault: false` or
  `MCP_SERVER_CARDS_ASK_BY_DEFAULT=0`, OpenCode's rules alone decide, and
  under its default the model can add a server a card describes without a
  prompt, as it could edit `opencode.json` by default.
- **OpenCode's default for everything else.** The model can still edit
  `opencode.json` itself, and add a server that way, unless your rules ask
  about edits.
- **A server you add.** Once added, its tools are OpenCode's MCP tools, under
  your rules like any other.
- **A publisher's claims.** A valid card says what its publisher says; it
  doesn't vouch for the server.
- **Other plugins.** A plugin runs inside OpenCode's server with the same
  access as this one.

## Undoing an addition

Ask OpenCode to remove it (`server_cards_remove_mcp_server`), or turn the
plugin off.

## Reporting

Report a vulnerability privately, through this repository's **Security →
Report a vulnerability** form on GitHub, not in a public issue. Name
`mcp-server-cards` for OpenCode.
