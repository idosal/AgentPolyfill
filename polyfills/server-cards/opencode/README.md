# mcp-server-cards for OpenCode

Name a company, and OpenCode finds the MCP servers its domain publishes. Ask
it to add one, and once you allow it, the server is in OpenCode's MCP
servers.

Also available for Claude Code ([mcp-server-cards for Claude Code](../claude-code/README.md))
and Codex ([mcp-server-cards for Codex](../codex/README.md)).

> What MCP servers does neon.com publish?

OpenCode reads that domain's catalog, fetches each Server Card it lists,
checks the card against the schema, and tells you what it found. When you ask
it to add one, OpenCode asks you first, naming the server and its URL.

This plugin implements the client side of the MCP Server Cards extension
(SEP-2127), which OpenCode doesn't support itself yet. The checks and the
wording are the shared modules of the Claude Code form
([`../claude-code/mod/hooks`](../claude-code/mod/hooks)), bundled unchanged.
Agentic Resource Discovery (ARD) is a separate plugin,
[`ard-discovery`](../../ard/opencode/README.md), because a search sends your
words to a third party.

## Install

You need **OpenCode 2.4** (the V2 plugin API; tested with 2.4.1). Nothing else:
no account, no key, no Node.

The plugin isn't on npm. OpenCode installs it from this repository on GitHub,
with Git:

```bash
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'
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
  "plugins": ["/path/to/AgentPolyfill/polyfills/server-cards/opencode/plugin"]
}
```

The folder is one bundled file, [`plugin/server.js`](plugin/), its licence
notices, and a `package.json` that names it. Nothing else is downloaded.

## Try it

Ask OpenCode "What MCP servers does neon.com publish?", then "Add Neon Docs".
OpenCode asks you. Approve, and the server is in
OpenCode's MCP servers at once, and OpenCode connects to it.

For a server behind a sign-in, add it the same way, then run
`opencode mcp auth <name>` in a terminal. The sign-in is OpenCode's own.

## How it works

1. **`server_cards_discover_mcp_servers`** reads the domain's
   `/.well-known/ai-catalog.json` and the `rel="ai-catalog"` links on its home
   page, then fetches and checks each card. It only reads public documents.
2. **OpenCode tells you what it found:** each server's card, the URL it
   connects to, and whether the card is valid. A refused card says why, and
   nothing refused can be added.
3. **`server_cards_add_mcp_server`** adds only a card a discovery showed in
   this session, at the URL that card gives, and only if OpenCode has no
   server of that name from anywhere else. It asks OpenCode's rules about
   `mcp_server_cards_add` on `<name>=<url>`; the request carries the host,
   URL, headers, the card and where it was listed, and how to undo it, as
   metadata. OpenCode Desktop shows a plugin action's resource in its prompt
   (seen for Events and Skills); the TUI shows neither (see [Limits](#limits)). OpenCode's shipped rules allow every action, so the
   plugin makes its two actions ask by default, with an OpenCode `evaluate`
   hook that turns `allow` into `ask` for them and nothing else.
4. **The server is added** with `ctx.mcp.transform`, OpenCode's way for a
   plugin to add an MCP server. OpenCode connects it with its own client, so
   its tools, its sign-in and its permission rules are OpenCode's, as for a
   server in your `opencode.json`.
5. **It stays, in this project.** The plugin keeps what it added in its own
   OpenCode storage (`ctx.storage`), one entry per project, and adds it again
   each time OpenCode loads the plugin there. A Git project's folders and
   worktrees share the entry; a folder outside Git has its own. It never
   writes your configuration files.
6. **`server_cards_remove_mcp_server`** takes away a server this plugin
   added, after OpenCode's rules allow `mcp_server_cards_remove`. Servers from
   your configuration files can't be removed with it.

### Secrets

A card that needs a secret (an API key in a header, or one in the URL) isn't
added by the plugin. A secret never passes through the model or the plugin,
and OpenCode fills in a variable only in its configuration files. The answer
gives you the entry to put in `opencode.json`, with `{env:VAR}` where the
secret goes, and the variable to set.

## Settings

| | What it does |
|---|---|
| `MCP_SERVER_CARDS_DISABLED=1`, or the plugin option `{"off": true}` | Do nothing, without being uninstalled. |
| `MCP_SERVER_CARDS_ASK_BY_DEFAULT=0`, or the plugin option `{"askByDefault": false}` | Leave additions and removals to OpenCode's rules alone; by default the plugin asks. Under OpenCode's default rules, a server is then added without a prompt. |

Set a variable in the environment OpenCode starts in. A plugin option goes in
the object form of the plugin's entry in `plugins`:
`{ "package": "/path/to/…/server-cards/opencode/plugin", "options": { "askByDefault": false } }`.

A `deny` or `ask` rule you write for `mcp_server_cards_add` or
`mcp_server_cards_remove` wins: OpenCode settles a `deny` before the plugin
hears of it, and the plugin never turns anything into `allow`. An `allow` rule
doesn't skip the question by itself, since the plugin can't tell it from
OpenCode's default. "Allow always" keeps nothing here: each addition is asked
about on its own. With nobody there to answer, as in a scheduled run, OpenCode
refuses the question.

When OpenCode supports Server Cards itself, turn the plugin off, or remove it
(OpenCode 2.4.1 has no support to detect).

## Limits

- **Only streamable HTTP.** OpenCode 2.4 connects remote servers over
  streamable HTTP; an SSE remote is refused.
- **Cards that need a secret** are added by hand ([Secrets](#secrets)).
- **Per project.** An added server is in the project it was added in only
  (OpenCode's plugin storage is one store for every project; the plugin keys
  it by project). To have it everywhere, put it in your global
  `opencode.json`. Tested: it stays across a restart, and another folder with
  the plugin doesn't get it.
- **No check against the live server.** The spec recommends checking a card
  against the server it describes (`server/discover`). That needs a request
  over OpenCode's connection, which a plugin can't send.
- **Tried live** with a real model: neon.com's two cards found, Neon Docs added
  after OpenCode asked, and connected
  ([`live-run.md`](../../../tools/opencode/live-run.md)). CI runs the tests on
  Linux, macOS and Windows.
- **OpenCode's TUI shows little in the prompt.** In OpenCode 2.4.1's TUI, a
  permission prompt for a plugin's own action says only "Call tool
  mcp_server_cards_add". The details are on the model's call line just above it, and
  "Always allow" lists the pattern it would save. Checked in the TUI
  ([`live-run.md`](../../../tools/opencode/live-run.md#in-opencodes-tui)). The call line
  names the URL; the request's host, headers and undo aren't shown.
- **Not tried yet:** Windows by hand (CI runs the tests there), and an
  addition from OpenCode Desktop (its prompts show a plugin action's
  resource, as seen for Events and Skills).

## Security

A card is the publisher's claim. The plugin fetches only public documents,
refuses what could display as something else, adds only what a discovery
showed, asks you about every addition, and never handles a secret.
[`SECURITY.md`](SECURITY.md) has the details.

## Spec and conformance

SEP-2127 (MCP Server Cards) and the AI Catalog, as the Claude Code form
follows them: the revisions and the rule-by-rule account are in its
[README](../claude-code/README.md#spec-and-conformance). The rules run in that
form's tests against the same modules; this form's
[`docs/conformance.md`](docs/conformance.md) has each rule's state in
OpenCode and where it is tested. [`test/e2e.test.ts`](test/e2e.test.ts)
runs this plugin in OpenCode 2.4.1, in a throwaway home, against a local web
with a catalog, two cards and a small MCP server: discovery; an addition
rejected and approved through OpenCode's rules; OpenCode connecting to the
added server; per project; the server still there after OpenCode restarts; a
card that needs a secret refused with the entry to add by hand; a server
behind a sign-in; removal; asking by default; and a server you already have
never replaced.

## Development

```bash
(cd ../../../tools/opencode && npm ci)   # the pinned OpenCode the tests run
npm ci
npm test                                 # Node 22.18 or newer
npm run typecheck
npm run build                            # plugin/server.js; npm run check fails when it is stale
```

`src/cards.ts` is OpenCode's side (the plan, the permission request, the added
servers); `src/plugin.ts` the plugin. The ARD form uses both. CI:
[`opencode-server-cards-test.yml`](../../../.github/workflows/opencode-server-cards-test.yml).

## Licence

Apache-2.0, as the rest of the repository.
