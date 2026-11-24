# MCP Events in Claude Code: what works today, and what is missing

As of 24 November 2026, against SEP-3415 (Final) and Claude Code 2.1.329
(mod API types of 2.1.330). This page is for people who work on Claude Code
or on MCP clients: it says what a mod can and cannot do for Events today.

**In short.** A mod can make Claude Code a client of the Events extension
today, with no change to Claude Code: push, poll and webhook delivery, checked
against the SEP clause by clause. It works with any server that follows the
SEP and can be reached with no credentials, a header, or a `headersHelper`. It
cannot work with a server whose only way in is Claude Code's interactive OAuth
sign-in, it needs a second connection to every server, it needs a helper
process and a JavaScript runtime, and it needs an open session. All of that is
Claude Code's to lift, and one addition to the mod API would lift most of it.

"The mod" is this repository: a hooks module that runs inside Claude Code and a
helper process that holds the Events client.

## 1. What the mod supports

The rules the SEP puts on a client or on a webhook receiver, and where each
stands, in summary. "Test" names the test that checks it. The full list, 86
clauses with the code and test for each, is in
[`conformance.md`](conformance.md).

### Negotiation and discovery

| The SEP asks | Here | Test |
|---|---|---|
| Events exists on protocol revision 2026-07-28 and later | Used only there. | `e2e`: "advertises events only where the extension does not define them" |
| The server advertises under `capabilities.extensions["io.modelcontextprotocol/events"]` | Read from there. **Outside the SEP, by default:** where that is absent, the top-level `events` key of the earlier design sketch (the form ChatGPT reads) is read too. `MCP_EVENTS_PRE_STANDARD=off` stops that, and the user is then told why such a server is left alone. | same |
| A client MUST NOT send `events/*` to a server that has not advertised the extension | Checked on every request, including after a reconnect. With the default above, "advertised" includes the earlier form; with `MCP_EVENTS_PRE_STANDARD=off` it is the SEP's rule exactly. | `spec`: "with the form from before the standard turned off…" |
| A client MAY declare the extension in its per-request capabilities | Declared. | interop runs |
| `events/list`, following `nextCursor` | Yes (up to 200 event types). | `e2e` |
| On `notifications/events/list_changed`, list again (opt in with `eventsListChanged` on `subscriptions/listen`) | Opts in when the server declares `listChanged: true`, and lists again on the notice. | `spec`: "a server that says its event types change…" |

### Poll

| The SEP asks | Here | Test |
|---|---|---|
| One `events/poll` loop per subscription; `cursor: null` means from now | Yes. | `e2e` |
| Store the cursor and pass it back | Saved per watch before an event is acknowledged. | `e2e`: restarts |
| `hasMore`: poll again immediately | Yes. A batch that brought nothing new is drained at the poll floor, so a server that always says "more" cannot spin the loop. | `spec`: poll |
| Otherwise wait `nextPollMs`; apply a configurable floor, default 1000 ms | Yes (`MCP_EVENTS_MIN_POLL_MS`). | `spec`: poll |
| `truncated: true` is a possible gap; keep going with the fresh cursor | Claude is told events were skipped. Ignored when no cursor was supplied, except mid-stream on push, where it is always a gap. | `spec`: cursors, push |
| Optional `maxEvents`, `maxAgeMs` | `maxEvents: 100`; `maxAgeMs` if the watch sets one. | |

### Push

| The SEP asks | Here | Test |
|---|---|---|
| One `events/stream` per subscription, routed by `_meta["io.modelcontextprotocol/subscriptionId"]` | Yes; several streams may be open. | `e2e`: push |
| Cancel by aborting the request (HTTP) or `notifications/cancelled` (stdio) | Yes (the SDK does each). | `e2e`: "unwatch cancels the stream" |
| Do not depend on the final result; do not apply the default request timeout | Yes. | |
| The granted `heartbeatMs` is authoritative; no message for 3× that, counted from `active`, means reconnect with the cursor (HTTP). On stdio, end of output is the signal | Yes. | `spec`: push |
| Reconnect with the last cursor, after a random wait | Yes. | `spec`, `e2e` |
| `notifications/events/error` is transient | Logged; the stream stays. | |

### Webhook

| The SEP asks | Here | Test |
|---|---|---|
| `events/subscribe` with `delivery: {mode, url, secret}`; the secret is the client's, `whsec_` + 24–64 random bytes | 32 random bytes per subscription, given to nobody but the MCP server. | `units`, `relay.e2e` |
| Call with an authenticated principal | Webhook is used only on a connection that carries a credential from the user's config (a header or a `headersHelper`), checked again for a saved watch. | `spec`: delivery mode |
| Callback URLs are `https` | Yes. | `relay.units` |
| Refresh before `refreshBefore`; always pass the last cursor | Refreshed at 60% of the granted lifetime (and at least hourly). | `relay.e2e` |
| `events/unsubscribe` | On unwatch. A subscription at a relay address is kept across restarts, because the address outlives the session. | `e2e`, `relay.e2e` |
| Verify the Standard Webhooks `v1` signature over the raw body before processing; accept any of several signatures | Yes, in the mod. | `units`, `relay.units` |
| Reject timestamps more than 5 minutes old; deduplicate on `webhook-id` | Yes. Stale or already-taken deliveries get `410`. | `relay.units` |
| Echo a `verification` challenge only if its signature verifies | Yes. The relay also publishes `/.well-known/mcp-webhook-receiver.json` (the SEP's fourth verification path). | `units`, `relay.e2e` |
| No `2xx` before the event is stored | The relay stores before answering; the mod acknowledges to the relay after writing the event and its own state. | `relay` tests |
| A forwarding endpoint passes on `cursor`, `eventId`, and `gap` / `terminated` envelopes | The relay forwards bodies byte for byte. | `relay` tests |
| Deduplicate by `eventId` within a subscription only | Per watch (the last 500 ids). | `e2e` |
| Bodies over 256 KiB may be refused with `413` | Yes. | `relay` tests |

### Cursors, termination, headers

| The SEP asks | Here | Test |
|---|---|---|
| An absent `cursor` is `null`; never persist or replay from `null` | Yes, everywhere a cursor appears. | `spec`: cursors |
| On termination, remove the subscription and tell the application | The watch is removed and Claude is told, in the mod's words. | `spec`: termination |
| On `NotFound` / `Unsupported`, list again and resubscribe against the current descriptor | Yes, once; a second termination straight after ends the watch. | `spec`: termination |
| Over Streamable HTTP, set `Mcp-Name` to the event name on poll, stream, subscribe, unsubscribe (Base64 form when not plain ASCII) | Yes. The SDK does this for tools only, so the mod adds it. | `spec`: routing headers |
| Support `x-mcp-header`: send `Mcp-Param-{Name}` for annotated arguments; leave out event types whose annotations are invalid; on `HeaderMismatch`, list again and retry | Yes. | `spec`: routing headers |
| Treat payloads with the same caution as tool results; receipt is not authorization to act | Payloads are shown as that server's data; actions go through Claude Code's permissions. | `e2e`, `hardening` |

### Optional parts not implemented

None of these is required of a client.

- No-expiry subscriptions (`ttlMs: null`), and leaving `ttlMs` out. The mod always suggests a lifetime (24 hours at a relay address).
- Secret rotation on refresh.
- Checking a server's asymmetric `v1a` signature against its Server Card, and source-IP allowlisting.
- Showing `deliveryStatus` to the user beyond a log line; the typed `data` of errors.
- A per-watch choice of delivery mode. The SEP's order is used: webhook where one is set up, then push, then poll.

## 2. What is missing from Claude Code

Each row is something a mod cannot do, which servers or uses it shuts out, and
what would close it.

| Gap | What it shuts out | What would close it |
|---|---|---|
| **Mods cannot use Claude Code's MCP connections or their credentials.** The mod API's `$.mcp` can call a tool and ask for a verdict, and nothing else, so the mod opens a second connection of its own. | Every server reached only through Claude Code's interactive OAuth sign-in, which is most hosted servers (section 3), and every claude.ai connector. A local server runs twice. | `$.mcp.request(server, method, params)`: any MCP method on Claude Code's own connection, with its credentials. That alone covers poll and webhook. See also [`sign-in.md`](sign-in.md). |
| **No notifications for a request made that way.** | Push delivery (`events/stream` answers with notifications on the request's stream), and `subscriptions/listen`. | Notifications delivered to the caller of a request, tagged with its subscription id. |
| **Mods cannot see what a server advertised.** | The rule "never send `events/*` to a server that has not advertised the extension", if requests went over Claude Code's connection. | The server's capabilities (including `extensions`) and the negotiated protocol revision, as sent. |
| **Claude Code's client would have to set the Events routing headers.** If requests go over Claude Code's connection, a mod can no longer add `Mcp-Name` and `Mcp-Param-*`, and the SDK sets them for tools only. | Any server that validates headers as the SEP says: it answers `400` to every poll, stream and subscribe. | The transport applying SEP-2243's rules to `events/*`, or letting the caller supply those headers. |
| **A hooks module cannot hold a connection.** It has `$.http.fetch`, which answers once the whole body is read, and no sockets, so anything long-lived needs a helper process, and the helper needs a runtime. (Poll over Streamable HTTP alone could in principle run inside the module; push, local servers over stdio and the relay's WebSocket cannot, so one helper carries all of it.) | Machines with neither Node nor Bun (Claude Code's own installer brings neither). Cloud sessions, where a mod starts no process. | The row above (`$.mcp.request` with notifications) removes the helper entirely. Short of that, a streaming fetch. |
| **No public address.** A laptop cannot receive a webhook. | Servers that deliver by webhook only, which is what servers built for ChatGPT do; and any event while Claude Code is closed. | A hosted receiver per user. It needs to hold no secrets: this mod's relay stores signed deliveries and the client verifies them, so its host can delay events but not forge them. Until then: one command deploys the relay to the user's own Cloudflare account. |
| **Events only reach an open session.** `$.prompt.submit` wakes an idle session, in a terminal or hosted by an app or the SDK; nothing starts one. | The extension's own motivation: an agent acting when nobody is there. | A way to start (or resume) a session when an event arrives. |
| **An event arrives as a prompt from a plugin.** | Claude Code cannot tell which server an event came from, show it differently from any other plugin's prompt, or apply a rule to it. | A message type for events that carries server, event type and payload, shown the way a tool result is. |
| **A server's verdict is by name only.** `$.mcp.connect` says whether Claude Code uses the server called "deploys"; it does not say which address that is. | Organisations with a managed MCP allow or deny list: the mod cannot check that the entry it read from a file is the server the policy allowed, so where such a policy is visible it connects to nothing. | The server's address with the verdict; or `$.mcp.request`, which makes the question go away. |
| **A mod cannot tell that Claude Code has gained Events itself.** | Standing down by itself: both would show every event. | What Claude Code's own MCP client declares (`extensions`), readable by a mod. |

### What `$.mcp.request` would be

It does not exist. It is the one function this document asks for: a way for a
mod to say "send this MCP method, with these parameters, to this server over
the connection you already have, and give me the answer".

```ts
const result = await $.mcp.request("deploys", "events/poll", {
  name: "deploy.finished",
  arguments: {},
  cursor: lastCursor,
})
```

Claude Code would not need to understand Events for this to work. An MCP
connection carries named messages; Claude Code only ever sends the names it
knows (`tools/call`, `tools/list` and so on), but the connection will carry any
name, and a server that implements Events already answers `events/poll`. Claude
Code would deliver the message with the sign-in it already holds and hand back
the reply. Everything that is Events stays in the mod: which methods to send,
the polling loop, cursors, deduplication, waking the session. The mod does
all of that today, over a second connection of its own.

| Delivery | What it needs from Claude Code |
|---|---|
| Poll | `request` alone. The mod calls `events/poll` on a timer. |
| Webhook | `request` alone, for `events/subscribe` and its refreshes. The server still posts to a public receiver. |
| Push | More: `events/stream` is a long-lived request whose events come back as notifications, so those would have to be passed to the mod. |

Two smaller things would have to come with it: what the server advertised, so
the mod can keep to the rule not to send `events/*` to a server without the
extension; and the `Mcp-Name` routing header on these requests, which a plugin
could no longer add itself.

It would not make Claude Code support Events natively: no built-in view of
events, no policy for them, and still only a running session. It removes the
second connection and makes OAuth servers reachable.

### What being a mod changed, and what it did not

This began as a plugin of the older kind: a stdio MCP server for the tools and
an `experimental` monitor whose printed lines woke a session. It is now a mod,
built on these parts of the mod API (checked against the type definitions of
Claude Code 2.1.330, run on 2.1.329):

- `$.tool.register` for the six tools, in place of an MCP server of its own.
- `$.prompt.submit` to wake a session, in place of a monitor's line. It starts
  a turn once the session is idle, under the plugin's name, and unlike a
  monitor it also works in a session an app or the SDK hosts.
- `$.mcp.connect(server)` for Claude Code's own verdict on a server
  (`unapproved`, `disabled`, `policy`, `auth`, …), on top of the mod's reading
  of the configuration files.
- `prompt.compose` for the catalog of event types, present only while there is
  something to watch.
- `$.process.spawn` for the helper: one process where there were two, and none
  when there is nothing to watch.

What it did not change is the part that matters most. `$.mcp.call(server, tool,
args)` calls a tool "with the engine's own connection and credentials". It
sends `tools/call` and nothing else, so `events/list`, `events/poll`,
`events/stream` and `events/subscribe` cannot go through it. The mod still
needs a connection of its own for Events, and servers behind interactive OAuth
are still out of reach.

So the ask is small and specific: next to `$.mcp.call`, a `$.mcp.request` for
methods that are not tools, under the same grant.

On OAuth: the mod could run its own sign-in, and deliberately does not.
[`sign-in.md`](sign-in.md) compares the options and says why.

In order of what they unlock: `$.mcp.request` with notifications and
capabilities removes the second connection, the helper process and the runtime
it needs, and makes OAuth servers work; a hosted receiver makes webhook-only
servers work with nothing to deploy; a way to start a session makes events
useful when nobody is at the keyboard.

## 3. Servers that offer Events today

What a search of vendor documentation and public source found on 22 November
2026. "Works" means with this mod as it is. Apart from Mastra and
Cloudflare, these are from the vendors' own documents and were not connected
to.

| Server | Delivery | Advertised | Credentials | With this mod |
|---|---|---|---|---|
| Servers built on Mastra's `@mastra/mcp` | push, poll, webhook | The extension, on 2026-07-28 | Whatever the server chooses | **Works** (tested; the demo server is one). |
| Cloudflare's API server (`mcp.cloudflare.com`) | webhook only | Top-level `events` only | OAuth, or an API token in a header | **Listed and subscribed to by default**, as a server of the earlier form (`MCP_EVENTS_PRE_STANDARD=off` leaves it alone). It needs an API token in a header, and a relay, since it delivers by webhook only. Delivery of an event from the hosted server has not been observed end to end. See the note below. |
| Appwrite (`mcp.appwrite.io`) | push, webhook | Both forms | OAuth only | No: OAuth. |
| Bird (`mcp.bird.com`) | webhook only | Not stated | OAuth only | No: OAuth. |
| The SEP author's demo server (`metronome-mcp.fly.dev`) | push, poll, webhook | The extension, on 2026-07-28 | OAuth only | No: OAuth. |
| Edge Delta | poll, webhook | The extension | A token in a header | Should work; not tried. |
| Hookdeck's open-source bridge (GitHub, Stripe, Slack and other webhooks as MCP events) | poll, webhook | Both forms | A bearer secret | Should work; not tried. Needs a Hookdeck account. |
| GitHub, Linear, Notion, Sentry, Stripe, Atlassian, Slack and other large hosted servers | | | | No Events support found. |

Cloudflare's server implements the design sketch that came before the SEP, as
its own documentation says, and the difference is more than where it declares
the capability. From its source (`src/events/`, last changed 28 October 2026):
the error codes are the sketch's numbers (`-32011`, `-32012`, `-32015`, where
the SEP has `-32023`, `-32024`, `-32027`); `webhook-id` is set to the `eventId`,
which the SEP says it must not be derived from; and it sends no `gap` or
`terminated` envelopes. The rest matches the SEP: the client's `whsec_` secret,
the `v1` signature, `X-MCP-Subscription-Id`, the verification challenge,
`refreshBefore`, `https`-only callbacks. None of the differences would stop
this mod's verification. The mod reads the sketch's error numbers as the
SEP's.

Two things stand out. Most hosted servers that have Events need OAuth, which
is the one thing a mod cannot use. And the best-known one, Cloudflare's,
still speaks the form that came before the standard, because that is what
ChatGPT reads; ChatGPT consumes webhook delivery only.
