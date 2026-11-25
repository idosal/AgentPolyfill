# ard-discovery for Antigravity

Find MCP servers for Google Antigravity through Agentic Resource Discovery
(ARD): a domain's `/.well-known/ard.json`, or a search of an ARD registry for
a task in plain words. Each search, and each server you add, is put to you
first in Antigravity's own approval card.

ARD is a draft from outside MCP, published by the
[ards-project](https://github.com/ards-project/ard-spec) on GitHub; this
plugin follows v0.91 (see [Spec and conformance](#spec-and-conformance)).

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md). Server Cards by domain alone are in
[`mcp-server-cards` for Antigravity](../../server-cards/antigravity/README.md),
and this plugin checks, shows and adds what it finds with the same code.

**Run live on 25 November 2026** in the Antigravity App 2.35.1 and CLI 1.5.17
with a real model, against a registry someone else runs (Hugging Face's own):
in both, a search approved and sent only to that registry, one declined, one
sent around the hook refused. The earlier builds also read buildkite.com's
`ard.json`. An ARD addition hasn't been run in the App (it is the same add as
`mcp-server-cards`, which has). Details in
[docs/conformance.md](docs/conformance.md#live-25-november-2026).

## Install

You need the Antigravity CLI (`agy`) to install a plugin from a folder: the
App doesn't ship it. Node 20 or newer on your `PATH` (Antigravity runs the
plugin's hook with `node`). From a clone of this repository (the sequence
checked on 25 November 2026):

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

### Where it runs

| Surface | Supported | Run live |
|---|---|---|
| Antigravity CLI 1.5.17 (macOS) | yes | these builds: a search of Hugging Face's registry approved, one declined, one around the hook refused. Earlier builds: `ard_discover` for buildkite.com, a search over `agy acp` |
| Antigravity App 2.35.1 (macOS) | yes | these builds: a search of Hugging Face's registry approved (the card showed the whole question), one declined, one around the hook refused |
| Antigravity IDE | no | Antigravity documents no plugin hooks for the IDE, so there is no question and no ticket: every search and addition there is refused |

## How it works

| Tool | What it does | Asks you first |
|---|---|---|
| `ard_discover(domain)` | Reads the domain's `ard.json`, its AI Catalog and their `rel` links, and checks each Server Card they list. Plain GETs to that domain. | No |
| `ard_search(query, registry?)` | Sends `query` to an ARD registry, a service someone else runs, follows its referrals one hop, and checks each result's card and whether its publisher's own catalog lists it. | Yes: the card's first line names the registry endpoints, its second the exact query |
| `add_mcp_server(identifier, url, name, headers, file, ...)` | Adds a server either tool showed, into `~/.gemini/config/mcp_config.json`. Its arguments must name what is written. | Yes, as in `mcp-server-cards` |

The asking works as in `mcp-server-cards` for Antigravity: `ard_search` and
`add_mcp_server` are eager (`plugin/mcp_config.json`), the plugin's
`PreToolUse` hook matches their eager names only, works out what the call
would send or write, answers `force_ask` with the question, and leaves a
one-use ticket (an hour at most, removed at the next model call or the turn's end) for exactly
that. The server sends a search, or writes an entry, only with that ticket.
For a search, the ticket is for the query and the endpoints: a different
query, or a registry that now resolves to other endpoints, isn't sent. A call
through `call_mcp_tool` doesn't reach the hook: nothing is sent and nothing is
written.

The question for a search:

```
registry.example: send this search to https://registry.example/search, and to up to three registries it refers to?
Query: "check why my CI build failed"
A registry is a service someone else runs, and it sees the query.
```

As the CLI showed it, for Hugging Face's registry (the third line hidden
behind "⋯ (1 lines hidden)"):

```
Reason: huggingface-hf-discover.hf.space: send this search to https://huggingface-hf-discover.hf.space/search, and to up to three registries it refers to?
 Query: "an MCP server that generates images"
```

To find the endpoints of a registry named by its domain, the hook reads that
domain's catalogs (GETs, no query), so it may take a few seconds. Its timeout
is 60 seconds; in CLI 1.5.17 a hook that times out makes Antigravity fail the
call, so nothing is sent.

An editor connected to `agy acp` shows the person only the tool's name and
arguments: for a search, the query and the registry as given, not the
endpoints it resolves to or the referrals.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_REGISTRY` | unset | The registry a search uses when it names none. |
| `ARD_DISCOVERY_DISABLED` | unset | `1` turns the server off: no tools, nothing fetched or sent. |
| `AGENTPOLYFILL_STATE_DIR` | `~/.gemini/agentpolyfill` | Where the hook and the server keep what they share (`ard-discovery/` in it). |

Antigravity has no ARD support to detect. If it ships some, disable or
uninstall the plugin, or set `ARD_DISCOVERY_DISABLED=1`.

## Gaps, and the host changes that would close them

The ones in [`mcp-server-cards` for Antigravity](../../server-cards/antigravity/README.md#gaps-and-the-host-changes-that-would-close-them)
apply to adding, and to the approval. Also:

| Gap | What it means for you | Host change that closes it |
|---|---|---|
| An editor connected to `agy acp` gets the tool's arguments, not the question. | In an editor you approve a search seeing the query and the registry as named, not the endpoints or referrals the query goes to. | The hook's `reason` in ACP's permission request. |
| No plugin hooks in the IDE. | The plugin doesn't work in the Antigravity IDE: searches and additions there are refused. | Plugin hooks in the IDE. |
| The hook and the server each read a named registry's catalogs. | If they differ between the two reads, the search is refused rather than sent somewhere you weren't shown. | Plugins able to carry the hook's resolved endpoints to the call (the ticket does this today). |
| Antigravity's personal `mcp_config.json` reads no `${VAR}`. | A search result's card that needs a secret can't be added. | `${VAR}` in the personal file. |

## Security

[SECURITY.md](SECURITY.md). In short: Antigravity's approval card is the
boundary, and every search and every addition asks; nothing is
auto-approved. The hook sees this plugin's search and addition and nothing
else. The plugin reads `~/.gemini/config/mcp_config.json` (which can
hold header values) only to check names, and never logs or shows them. It
never opens `mcp_oauth_tokens.json` or any sign-in store.

## Spec and conformance

The same as the other forms: **ARD v0.91**, a draft from outside MCP
published by the ards-project on GitHub, at
[`f073b1ea9b`](https://github.com/ards-project/ard-spec/tree/f073b1ea9b)
(§5.1, §5.3, Appendix B, for MCP Server Cards only), and MCP Server Cards
(SEP-2127, Final) with the AI Catalog v0.9 for the cards it finds.

[docs/conformance.md](docs/conformance.md) has this form's own client rules
table (every ARD rule, with the test in this form's suite), the proof (115
tests: 102 shared rule tests and 13 of this form's own) and the live runs.
The MCP conformance suite has no ARD scenarios.

## Development

```bash
npm ci
npm run build
npm test
```

The search rules are the Codex form's (`../codex/src/search.ts`); the gate,
the Antigravity host and the add tool are `mcp-server-cards`'
(`../../server-cards/antigravity/src`).
