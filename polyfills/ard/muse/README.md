# ard-discovery for Muse Code

Muse Code finds the MCP servers a domain lists through Agentic Resource
Discovery: its `ard.json`, beside its AI Catalog. For the server you pick, it
gives you the `muse mcp add …` command, which you run yourself.

Also available for Claude Code: [ard-discovery for Claude Code](../claude-code/README.md),
for Codex: [ard-discovery for Codex](../codex/README.md),
and for Pi: [ard-discovery for Pi](../pi/README.md).

[ARD](https://github.com/ards-project/ard-spec) v0.91 is a draft.
- **The folder.** Muse installs from this repository's Codex marketplace, so the
  plugin lives in the Codex plugin's folder, [`../codex/plugin`](../codex/plugin),
  with its own manifest ([`.muse-plugin/plugin.json`](../codex/plugin/.muse-plugin/plugin.json))
  and its own bundle, `muse/dist/server.mjs` there. The Codex bundle beside it is
  the Codex form's alone, the same with or without this form.
- **The code.** [`src/main.ts`](src/main.ts): the Codex form's `ard_discover`,
  named for Muse, and mcp-server-cards' Muse add
  ([`../../server-cards/muse/src/muse.ts`](../../server-cards/muse/src/muse.ts)).
- **Its version** is its own, 0.1.0.
- **All four forms.** [AgentPolyfill in Muse Code](../../../docs/muse.md) covers
  every Muse form.

## Install

You need **Muse Code 1.4.25** (the version tested) and **Node 20 or newer**:

```bash
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install ard-discovery@agent-polyfill
muse plugins approve ard-discovery
```

Then start a new `muse` session in a workspace you trust. After an update,
approve again.

To remove it: `muse plugins remove ard-discovery --delete-data`.
- **Left behind:** servers you added with its command stay in Muse's settings.
  `muse mcp remove <name>` undoes one.

## How you say yes

**Muse offers plugins no approval dialog.** In the other hosts, the polyfills
ask you through a prompt the host draws itself, which the model can't answer:

- **Claude Code:** its permission dialog.
- **Codex:** its approval prompt, or an MCP form.
- **Pi:** a dialog.
- **OpenCode:** its permission prompt (the polyfills set their own actions to
  ask).

Muse has nothing like that for a plugin. Its MCP client offers no form, and a
tool call that isn't read-only goes to Muse's approval judge, a model that may
approve with nobody asked. So in Muse, this plugin never adds a server itself,
and sends no search to a registry. It gives you the `muse mcp add …` command,
quoted so that what you see is what runs, and **you run it yourself**, in a
terminal or after `!` at the Muse prompt. Not running it is saying no.

## What it does in Muse

- **`ard_discover(domain)`** reads the domain's `/.well-known/ard.json`, its AI
  Catalog and their `rel` links. It checks each Server Card they list, with the
  Server Cards rules, and sends only GETs.
- **`add_mcp_server`** checks a server `ard_discover` showed and gives the
  `muse mcp add …` command, as
  [mcp-server-cards does in Muse](../../server-cards/muse/README.md#how-it-works).
  Nothing is written but by you.
- **No registry search.** `ard_search` isn't offered in Muse. A search sends
  the words of your request to a service someone else runs, so every form asks
  you first. Muse gives a plugin no way to ask:
  - its MCP client offers no elicitation;
  - a tool call that isn't read-only goes to Muse's approval judge, a model.

  If you want a server for a task and name no company, the plugin says so, and
  Muse asks you which domain to look at.

## Settings

None in Muse. Muse passes a plugin's server no environment variables, and
there is no search to point at a registry. Turn it off with
`muse plugins disable ard-discovery`.

## Limits

- **No registry search** (above).
- **You run the command.** As for Server Cards in Muse.
- **Platforms.** Checked on macOS only.

## Security

Discovery sends only GETs to the domain you name and the card URLs it lists.
Nothing is ever sent to a registry from Muse. The plugin reads no
configuration file and no sign-in store. Details: [`SECURITY.md`](SECURITY.md).

## Spec and conformance

[`docs/conformance.md`](docs/conformance.md) lists where the Muse form
differs from the [Codex form's rules](../codex/README.md#client-rules). Muse
runs are in [`docs/live-run.md`](docs/live-run.md). **No run used a real
model.**

## Development

From this folder, after `npm ci` in [`../codex`](../codex) and in
[`../../server-cards/codex`](../../server-cards/codex): `npm test` (M-1 to M-3 in
`test/adapter.test.ts`, and the bundle and manifest checks in
`test/bundle.test.ts`), `npm run typecheck`, and `npm run build`, which writes
`../codex/plugin/muse/dist/server.mjs`. The Codex bundle is built in `../codex`,
and nothing here changes it.

## Licence

Apache-2.0, as the rest of the repository.
