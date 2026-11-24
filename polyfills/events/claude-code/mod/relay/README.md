# mcp-events relay

A public address for a local MCP client's webhooks.

An MCP server that delivers events by webhook (SEP-3415) needs an https URL to
POST to. Claude Code on your machine has none. This Cloudflare Worker is that address:
it accepts each delivery, stores it, and hands it to the plugin over a
WebSocket, at once while Claude Code is open and on the next start otherwise.

It is tested in the local Workers runtime (`npm test`) and has been run
deployed on Cloudflare, with the mod collecting from it.

## Set up

You need Node 22.18 or newer and a Cloudflare account.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npm run setup
```

`setup` deploys the Worker (and its Durable Object) to your account, makes a
random access key, stores it as the Worker's `ACCESS_KEY` secret, writes
`~/.mcp-events/relay.json` (readable only by you) for the plugin, and checks
that the deployed relay refuses a connection without the key and accepts one
with it. It never prints the key. Then restart Claude Code.

A new access key: `npm run setup -- --rotate`. To remove everything:
`npx wrangler delete`, then delete `~/.mcp-events/relay.json`.

## A relay anyone may use

`wrangler.public.jsonc` deploys the same Worker with no access key, for people
who cannot deploy their own:

```bash
npm run deploy:public
```

That is `wrangler deploy -c wrangler.public.jsonc`, with `VERSION` set to the
commit, which `GET /` then shows.

Deploy it on a Workers Paid account that holds nothing else, with billing
notifications on. On Workers Free, an account's daily quotas (requests, and
Durable Object rows written) are shared by every Worker on it, and anyone can
spend them just by sending requests here: a request the relay refuses still
counts as one. Then the relay, and every other Worker on the account, stops
until the quotas reset at 00:00 UTC. Nothing in the relay can prevent that. On
Paid the same traffic is billed instead, and Cloudflare offers billing
notifications, not a spending cap.

The mod's author runs one at
`https://mcp-events-public-relay.idosalomon.workers.dev`; the mod uses it only
when its user sets `MCP_EVENTS_RELAY=public`. Whoever deploys such a relay can
read the event payloads of everyone who uses it, which is why it is opt-in and
why the mod says so each time. What keeps it from being more than that:

- A mailbox opens only with its own key, so one user cannot read or register
  addresses in another's mailbox.
- It holds no signing secret, so it cannot create or alter an event.
- A delivery is deleted once collected, and after 23 hours if it never is
  (the clear-out runs hourly, so within about a day; this depends on
  Cloudflare running the mailbox's alarm).
- One mailbox holds at most 100 deliveries (4 MiB, their headers included)
  for at most 16 webhook addresses. An address its owner has not asked for or collected from
  in a week is retired, whatever was posted to it meanwhile. A mailbox with no
  address and nobody connected gives its storage back.
- Rate limits: about 120 deliveries a minute to one webhook address, 300
  delivery requests a minute from one sender, 30 connections a minute from
  one sender. A sender is an IPv4 address, or an IPv6 /64 (one home, office
  or server can send from any address in its /64). Past any of them the
  answer is `429` with `Retry-After`. Cloudflare's rate limiter is
  approximate and counts per location. An address's allowance is spent only
  by a well-formed delivery to an address that exists, so junk sent
  elsewhere in a mailbox does not use it up.
- MCP servers hosted on Cloudflare Workers all reach the relay from one
  address (Cloudflare sets `CF-Connecting-IP` to `2a06:98c0:3600::103` for a
  Worker's request to another Cloudflare site), so their delivery requests are
  counted per mailbox instead, 3,000 a minute to one mailbox. Junk a Worker
  sends to made-up addresses spends only the buckets of the mailboxes it names,
  never another's. Each webhook address's own allowance still applies. This
  comes from Cloudflare's documentation; it was not tested here.
- A request whose limit cannot be checked is refused with `503`
  (`REQUIRE_LIMITS`): with its limits off, an open relay is free storage.
- A connection that sends more than 600 messages in a minute, or a frame over
  256 KiB, is closed. Asking again for an address already asked for on the
  same connection sends nothing again.
- It opens at most 2,000 new mailboxes in an hour, 60 from one sender and
  200 from one network (an IPv6 /48; an IPv4 address is its own network).
  Past any of them, a new mailbox is refused with `429` until the hour is
  over; mailboxes that exist are not affected. One /48 (which tunnel brokers
  hand out free) cannot spend the hour's 2,000 by itself; someone with ten or
  more /48s or many IPv4 addresses still can, and keep new users out for the
  rest of that hour. A mailbox that gave its storage back counts as new when
  its owner returns, and many people behind one address or network (an
  office, a conference, a mobile carrier) share its ceiling. To count per
  sender and network it keeps, for that hour, hashes salted with a value made
  for the hour; they are deleted when the hour is over.
- It holds at most 20,000 mailboxes at once (`MAX_LIVE_MAILBOXES`), so at most
  about 80 GiB in all. Past it, a new mailbox is refused with `503` until
  others give their storage back. The hourly ceilings bound how fast
  mailboxes appear; this bounds how many there are.
- The front page names an abuse contact. A mailbox the operator lists in
  `BLOCKED_MAILBOXES` is refused: its socket and its deliveries get `410`.
- Request logs are off.
- `GET /` says who runs it, that it is open, how long it keeps a delivery,
  where to report abuse, and which build is deployed.
- The plugin has its address written in, so whoever holds that hostname gets
  its users' payloads and mailbox keys (though still no signing secret). If it
  is ever retired, a plugin release without it comes first, and its
  `workers.dev` subdomain is kept, not given up for someone else to claim.

## What it is trusted with

Nothing it could misuse to make an event up.

- **No signing secret.** The plugin makes each subscription's secret and gives
  it only to the MCP server. The relay cannot check or forge a signature. It
  checks what needs no secret (size, encoding, the Standard Webhooks headers,
  the timestamp's freshness), stores the delivery byte for byte, and the plugin
  verifies it on collection.
- **Two keys, received and not stored.** A mailbox's public name is the
  SHA-256 of a key the plugin makes and keeps. Presenting a key whose hash is
  the name in the address is what opens the mailbox, so the relay receives
  that key each time the plugin connects (in a WebSocket header, never in a
  URL) and stores none. The same goes for the relay's access key, where it
  has one, which is a secret of the Worker's. Someone who runs a relay could
  keep a mailbox key they were shown and read that mailbox with it; they
  could read its payloads anyway (next point).
- **It can read payloads.** Webhooks are signed, not encrypted, so whoever runs
  the relay can read the events that pass through it. Run your own.
- **It can delay or drop.** It cannot replay: the plugin refuses a delivery it
  has already taken, or one signed well before those it has taken. It says when
  a delivery arrived, and the plugin's freshness check takes its word, so a
  relay can hold a genuine delivery back and hand it over later as fresh: for
  up to 25 hours on the public relay (its retention and an hour), and up to
  eight days on one of your own.
- **Challenges.** A server's verification challenge is passed to the connected
  plugin, which echoes it only if its signature verifies. Every challenge the
  plugin does not confirm gets the same `503`: refused, unanswered, or with no
  plugin connected. So posting one without the secret does not tell whether
  the plugin is online, except by how long the answer takes. That is this relay's behaviour. A server
  cannot tell it from a relay that echoes challenges itself; such a relay would
  have an address confirmed without the plugin, and still could not forge an
  event.

## Who can use it

- Only a holder of a mailbox's key can read that mailbox. One mailbox cannot
  see another's deliveries (each is its own Durable Object).
- With `ACCESS_KEY` set (what `setup` does), opening any mailbox also needs
  that key. With no `ACCESS_KEY`, the relay refuses every connection unless
  `OPEN_RELAY` is `"1"`, which lets anyone who can reach it open a mailbox and
  store data on your account. Leave it off unless you mean that.
- Anyone who knows a webhook address can POST to it. What they send is stored
  (within the limits below) and then dropped by the plugin, because it does not
  verify. It cannot displace a genuine delivery already stored. It can crowd
  out new ones: all of a mailbox's addresses share its room, and while Claude
  Code is closed nothing collects from it, so enough junk to one address fills
  it, and genuine deliveries to any of them are answered `503` until the
  plugin next connects or the junk reaches the end of its retention time.
  Whether an event sent meanwhile is retried is up to the server. A webhook
  address is known to the MCP server you gave it to. From version 0.7.0 the
  plugin gives each MCP server a mailbox of its own (one key per server and
  project), so a server can crowd out only its own deliveries; until then a
  project's servers shared one mailbox, and one could do this to the others.
  Treat an address as a secret.

## Addresses

| | |
|---|---|
| `POST /hooks/<mailbox>/<hook>` | A delivery from an MCP server. `404` for an address nobody registered, `410` for one that was removed. |
| `GET /mailboxes/<mailbox>/socket` | The plugin's WebSocket (credentials travel as subprotocols). |
| `GET /.well-known/mcp-webhook-receiver.json` | `{"receivers": ["/hooks/"]}`, for servers that verify an endpoint that way. |
| `GET /healthz` | `{"ok": true}` |

The socket's messages are in [`src/protocol.ts`](src/protocol.ts).

## Limits

| | Default | Setting |
|---|---|---|
| Body of one delivery | 256 KiB | |
| Deliveries a mailbox holds | 500 | `MAX_QUEUED` |
| Their total size, headers included | 16 MiB | `MAX_QUEUED_BYTES` |
| Hooks per mailbox | 64 | `MAX_HOOKS` |
| An uncollected delivery is kept | 7 days | `DELIVERY_TTL_S` |
| A hook nobody used is retired after | 30 days | `HOOK_IDLE_TTL_S` |
| A challenge waits for the plugin | 4 s | `ASK_TIMEOUT_MS` |
| Challenges waiting at once | 16 | |
| One frame from the plugin | 256 KiB | |
| Messages one connection sends in a minute | 1,200 | `SOCKET_MESSAGES_PER_MINUTE` |
| New mailboxes opened in an hour, in all, from one sender (IPv4 address or IPv6 /64) and from one network (IPv6 /48) | no ceiling | `NEW_MAILBOXES_PER_HOUR`, `NEW_MAILBOXES_PER_SENDER_PER_HOUR`, `NEW_MAILBOXES_PER_NETWORK_PER_HOUR` |
| Mailboxes held at once | no ceiling | `MAX_LIVE_MAILBOXES` |
| Mailboxes refused | none | `BLOCKED_MAILBOXES` |
| A request whose rate limit cannot be checked | let through | `REQUIRE_LIMITS=1` refuses it |

A full mailbox answers `503` with `Retry-After`, so the server tries again
later. Request logs are off (`observability` in `wrangler.jsonc`): webhook
addresses are capabilities.

A relay behind an access key has no rate limit of its own on POSTs to a known
address beyond those limits (the rate limits of `wrangler.public.jsonc` are
bindings you can copy); Cloudflare's platform protections apply. Whether your plan's limits
suit your event volume is yours to check.

## Develop

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm test` starts the Worker in the local Workers runtime and talks to it over
real HTTP and WebSockets. It covers: who may open a mailbox; storing, handing
over and acknowledging deliveries; holding them while nobody is connected;
retries and look-alike deliveries under one id; passing a challenge to the
plugin; malformed and oversized requests; removed and idle hooks; a replaced
connection losing its say; the challenge cap; a full mailbox; and that what is
stored survives a restart. `test/adversarial-test.ts` attacks it: two tenants,
an outsider, a malicious MCP server and a hostile relay, against the plugin's
real relay client.
