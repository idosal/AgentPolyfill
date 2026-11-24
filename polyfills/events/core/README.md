# Events core

The client side of MCP Events
([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)),
shared by both forms of the Events polyfill:
[`../claude-code`](../claude-code) for Claude Code and
[`../codex`](../codex) for Codex. It isn't installed by itself: each form
bundles it into its own plugin folder.

What is here:

- the Events client (`events-client.ts`, `routing-headers.ts`);
- the watches and their delivery loops (`watcher.ts`);
- webhook verification and the local receiver (`webhooks.ts`, `tunnel.ts`);
- the relay client (`relay.ts`);
- the event store (`store.ts`);
- handing events to the session (`delivery.ts`, `format.ts`);
- the wake gate (`wake.ts`);
- the tools' handlers (`tools.ts`);
- the handling of what servers send (`untrusted.ts`).

What each host says differs in a few places: its name, where to set up a
relay, and what wakes a session again. `host.ts` holds those words. Its
defaults are Claude Code's, and each host's helper sets its own with
`configureHost()`.

The relay's wire format comes from the relay Worker itself, through
`relay-protocol.ts`. The Worker's source is
[`../claude-code/mod/relay`](../claude-code/mod/relay): the Claude Code mod
ships it and deploys it from its own folder.

The tests of every rule the SEP puts on a client run in each form, against
this code. Run `npm ci` here, then `npm test` in either form's folder.
