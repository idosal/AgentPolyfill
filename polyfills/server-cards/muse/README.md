# mcp-server-cards for Muse Code

Name a company and Muse Code finds the MCP servers its domain publishes, and
checks each Server Card. For the server you pick, it gives you the
`muse mcp add …` command, which you run yourself.

Also available for Claude Code: [mcp-server-cards for Claude Code](../claude-code/README.md),
for Codex: [mcp-server-cards for Codex](../codex/README.md),
and for Pi: [mcp-server-cards for Pi](../pi/README.md).

This plugin implements the client side of MCP Server Cards,
[SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md)
(Final; the extension is Beta).
- **The folder.** It's the Codex plugin's folder, [`../codex/plugin`](../codex/plugin),
  with a Muse manifest beside the Codex one
  ([`.muse-plugin/plugin.json`](../codex/plugin/.muse-plugin/plugin.json)).
- **The Muse-only code** is in [`../codex/src/muse.ts`](../codex/src/muse.ts).
- **All four forms.** [AgentPolyfill in Muse Code](../../../docs/muse.md) covers
  every Muse form.

## Install

You need **Muse Code 1.4.25** (the version tested) and **Node 20 or newer**:

```bash
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-server-cards@agent-polyfill
muse plugins approve mcp-server-cards
```

Then start a new `muse` session in a workspace you trust. After
`muse plugins update mcp-server-cards`, approve again.

To remove it: `muse plugins remove mcp-server-cards --delete-data`.
- **Left behind:** any server you added with the command it gave you. That's
  yours now, in Muse's settings: `muse mcp remove <name>` undoes one.
- **The marketplace.** If no other plugin of it is installed,
  `muse plugins marketplace remove agent-polyfill`.

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
approve with nobody asked. So in Muse, this plugin never adds a server itself.
It gives you the `muse mcp add …` command, quoted so that what you see is what
runs, and **you run it yourself**, in a terminal or after `!` at the Muse
prompt. Not running it is saying no.

## Try it

Ask: "What MCP servers does neon.com publish? Add Neon Docs."
1. **Discovery.** Muse calls `discover_mcp_servers`, which shows the two
   servers neon.com publishes.
2. **The command.** `add_mcp_server` answers with the command for Neon Docs:

   ```bash
   muse mcp add neon-docs --url https://neon.com/docs/mcp
   ```

3. **You run it.** Run it in a terminal, or after `!` at the Muse prompt. A new
   `muse` session connects it.

## How it works

- **Discovery** is the same as in every form:
  - **What it reads:** the domain's AI Catalog (`/.well-known/ai-catalog.json`
    and `rel="ai-catalog"` links), then each Server Card it lists.
  - **What it checks:** each card against the schema, with the shared rules
    on URLs, private addresses and text that displays as something else.
  - **What it sends:** only GETs.
- **Adding writes nothing.** Muse gives a plugin no way to ask you, so the
  plugin can't ask before it writes:
  - its MCP client offers no elicitation;
  - a tool call that isn't read-only goes to Muse's approval judge, a model
    that may approve it with nobody asked.

  So `add_mcp_server` runs the same checks as in Codex, then answers with the
  `muse mcp add …` command, for you to run:
  - a card shown in this session;
  - the URL it gives, which must be the URL the model names;
  - Muse's limits;
  - a name Muse doesn't have yet (`muse mcp get`).

  Running the command is your yes. It shows the URL, every header it writes,
  the host it connects to, and how to undo it. Each word that needs it is
  quoted for the shell, so what you see is what runs. A secret stays a
  reference: `--bearer-token-env-var VAR`, or a header whose whole value is
  `${VAR}`, which you set in the environment you start `muse` from.
- **Sign-in is Muse's own.** If the server asks for a sign-in, run
  `muse mcp login <name>`. Muse holds that sign-in, and the plugin never sees
  it.

## Settings

None in Muse. Muse passes a plugin's server no environment variables, so
`MCP_SERVER_CARDS_DISABLED` has no effect there. Turn it off with
`muse plugins disable mcp-server-cards`.

### When Muse supports Server Cards itself

Disable the plugin. Muse doesn't tell a plugin what its own client supports.

## Limits

- **You run the command.** It can't add a server for you, because Muse can't
  ask you first.
- **Server checks** (S-3). The card's claims aren't checked against the live
  server, as in every form.
- **SSE remotes are refused.** Muse connects stdio and streamable HTTP
  servers.
- **A secret inside other text** (`Token ${VAR}`) or in the URL is refused.
  Muse fills a reference only as a whole value.
- **Platforms.** Checked on macOS only.

## Security

A card is the publisher's claim, not a check of the server. Nothing is written
to your configuration but by you, with the command. The plugin reads no
configuration file and no sign-in store. It runs `muse` only for
`muse mcp get <name> --json`. Details: [`SECURITY.md`](SECURITY.md).

## Spec and conformance

The rules are met by the code every form shares. The
[Claude Code table](../claude-code/README.md#client-rules) holds, except for
the rows in [`docs/conformance.md`](docs/conformance.md). Muse runs are in
[`docs/live-run.md`](docs/live-run.md). **No run used a real model.**

## Development

Built and tested with the Codex form, from [`../codex`](../codex): `npm ci`,
`npm test` (the Muse tests are M-1 to M-7 in `test/adapter.test.ts`, and the
Muse manifest check in `test/bundle.test.ts`), and `npm run build`.

## Licence

Apache-2.0, as the rest of the repository.
