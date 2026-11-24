# Interop: Events servers written by others

24 November 2026, macOS, Node 22. Each run drives the helper as Codex starts it
(an MCP server over stdio, every call carrying a session id), with a stand-in
`codex` that records each wake (`test/fake-codex.mjs`). The runner is
[`test/interop/run.ts`](../test/interop/run.ts). The live run in Codex itself
is [`live-run.md`](live-run.md).

| Server | Who wrote it | Ran | Result |
|---|---|---|---|
| [NHTanvir/hookbench](https://github.com/NHTanvir/hookbench) reference server (`hookbench serve`) | NHTanvir | yes, locally | 7 of 7 |
| [hookdeck/mcp-events-outpost-demo](https://github.com/hookdeck/mcp-events-outpost-demo) | Hookdeck | yes, locally, against the demo's own mock Outpost | 4 of 4 |
| [olaservo/mcp-mailbox](https://github.com/olaservo/mcp-mailbox) | olaservo | no: not an Events server | n/a |
| [`servers/event-feeds`](../../../../servers/event-feeds) (this repository), the hosted copy | this repository | yes | 3 of 3, and the live run |

## hookbench

`hookbench serve --allow-loopback-callbacks` (its strict defaults refuse a
callback on 127.0.0.1), events fired with `hookbench fire`. The helper's
configuration gave the server its dev token as a header, as a user would.

```
HOOKBENCH=<checkout> node --no-warnings test/interop/run.ts hookbench
pass  discovery: events/list over Streamable HTTP, protocol 2026-07-28, the extension declared  (ticket.created, build.finished, alert.fired)
pass  watch: ticket.created {priority: high} by webhook, build.finished {branch: main} by push  (w-6cc098 webhook, w-20082c push)
pass  webhook delivery: signed by the server, verified, stored, and the session woken with ids only
pass  filtering: a ticket that does not match the watch's arguments does not arrive
pass  push delivery and routing headers: build.finished {branch: main} over events/stream (Mcp-Param-Branch)
pass  termination: the server ends build.finished subscriptions; the watch is removed and the session told  (notice: [mcp-events] Watch w-20082c (hookbench · build.finished) ended: the server ended the subscription (error -32024 (forbidd…)
pass  unwatch: the webhook subscription is ended with events/unsubscribe
```

The webhook watch went to the helper's own receiver through
`MCP_EVENTS_PUBLIC_URL` on loopback (`MCP_EVENTS_DEV=1` allows plain http
there, for tests only), not through a relay.

## mcp-events-outpost-demo

The demo's MCP server, whose webhook subscriptions Hookdeck Outpost runs,
started against the mock Outpost in its own `test/mock-outpost.ts` (the
stand-in its end-to-end test uses; no Outpost account), with its token
`tok-alice`:

```
OUTPOST_LAUNCH="node <checkout>/node_modules/tsx/dist/cli.mjs test/interop/launch-outpost.mts <checkout>" \
  node --no-warnings test/interop/run.ts outpost
pass  discovery: order.created, webhook only
pass  watch order.created {currency: USD, highValue: true}: subscribed through Outpost, its challenge answered
pass  a matching order is delivered, signed by Outpost, and wakes the session; one that does not match is not
pass  unwatch: events/unsubscribe through Outpost
```

[`test/interop/launch-outpost.mts`](../test/interop/launch-outpost.mts) does what the demo's
`test/e2e.test.ts` does before its tests: `new MockOutpost().start()`, then
`createApp({ tokens: {tok-alice: alice}, outpost: <the mock> })` on a free
port, and prints the two addresses. Not run against a real Outpost.

## mcp-mailbox

A mailbox for webhook deliveries (a Cloudflare Worker that stores signed
deliveries) and a reader that collects them, built for another server
(forge-mcp-server, not in the repository). It is another design of what this
plugin's relay does, not an Events server, so there is nothing in it for this
client to subscribe to. This client collects webhooks only through its own
relay or its own receiver; it does not read mcp-mailbox. Not run.

## event-feeds

```
node --no-warnings test/interop/run.ts feeds
pass  discovery: the hosted event-feeds server lists its event types
pass  a demo button, watched by poll
pass  a press wakes the session; get_event returns it
```

The same server woke a real Codex session in [`live-run.md`](live-run.md).
