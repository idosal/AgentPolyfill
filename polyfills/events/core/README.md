# Events core

The client side of MCP Events
([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md))
that each host's form of the Events polyfill shares. It is not installed by
itself: each form bundles it into its own plugin folder.

- Used by [`../claude-code`](../claude-code) (Claude Code) and
  [`../codex`](../codex) (Codex).
- What is here: the Events client (`events-client.ts`, `routing-headers.ts`),
  the watches and their delivery loops (`watcher.ts`), webhook verification
  and the local receiver (`webhooks.ts`, `tunnel.ts`), the relay client
  (`relay.ts`), the event store (`store.ts`), handing events to the session
  (`delivery.ts`, `format.ts`), the wake gate (`wake.ts`), the tools' handlers
  (`tools.ts`), and the handling of what servers send (`untrusted.ts`).
- What each host says differs in a few places (its name, where to set up a
  relay, what wakes a session again): `host.ts` holds those words, Claude
  Code's by default, and each host's helper sets its own with `configureHost()`.
- The relay's wire format comes from the relay Worker itself, through
  `relay-protocol.ts`: the Worker's source is
  [`../claude-code/mod/relay`](../claude-code/mod/relay), which the Claude
  Code mod ships and deploys from its own folder.

The tests of every rule the SEP puts on a client run in each form, against
this code: `npm test` in either folder, after `npm ci` here.
