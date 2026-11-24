# ard-discovery for OpenCode

OpenCode finds MCP servers through Agentic Resource Discovery (ARD): in what a
domain lists, or by asking an ARD registry for a server that can do a task.
You choose the registry, and every search is put to OpenCode's permission
rules first.

Also available for Claude Code ([ard-discovery for Claude Code](../claude-code/README.md))
and Codex ([ard-discovery for Codex](../codex/README.md)).

> Find an MCP server that can check why my CI build failed.

This OpenCode plugin adds the consumer side of
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) for MCP
servers:

- **By domain.** `ard_discover` reads a domain's `/.well-known/ard.json` and
  the `rel="ard"` links on its home page, beside the AI Catalog.
- **By task.** `ard_search` asks an ARD registry, in plain words, for a server
  that can do something.

Each Server Card it finds is checked against the schema. A search result
counts as confirmed only when the publisher's own domain lists it. Adding a
server works as in [`mcp-server-cards`](../../server-cards/opencode/README.md),
with the same code.

**A search sends your query to a third party.** The plugin ships with no
registry: name one in the request, or set `ARD_DISCOVERY_REGISTRY`. With
neither, a search is refused and nothing is sent. Discovery by domain sends
nothing but plain `GET`s to that domain.

ARD is a draft (v0.91), not an MCP specification.

## Install

The plugin isn't on npm yet. From a clone of this repository, add its folder
to `plugins` in your OpenCode configuration:

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/ard/opencode/plugin"],
  "permissions": [
    { "action": "ard_search", "resource": "*", "effect": "ask" },
    { "action": "mcp_server_cards_add", "resource": "*", "effect": "ask" }
  ]
}
```

The rules make OpenCode ask you before each search and each addition. Without
them, OpenCode's default allows both: a search would be sent without a
prompt. It works on its own; installing `mcp-server-cards` beside it is
optional.

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1).

## How it works

- **`ard_discover`** reads `ard.json` (a manifest that needs no
  `specVersion`), `rel="ard"` links and the AI Catalog, then fetches and
  checks each card. Read-only.
- **`ard_search`** posts the query to the registry's `/search` endpoint (or to
  the registries a domain's catalog lists, at most three), and follows its
  referrals one hop. Before anything is sent, it asks OpenCode's rules about
  `ard_search` on the registry hosts; the request carries the exact query and
  endpoints. A registry a referral names is asked about the same way before
  the query goes to it; one that isn't allowed gets nothing. Nothing is saved by "Allow always": each search is asked about on
  its own. A query is one line of plain words, at most 300 characters, so the
  request shows all of what is sent.
- **`ard_add_mcp_server`** and **`ard_remove_mcp_server`** add or remove a
  server either tool showed, as `mcp-server-cards` does, under the same
  permission actions (`mcp_server_cards_add`, `mcp_server_cards_remove`).

## Settings

| | What it does |
|---|---|
| `ARD_DISCOVERY_REGISTRY` | The registry a search goes to when the request names none. Unset by default. |
| `ARD_DISCOVERY_DISABLED=1`, or the plugin option `{"off": true}` | Do nothing, without being uninstalled. |

## Limits

- **OpenCode's default allows every action,** so with no `ard_search` rule a
  search is sent without a prompt. Add the rules in [Install](#install).
- The limits of [`mcp-server-cards`](../../server-cards/opencode/README.md#limits)
  for adding a server.
- **Tried live** with a real model: buildkite.com's `ard.json` read
  ([`live-run.md`](../../../tools/opencode/live-run.md)). CI runs the tests on
  Linux and macOS.
- **Not tried yet:** Windows, the TUI and the desktop app as clients, and a
  live registry search.

## Security

[`SECURITY.md`](SECURITY.md).

## Spec and conformance

ARD v0.91 (draft), as the Claude Code form follows it: the rules are in its
[README](../claude-code/README.md) and tested there against the same modules.
[`test/e2e.test.ts`](test/e2e.test.ts) runs this plugin in OpenCode 2.4.1, in a
throwaway home, against a local web with an `ard.json`, a card, a small MCP
server and a registry: discovery; a search refused with no registry; a search
put to OpenCode's rules, rejected (nothing sent) and approved (sent to that
registry only); and adding what it found.

## Development

```bash
(cd ../../../tools/opencode && npm ci)
npm ci
npm test
npm run typecheck
npm run build      # plugin/server.js; npm run check fails when it is stale
```

CI: [`opencode-ard-test.yml`](../../../.github/workflows/opencode-ard-test.yml).

## Licence

Apache-2.0, as the rest of the repository.
