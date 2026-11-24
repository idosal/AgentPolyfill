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
npx wrangler deploy -c wrangler.public.jsonc
```

The mod's author runs one at
`https://mcp-events-public-relay.idosalomon.workers.dev`; the mod uses it only
when its user sets `MCP_EVENTS_RELAY=public`. Whoever deploys such a relay can
read the event payloads of everyone who uses it, which is why it is opt-in and
why the mod says so each time. What keeps it from being more than that:

- A mailbox opens only with its own key, so one user cannot read or register
  addresses in another's mailbox.
- It holds no signing secret, so it cannot create or alter an event.
- A delivery is deleted once collected, and after 23 hours if it never is
  (the clear-out runs hourly, so within a day).
- One mailbox holds at most 100 deliveries (4 MiB) for at most 16 webhook
  addresses; an address that has had no delivery, and no plugin connected
  for it, for a week is retired.
- Rate limits: about 120 deliveries a minute to one mailbox, 1,200 a minute
  from one sender, 60 connections a minute from one address. Past any of
  them the answer is `429` with `Retry-After`. Cloudflare's rate limiter is
  approximate and counts per location.
- Request logs are off.
- `GET /` says who runs it, that it is open, and how long it keeps a delivery.

## What it is trusted with

Nothing it could misuse to make an event up.

- **No signing secret.** The plugin makes each subscription's secret and gives
  it only to the MCP server. The relay cannot check or forge a signature. It
  checks what needs no secret (size, encoding, the Standard Webhooks headers,
  the timestamp's freshness), stores the delivery byte for byte, and the plugin
  verifies it on collection.
- **It does not keep your mailbox key.** A mailbox's public name is the
  SHA-256 of a key the plugin makes and keeps. The plugin presents that key to
  open the mailbox; the relay checks it against the name and does not store
  it.
- **It can read payloads.** Webhooks are signed, not encrypted, so whoever runs
  the relay can read the events that pass through it. Run your own.
- **It can delay or drop.** It cannot replay: the plugin refuses a delivery it
  has already taken, or one signed well before those it has taken.
- **Challenges.** A server's verification challenge is passed to the connected
  plugin, which echoes it only if its signature verifies; with no plugin
  connected the relay answers 503. That is this relay's behaviour. A server
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
  out new ones. Junk counts against the mailbox's rate limit before anything
  is checked, so a steady stream of it gets genuine deliveries answered `429`
  even while the plugin is connected. While Claude Code is closed only expiry
  clears the mailbox, so enough junk fills it, and genuine deliveries are
  answered `503` until the plugin next connects or the junk expires. Whether an event sent meanwhile is retried is up to
  the server. A webhook address is known only to the MCP server you gave it
  to; treat it as a secret.

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
| Their total size | 16 MiB | `MAX_QUEUED_BYTES` |
| Hooks per mailbox | 64 | `MAX_HOOKS` |
| An uncollected delivery is kept | 7 days | `DELIVERY_TTL_S` |
| A hook nobody used is retired after | 30 days | `HOOK_IDLE_TTL_S` |
| A challenge waits for the plugin | 4 s | `ASK_TIMEOUT_MS` |
| Challenges waiting at once | 16 | |

A full mailbox answers `503` with `Retry-After`, so the server tries again
later. Request logs are off (`observability` in `wrangler.jsonc`): webhook
addresses are capabilities.

There is no rate limit of its own on POSTs to a known address beyond those
limits; Cloudflare's platform protections apply. Whether your plan's limits
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
stored survives a restart.
