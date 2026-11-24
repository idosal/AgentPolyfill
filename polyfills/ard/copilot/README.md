# ard-discovery for GitHub Copilot CLI

Copilot finds MCP servers through Agentic Resource Discovery (ARD): in what a
domain lists, or by asking an ARD registry for a server that can do a task.
You choose the registry, and Copilot shows you a form before every search.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md).

> Find an MCP server that can check why my CI build failed.

This Copilot plugin adds the consumer side of
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) for MCP
servers:

- **By domain.** It reads a domain's `/.well-known/ard.json` and the
  `rel="ard"` links on its home page, beside the AI Catalog.
- **By task.** It asks an ARD registry, in plain words, for a server that can
  do something.

Each Server Card it finds is checked against the schema. A search result
counts as confirmed only when the publisher's own domain lists it. To add a
server, Copilot shows you a form, and only on your accept does the server go
into Copilot's MCP configuration.

**A search sends your query to a third party.** `ard_search` posts the words
of your request to an ARD registry: a service someone else runs. The plugin
ships with no registry, so you choose which one sees your words: name it in
the request, or set `ARD_DISCOVERY_REGISTRY`. With neither, a search is
refused and nothing is sent. Copilot shows you a form before every search,
naming the registry and the exact query.

ARD is a draft, not an MCP specification. The revision this plugin follows is
in [Spec and conformance](#spec-and-conformance).

## Install

```bash
copilot plugin marketplace add idosal/AgentPolyfill
```

```bash
copilot plugin install ard-discovery@agent-polyfill
```

Start a new Copilot session afterwards. It works on its own; installing
[`mcp-server-cards`](../../server-cards/copilot/README.md) beside it is
optional (each has its own `add_mcp_server`, and Copilot keeps them apart by
server name).

You need GitHub Copilot CLI 1.0.115 or newer (no experimental mode) and
Node.js 20 or newer on your `PATH`.

To remove it, run `copilot plugin uninstall ard-discovery@agent-polyfill`.

## Try it

Ask Copilot "What does buildkite.com list in its ard.json?", then "Add it".
Copilot asks before it runs each tool, then shows the form. Accept it, run
`/mcp reload`, and sign in when Copilot asks (`/mcp auth buildkite`).

To try search without sending anything to a third party, start the
[demo registry](../claude-code/README.md#demo-registry) from a clone,
`node polyfills/ard/claude-code/demo/registry.mjs` (it listens on
`http://127.0.0.1:9011`), and ask: "Search the registry at
http://127.0.0.1:9011 for an MCP server that can check why my CI build
failed."

## How it works

It is the Codex form's tools ([`../codex/src/ard.ts`](../codex/src/ard.ts)),
with Copilot's name and Copilot's `add_mcp_server`
([`mcp-server-cards` for Copilot](../../server-cards/copilot/README.md#step-by-step)).
The steps are the Codex form's [Step by step](../codex/README.md#step-by-step),
with these differences:

- Copilot asks before each of the plugin's tools runs ("Do you want to use
  this tool?"), as for any MCP tool, and then the plugin's form asks about the
  search or the add. Seen live in the TUI, against the demo registry:

  ```
  ard-discovery needs information.
  127.0.0.1:9011: send this search to http://127.0.0.1:9011/search, and to up to three registries it refers to?
  Query: "check why my CI build failed"
  A registry is a service someone else runs, and it sees the query.
  Your answer:
  ❯ Don't send it
    Send the search
  ```

- Where nobody can be asked (`copilot -p`, with `--allow-all-tools` or
  `--yolo`), Copilot declines the form, so nothing is sent or written.
- An add goes through `copilot mcp add`, with `${VAR}` references for
  secrets, into `~/.copilot/mcp-config.json`, and connects after `/mcp reload`.

Copilot 1.0.115 also has a discovery of its own, a built-in
`discover-resources` skill whose `catalog_search` searches a remote catalogue
GitHub runs. It doesn't read `ard.json` or speak ARD's registry search, so
the two don't overlap, and this plugin doesn't stand down for it.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_REGISTRY` | unset | The registry a search uses when the request names none: a base URL, or a domain whose catalog lists a registry. Unset, a search must name one. |
| `ARD_DISCOVERY_DISABLED` | unset | `1` turns the plugin off: no tools, nothing fetched or sent. |
| `COPILOT_HOME`, `COPILOT_CLI_PATH` | as Copilot sets them | As in [mcp-server-cards](../../server-cards/copilot/README.md#settings). |

### When Copilot supports ARD itself

Copilot doesn't read ARD yet. When it does, uninstall the plugin, disable it
(`copilot plugin disable ard-discovery@agent-polyfill`), or set
`ARD_DISCOVERY_DISABLED=1`.

## Limits

- **The query leaves your machine** once you accept that search. That is what
  a search is.
- **Search results today.** The one public registry, Hugging Face Discover,
  returns MCP Registry `server.json` entries, not Server Cards, so nothing it
  returns can be added yet (the Claude Code form's
  [findings](../claude-code/README.md#findings-to-report-upstream)).
- **Two questions per search or add:** Copilot's tool prompt, then the form.
- **A public name that resolves to a private address isn't caught,** as in
  mcp-server-cards.
- **The limits of adding a server** are
  [mcp-server-cards'](../../server-cards/copilot/README.md#limits), VS Code
  included.

## Security

[SECURITY.md](SECURITY.md) says what the plugin sends, to whom, and what it
trusts. In short:

- Discovery by domain reads public documents from that domain.
- Search sends your query text to the registry, and to at most three
  registries it refers to, only after you accept that search in the form.
- It writes only Copilot's MCP configuration, for a server you accept.

## Spec and conformance

It implements, as the other forms do:

- **ARD v0.91** at commit
  [`f073b1ea9b`](https://github.com/ards-project/ard-spec): §5.1 (domain
  discovery: `ard.json` and `rel="ard"`), §5.3 (registry search) and Appendix
  B (error codes), for MCP Server Cards only. ARD is a draft ("Proposal"); it
  isn't an MCP specification, and it can still change.
- MCP Server Cards
  ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9,
  for the cards it finds.

### Client rules

All forms follow the same ARD rules and Server Cards rules, with the same
code. The full tables are with the Claude Code forms:
[ARD's client rules](../claude-code/README.md#client-rules) and
[mcp-server-cards'](../../server-cards/claude-code/README.md#client-rules).
The rows particular to a host with a form (Q-1 to Q-5, V-3, D-1, H-3) are the
Codex form's [table](../codex/README.md#client-rules), met here by the same
code and tests (A-1 to A-12). Copilot asks its MCP servers for revision
2025-11-25, so the forms use titled choices (`oneOf`), as A-11 checks.

### Proof

- **Per rule:** 112 tests, run with `npm test`: ARD's 8 registry rule tests and
  the Server Cards core's 88, run against the committed bundle; 14 of this
  form's own (A-1 to A-14, over stdio, with a stand-in `copilot` and a local
  registry on 127.0.0.1); 2 that check the installed folder.
- **The real host,** 25 November 2026, Copilot CLI 1.0.115 on macOS, with an
  isolated `COPILOT_HOME`, no GitHub sign-in, and a scripted model on this
  machine:
  - Installed from this repository's marketplace beside `mcp-events` and
    `mcp-server-cards`.
  - `ard_discover` for buildkite.com read `ai-catalog.json` and `ard.json` (one
    entry each) and returned Buildkite's valid card.
  - In the TUI, against the demo registry on 127.0.0.1, so no query left the
    machine: Copilot's tool prompt, then the form quoted above. **Send the
    search** posted the query, and the result listed Buildkite and Netlify,
    both confirmed by their publishers.
  - A search with no registry named or set was refused, naming
    `ARD_DISCOVERY_REGISTRY`, and nothing was sent.
- **Upstream conformance:** the MCP conformance suite has no Server Card or
  ARD scenarios.

## Development

From this folder (`polyfills/ard/copilot`):

```bash
npm ci
npm test
npm run typecheck
npm run build    # plugin/dist/server.mjs; a test fails when it is stale
```

CI: [`copilot-ard-test.yml`](../../../.github/workflows/copilot-ard-test.yml).

## Licence

Part of [AgentPolyfill](../../../README.md). Apache-2.0. See
[`LICENSE`](../../../LICENSE).

This is a community project. It isn't affiliated with or endorsed by GitHub,
Microsoft, Google, Hugging Face, the Model Context Protocol project, the
Agentic AI Foundation or the Linux Foundation. GitHub Copilot is a trademark of
GitHub, Inc.
