# ard-discovery for Muse Code

Muse Code finds the MCP servers a domain lists through Agentic Resource
Discovery: its `ard.json`, beside its AI Catalog. For the server you pick, it
gives you the `muse mcp add …` command, which you run yourself.

Also available for Claude Code: [ard-discovery for Claude Code](../claude-code/README.md),
for Codex: [ard-discovery for Codex](../codex/README.md),
and for Pi: [ard-discovery for Pi](../pi/README.md).

[ARD](https://github.com/ards-project/ard-spec) v0.91 is a draft.
- **The folder.** It's the Codex plugin's folder, [`../codex/plugin`](../codex/plugin),
  with a Muse manifest beside the Codex one
  ([`.muse-plugin/plugin.json`](../codex/plugin/.muse-plugin/plugin.json)).
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

Built and tested with the Codex form, from [`../codex`](../codex): `npm ci`,
`npm test` (the Muse tests are M-1 to M-3 in `test/adapter.test.ts`), and
`npm run build`.

## Licence

Apache-2.0, as the rest of the repository.
