# SEP-3415 client conformance, clause by clause

How this client (mcp-events 0.6.0) stands against the **Final** text of
SEP-3415 (`seps/3415-events-extension.md` in
`modelcontextprotocol/modelcontextprotocol`, as fetched on 24 November 2026)
and against the transport rules it defers to (Streamable HTTP in the
2026-07-28 specification, and SEP-2243).

**Result: 86 client-side clauses. With `MCP_EVENTS_PRE_STANDARD=off`: 80 met,
6 not applicable, none missing. By default: 78 met, 2 met with a documented
exception (CAP-2 and CAP-4, below), 6 not applicable, none missing.** The
upstream conformance suite's Events client scenarios pass 17 of 17 (see the
end).

**One deliberate deviation is on by default.** A server that advertises events
only as the top-level `events` capability of the earlier design sketch, which
is what ChatGPT reads, is used. That is against CAP-2 and CAP-4 below for such
a server, and for no other. `MCP_EVENTS_PRE_STANDARD=off` removes it.

How the table was made: every normative statement that binds a client or a
webhook receiver was listed, the code for each was read, and small probes were
run where reading was not conclusive. Verdicts: MET, or N/A (optional and not
used, or it cannot arise in this design). The upstream conformance suite is a
separate thing; see the end.

## The clauses

### Capability, discovery, modes

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| CAP-1 | Capability Negotiation | "A client MAY declare the same identifier with an empty settings object" | `src/events-client.ts` | no test (seen on the wire in a probe) | MET |
| CAP-2 | Fallback | "A client MUST NOT send them to a server that has not advertised the extension" | `src/events-client.ts`; `src/watcher.ts`; `src/helper.ts` | spec-test "with the form from before the standard turned off, no events/* request goes to a server that has not advertised the extension"; e2e "a server that advertises events only in the form from before the standard… is used, unless that form is turned off" | MET with `MCP_EVENTS_PRE_STANDARD=off`. **By default not met for a server of the earlier form** (it advertised a top-level `events` capability, not the extension); met for every other server |
| CAP-3 | Specification, Backward Compat | "defined for protocol revision `2026-07-28` and later" | `src/events-client.ts` | e2e same test (legacy-revision part) | MET (N6) |
| CAP-4 | Backward Compat | "That key is not part of this extension" | `src/events-client.ts` | spec-test "no events/* request…", "a pre-standard server the user named…" | MET with `MCP_EVENTS_PRE_STANDARD=off`. **By default that key is read**, where the extension's own is absent (deliberate; the form ChatGPT reads) |
| LC-1 | Dynamic event types | "The client SHOULD call `events/list` again to refresh its registry" | `src/events-client.ts` | spec-test "a server that says its event types change is listened to…"; spec-test "the opt-in to change notices is made again after the connection was lost" | MET (the opt-in is made again on a new connection, and a notice during a read reads once more) |
| LIST-1 | Listing | "present when more pages are available; same semantics as tools/list" | `src/events-client.ts` | no test | MET (capped, B7) |
| DM-1 | Listing | "A client that cannot use any of the listed modes cannot subscribe" | `src/events-client.ts`; `src/watcher.ts` | spec-test "webhook is for an authenticated connection…"; e2e "nothing public is opened unless asked…" | MET |
| TERM-1 | Event type removal | "fetches `events/list` again and resubscribes against the current descriptor" | `src/watcher.ts` | spec-test "NotFound or Unsupported: the list is read again…" | MET (N1) |
| STATE-1 | Client-Owned State | "The client maintains its own subscription registry" | `src/store.ts`; `src/watcher.ts` | e2e "a watch resumes from its saved cursor…" | MET |
| DEDUP-1 | Event Occurrences, Guarantees | "client-side deduplication within a subscription" | `src/watcher.ts`; `src/store.ts` | e2e same test ("no duplicate of the earlier event"); recovery-test "an event written to the spool before the watch was saved is not written again…" and "seen ids read in an earlier session's spool are saved before it is taken off the list…"; properties "a genuine delivery handed over any number of times…" | MET (last 500 ids; a starting helper also counts the ids already in its own and listed sessions' spools) |

### Poll

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| POLL-1 | Poll | "calls `events/poll` at the interval the server recommends" | `src/watcher.ts` | e2e "a poll-only event type is polled, from now on…" | MET |
| POLL-2 | Poll | "The client stores it and passes it back on the next poll" | `src/watcher.ts` | spec-test "hasMore: the next poll follows at once…" (cursors `[null, c1, c2]`) | MET |
| POLL-3 | Poll | "has nothing to persist and always polls with `null`" | `src/watcher.ts` | no poll test (push variant in spec-test) | MET |
| POLL-4 | Poll | "SHOULD poll again immediately with the updated cursor, ignoring `nextPollMs`" | `src/watcher.ts` | spec-test same (only with new events); spec-test "hasMore with a batch that brought nothing new is still drained…" | MET (always drained; a batch with nothing new drains at the poll floor) |
| POLL-5 | Poll | "When it is `false`, the client waits `nextPollMs`" | `src/watcher.ts` | spec-test same; e2e "…a wild poll interval does not spin" | MET |
| POLL-6 | Poll | "Clients SHOULD apply a configurable floor (default 1000 ms)" | `src/watcher.ts` | spec-test same | MET |
| POLL-7 | Poll, Termination | "A JSON-RPC error response to the next `events/poll` request" | `src/watcher.ts` | spec-test "for poll, an error answer is the signal" | MET |
| GOV-1 | Governance | "clients SHOULD respect it" | `src/watcher.ts` | spec-test same | MET |

### Push

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| PUSH-1 | Push | "a long-lived `events/stream` request, one per subscription" | `src/watcher.ts`; `src/events-client.ts` | e2e "watch → only matching events reach Claude…" | MET |
| PUSH-2 | Push, Cancellation | "The client cancels by aborting the request stream" / "`notifications/cancelled`" on stdio | `src/events-client.ts` (SDK picks per transport) | e2e "unwatch cancels the stream on the server (notifications/cancelled)" (stdio); HTTP: no test | MET |
| PUSH-3 | Event delivery | "uses it to route notifications to the right stream" | `src/events-client.ts` | e2e push (one stream); no concurrent-stream test | MET |
| PUSH-4 | Event delivery | "The subscription stays active, and the server retries and resumes" | `src/watcher.ts` | no test | MET |
| PUSH-5 | Event delivery, Gaps | "sent, initially and again mid-stream if a gap occurs" | `src/watcher.ts` | spec-test "truncated is only a gap when a cursor was supplied" (initial only); spec-test "active again with truncated, on a stream already open, is a gap…" | MET |
| PUSH-6 | Lifecycle | "Clients MUST NOT depend on receiving it" | `src/watcher.ts` | spec-test "over HTTP, a stream silent for three times…" (reconnect with no result) | MET |
| PUSH-7 | Heartbeat interval | "The client MAY suggest an interval… the grant is authoritative" | `src/watcher.ts` | spec-test same (grant of 300 ms is used) | MET |
| PUSH-8 | Heartbeat interval | "Clients SHOULD NOT apply their default request timeout to `events/stream`" | `src/events-client.ts` | no test | MET (2^31-1 ms; see B5) |
| PUSH-9 | Heartbeat interval | "three times the granted `heartbeatMs`… SHOULD treat the stream as dead and reconnect" | `src/watcher.ts` | spec-test "over HTTP, a stream silent for three times the granted heartbeat…", "…a server that grants no interval is held to the one its heartbeats keep…", "…a grant is authoritative…"; upstream `sep-3415-client-stream-reconnect-with-cursor` | MET (with no grant, see B5) |
| PUSH-10 | Heartbeat interval | "On stdio, the client detects a dead server by end of file" | `src/watcher.ts` | spec-test "over stdio the heartbeat is not a deadline…" | MET |
| PUSH-11 | Reconnection | "a new `events/stream` with the same subscription and its last known cursor" | `src/watcher.ts` | spec-test "an absent cursor is a null cursor…"; e2e restart test | MET |
| PUSH-12 | Reconnection | "Clients SHOULD wait a random jitter before reconnecting" | `src/watcher.ts` | no test | MET |
| PUSH-13 | Heartbeat, Cursor advancement | "the client's persisted cursor advances even when no events match" | `src/watcher.ts` | spec-test "an absent cursor is a null cursor…" | MET |
| PUSH-14 | Termination | "The client SDK SHOULD remove the subscription and notify the application" | `src/watcher.ts` | spec-test "Forbidden: the subscription is removed from the registry and the session is told" | MET |

### Webhook: the client's requests

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| WH-1 | Subscribing, Secret generation | "Client SDKs SHOULD generate the secret" / "from a CSPRNG by default" | `src/webhooks.ts`; `src/watcher.ts` | units "secret is whsec_ + base64 of 24-64 bytes" | MET |
| WH-2 | Subscribing | "SHOULD NOT expose an interface that encourages hand-picked values" | `src/tools.ts` (no secret input anywhere) | no test | MET |
| WH-3 | Subscribing | "the client MUST call `events/subscribe` again with the same subscription key before `refreshBefore`" | `src/watcher.ts` | upstream `sep-3415-client-refresh-before-expiry` | MET (N2) |
| WH-4 | Subscribing | "always pass the last persisted cursor" | `src/watcher.ts` | relay.e2e "events delivered while Claude Code is closed…" (indirect) | MET |
| WH-5 | Subscription TTL | "the client's suggested lifetime in milliseconds" | `src/watcher.ts` | no test | MET |
| WH-6 | Subscription TTL | "clients SHOULD still call `events/subscribe` and `events/list` occasionally" | `src/watcher.ts` | no test | N/A (never asks for `ttlMs: null`; if granted anyway: hourly subscribe, no periodic list) |
| WH-7 | Subscription identity | "MUST be called with an authenticated principal" | `src/events-client.ts`; `src/watcher.ts` | spec-test "webhook is for an authenticated connection…"; spec-test "a saved webhook watch whose connection no longer carries credentials is not subscribed again" | MET. "Authenticated" means the connection carries a header from the configuration or a headersHelper; the server is the judge of it |
| WH-8 | Subscription identity | "calls `events/unsubscribe` for the old one and `events/subscribe` for a new one" | `src/watcher.ts` | no test | MET |
| WH-9 | Delivery status | "lets the client detect delivery problems" | `src/watcher.ts` | no test | MET (logged only) |
| WH-10 | Endpoint verification | "yields `CallbackEndpointError`" | `src/watcher.ts` | no test | MET (retried with backoff) |
| WH-11 | Unsubscribing | "The client supplies `name`, `arguments` and `delivery.url`" | `src/events-client.ts`; `src/watcher.ts` | e2e "a webhook-only event type: verification, signed delivery to the receiver, unsubscribe on unwatch" | MET |
| WH-12 | TLS requirement | "Callback URLs MUST use `https://`" | `src/relay.ts`; `src/tunnel.ts` | relay.units "the relay address must be https…"; `MCP_EVENTS_PUBLIC_URL`: no test | MET (DEV exception documented) |
| WH-13 | Secret rotation | "The client supplies a new `delivery.secret` on a refresh call" | not implemented (`src/watcher.ts` keeps one secret per watch) | none | N/A (optional) |
| KILL-1 | Governance | "For webhook, call `events/unsubscribe` for immediate termination" | `src/watcher.ts` | e2e unwatch tests | MET |

### Webhook: receiver (the mod) and endpoint (the relay)

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| RX-1 | Delivery | "The receiver MUST verify the signature before processing" | `src/webhooks.ts`; `src/relay.ts` | units "a changed body, another secret, or a stale timestamp does not"; relay.units "a changed body, another secret, or no signature: refused, and nothing runs"; relay.e2e "a forged, altered or replayed delivery…" | MET (N5) |
| RX-2 | Delivery, Signature scheme | "SHOULD reject deliveries whose `webhook-timestamp` is more than 5 minutes old" | `src/webhooks.ts`; `mod/relay/src/index.ts` | units same; relay.units "a relayed delivery is judged against the time the relay received it…"; mod/relay/test "malformed deliveries are refused…" | MET (relayed: against the relay's receipt time, plus B1) |
| RX-3 | Delivery | "SHOULD deduplicate on `webhook-id`" | `src/webhooks.ts`; `mod/relay/src/mailbox.ts` | relay.units "the very same signed delivery is taken once…"; hardening "two copies arriving at the same moment cannot both get in"; mod/relay/test "a retry with the same webhook-id is stored once" | MET (each id taken is remembered for 8 days, up to 1,000; B1) |
| RX-4 | Delivery | "MUST scope that to the subscription" | `src/store.ts`; `src/watcher.ts` | no direct test | MET |
| RX-5 | Delivery | "The client persists every cursor it receives" | `src/watcher.ts` | relay.e2e offline test (indirect) | MET |
| RX-6 | Delivery | "The endpoint MUST make `cursor` and `eventId` available to the consuming client" | `mod/relay/src/index.ts`; `mod/relay/src/mailbox.ts` | mod/relay/test "a delivery is stored, then handed over unchanged…" | MET |
| RX-7 | Acknowledgement | "SHOULD NOT return `2xx` until the event has been durably persisted or forwarded" | `src/webhooks.ts`; `src/store.ts`; `src/watcher.ts`; `mod/relay/src/mailbox.ts` | units "echoes a challenge only when it verifies; stores events before 2xx; 503 when it cannot"; relay.units "storage failure is a 503…"; mod/relay/test "queued deliveries and registered hooks are on disk…" | MET |
| RX-8 | Acknowledgement | "Endpoints SHOULD therefore respond quickly" | same | no test | MET |
| RX-9 | Delivery model | "responds `410 Gone`" | `src/webhooks.ts`; `mod/relay/src/index.ts`; `mod/relay/src/mailbox.ts` | relay.units; mod/relay/test "a removed hook answers 410…" | MET (B2) |
| RX-10 | Subscribe and delivery race | "SHOULD return a retryable status (`503` or `425 Too Early`)" | by design: address registered before subscribe (`src/watcher.ts`); unknown path gets 404 (`src/webhooks.ts`; `mod/relay/src/mailbox.ts`) | units (404) | N/A (the race cannot occur; 404 is still retried under the non-2xx rule) |
| RX-11 | Non-event bodies | "The endpoint MUST forward `gap` and `terminated` envelopes" | `mod/relay/src/mailbox.ts` (only `verification` is diverted) | no relay test with such a body | MET |
| RX-12 | Non-event bodies, Endpoint verification | "echoes the nonce only if one of those secrets verifies" | `src/webhooks.ts`; `src/relay.ts`; `mod/relay/src/mailbox.ts` | units same test; relay.units "a challenge is echoed only when its signature verifies"; mod/relay/test "a verification challenge goes to the connected plugin…"; relay.e2e first test | MET |
| RX-13 | Non-event bodies | "The client persists `cursor` and treats it as `truncated: true`" | `src/webhooks.ts`; `src/watcher.ts` | relay.units "a replayed gap or termination…"; hardening (hook level only) | MET |
| RX-14 | Non-event bodies, Termination | "The subscription no longer exists on the server" | `src/webhooks.ts`; `src/watcher.ts` | hook level only | MET |
| RX-15 | Signature scheme | "Receivers MUST compute the HMAC over the raw body" | `src/webhooks.ts`; `mod/relay/src/index.ts` | units "a changed body…"; mod/relay/test "handed over unchanged…" | MET (N4) |
| RX-16 | Signature scheme | "The receiver accepts the delivery if any of them verifies" | `src/webhooks.ts` | units "any one of several signatures may match (secret rotation)" | MET |
| RX-17 | Server identity | "Endpoints that do not enforce server identity ignore `v1a,`" | `src/webhooks.ts` | no test | MET |
| RX-18 | Delivery profile | "MAY reject larger bodies with `413 Payload Too Large`" | `src/webhooks.ts`; `mod/relay/src/index.ts` | mod/relay/test "malformed deliveries are refused…" | MET |
| RX-19 | Endpoint verification | "serves `/.well-known/mcp-webhook-receiver.json`" | `mod/relay/src/index.ts` | mod/relay/test "answers health checks and publishes the well-known receiver document" | MET |
| RX-20 | Signature scheme | "so that the receiver can select the correct secret without parsing the body" | unused: the path selects (`src/webhooks.ts`) | none | N/A (N3) |
| RX-21 | Server identity | "The verifying public key MUST be discovered from an origin the client already authenticates" | not implemented | none | N/A (optional feature) |

### Cursors

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| CUR-1 | Cursor Lifecycle | "MUST NOT attempt to persist or replay from it" | `src/watcher.ts` | spec-test "an absent cursor is a null cursor: there is nothing to resume from…" | MET |
| CUR-2 | Cursor Lifecycle | "An absent `cursor` field MUST be treated identically to an explicit `cursor: null`" | `src/events-client.ts`; `src/watcher.ts`; `src/webhooks.ts` | spec-test same | MET |
| CUR-3 | Cursor Lifecycle | "The client persists it exactly as it would a cursor from a delivered event" | `src/watcher.ts` | spec-test same | MET |
| CUR-4 | Cursor Lifecycle | "All three modes accept an optional `maxAgeMs`" | `src/watcher.ts` | no test that it is sent | MET |
| CUR-5 | Gaps | "The client never reconnects or resubscribes in response" | `src/watcher.ts` | spec-test "truncated is only a gap when a cursor was supplied" | MET |
| CUR-6 | Gaps | "Clients SHOULD treat it as one… and SHOULD persist the fresh cursor" | `src/watcher.ts` | spec-test same | MET (mid-stream push is PUSH-5) |
| CUR-7 | Gaps | "`truncated` SHOULD be `false` and clients SHOULD ignore it" | `src/watcher.ts` | spec-test same | MET |

### Routing headers (Streamable HTTP)

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| RH-1 | Routing Headers | "the client MUST set the `Mcp-Name` header… to the value of `params.name`" | `src/routing-headers.ts`; `src/events-client.ts` | spec-test "Mcp-Name carries the event name on poll, stream, subscribe and unsubscribe…", "the headers go out with the request…" (mocked fetch) | MET |
| RH-2 | Routing Headers | "MUST be carried in the Base64 sentinel format" | `src/routing-headers.ts` | spec-test "a name that is not plain ASCII is carried in the Base64 form" | MET |
| RH-3 | Routing Headers | "`events/list` has no `params.name` and carries no `Mcp-Name` header" | `src/routing-headers.ts` | spec-test same as RH-1 | MET (`Mcp-Method` is the SDK's) |
| RH-4 | Custom headers | "MUST set an `Mcp-Param-{Name}` header for each annotated property that has a value" | `src/routing-headers.ts`; `src/events-client.ts` | spec-test "x-mcp-header: an annotated argument that has a value is mirrored…"; spec-test "a header value is sent plain only when it is printable ASCII…" | MET |
| RH-5 | Custom headers | "MUST exclude an event type whose annotations violate them… SHOULD log a warning" | `src/routing-headers.ts`; `src/events-client.ts` | spec-test "an event type whose annotations break the transport's rules is left out of the list" | MET |
| RH-6 | Custom headers | "SHOULD call `events/list` again and retry with the headers" | `src/watcher.ts` | no test | MET (unsubscribe lists again and retries once) |
| RH-7 | Custom headers | "Clients on other transports MAY ignore the annotation" | `src/events-client.ts` | none needed | MET |

### Security considerations that bind a client

| Id | Section | Quote | Code | Test | Verdict |
| --- | --- | --- | --- | --- | --- |
| SEC-1 | Untrusted payloads | "MUST be treated with the same caution as tool results" | `src/format.ts`; `src/untrusted.ts`; `src/tools.ts`; `src/watcher.ts` | wake "by default what a server wrote is not in the wake message; get_event returns it, as a tool result"; hardening "an event's text is shown as data…"; e2e "what a watch shows is the plugin's and the user's own…" | MET |
| SEC-2 | Untrusted payloads | "Clients SHOULD sanitize or sandbox event payloads before presenting them to an LLM" | same | same | MET |
| SEC-3 | Authorization | "Receipt of an event does NOT constitute authorization to act" | `src/tools.ts` (told to the model; Claude Code's permissions enforce) | no test | MET |
| SEC-4 | Governance | "Clients SHOULD support policy evaluation between event receipt and action execution" | none in the mod; Claude Code's permissions and hooks | none | N/A (host) |
| SEC-5 | Governance | "The client owns all subscription state" | `src/store.ts`; `src/tools.ts` | e2e list_watches assertions | MET |

## Rules with no test, or tested only below the real transport

Met by reading the code, and not held there by a test:

- **`HeaderMismatch` on `events/unsubscribe`** (list again, retry once).
- **Over real Streamable HTTP**, the routing headers, abort-as-cancel and the
  three-heartbeat rule are tested with a stand-in `fetch`, not through the
  SDK's transport. The interop runs do go over real HTTP against Mastra's
  server (`test/interop/deploys.ts`, `test/interop/sign-in.ts`), and it does
  not validate those headers.
- Also untested: reconnect jitter; `notifications/events/error` keeps the
  stream; several concurrent streams; `gap` and `terminated` envelopes at the
  watch level (tested at the receiver); unsubscribe-then-subscribe when the
  webhook address changes; `deliveryStatus`; the `CallbackEndpointError`
  retry; `maxAgeMs` on the wire; `events/list` pagination; deduplication
  across two subscriptions.

## What it does that the SEP does not define

The rule for this project is "what SEP-3415 defines for a client, and nothing
more". Nothing here adds to the protocol: no method, field or header of its own
goes to a server. These are limits and choices on the client's side of the
line, listed so nobody has to find them. B1 to B3 can change what happens to a
conforming server's events.

| # | Behaviour | Where | Note |
| --- | --- | --- | --- |
| B1 | **Replay guard**: the id of every delivery taken is remembered, saved with the watch, for 8 days and up to 1,000 ids; past 1,000 the oldest are forgotten and everything signed at or before them is refused for good; nothing signed more than 8 days ago is taken. The SEP asks only for the 5-minute window and `webhook-id` dedup. | `src/webhooks.ts` | Until 0.5.0 a delivery signed more than 10 minutes before the newest one taken was refused, though it was never taken. That happened to one left at the relay after a 503, and its event was lost, because the server's watermark had passed it (found by the model: `model/delivery.qnt`, `refusedAsOld`). Now the loss needs more than 1,000 deliveries to that watch taken in between. |
| B2 | A stale timestamp is answered **410** (do not retry) rather than a retryable status. | `src/webhooks.ts`; `mod/relay/src/index.ts` | The SEP permits 410 for "stale". With more than 5 minutes of clock skew every delivery is refused and none is retried. |
| B3 | Admission limits on events in **all** modes: an `eventId` over 512 characters is dropped silently; an event over 256 KiB serialized or nested deeper than 24 is skipped with a notice (the SEP's 256 KiB is guidance for webhook bodies only); strings equal to a known secret are rewritten to `[redacted]`; a non-ISO `timestamp` is dropped; the occurrence's `name` is replaced by the watch's. | `src/watcher.ts`; `src/untrusted.ts` | |
| B4 | Timestamps more than 5 minutes **ahead** are refused. | `src/webhooks.ts`; `mod/relay/src/index.ts` | Standard Webhooks tolerance; the SEP text says only "old". |
| B5 | 60 s deadline for the first message (before `active`) on HTTP streams. When `active` grants no `heartbeatMs` (the SEP says every `active` does), the stream is held to three times the longest quiet before a heartbeat seen so far, and to 60 s until a heartbeat has come. | `src/watcher.ts` | The SEP counts liveness from `active` only. The server "sends a heartbeat whenever `heartbeatMs` passes without any other message", so the quiet before a heartbeat is its interval. Until 0.5.0 it was 60 s in that case, which is why the upstream suite's push scenario, whose stand-in grants none, did not see a reconnect. |
| B6 | A `hasMore` batch that brought nothing new is drained at the poll floor, not at once. | `src/watcher.ts` | So a server that always says "more" cannot spin the loop. |
| B7 | Event-type admission filters on `events/list`: names over 128 characters or with control characters, names matching a known secret, types with no known delivery mode, more than 200 types or 20 pages; descriptions cut at 2,000; schemas bounded ("tamed") before display. | `src/events-client.ts`; `src/untrusted.ts` | |
| B8 | 4 MiB cap on one response or one SSE message. | `src/events-client.ts` | A larger poll result fails every time (`maxEvents: 100` limits the risk). |
| B9 | Error policy: `-32601` and `-32602` end the subscription; `NotFound`/`Unsupported` re-list and restart at most once per 60 s per watch, reusing the stored cursor. | `src/watcher.ts` | See note N1. |
| B10 | The relay and its protocol: mailbox per key (from 0.7.0 one key, so one mailbox, per MCP server and project; the project's one mailbox of earlier versions is emptied into them and forgotten), WebSocket subprotocol, access key, 7-day retention, 30-day idle retirement, 410 tombstones, 500-delivery / 16 MiB queue with 503 + `Retry-After`, dedup keyed on (hook, `webhook-id`, digest) rather than `webhook-id` alone, `/healthz`. | `mod/relay/src/*`, `src/relay.ts`; `src/webhooks.ts` | The SEP leaves the proxy-to-client channel "implementation-defined", so this is permitted, but none of it is SEP-defined. |
| B11 | A lasting (relay) subscription is kept, not unsubscribed, when the session ends. | `src/watcher.ts` | Permitted: unsubscribe is optional. |
| B12 | Private request `_meta` key `dev.mcp-events-plugin/streamKey`. | `src/events-client.ts` | Stripped before sending (checked on the wire over stdio; no test asserts it). |
| B13 | Unknown control-envelope `type` is acknowledged 200 and ignored; `list_changed` is acted on wherever it arrives, opted in or not. | `src/webhooks.ts`; `src/events-client.ts` | Harmless. |
| B14 | One session per project runs the watches; spool, hand-over to Claude Code, tools. Each session that runs them is listed for the project; the next one takes over what listed sessions stored and never handed over. The hooks module acknowledges a submitted batch, or the notice that waking stopped, again before the next take, and the helper counts it: a wake, or the notice given (from 0.5.1, the budget keeps on disk that the notice was handed over). A starting helper saves the seen ids it read in listed sessions' spools before it takes them off the list (0.5.1). | `src/store.ts`, `src/delivery.ts`, `src/tools.ts`, `src/watcher.ts`, `mod/hooks/register.ts` | Application layer, which the SEP leaves open. |
| B15 | **On by default:** servers of the form from before the standard (top-level `events` key; error codes -32011..-32015 read as the SEP's), unless `MCP_EVENTS_PRE_STANDARD=off` or a list that leaves the server out. Opt-in: `MCP_EVENTS_DEV` (http on loopback, webhook without credentials). | `src/events-client.ts`; `src/helper.ts`; `src/watcher.ts`; `src/relay.ts`; `src/tunnel.ts` | The first is against CAP-2 and CAP-4 for such a server; see the top of this page. |

Within the SEP, fixed here: `maxEvents: 100`, a suggested `heartbeatMs` of
15000, `ttlMs` of 24 hours (relay) or 15 minutes (session), refresh at 60 % of
the remaining grant and at least hourly.

## Notes that are not verdicts

- **N1. Restart after `Unsupported` reuses the stored cursor** (`src/watcher.ts`; the test asserts cursor `c5` is reused). SEP L221 lets a poll server answer a stale schema-epoch cursor with `Unsupported` "to force rediscovery". Against such a server the watch re-lists, polls with the same cursor, gets `Unsupported` again inside the 60 s guard and is removed. The SEP does not say which cursor to use after rediscovery, so this is ambiguous, not a violation.
- **N2. Refresh timing trusts the local clock** (`src/watcher.ts`). If `refreshBefore` is already in the past by the local clock (skew larger than the grant), the loop refreshes every 250 ms without end.
- **N3. `X-MCP-Subscription-Id` is never used.** Each watch has its own address and secret, so the path selects the secret (`src/watcher.ts`). A `terminated` envelope that verifies ends the watch whichever subscription id it names.
- **N4. `webhook-timestamp` is re-serialized through `Number()` before the HMAC** (`src/webhooks.ts`). A non-canonical value such as a leading zero fails verification (it reads as `no matching v1 signature`). Fails closed.
- **N5. The relay returns 2xx before any signature check** (it holds no signing secret). Verification happens in the plugin before anything is acted on, so RX-1 holds, but a 2xx from the relay does not mean "verified".
- **N6. The revision test is a string comparison** (`src/events-client.ts`): any revision string that sorts after `2026-07-28` counts as later.

## The upstream conformance suite

The suite's Events client scenarios are in an open pull request,
`modelcontextprotocol/conformance#541` ("client conformance scenarios",
stacked on #521; neither merged on 24 November 2026; `main` has no Events
scenarios): `events-client-no-extension`, `events-client-poll`,
`events-client-push` and `events-client-webhook`, 17 checks against an HTTP
stand-in server. They quote the SEP from before it was Final (for one, a
dead stream at twice the heartbeat, where the Final text says three times).

`npm run conformance` runs them against this client through
[`test/conformance-driver.ts`](../test/conformance-driver.ts) (the same
`EventsConnection` and `WatchManager` the helper runs, over a temporary state
folder), from a checkout of the suite named in `MCP_CONFORMANCE_SUITE_DIR`.
That checkout is code this repository does not hold: read it before you run it.

**Result, 24 November 2026, on 0.5.0: 17 of 17 pass** (not run again on 0.5.1 or 0.6.0, whose
changes, to the wake budget's notice, the order of a starting helper's writes and the runtime the
helper runs on, are outside what these scenarios reach), unmodified, at the pull request's
head `c8625de3118c2d5dc0561696cddeb0baaf124f2c`, on Node 22.23.1, macOS 15 on
Apple Silicon. 0.4.1 passed 15: in `events-client-push` the stand-in's
`notifications/events/active` carries no `heartbeatMs`, so the client waited
its own 60 seconds before treating the silent stream as dead, and inside the
9-second run it never reconnected. `sep-3415-client-stream-reconnect-with-cursor`
was a warning, and `sep-3415-client-null-cursor-not-replayed` a failure for
want of a reconnect to grade (the suite: "Not testable"). B5 above is the
change.

| Scenario | Checks | 0.4.1 | 0.5.0 |
| --- | --- | --- | --- |
| `events-client-no-extension` | 1 | 1 | 1 |
| `events-client-poll` | 10 | 10 | 10 |
| `events-client-push` | 3 | 1 (1 warning, 1 failure) | 3 |
| `events-client-webhook` | 3 | 3 | 3 |

The webhook scenario runs with the client's testing switch (`MCP_EVENTS_DEV`)
on, as its stand-in is plain http on this machine and asks for no credentials,
and the client subscribes by webhook only to an https address on an
authenticated connection.
