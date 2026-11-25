# ard-discovery for OpenCode

OpenCode finds MCP servers through Agentic Resource Discovery (ARD): in what a
domain lists, or by asking an ARD registry for a server that can do a task.
You choose the registry, and OpenCode asks you before every search.

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

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1). OpenCode runs
the plugin itself, so you don't need Node.

The plugin isn't on npm. OpenCode installs it from this repository on GitHub,
with Git:

```bash
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'
```

That adds it to `plugins` in your global configuration
(`~/.config/opencode/opencode.json`), so it runs in every project, from the
next time OpenCode opens one. `#main` installs what the main branch holds; a
commit in its place pins one version. To remove it, run `opencode plugin remove` with the
same text.

Or, from a clone of this repository, add the plugin's folder to `plugins`
yourself, in the global configuration or a project's `opencode.json`:

```jsonc
{
  "plugins": ["/path/to/AgentPolyfill/polyfills/ard/opencode/plugin"]
}
```

The folder is one bundled file, [`plugin/server.js`](plugin/), which holds
only this repository's code, and a `package.json` that names it. Nothing else
is downloaded.
It works on its own; installing `mcp-server-cards` beside it is optional.

## How it works

- **`ard_discover`** reads `ard.json` (a manifest that needs no
  `specVersion`), `rel="ard"` links and the AI Catalog, then fetches and
  checks each card. Read-only.
- **`ard_search`** posts the query to the registry's `/search` endpoint (or to
  the registries a domain's catalog lists, at most three), and follows its
  referrals one hop. Before anything is sent, it asks OpenCode's rules about
  `ard_search` on the registry hosts; the request carries the exact query and
  endpoints. A registry a referral names is asked about the same way before
  the query goes to it; one that isn't allowed gets nothing. Nothing is saved
  by "Allow always": each search is asked about on its own. A query is one
  line of plain words, at most 300 characters, so the request shows all of
  what is sent.
- **Asked by default.** OpenCode's shipped rules allow every action, so the
  plugin makes its own actions (`ard_search`, `mcp_server_cards_add`,
  `mcp_server_cards_remove`) ask, with an OpenCode `evaluate` hook that turns
  `allow` into `ask` for them and nothing else. A `deny` or `ask` rule you
  write wins; an `allow` rule doesn't skip the question by itself, since the
  plugin can't tell it from OpenCode's default. With nobody there to answer,
  as in a scheduled run, OpenCode refuses the question.
- **`ard_add_mcp_server`** and **`ard_remove_mcp_server`** add or remove a
  server either tool showed, as `mcp-server-cards` does, under the same
  permission actions (`mcp_server_cards_add`, `mcp_server_cards_remove`).

## Settings

| | What it does |
|---|---|
| `ARD_DISCOVERY_REGISTRY` | The registry a search goes to when the request names none. Unset by default. |
| `ARD_DISCOVERY_DISABLED=1`, or the plugin option `{"off": true}` | Do nothing, without being uninstalled. |
| `ARD_DISCOVERY_ASK_BY_DEFAULT=0`, or the plugin option `{"askByDefault": false}` | Leave searches and additions to OpenCode's rules alone; by default the plugin asks. Under OpenCode's default rules, a search is then sent without a prompt. |

Set a variable in the environment OpenCode starts in. A plugin option goes in
the object form of the plugin's entry in `plugins`:
`{ "package": "/path/to/…/ard/opencode/plugin", "options": { "askByDefault": false } }`.

## Limits

- The limits of [`mcp-server-cards`](../../server-cards/opencode/README.md#limits)
  for adding a server.
- **Tried live** with a real model: buildkite.com's `ard.json` read, and a
  search sent to the repository's demo registry after OpenCode asked, which
  returned Buildkite's and Netlify's servers, each confirmed by its
  publisher's catalog ([`live-run.md`](../../../tools/opencode/live-run.md)).
  CI runs the tests on Linux, macOS and Windows.
- **OpenCode's TUI shows little in the prompt.** In OpenCode 2.4.1's TUI, a
  permission prompt for a plugin's own action says only "Call tool
  <action>" (seen in the TUI for the other three plugins,
  [`live-run.md`](../../../tools/opencode/live-run.md#in-opencodes-tui); ARD's
  search wasn't tried there). For `ard_search`, nothing is saved, so the
  prompt would offer "Allow once" and "Reject" only, as for Server Cards. The
  details are on the model's call line just above it: the query and the
  registry you named. **A registry a referral
  names is asked about in a prompt of its own that, in the TUI, shows only
  "Call tool ard_search"**: its host is in the request alone, and nothing on
  screen names it. The plugin can't do better in the TUI. OpenCode Desktop
  shows a plugin action's resource in its prompt (seen for Events and
  Skills), so there the host shows; or reject a prompt you can't read.
- **Not tried yet:** Windows by hand (CI runs the tests there), ARD in
  OpenCode Desktop, and a public registry: none that takes an
  unauthenticated search was found; searches were run against the
  repository's demo registry.

## Security

[`SECURITY.md`](SECURITY.md).

## Spec and conformance

ARD v0.91 (draft), as the Claude Code form follows it: the rules are in its
[README](../claude-code/README.md) and tested there against the same modules;
this form's [`docs/conformance.md`](docs/conformance.md) has each rule's
state in OpenCode and where it is tested.
[`test/e2e.test.ts`](test/e2e.test.ts) runs this plugin in OpenCode 2.4.1, in a
throwaway home, against a local web with an `ard.json`, a card, a small MCP
server and a registry: discovery; a search refused with no registry; a search
put to OpenCode's rules, rejected (nothing sent) and approved (sent to that
registry only); a referred registry asked about on its own and, rejected,
sent nothing; adding what it found; and asking by default.

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
