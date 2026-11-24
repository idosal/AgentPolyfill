# ard-discovery for Antigravity

Find MCP servers for Google Antigravity through Agentic Resource Discovery
(ARD): a domain's `/.well-known/ard.json`, or a search of an ARD registry for
a task in plain words. Each search, and each server you add, is put to you
first in Antigravity's own approval card.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md). Server Cards by domain alone are in
[`mcp-server-cards` for Antigravity](../../server-cards/antigravity/README.md),
and this plugin checks, shows and adds what it finds with the same code.

**It hasn't been run in a live Antigravity yet.** It is built from
Antigravity's documentation (App v2.35.1, CLI v1.5.16, read on 25 November
2026) and tested against stand-ins. What a live run has to confirm is in
[`mcp-server-cards`' list](../../server-cards/antigravity/README.md#before-you-rely-on-it),
for `ard_search` as well as `add_mcp_server`.

## Install

Node 20 or newer on your `PATH`, then, from a clone of this repository:

```bash
agy plugin install AgentPolyfill/polyfills/ard/antigravity/plugin
```

Or copy `plugin/` to `~/.gemini/config/plugins/ard-discovery/`. No registry
is set: a search names the one you choose, or set `ARD_DISCOVERY_REGISTRY` in
the environment Antigravity starts in.

## How it works

| Tool | What it does | Asks you first |
|---|---|---|
| `ard_discover(domain)` | Reads the domain's `ard.json`, its AI Catalog and their `rel` links, and checks each Server Card they list. Plain GETs to that domain. | No |
| `ard_search(query, registry?)` | Sends `query` to an ARD registry, a service someone else runs, follows its referrals one hop, and checks each result's card and whether its publisher's own catalog lists it. | Yes: the card names the registry endpoints and the exact query |
| `add_mcp_server(...)` | Adds a server either tool showed, into `~/.gemini/config/mcp_config.json`. | Yes, as in `mcp-server-cards` |

The asking works as in `mcp-server-cards` for Antigravity: the plugin's
`PreToolUse` hook works out what the call would send or write, answers
`force_ask` with the question, and leaves a one-use ticket for exactly that.
The server sends a search, or writes an entry, only with that ticket. For a
search, the ticket is for the query and the endpoints: a different query, or
a registry that now resolves to other endpoints, isn't sent. Without the
hook, nothing is sent and nothing is written.

The question for a search:

```
registry.example: send this search to https://registry.example/search, and to up to three registries it refers to?
Query: "check why my CI build failed"
A registry is a service someone else runs, and it sees the query.
```

To find the endpoints of a registry named by its domain, the hook reads that
domain's catalogs (GETs, no query), so it may take a few seconds. Its timeout
is 60 seconds.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_REGISTRY` | unset | The registry a search uses when it names none. |
| `ARD_DISCOVERY_DISABLED` | unset | `1` turns the server off: no tools, nothing fetched or sent. |
| `AGENTPOLYFILL_STATE_DIR` | `~/.gemini/agentpolyfill` | Where the hook and the server keep what they share (`ard-discovery/` in it). |

Antigravity has no ARD support to detect. If it ships some, disable or
uninstall the plugin, or set `ARD_DISCOVERY_DISABLED=1`.

## Limits

The ones in [`mcp-server-cards` for Antigravity](../../server-cards/antigravity/README.md#limits)
apply to adding, and to the approval: it's yes or no, it depends on the hook
matching the tool's name (`mcp_.*ard.discovery.*(ard_search|add_mcp_server)`),
and without the hook nothing is sent. Also:

- **The hook and the server each read a named registry's catalogs.** The
  hook to show you the endpoints, the server to search them. If they differ
  between the two reads, the search is refused rather than sent somewhere you
  weren't shown.
- **A search result's card that needs a secret can't be added,** since
  Antigravity's file reads no variables.

## Spec and conformance

The same as the other forms: **ARD v0.91** at
[`f073b1ea9b`](https://github.com/ards-project/ard-spec) (§5.1, §5.3,
Appendix B, for MCP Server Cards only; a draft, not an MCP specification),
and MCP Server Cards (SEP-2127, Final) with the AI Catalog v0.9 for the cards
it finds.

The ARD and Server Cards rules are the shared ones (see the
[Codex form's table](../codex/README.md#client-rules)). Where Antigravity
differs:

| # | Rule | Test | State |
|---|---|---|---|
| Q-2 | The person chooses the registry | R-5 | met: none set by default; with none named, the hook denies and nothing is sent |
| Q-3 | Every search is put to the person first, naming the query and the registry | R-2, R-3 | met, if the hook runs: `force_ask` naming the endpoints and the query. Without its ticket, nothing is sent |
| Q-4 | What is sent is what was shown | R-4, R-5 | met: the ticket is for that query and those endpoints; the Codex form's length and character rules apply |
| D-1 | Domain discovery reads `ard.json` | R-7 | met |

### Proof

106 tests, run with `npm test`: 96 shared rule tests (ARD's registry client
from `../claude-code/mod/tests`, and the Server Cards core's from
`../../server-cards/claude-code/mod/tests`), built from the same sources as
the bundle, and 10 of this form's own (R-1 to R-9 and B-1), with the server
on stdio, its hook as a command, a web with an `ard.json` and a registry on
127.0.0.1, and a throwaway `HOME`. No live run yet.

## Development

```bash
npm ci
npm run build
npm test
```

The search rules are the Codex form's (`../codex/src/search.ts`); the gate,
the Antigravity host and the add tool are `mcp-server-cards`'
(`../../server-cards/antigravity/src`).
