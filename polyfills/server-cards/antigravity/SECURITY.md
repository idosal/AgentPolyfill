# Security

This covers `mcp-server-cards` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms use the same discovery and card rules, with
their own host adapters.

The plugin reads documents strangers publish and turns a card the person
approves into an Antigravity MCP entry. Catalogs and cards are untrusted data,
including their descriptions. A card is advisory, never authority for a
security decision.

## What is trusted

- **You:** your approval in Antigravity's own approval card.
- **Antigravity:** its approval card, its hooks, its MCP connection and its
  sign-in. In the App, the card shows the plugin's question; an editor
  connected to `agy acp` shows the tool's name and arguments instead (see
  [Limits](README.md#limits)).
- **Not the publisher or the model:** neither can supply a URL to add. The
  card must have been shown by `discover_mcp_servers` within the hour, and the
  URL it yields must equal the URL in the call.

## The boundary: Antigravity's approval card

Antigravity documents no MCP elicitation; its client declares it but cancels
every request without showing it (seen live, App v2.35.1 and CLI v1.5.16).
So an addition is put to you through the plugin's `PreToolUse` hook:

- The hook works out exactly what would be written and answers `force_ask`.
  Antigravity then shows its approval card with the plugin's question (the
  host first, the URL, the headers, the file and how to undo it). `force_ask`
  ignores any "always allow" you set, and the card greys those choices out.
- The hook leaves a one-use ticket for that exact entry, valid for 4 hours,
  and adds its name to the call. The MCP server writes only with that ticket,
  unused, for the same entry. No ticket, no write: if the hook didn't run, the
  call is refused and says so.
- Nothing is auto-approved: the hook never answers `auto_approve` and sets no
  permission overrides. `discover_mcp_servers`, which only reads, goes through
  Antigravity's usual approval for MCP tools.
- Hooks fail open in Antigravity (a non-zero exit is ignored), so the hook
  always exits 0 and answers `deny` when anything goes wrong.

The ticket guards against the agent adding a server through this tool without
your approval. A command you let the agent run as you could run the hook
itself and get a ticket, but it could also edit `mcp_config.json` directly.
Antigravity's terminal sandbox (on by default) keeps commands to the workspace
and temp folders, so they can't write the plugin's ticket folder.

## What the plugin does

### What it fetches

Plain GET requests to the named domain's AI Catalog and home page, then
catalog links, nested catalogs and cards. No conversation, cookie, stored
credential or header from your configuration goes with discovery. Headers
are Accept, If-None-Match where cached, and a User-Agent naming the plugin.

The shared code caps response bodies at 512 KiB and cards at 64 KiB, with 20
cards, three page links and catalogs four deep. Public sources can't point at
literal private or loopback addresses, private host spellings such as
`.local`, or single-label names. Plain HTTP is allowed only for loopback
development. Every redirect is checked under the same rules, at most five
hops. A public name that resolves to a private address is a known gap (Node's
fetch resolves names itself).

### What it reads

- `~/.gemini/config/mcp_config.json`, to refuse a name you already have. That
  file can hold header values (API keys). The plugin keeps the rest of the
  file as it is when it writes, and never logs or shows any value from it. A
  file it can't read as JSON is refused without quoting it: Node's parser
  error can quote a piece of the file.
- Its own folder, `~/.gemini/agentpolyfill/mcp-server-cards/` (0700): the
  cards shown in the last hour, and the tickets.

It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json` or any other
sign-in store, Antigravity's or anyone's.

### What it writes

Only an entry you approved, under `mcpServers` in
`~/.gemini/config/mcp_config.json`: `{"serverUrl": ..., "headers": {...}}`.
It writes the whole file in one step (a temporary file, then a rename) and
keeps its permissions. It refuses a name you have, in any case, before the
question and again before writing. It never writes a secret: a card that
needs one (an API key in a header or the URL) is refused, because
Antigravity's personal file reads no `${VAR}`. You add such a server by hand.

### Text

Shared validation refuses control characters, direction marks, userinfo and
markup in URLs, and unsafe variable substitutions. Other characters that show
as nothing (a soft hyphen, variation selectors, tag characters) don't get a
card refused, but they're taken out of everything shown, and a header value
that would be written holding one is refused, so the value written is the
one you were asked about.

## What it does not protect against

- A server misbehaving after it's added. Antigravity's own handling of that
  server and its tools governs from then on.
- An approval given without reading the card, or answered by an editor on the
  person's behalf.
- Another program writing `mcp_config.json` at the same moment: one of the two
  writes could be lost.
- Disagreement between a card and the live server: the plugin can't send
  `server/discover` over Antigravity's connection.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-server-cards`, the Antigravity
form, the Antigravity surface and version, and the domain or card. Don't
include credentials.
