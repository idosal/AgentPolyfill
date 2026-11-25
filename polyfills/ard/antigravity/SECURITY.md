# Security

This covers `ard-discovery` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms follow the same ARD and Server Cards rules,
with their own host adapters.

The plugin finds MCP servers through a domain's `ard.json` or an ARD
registry, checks their Server Cards, and adds one you approve. Everything a
domain, a card or a registry returns is untrusted data. A registry's order is
its relevance ranking, not a judgement of trust; a result is confirmed only
when its publisher's own catalog lists it.

## What is trusted

- **You:** your approval in Antigravity's own approval card, for each search
  and each addition.
- **Antigravity:** its approval card, its hooks, its MCP connection and its
  sign-in.
- **The plugin's state folder**, `~/.gemini/agentpolyfill/ard-discovery/`.
  Anything that can write it, or run the plugin's hook as you, can make a
  ticket for a search or an addition. Antigravity's terminal sandbox, on by
  default, keeps the agent's commands to the workspace and temporary folders;
  a command run outside it (you approved it, Auto mode judged it safe, or the
  sandbox is off, as in Turbo) can reach the folder.
- **Not a registry, a publisher or the model:** none of them chooses where a
  search goes, what it says, or what is added.

## The boundary: Antigravity's approval card

As in [`mcp-server-cards` for Antigravity](../../server-cards/antigravity/SECURITY.md#the-boundary-antigravitys-approval-card):
Antigravity cancels MCP elicitation without showing it, so the plugin's
`PreToolUse` hook puts each `ard_search` and each `add_mcp_server` to you with
`force_ask`, and leaves a one-use ticket for exactly that call (an hour at
most, named by its SHA-256, removed when the conversation's turn ends). The
MCP server sends a search, or writes an entry, only with that ticket. Nothing
is auto-approved. `ard_discover`, which only reads, isn't gated and goes
through Antigravity's usual approval for MCP tools.

The two gated tools are eager, and the hook's matcher takes their eager names
only: it never sees another server's call, and one of them called through
`call_mcp_tool` carries no ticket and is refused. In CLI 1.5.17 a hook that
fails or times out (this one's timeout is 60 seconds, since it may read a
registry's catalogs) makes Antigravity fail the call, so nothing is sent.
Antigravity documents no plugin hooks for the IDE: there, every search and
addition is refused.

For a search, the ticket is for the query and the exact registry endpoints the
question named. The question's first line names the endpoints and that up to
three registries they refer to may be asked; its second is the query (the
CLI's card shows those two lines). To name the endpoints of a registry given
by its domain, the hook reads that domain's catalogs (GETs, no query); the
server reads them again before sending, and a search whose endpoints changed
is refused rather than sent somewhere you weren't shown.

**In an editor.** An editor connected to `agy acp` gets the tool's name and
arguments, not the hook's question. For a search, the person sees the query
and the registry argument as given (a domain, say), not the endpoints it
resolves to or the one-hop referrals. For an addition, the arguments name
what is written (the name, URL, header names and file), as in
`mcp-server-cards`.

## What the plugin does

### What it sends

- `ard_discover`: plain GETs to the named domain (`/.well-known/ard.json`,
  `/.well-known/ai-catalog.json`, the home page), then the cards they list.
- `ard_search`, after your approval only: the query, as a POST, to the
  registry endpoints the question named, and to up to three registries they
  refer to. No registry is set by default; one is named in the request or
  set with `ARD_DISCOVERY_REGISTRY`. A query is at most 300 characters, on one
  line, with no control characters, direction marks, hidden characters (tag
  characters, variation selectors, a soft hyphen) or markup, so what is sent
  is exactly what you were shown. A redirect never takes a search to another
  origin.

Fetching follows the Server Cards rules: no private or loopback address from
a public source, HTTPS except for loopback development, every redirect
checked, bounded answers.

### What it reads and writes

The same as `mcp-server-cards` for Antigravity: it reads
`~/.gemini/config/mcp_config.json` (which can hold header values) only to
refuse a name you have, never logs or shows any value from it, and writes an
approved entry there; its own state is in
`~/.gemini/agentpolyfill/ard-discovery/`. It never opens
`mcp_oauth_tokens.json` or any sign-in store, and never writes a secret.

### Text

A registry's own words (result names, descriptions, error messages) reach the
result as one quoted line, with hidden characters taken out; a result whose
identifier hides a character is skipped.

## What it does not protect against

- What a registry does with your query: it sees it. That's why each search
  asks first and names where it goes.
- A server misbehaving after it's added, an approval given without reading,
  and a public name that resolves to a private address, as in
  `mcp-server-cards`.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `ard-discovery`, the Antigravity form,
the Antigravity surface and version, and the domain or registry. Don't
include credentials.
