# Security

This covers `mcp-server-cards` for Pi. The other forms use the same discovery and card
rules, with their own host adapters: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md), [OpenCode](../opencode/SECURITY.md).

The extension reads documents strangers publish and turns an accepted card
into a Pi MCP entry. Catalogs and cards are untrusted data, including their
descriptions. A card is advisory, never authority for a security decision.

## What is trusted

- **You:** the explicit choice **Add it** in the question.
- **Pi:** its extension UI, CLI, configuration parser, MCP connection and
  sign-in. An RPC client must relay questions to its person honestly.
- **Not the publisher or model:** neither can supply an arbitrary URL to
  add. The card must have been shown in this session and its planned URL
  must match the URL in the tool call.

## What the extension does

### What it fetches

Plain GET requests to the named domain's AI Catalog and home page, then
catalog links, nested catalogs and cards. These requests reveal the network
address and requested path to their recipients. No conversation, cookie,
stored credential or secret header goes with discovery. Headers are Accept,
If-None-Match where cached, and a User-Agent naming the adapter.

The shared code caps response bodies at 512 KiB and cards at 64 KiB, with
20 cards, three page links and catalogs four deep. The session cache is in
memory. New, resumed, forked and reloaded sessions start with no remembered
cards or cache.

### Where it won't go

Public sources cannot point at literal private or loopback addresses,
private host spellings such as `.local`, or single-label names. Plain HTTP
is allowed only for loopback development. The reused Node fetch adapter
checks every redirect under the same rules, at most five hops. It never
reads the host's credentials to fetch a card.

DNS resolution is still Node's: a public hostname resolving to a private
address is a known gap. These discovery rules do not replace Pi's network
behavior once you add and connect a server.

### What it writes

Only an accepted server in Pi's user-level `mcp.json`, under
`$PI_CODING_AGENT_DIR` or `~/.pi/agent`. It uses the running Pi's verified CLI
entrypoint with `process.execPath` and `pi.exec`, without a shell. It does
not edit JSON itself or use project-local add flags.

- The question names the server, actual host, URL, headers, file and
  `pi mcp remove <name>` undo command. **Don't add it** comes first.
- Only **Add it** writes. No UI, decline, close, cancellation, dialog error,
  or another answer writes nothing. Print and JSON modes refuse.
- Pi has no universal tool-call approval prompt. This question supplies
  consent; annotations let permission extensions gate calls too.
- Existing user entries, trusted-project entries and session registrations
  are refused before and after the question. Invalid or unreadable JSON is
  treated as occupied. The adapter reads only configuration names; it does
  not resolve existing values or run their commands.
- After saving, it registers the new server for this session. That starts
  Pi's own connection in the background. A successful save is not a claim
  that authentication or connection has succeeded.
- A failed CLI command never triggers registration. Its output is not
  echoed because it could contain credentials. The result asks you to check
  the file if a write may have completed before the command failed.

### Text and secrets

Shared validation refuses invisible characters, direction marks, userinfo,
misleading URL markup and unsafe variable substitutions. Other characters
that show as nothing (a soft hyphen, variation selectors, tag characters)
don't get a card refused, but they're taken out of everything shown, and a
header value that would be written holding one is refused, so the value
written is the one you were asked about. Output passes a plain-text filter.
The host is named first and again on its own line.

The adapter refuses duplicate header names, header markup and any header
value beginning with `!`: Pi interprets that prefix as a shell command.
Card and model values cannot introduce `$` references. Only the shared
planner generates `${VAR}` references for declared secret inputs.

Secrets are never requested, expanded, read or stored by this extension.
They remain references named `MCP_<SERVER>__<INPUT>_<TAG>`; the tag is 80 bits
of SHA-256 over the card name and remote URL. Another card cannot simply
choose an existing credential variable. Model-supplied values for secret
inputs are ignored. A card containing a literal declared secret is refused.
Pi expands references when it connects; you set the values where Pi starts.
Secret URL variables and SSE endpoints are refused.

### What it never does

It never reads `mcp-auth.json`, `auth.json` or any stored credential. It never
signs in, opens an OAuth browser or approves a tool call for you. OAuth
belongs to Pi; use `/mcp` or `pi mcp login <name>`. The only command the
adapter runs is Pi's `mcp add`, with arguments it constructs from the checked
plan. It has no persistent log of its own. Pi may record tool results and
dialog activity in its normal session history.

## What it does not protect against

- A valid publisher's server misbehaving after connection. Pi's tool
  pipeline and any installed permission extensions govern its tools.
- A question accepted without being read, or another extension or RPC
  client answering it on the person's behalf.
- Another process writing the same name between the final check and the
  CLI write. Pi lacks an atomic add-if-absent option.
- Public DNS names resolving to private addresses.
- Disagreement between a card and the live server. The adapter cannot
  compare the card over Pi's connection with `server/discover`.

## Undoing an addition

Run `pi mcp remove <name>` to remove the saved entry. Use `/reload` or start
a new session to refresh an already running Pi after an external removal.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-server-cards`, the Pi form, the Pi
version and the relevant domain or card. Do not include credentials.
