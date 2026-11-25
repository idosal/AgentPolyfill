# mcp-server-cards for GitHub Copilot CLI

Name a company, and Copilot finds the MCP servers its domain publishes. Ask
it to add one, accept the form Copilot shows you, and the server goes into
Copilot's own MCP configuration.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md).

> What MCP servers does neon.com publish?

Copilot reads that domain's catalog, fetches each Server Card it lists, checks
the card against the schema, and tells you what it found. When you ask it to
add one, Copilot shows you a form naming the server, the URL, the headers, the
file it writes and the undo command. Only if you accept does the server go
into Copilot's MCP configuration, as if you had typed `copilot mcp add`.

This Copilot plugin implements the client side of the MCP Server Cards
extension (SEP-2127), which Copilot doesn't support itself yet. The revisions
it follows are in [Spec and conformance](#spec-and-conformance).

Agentic Resource Discovery (ARD) isn't in this plugin. ARD is a draft, not an
MCP specification, and its registry search sends your words to a third party,
so it's a separate plugin, [`ard-discovery`](../../ard/copilot/README.md).

## Install

```bash
copilot plugin marketplace add idosal/AgentPolyfill
```

```bash
copilot plugin install mcp-server-cards@agent-polyfill
```

The first command adds the [AgentPolyfill](../../../README.md) marketplace
(Copilot reads its `.github/plugin/marketplace.json`), and the second installs
the plugin. Start a new Copilot session afterwards.

You need:

- GitHub Copilot CLI 1.0.115 or newer (tested with 1.0.115). This plugin is an
  MCP server in a plugin, so it needs **no** experimental mode.
- Node.js 20 or newer on your `PATH`. The plugin is one JavaScript file with
  no dependencies, [`plugin/dist/server.mjs`](plugin/dist/server.mjs), which
  Copilot starts as a stdio MCP server.

To remove it, run `copilot plugin uninstall mcp-server-cards@agent-polyfill`.

## Try it

Ask Copilot "What MCP servers does neon.com publish?", then "Add Neon Docs".
Copilot asks before it runs each of the plugin's tools, then shows the
plugin's form: choose **Add it**. Neon Docs needs no sign-in. Run
`/mcp reload` (or start a new session) to use it.
`copilot mcp remove neon-docs` removes it again.

## How it works

### Step by step

1. **Ask.** For example "connect Copilot to Buildkite", or "what MCP servers
   does neon.com publish?".
2. **Copilot calls `discover_mcp_servers`** (it shows as
   `mcp-server-cards-discover_mcp_servers`). Copilot asks first, as for any MCP
   tool ("Do you want to use this tool?"). The tool reads the domain's
   `/.well-known/ai-catalog.json` and the `rel="ai-catalog"` links on its home
   page, then fetches and checks each card. It changes nothing.
3. **Copilot tells you what it found:** each server's card, the URL it
   connects to, and whether the card is valid. A refused card says why, and
   nothing refused can be added.
4. **Ask Copilot to add one.** Copilot asks before it runs `add_mcp_server`,
   and then the plugin asks you through Copilot's form (MCP elicitation):

   ```
   mcp-server-cards needs information.
   neon.com: add the MCP server "neon-docs" to Copilot?
   It connects to the host neon.com
   URL: https://neon.com/docs/mcp (streamable HTTP)
   Headers: none
   From the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog.
   Written to /Users/you/.copilot/mcp-config.json (all your projects).
   To undo: copilot mcp remove neon-docs
   Your answer:
   ❯ Don't add it
     Add it
   ```

   - Choose **Add it**, and the server is written with `copilot mcp add`. Only
     that choice adds. **Don't add it** is selected first.
   - Choose **Don't add it**, decline (ctrl+d) or cancel (esc) the form, and
     nothing is written. Copilot is told not to ask again unless you bring it
     up.
   - Where nobody can be asked (`copilot -p`), Copilot declines the form, so
     nothing is written. That holds with `--allow-all-tools` and with `--yolo`
     (seen live): allowing tools doesn't answer a form.
   - The plugin adds only a card a tool showed in this session, at the URL
     that card gives, and only if no server of that name exists
     (`copilot mcp get`, run in your session's folder so a project's servers
     count). Otherwise it refuses before asking.
5. **The server is added** to `$COPILOT_HOME/mcp-config.json`
   (`~/.copilot/mcp-config.json`), which serves all your projects. Copilot
   connects it after `/mcp reload`, or in your next session.
6. **If it needs a sign-in,** Copilot offers it when it first connects
   (`/mcp auth <name>`). `copilot mcp add` contacts no server and starts no
   sign-in, and the plugin never sees one.
7. **If the card asks for a secret,** such as an API key, the plugin never
   asks you for it and never shows it to Copilot's model. The configuration
   holds a reference to an environment variable, such as
   `${MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ}`, which Copilot expands when it
   connects, and the result tells you that name. Set it where you start
   Copilot, then start Copilot again. The tag at the end is 80 bits of SHA-256
   over the card's name and URL, so no other card can be given a reference to
   it.
8. **To undo an addition,** run `copilot mcp remove <name>`. The result gives
   the exact line.

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list, and reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Adds a server shown in this session, after your accept in the form. `url` must be the URL the server will connect to. |

### Native discovery in Copilot

Copilot 1.0.115 has a discovery of its own: a built-in `discover-resources`
skill with `catalog_search` and `catalog_select` tools, which search a remote
catalogue GitHub runs (it handles `application/mcp-server-card+json`). That is
a search of someone's catalogue, not SEP-2127's discovery from a domain: the
runtime has no `ai-catalog` handling. So this plugin doesn't stand down for
it, and the two don't overlap.

### What differs between the forms

All three run the same card, discovery and configuration code, in
[`../claude-code/mod/hooks`](../claude-code/mod/hooks). This form also runs the
Codex form's MCP server, fetch and form code (`../codex/src`), with a Copilot
front: its own plan and `copilot mcp add`.

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| What runs | a mod inside Claude Code | a stdio MCP server in a Codex plugin | a stdio MCP server in a Copilot plugin |
| Consent to an add | the mod's question in Claude Code's permission prompt | a form (MCP elicitation) | Copilot's tool prompt, then a form (MCP elicitation) |
| Where it's written | `claude mcp add`, in the scope you choose | `codex mcp add`, all projects | `copilot mcp add`, all projects |
| Secrets | `${VAR}` references | names of environment variables; a secret in a URL or mixed into a header is refused | `${VAR}` references, anywhere Claude Code allows them |
| SSE remotes | added | refused | added |
| Sign-in | `/mcp` | `codex mcp login <name>` | `/mcp auth <name>` |
| New servers | next session | next session | after `/mcp reload` |
| Protocol revisions it adds for | 2026-07-28 back to 2024-11-05 | 2025-06-18 back to 2024-11-05 | 2026-07-28 back to 2024-11-05 |

## Settings

The plugin reads these from the environment Copilot starts in.

| Variable | Default | What it does |
|---|---|---|
| `MCP_SERVER_CARDS_DISABLED` | unset | `1` turns the plugin off: no tools, nothing fetched. |
| `COPILOT_HOME` | `~/.copilot` | Where Copilot keeps its configuration. The plugin writes there, through `copilot mcp add`. |
| `COPILOT_CLI_PATH` | set by Copilot | The `copilot` to run. Copilot sets it for its MCP servers; without it the plugin tries `copilot` on `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. |

### When Copilot supports Server Cards itself

Copilot has no Server Card support to detect yet. When it ships, uninstall the
plugin, disable it (`copilot plugin disable mcp-server-cards@agent-polyfill`),
or set `MCP_SERVER_CARDS_DISABLED=1`. The server then registers no tools and
fetches nothing.

## Limits

Each limit names the host change that would remove it.
[What hosts would need to change](../../../docs/host-changes.md) covers these
for every host.

- **The card isn't compared with the live server** (rule S-3). The plugin
  can't send `server/discover` over Copilot's connection. A
  `session.rpc.mcp.request` in Copilot's API that passes any MCP request to a
  configured server would let it, though only from an extension, not from an
  MCP server.
- **Two questions for one add.** Copilot asks before every MCP tool call, and
  the form is the plugin's own question. "Don't ask again" on Copilot's prompt
  removes the first; the form stays.
- **New servers need `/mcp reload`.** An MCP server can't ask Copilot to
  reload; an extension could (`session.rpc.mcp.reload`), but that would need
  experimental mode for a feature that otherwise doesn't.
- **A public name that resolves to a private address isn't caught,** because
  Node's `fetch` resolves names itself. Redirects are checked hop by hop.
- **In VS Code, loaded but no add run.** VS Code 1.147.0's Copilot harness
  started the plugin's MCP server from the same `~/.copilot` (seen connected,
  signed in to GitHub, 25 November 2026). No server was added through it
  there, so whether VS Code shows the plugin's form is untested. VS Code's own
  chat (the Local harness) has MCP elicitation too.

## Security

[SECURITY.md](SECURITY.md) says what the plugin sends, what it stores, what it
changes and what it trusts. In short:

- It reads public documents from the domain you name, and the card URLs that
  domain's catalog lists. It never fetches a local or private address unless
  you name one yourself, and no redirect takes it to one.
- It changes only Copilot's MCP configuration, for the server you accept in
  the form, with `copilot mcp add`.
- It never reads Copilot's credentials, holds no token, and never puts a
  secret's value anywhere.

## Spec and conformance

It implements the client side of the MCP Server Cards extension:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in
  [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card)
  at commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127
  hands domain discovery to: v0.9, a release candidate, at `19208af2f8`.

### Client rules

All forms run the same code and tests for the discovery, validation, input and
transport rules. The full table is with the Claude Code form's
[client rules](../claude-code/README.md#client-rules). Here, those tests run
against the built [`plugin/dist/server.mjs`](plugin/dist/server.mjs), with
`npm test`. These are the rows where Copilot differs:

| # | Rule | Test | State |
|---|---|---|---|
| P-1 | Never replace a server the person has | E-5, E-7 | met: a name `copilot mcp get` knows, or can't rule out, is refused before the person is asked, and again before writing |
| P-2 | A person approves every addition | E-3, E-4, E-9 | met: a form naming the server, URL, headers, file and undo, with a required choice. Only **Add it** adds. Copilot declines the form where nobody can be asked, `--yolo` included (seen live) |
| P-3 | Add only what was shown, as shown | E-5 | met |
| I-2 | Handle `isSecret` values securely | C-2, C-3, E-6 | met: a `${VAR}` reference named for this card, never a value |
| I-3 | Choose a remote by its `supportedProtocolVersions` | C-6 | met, with Copilot's revisions |
| I-4 | Transport `streamable-http` or `sse` | C-3 | both met |
| V-3 | No text that displays as something else | C-5, plus the shared tests | met. A header's value is shown in the form as it is, so it may hold no markup |
| P-4 | Nothing from a card is read as an option of `copilot mcp add` | C-7 | met: every option is written `--option=value` (a header name may legally start with `-`; Copilot 1.0.115 refuses `--header -x: v` and takes `--header=-x: v` whole), and the name (a slug) and the URL (http or https) are checked again before the command runs, with no shell |
| P-5 | One value per header | C-8 | met: a card that sets one header twice, in any letter case, is refused, so the form, the command and the file can't disagree |

### Proof

- **Per rule:** 107 tests, run with `npm test`: 88 shared rule tests from
  `../claude-code/mod/tests`, run against the committed bundle; 17 of this
  form's own (the Copilot plan, C-, and the server as Copilot runs it, E-, with
  a stand-in `copilot` that parses options as Copilot's does, and a web on
  127.0.0.1); 2 that check the installed folder.
- **The real host,** 25 November 2026, Copilot CLI 1.0.115 on macOS, with an
  isolated `COPILOT_HOME`, no GitHub sign-in, and a scripted model on this
  machine (as in [mcp-events' live run](../../events/copilot/docs/live-run.md)):
  - Installed from this repository's marketplace (`copilot plugin marketplace
    add`, `copilot plugin install mcp-server-cards@agent-polyfill`), beside
    `mcp-events` and `ard-discovery`, all three loading in one session.
  - `discover_mcp_servers` for neon.com returned Neon and Neon Docs, both valid,
    from neon.com's own published cards.
  - In the TUI: Copilot's tool prompt for each tool, then the form above, drawn
    as quoted. **Add it** wrote `neon-docs` to `mcp-config.json` through
    `copilot mcp add`.
  - In `copilot -p`, with `--allow-all-tools` and with `--yolo`: Copilot
    declined the form, and nothing was written.
  - `copilot mcp add` (1.0.115) checked by hand: it writes `--header` values
    and `${VAR}` references as given, accepts SSE, refuses a name that exists,
    and contacts no server. Copilot expands `${VAR}` in a server's URL and
    headers when it connects (seen against a local server).
- **Upstream conformance:** the MCP conformance suite has no Server Card
  scenarios.

## Development

From this folder (`polyfills/server-cards/copilot`):

```bash
npm ci
npm test         # builds the tests and runs them against plugin/dist/server.mjs
npm run typecheck
npm run build    # plugin/dist/server.mjs; a test fails when it is stale
```

`src/` is what is specific to Copilot: the plan and `copilot mcp add`
(`copilot.ts`), its name and revisions (`host.ts`), and `add_mcp_server`
(`tools.ts`). CI: [`copilot-server-cards-test.yml`](../../../.github/workflows/copilot-server-cards-test.yml).

## Licence

Part of [AgentPolyfill](../../../README.md). Apache-2.0. See
[`LICENSE`](../../../LICENSE).

This is a community project. It isn't affiliated with or endorsed by GitHub,
Microsoft, the Model Context Protocol project, the Agentic AI Foundation or
the Linux Foundation. GitHub Copilot is a trademark of GitHub, Inc.
