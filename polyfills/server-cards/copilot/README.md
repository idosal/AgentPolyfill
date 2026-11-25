# mcp-server-cards for GitHub Copilot CLI

Name a company, and Copilot finds the MCP servers its domain publishes. Ask
it to add one, accept the form Copilot shows you, and the server goes into
Copilot's own MCP configuration.

Also available for [Claude Code](../claude-code/README.md),
[Codex](../codex/README.md) and [Pi](../pi/README.md).

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

From a clone of this repository (the install that was tested, on Copilot CLI
1.0.115):

```bash
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install mcp-server-cards@agent-polyfill
```

Copilot loads a plugin from a local marketplace where it is, without copying
it, so keep the clone; `git pull` in it brings the next version. Once this
plugin is on the repository's default branch,
`copilot plugin marketplace add idosal/AgentPolyfill` adds the same
marketplace from GitHub (Copilot reads its `.github/plugin/marketplace.json`),
and Copilot keeps its own copy. Start a new Copilot session afterwards.

You need:

- GitHub Copilot CLI 1.0.115 or newer (tested with 1.0.115). This plugin is an
  MCP server in a plugin, so it needs **no** experimental mode.
- Node.js 20 or newer on your `PATH`. The plugin is one JavaScript file with
  no dependencies, [`plugin/dist/server.mjs`](plugin/dist/server.mjs), which
  Copilot starts as a stdio MCP server.

For one run without installing: `copilot --plugin-dir ./AgentPolyfill/polyfills/server-cards/copilot/plugin`.

### Uninstall

```bash
copilot plugin uninstall mcp-server-cards@agent-polyfill
```

What stays behind (seen with Copilot 1.0.115):

- **Servers you added** stay in `~/.copilot/mcp-config.json`. Remove each with
  `copilot mcp remove <name>`; the plugin told you the name when it added it.
- **Copilot's own records:** `enabledPlugins` in `~/.copilot/settings.json`
  keeps `"mcp-server-cards@agent-polyfill": false`, and the marketplace stays
  until `copilot plugin marketplace remove agent-polyfill` (which other plugins
  from this repository need too).
- **The clone,** if you installed from one.

The plugin itself stores nothing: what it discovers is kept in memory for the
session.

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

### Copilot's own catalogue

Copilot 1.0.115 has a discovery of its own, and it does read Server Cards. What
was checked, in the runtime Copilot unpacks (in its cache folder, 25 November
2026):

- **A built-in skill, `discover-resources`** (`builtin-skills/discover-resources/SKILL.md`),
  whose `catalog_search` and `catalog_select` tools search a catalogue Copilot
  is given (its "catalog authority"), for public MCP servers and skills.
- **An experimental SDK API** (`copilot-sdk/generated/rpc.d.ts`): `catalog.search`,
  and `mcp.planInstall`, which plans an install from a candidate that search
  returned, or from a card supplied by URL or as data. It accepts the Server
  Card media type, `application/mcp-server-card+json`.

What wasn't seen: discovery from a domain, SEP-2127's way in. Neither the
runtime's JavaScript nor the SDK's types mention the AI Catalog or a
`.well-known` path, and the skill sends a capability query, not a domain.
Copilot's compiled core couldn't be searched as text, so that isn't proof.
Not run: the skill wasn't listed by `copilot skill list` when signed out, and
neither the skill nor the API was tried. Whether Copilot's install planning
applies SEP-2127's rules to a card also wasn't checked.

So the two do different things: Copilot searches a catalogue for a task, and
this plugin reads what a domain publishes. The plugin doesn't stand down for
Copilot's catalogue. If Copilot comes to read a domain's catalog itself, turn
the plugin off ([below](#when-copilot-supports-server-cards-itself)).

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

Copilot reads Server Cards from its own catalogue ([above](#copilots-own-catalogue)),
but not from a domain, which is SEP-2127's discovery, so there is nothing to
stand down for yet, and the plugin has nothing to detect. When Copilot reads a
domain's catalog itself, uninstall the plugin, disable it
(`copilot plugin disable mcp-server-cards@agent-polyfill`), or set
`MCP_SERVER_CARDS_DISABLED=1`. The server then registers no tools and fetches
nothing.

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
- **In VS Code, the form shows as one paragraph.** VS Code 1.147.0's Copilot
  harness runs the plugin from the same `~/.copilot`, and an add worked there:
  `add_mcp_server` stopped at VS Code's tool prompt, then VS Code showed the
  plugin's form ("Your answer", the question, **Don't add it** first), and
  **Add it** wrote the server. It runs the question's lines (server, URL,
  headers, file, undo) together in one paragraph. VS Code's own chat (the
  Local harness) has MCP elicitation too.

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

Each client rule, how Copilot meets it and where it is tested, is in
[`docs/conformance.md`](docs/conformance.md). The shared rules (D-1 to D-9,
V-1 to V-3, C-1 to C-3, S-1 to S-6, I-1 to I-4) are the same code and the
same 90 tests as in the other forms, run here against the committed bundle.
This form's own tests cover the Copilot plan and its command line (C-1 to
C-9) and the server as Copilot starts it (E-1 to E-10): the form, existing
names, secrets, headers, failure, stand-down and hidden characters. One rule
isn't met, as in the other forms: S-3, the live comparison of a card with the
server.

In Copilot CLI 1.0.115 itself, the plugin was installed from a clone as a
marketplace, found Neon and Neon Docs on neon.com, and after Copilot's tool
prompt and **Add it** in the plugin's form, wrote `neon-docs` with
`copilot mcp add`. In `copilot -p`, with `--yolo` too, Copilot declined the
form and nothing was written. The MCP conformance suite has no Server Card
scenarios, so there is no upstream run to report.

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
