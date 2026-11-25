# mcp-server-cards for Antigravity

Name a company, and Antigravity's agent finds the MCP servers its domain
publishes. Ask it to add one, approve it in Antigravity's own approval card,
and the server goes into Antigravity's MCP configuration, where Antigravity
connects it with its own sign-in.

Also available for [Claude Code](../claude-code/README.md) and
[Codex](../codex/README.md).

> What MCP servers does buildkite.com publish?

This plugin implements the client side of the MCP Server Cards extension
(SEP-2127), which Google Antigravity doesn't support itself yet. It works in
the Antigravity App, the CLI (`agy`) and the IDE, which share plugins. The
revisions it follows are in [Spec and conformance](#spec-and-conformance).

**Run live on 25 November 2026** in Antigravity App v2.35.1 and CLI v1.5.16
(macOS): discovery, the approval card (approved and declined) and a written
entry that the App then connected. The IDE's agent wasn't run. See
[What was checked live](#what-was-checked-live).

ARD isn't in this plugin. Its `/.well-known/ard.json` and its registry search
are in [`ard-discovery` for Antigravity](../../ard/antigravity/README.md),
because a search sends your words to a third party.

## Install

You need Node 20 or newer on your `PATH`. Antigravity starts the plugin's MCP
server with `node` (it falls back to its own Node for that), and runs the
plugin's approval hook with `node`, which has no such fallback.

From a clone of this repository (the sequence checked on 25 November 2026,
CLI 1.5.16):

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/server-cards/antigravity/plugin
agy plugin list
```

`agy plugin install` copies the folder to
`~/.gemini/config/plugins/mcp-server-cards/`, which the App and the CLI both
read; the App picks it up when it next starts. Nothing is published to
Antigravity's Marketplace. To turn it off, disable it in Customizations >
Installed, or run `agy plugin disable mcp-server-cards`.

### Uninstall, and what stays behind

```bash
agy plugin uninstall mcp-server-cards
```

That removes the plugin's folder. It leaves:

- the servers you added, under `mcpServers` in
  `~/.gemini/config/mcp_config.json` (remove one in Customizations > Installed
  > MCP Servers, or from the file);
- the plugin's own folder, `~/.gemini/agentpolyfill/mcp-server-cards/` (cards
  shown in the last hour, and tickets): delete it by hand.

### Where it was run

| Surface | Run | |
|---|---|---|
| Antigravity App v2.35.1 (macOS) | yes | discovery, the approval card (approve and decline), a written entry connected |
| Antigravity CLI v1.5.16 (macOS) | yes | headless `agy -p` (a decline nobody could answer), and an editor over `agy acp` (approve and decline) |
| Antigravity IDE v2.8.0 | no | installed, but not signed in, so its agent never ran; its hooks page lists no plugin hooks, and without the hook every addition is refused |

## Try it

Ask "What MCP servers does neon.com publish?", then "Add Neon Docs".
Antigravity's approval card asks you first:

```
neon.com: add the MCP server "neon-docs" to Antigravity?
It connects to the host neon.com
URL: https://neon.com/docs/mcp
Headers: none
From the Server Card com.neon/docs-mcp, listed in https://neon.com's catalog.
Written to /Users/you/.gemini/config/mcp_config.json (all your projects, in the App, the CLI and the IDE).
To undo: delete the server in Customizations > Installed > MCP Servers, or remove "neon-docs" under mcpServers in /Users/you/.gemini/config/mcp_config.json.
```

Approve it, and the entry is written. For a server behind a sign-in, such as
Buildkite's, Antigravity then shows **Authenticate** next to it in
Customizations > Installed > MCP Servers (`/mcp` in the CLI).

## How it works

1. **`discover_mcp_servers(domain)`** reads the domain's AI Catalog
   (`/.well-known/ai-catalog.json` and `rel="ai-catalog"` links), fetches
   each Server Card it lists, checks it against the schema, and shows what it
   found, valid or refused. It only reads.
2. **`add_mcp_server(identifier, url, ...)`** adds a server that a discovery
   showed. Before it runs, Antigravity runs the plugin's `PreToolUse` hook
   (`hooks.json`). The hook works out exactly what would be written and
   answers `force_ask`: Antigravity shows its approval card with the
   question above, whatever you have allowed before. The hook also leaves a
   one-use ticket for that exact entry and adds its name to the call.
3. **The server writes only with that ticket.** It recomputes the entry, and
   writes it only if the ticket is there, unused, less than 4 hours old,
   and for that same entry. No ticket, no write: if the hook didn't run, the
   call is refused and says so.
4. **The entry** goes into `~/.gemini/config/mcp_config.json` as
   `{"serverUrl": ..., "headers": {...}}`, keeping the rest of the file as it
   is. The plugin refuses a name you already have, a file it can't read as
   JSON, and a card that needs a secret.

Why a hook: Antigravity documents no MCP elicitation, so an MCP server can't
put a question to you itself. A `PreToolUse` hook can, through Antigravity's
own approval card, and hooks fail open (a hook that crashes is ignored). The
ticket is what makes this fail closed instead.

What the hook and the server share sits in `~/.gemini/agentpolyfill/mcp-server-cards/`,
private to you: the cards shown in the last hour, and the tickets.

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list. Read-only. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Adds a server shown in this conversation, after your approval. `url` must be the URL the card yields. |

### What differs between the forms

All three run the same card, discovery and configuration code, in
[`../claude-code/mod/hooks`](../claude-code/mod/hooks), and this form reuses
the Codex form's MCP server, fetch and checks (`../codex/src`).

| | Claude Code | Codex | Antigravity |
|---|---|---|---|
| What runs | a mod inside Claude Code | a stdio MCP server | a stdio MCP server and a `PreToolUse` command hook |
| Consent to an add | Claude Code's permission prompt | an MCP elicitation form | Antigravity's approval card (`force_ask`), with a one-use ticket |
| Where it's written | `claude mcp add`, in the scope you choose | `codex mcp add`, `~/.codex/config.toml` | `~/.gemini/config/mcp_config.json`, written by the plugin (there's no `agy mcp add`) |
| Secrets | `${VAR}` references | names of environment variables | refused: the file reads no variables, and the plugin never writes a secret |
| SSE remotes | added | refused | refused: `serverUrl` is streamable HTTP |
| Sign-in | `/mcp` | `codex mcp login` | Authenticate, in Customizations or `/mcp` |
| Settings | `/config` | environment variables | environment variables |

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MCP_SERVER_CARDS_DISABLED` | unset | `1` turns the plugin's server off: no tools, nothing fetched. |
| `AGENTPOLYFILL_STATE_DIR` | `~/.gemini/agentpolyfill` | Where the hook and the server keep what they share. Both must see the same value. |
| `MCP_SERVER_CARDS_LOG` | unset | A file to log to, for development. |

### When Antigravity supports Server Cards itself

Antigravity has no Server Card support to detect yet. When it ships, disable
or uninstall the plugin, or set `MCP_SERVER_CARDS_DISABLED=1`.

## Limits

Each names the host change that would remove it.
[What hosts would need to change](../../../docs/host-changes.md) has the
Antigravity column.

- **A card that needs a secret can't be added.** Antigravity reads no
  `${VAR}` in `~/.gemini/config/mcp_config.json` (a plugin's own file can,
  for its declared `variables`). The plugin would have to write the key, and
  it never does. You add such a server by hand. Fix: `${VAR}` in the
  personal file.
- **The approval is yes or no.** `force_ask` has no other choices. Antigravity's
  MCP client declares elicitation, but cancels every request without showing
  it (seen live, App and CLI); a working form would give the choices the
  Codex form shows.
- **An editor shows less.** Through `agy acp` (Zed, JetBrains and others),
  Antigravity sends the editor the tool's name and arguments, not the hook's
  question: the person sees the server's card identifier and URL, but not the
  headers, the file or the undo. Fix: pass the hook's `reason` in ACP's
  permission request.
- **The approval depends on the hook seeing the call.** Antigravity calls a
  lazily loaded MCP tool (its default) through its own `call_mcp_tool`, with
  the server in `ServerName`, and an eager one as `mcp_<server>_<tool>`
  (seen live). The hook's matcher takes both, and the gate acts only when
  `ServerName` is this plugin's server, `mcp-server-cards_cards`. So the hook
  runs, briefly, for every lazy MCP call of any server. If Antigravity
  changes those names, nothing is added (the server refuses without a
  ticket); it never adds unasked. Fix: MCP elicitation.
- **The plugin writes the configuration file itself.** The CLI has
  `agy mcp add` (1.5.16; the MCP page doesn't mention it), and it writes the
  same entry, but the App doesn't ship `agy`, so the plugin can't count on
  it. It writes the whole file in one step and keeps everything else in it,
  but a file with comments, or one Antigravity is writing at the same moment,
  isn't handled: the first is refused, the second could lose one of the two
  writes. Fix: a plugin API for adding a server.
- **The card isn't compared with the live server** (rule S-3). The plugin
  can't send `server/discover` over Antigravity's connection.
- **A project's own `.agents/mcp_config.json` isn't checked for a name
  clash.** The plugin's server isn't told which project you're in.
- **A public name that resolves to a private address isn't caught,** as in
  the Codex form. Redirects are checked.
- **When the new server's tools arrive** isn't documented: in a new
  conversation, or after refreshing it in the MCP Servers list or `/mcp`.

## What was checked live

Checked live on 25 November 2026, through the Events plugin, which uses the
same gate ([its record](../../events/antigravity/docs/live-run.md)):

- the name a `PreToolUse` hook sees for a plugin's MCP tool (`call_mcp_tool`
  with `ServerName`, `ToolName` and `Arguments`, for a lazily loaded tool),
  and that the matcher in `plugin/hooks.json` takes it;
- that `overwrite` reaches the MCP server's arguments (the ticket);
- that Antigravity starts the hook in the plugin folder, with the same `HOME`
  as the plugin's server.

Also: `agy plugin validate --strict` passes, and `agy mcp add` writes the same
entry shape as the plugin (`serverUrl`, `headers`).

Checked live later the same night ([record](../../events/antigravity/docs/live-run.md#second-pass-later-the-same-night)):

- In the **App**, the approval card shows the hook's whole question above the
  tool name, joined into one paragraph (which is why it starts with the
  host), and greys out the "always allow" choices.
- In the **CLI** through an editor (`agy acp`), the permission request carries
  only the tool's name and arguments (server, card identifier, URL), not the
  question. In headless `agy -p`, nobody can answer, so the call is denied.
- An approved addition wrote `"neon-docs": {"serverUrl": "https://neon.com/docs/mcp"}`,
  and the App connected it. A declined one, in the App and over ACP, wrote
  nothing.

Not checked yet: a server behind a sign-in (Authenticate) after an addition,
and the IDE (its hooks page lists no plugin hooks; without them the gate
refuses every addition).

## Security

[SECURITY.md](SECURITY.md) says what the plugin fetches, reads and writes, and
what it trusts. In short:

- Antigravity's approval card is the boundary: every addition asks, and
  nothing is auto-approved.
- It reads `~/.gemini/config/mcp_config.json`, which can hold header values,
  to check names, and never logs or shows them. It never opens
  `mcp_oauth_tokens.json` or any sign-in store, and never writes a secret.
- It changes only `mcp_config.json`, for the entry you approve, and its own
  folder in `~/.gemini/agentpolyfill/`.

## Spec and conformance

The same revisions as the other forms:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in
  [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card)
  at commit `28db12c9b4` (2026-11-19).
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9 at
  `19208af2f8`.

The rules, where Antigravity differs from the other forms, and the proof (119
tests: 90 shared rule tests and 29 of this form's own, plus the live run) are
in [docs/conformance.md](docs/conformance.md).

## Development

```bash
npm ci
npm run build      # plugin/dist/server.mjs
npm test
npm run typecheck
```

`src/gate.ts` (the hook, the ticket) and `src/host.ts` are shared with the
ARD form, and with the Skills and Events forms for Antigravity.
