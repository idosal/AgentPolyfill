# ard-discovery for Antigravity

Find MCP servers for Google Antigravity through Agentic Resource Discovery
(ARD): a domain's `/.well-known/ard.json`, or a search of an ARD registry for
a task in plain words. Each search, and each server you add, is put to you
first in Antigravity's own approval card.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md). Server Cards by domain alone are in
[`mcp-server-cards` for Antigravity](../../server-cards/antigravity/README.md),
and this plugin checks, shows and adds what it finds with the same code.

**Run live on 25 November 2026** in Antigravity CLI v1.5.16 (macOS):
`ard_discover` for buildkite.com, and an `ard_search` put to the person with
the exact query and registry and sent only after the approval. The App's
approval card was checked with the other Antigravity forms; the IDE's agent
wasn't run. Details in [docs/conformance.md](docs/conformance.md#live-25-november-2026).

## Install

Node 20 or newer on your `PATH` (Antigravity runs the plugin's hook with
`node`). From a clone of this repository (the sequence checked on 25 November
2026, CLI 1.5.16):

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/ard/antigravity/plugin
agy plugin list
```

`agy plugin install` copies the folder to `~/.gemini/config/plugins/ard-discovery/`,
which the App and the CLI both read. Nothing is published to Antigravity's
Marketplace. No registry is set: a search names the one you choose, or set
`ARD_DISCOVERY_REGISTRY` in the environment Antigravity starts in.

### Uninstall, and what stays behind

```bash
agy plugin uninstall ard-discovery
```

That removes the plugin's folder. It leaves the servers you added (under
`mcpServers` in `~/.gemini/config/mcp_config.json`) and the plugin's own
folder, `~/.gemini/agentpolyfill/ard-discovery/` (cards shown in the last
hour, and tickets), which you delete by hand.

### Where it was run

| Surface | Run | |
|---|---|---|
| Antigravity App v2.35.1 (macOS) | no ARD call | the same approval card was checked with `mcp-server-cards` and `mcp-skills` |
| Antigravity CLI v1.5.16 (macOS) | yes | `ard_discover`, and `ard_search` approved over `agy acp` |
| Antigravity IDE v2.8.0 | no | installed, not signed in; its hooks page lists no plugin hooks, and without the hook every search and addition is refused |

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
seeing the call (`call_mcp_tool` with `ServerName` `ard-discovery_ard`, or the eager `mcp_ard-discovery_ard_<tool>`),
and without the hook nothing is sent. Also:

- **The hook and the server each read a named registry's catalogs.** The
  hook to show you the endpoints, the server to search them. If they differ
  between the two reads, the search is refused rather than sent somewhere you
  weren't shown.
- **A search result's card that needs a secret can't be added,** since
  Antigravity's file reads no variables.

## Security

[SECURITY.md](SECURITY.md). In short: Antigravity's approval card is the
boundary, and every search and every addition asks; nothing is
auto-approved. The plugin reads `~/.gemini/config/mcp_config.json` (which can
hold header values) only to check names, and never logs or shows them. It
never opens `mcp_oauth_tokens.json` or any sign-in store.

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

115 tests (102 shared rule tests and 13 of this form's own), `agy plugin
validate --strict`, and the live run: [docs/conformance.md](docs/conformance.md).

## Development

```bash
npm ci
npm run build
npm test
```

The search rules are the Codex form's (`../codex/src/search.ts`); the gate,
the Antigravity host and the add tool are `mcp-server-cards`'
(`../../server-cards/antigravity/src`).
