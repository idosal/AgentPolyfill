# event-feeds

A public MCP server that offers **events**: things an agent can watch, so that it wakes up and acts
when they happen. It implements the server side of the MCP Events extension,
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)
(`io.modelcontextprotocol/events`, protocol revision 2026-07-28), on one Cloudflare Worker.

It is run by Ido Salomon as part of [MCPolyfill](https://github.com/idosal/MCPolyfill), so that anyone
with an Events-capable client can try Events in a minute without running anything. Source:
[`servers/event-feeds`](https://github.com/idosal/MCPolyfill/tree/main/servers/event-feeds).

- Server: `https://event-feeds.idosalomon.workers.dev/mcp`
- Web page: <https://event-feeds.idosalomon.workers.dev/> (what this is, and a demo button)

## Try it

Claude Code does not have Events built in yet. With the `mcp-events` polyfill from MCPolyfill
installed, add the server:

```bash
claude mcp add --transport http feeds https://event-feeds.idosalomon.workers.dev/mcp
```

Then start `claude` and say one of these:

- "Give me a demo button and tell me what I type when I press it."
  Claude makes a private button page, gives you the link, and watches it. Press the button; the idle
  session wakes within a few seconds, reads your message with `read_event_text`, and answers.
- "Tell me when someone comments on the Show HN for MCPolyfill."
- "Watch npm for a new version of wrangler and tell me what changed."

No sign-in. Any other client that speaks MCP Events can use the same URL.

## What you can watch

Every event type is offered by poll delivery (see [Delivery modes](#delivery-modes)). Each one's
arguments are its filter, checked against its `inputSchema`; anything else is refused with
`InvalidParams`.

| Event | Fires when | Arguments | Checked every |
|---|---|---|---|
| `demo.button` | the button on a private page is pressed | `channel` (from the `new_demo_button` tool, or from [/b/new](https://event-feeds.idosalomon.workers.dev/b/new)) | 2 s |
| `hn.comment` | a new comment appears in a Hacker News thread | `story` (item id), optional `author`, `repliesTo` | 30 s |
| `hn.story` | a new story is posted to Hacker News | optional `query` (words in the title), `kind` (`any`, `show_hn`, `ask_hn`), `author` | 60 s |
| `npm.release` | a package's dist-tag (`latest` by default) moves to a new version | `package`, optional `tag` (`next`, `beta`, ... or `*`) | 60 s |
| `github.release` | a public GitHub repository publishes a release or tag | `repo` (`owner/name`) | 2 min |
| `usgs.earthquake` | USGS records an earthquake at or above a magnitude | optional `minMagnitude` (default 2.5), `latitude` + `longitude` + `radiusKm` | 60 s |

One example request for each, as `events/poll` params (the first poll of a subscription has
`cursor: null` and returns no events, only a cursor; later polls send that cursor back):

```jsonc
{ "name": "demo.button",     "arguments": { "channel": "bAbC...30 characters..." }, "cursor": null }
{ "name": "hn.comment",      "arguments": { "story": 50611576 }, "cursor": null }
{ "name": "hn.story",        "arguments": { "query": "rust", "kind": "show_hn" }, "cursor": null }
{ "name": "npm.release",     "arguments": { "package": "@modelcontextprotocol/sdk", "tag": "*" }, "cursor": null }
{ "name": "github.release",  "arguments": { "repo": "oven-sh/bun" }, "cursor": null }
{ "name": "usgs.earthquake", "arguments": { "minMagnitude": 4, "latitude": 35.68, "longitude": 139.69, "radiusKm": 500 }, "cursor": null }
```

And what events look like (entries of `events[]`):

```json
{ "eventId": "press-1", "name": "demo.button", "timestamp": "2026-11-24T00:33:28Z",
  "data": { "press": 1, "hasMessage": true, "pressedAt": "2026-11-24T00:33:28Z" } }
{ "eventId": "50621511", "name": "hn.comment", "timestamp": "2026-11-24T00:07:50Z",
  "data": { "id": "50621511", "url": "https://news.ycombinator.com/item?id=50621511",
            "parentId": "50620599", "storyId": "50611576", "postedAt": "2026-11-24T00:07:50Z" } }
```

Three tools come with it: `new_demo_button` makes a button page and its channel, `find_hn_story`
looks up a story's id by words in its title, and `read_event_text` returns the text behind an event.

## Third-party text stays out of events

Anyone can write a Hacker News comment or title, a release note, or a button message, and every
watcher's agent would read it. So an event's `data` holds only ids, numbers, booleans, timestamps and
links the server builds itself from ids (`https://news.ycombinator.com/item?id=…`,
`https://earthquake.usgs.gov/earthquakes/eventpage/…`, `https://www.npmjs.com/package/…/v/…`,
`https://github.com/<repo>/releases/tag/…`). No titles, comment text, author names, submitted links,
release notes, place names or button messages; `additionalProperties: false` on every
`payloadSchema`, and a test checks every string in every event is a single token.

**Tags and versions are publisher-chosen tokens.** Three values in events are chosen by whoever
publishes the package or the release, and are kept because they are what the event is about: an npm
version and dist-tag (checked against `^[0-9A-Za-z.+-]{1,64}$` and `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
and a GitHub tag (kept only if it matches `^[A-Za-z0-9._@+/-]{1,100}$`). The character sets rule out
spaces and most punctuation, but a publisher can still pick a token such as
`v1.0.0-run-curl.example.sh-now`: treat these as untrusted too. A GitHub release's `eventId` is the feed
entry's id (`tag:github.com,2008:Repository/<number>/<tag>`) only when it is at most 100 characters
and holds such a tag; otherwise it is a hash, and an unusual tag is left out of the event (its link is
then the releases page). The npm package and the GitHub repository are the subscriber's own arguments.

The text is fetched by the agent when it wants it, as a tool result: `read_event_text` takes the
event type and its id (plus `repo` or `channel` where needed) and answers with the text, plain (HTML
and control characters removed), on one line, capped (titles 200 characters, comments and notes
1500, messages 120). That keeps the text small; it does not make it safe. SEP-3415 says event payloads
are untrusted data, to be handled like tool results, and the same holds for this text.

## What this server stores

**Nothing a client sends is kept, except demo-button presses.** A channel keeps its presses (a
number, a time, and the message typed next to the button, at most 120 characters) in its own Durable
Object for one hour, then they are deleted. That is the only write the code makes
(`src/button-do.ts`).

There are no accounts, no request logs (Workers observability and Logpush are off, and the code logs
nothing), and no subscriptions on the server: everything it needs to answer a poll is in the cursor
the client sends back. Two short-lived things exist to protect the server and its sources, and hold
nothing a client wrote:

- Cloudflare's rate-limit counters, keyed by client address (or IPv6 /64), for one minute; and in
  memory, in one small Durable Object per upstream host, this minute's count of fetches from that
  host, in all and per client key.
- Copies of public upstream pages in Cloudflare's edge cache, keyed by their upstream URL (so they
  reflect which public thread, package, repository or feed was asked for): a fresh copy for up to two
  minutes, and the last good copy for up to an hour, used when a fresh read is refused or fails.

## Demo-button channels

A channel id is `b` followed by 30 base64url characters: 9 random bytes from the Workers CSPRNG and the
4-byte time it was made (13 bytes, 18 characters), then the first 9 bytes of
`HMAC-SHA256(CHANNEL_SECRET, those 13 bytes)` (12 characters). `CHANNEL_SECRET` is a random value set
with `wrangler secret put`, never in the source.

- **Checked** on every page load, press and poll by recomputing the HMAC and comparing in constant
  time, then requiring the time to be no later than a minute ahead and less than an hour old. Nothing
  is looked up to check an id.
- **One channel reveals nothing about another.** The random part of each id is independent (72 bits),
  and the HMAC tag does not reveal the secret, so knowing any number of channels does not let anyone
  guess, forge or extend another. Only the holder of a channel's link can press its button or read
  its presses.
- **Old channels.** After an hour a channel is refused everywhere: its page shows "expired", a press
  gets `410`, and a poll gets `InvalidParams`, which ends the client's watch; none of these touch
  storage. The channel's Durable Object deletes its presses five minutes after the hour.
- Nothing about the visitor goes into an id, and the button page sends no `Referer`.

## How it works

- **Stateless polls.** A cursor is base64url JSON saying where the subscription stands in its upstream
  feed: a watermark, the ids it has already seen on the current page, and when it last looked. It is
  bound to its event type and a hash of its arguments, so a cursor from one subscription is refused on
  another. A comment Hacker News indexes late (an older id after newer ones) is still delivered once.
- **Gaps are reported.** When the upstream page no longer reaches back to the cursor (the feed moved
  on by more than a page between two polls), or `maxAgeMs` floors past it, the result has
  `truncated: true`, as SEP-3415 asks, and delivery resumes from where the page begins.
- **Shared upstream reads.** The page a subscription reads depends only on its arguments, never on its
  cursor, so every client watching the same thread, package or repository shares one edge-cached
  response. For Hacker News it also names the current poll interval: Algolia's API caches its answer to
  an identical query for several minutes (a thread's comments were measured seven minutes stale), so
  the query asks for the past 7 days from a start rounded to 30 s (comments) or 60 s (stories). The
  answer is fresh each interval, and clients in the same interval still share one read.

## Delivery modes

| Mode | Offered | Why |
|---|---|---|
| poll (`events/poll`) | yes, for every event type | Works on a stateless Worker, keeps no state per client, and a client behind NAT can use it. |
| push (`events/stream`) | no: answers `Unsupported` (`-32026`, `data.feature: "deliveryMode"`) | A held stream per subscriber would keep a Worker or Durable Object running for each one; polling every 2 s gives the button the same feel for a fraction of the cost. |
| webhook (`events/subscribe`) | no: answers `Forbidden` (`-32024`) | SEP-3415 requires an authenticated principal for webhook subscriptions, and this server has no sign-in. A public server that POSTs to URLs strangers give it would also be an abuse vector, and it would have to hold state per subscriber. |

The server advertises Events only as SEP-3415 defines it, under `capabilities.extensions` in its
`server/discover` result. It does not also advertise the pre-standard top-level `events` capability
(the form ChatGPT reads): the SEP says that key "is not part of this extension", and the pre-standard
form numbers its errors differently (`-32011` to `-32015`), so one server cannot answer both forms
correctly. Whether ChatGPT can use this server has not been tested.

## Protocol details

- **Both eras.** Requests with `MCP-Protocol-Version: 2026-07-28` are served statelessly: `_meta`
  must carry the protocol version and client capabilities, and `Mcp-Method` and `Mcp-Name` must match
  the body (else `400` with `HeaderMismatch`, `-32020`). An `initialize` request (protocol revisions
  2025-11-25 and earlier) is answered without a session and with tools only, because the Events
  extension is not defined for those revisions. That is how Claude Code's own MCP connection lists the
  two tools.
- **Errors** use SEP-3415's codes: unknown event name `NotFound` (`-32023`, `data.kind: "event"`), bad
  arguments or cursor `InvalidParams` (`-32602`), push `Unsupported`, webhook `Forbidden`, rate limit
  `ResourceExhausted` (`-32025`). An upstream that fails mid-subscription is not an error: the poll
  returns no events, keeps the client's cursor and asks it to wait 2 minutes. An expired button channel
  is `InvalidParams` on every poll, so the watch ends.
- **Not offered:** `listChanged` (the event types are fixed), resources, prompts.

## Limits

Every route is rate limited per client address (an IPv6 client counts by its /64, since a host can use
any address in it, and an IPv4 address written as IPv6, `::ffff:a.b.c.d`, counts as that IPv4 address), and fails closed: if a limiter cannot answer, the request is refused. The `/mcp`
limit leaves room for several people behind one network address, each with a button watch polling
every 2 s (30 requests a minute).

| Route | Limit (per address, per minute) | Over the limit |
|---|---|---|
| `POST /mcp` (and any other method on `/mcp`) | 240 | `429`, JSON-RPC `ResourceExhausted` (`-32025`) |
| `POST /api/press` (the button) | 20, shared with new buttons; and one press a second, 50 presses per channel | `429` |
| `GET /b/new` and the `new_demo_button` tool | 20, shared with presses | `429` / tool error |
| `GET /`, `GET /b/<channel>`, `/robots.txt`, anything else | 60 | `429` |

| Other limits | |
|---|---|
| Upstream reads | edge-cached for about each poll interval (25 s to 2 min). Fetches that miss the cache are capped per upstream host for the whole service (120 a minute for Algolia, the HN API, npm and GitHub, 60 for USGS), and any one client (address or IPv6 /64) gets at most 10 of a host's fetches a minute, so one client cannot spend a feed's minute for everyone. When a fetch is refused or fails, the last good copy (up to an hour old) answers instead: it can start a new watch (counting nothing older than that moment as new), while an existing watch keeps its cursor and is asked back at its usual interval. 6 s timeout, 1 MB body cap, only the five hosts below, at URLs built from checked arguments. No URL a client sends is ever fetched. |
| Arguments | checked against each `inputSchema` (types, ranges, patterns, lengths); unknown keys refused |
| Request body | 64 KiB; one JSON-RPC message per request (no batches) |
| Cursor | 4096 characters |
| `maxEvents` | at most 50 per poll (default 20) |
| Text from `read_event_text` | titles 200 characters, comments and notes 1500, place names 120, button messages 120 |

## Upstream sources and their terms

| Source | Used for | What its terms say, and how this server uses it |
|---|---|---|
| [HN Search API by Algolia](https://hn.algolia.com/api) | `hn.comment`, `hn.story`, `find_hn_story` | "We are limiting the number of API requests from a single IP to 10,000 per hour." Each thread or search is read at most about once per 25–50 s per Cloudflare location, shared by every client watching it, and the whole service reads Algolia at most 120 times a minute (7,200 an hour). |
| [Hacker News API](https://github.com/HackerNews/API) (Firebase) | checking that `story` is a story when a watch starts; `read_event_text` for HN items | "There is currently no rate limit." Cached 1 minute to 1 hour; at most 120 reads a minute. |
| [npm public registry](https://docs.npmjs.com/policies/open-source-terms) | `npm.release` | The terms allow replicating data "from the Public Registry using the Public APIs" and forbid automated access to the website. This reads only `registry.npmjs.org/-/package/<name>/dist-tags` (a few hundred bytes), never npmjs.com. |
| GitHub release feeds (`github.com/<owner>/<repo>/releases.atom`) | `github.release` | The public Atom feed a feed reader polls; no token and no REST API. GitHub's [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) restrict scraping and do not address feed polling directly. Each repository's feed is read at most about once per 2 minutes per location. |
| [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | `usgs.earthquake`; `read_event_text` (an event's detail file) | US Government data, regenerated every minute and served with `max-age=60`. One shared file (the past hour), read at most about once a minute per location; at most 60 USGS reads a minute in all. |

This project is not affiliated with any of them.

## Run your own

You need Node 22.18 or newer and a Cloudflare account (the free plan works; see the note below).

```bash
git clone https://github.com/idosal/MCPolyfill
cd MCPolyfill/servers/event-feeds
npm install
npx wrangler deploy
openssl rand -base64 32 | npx wrangler secret put CHANNEL_SECRET
```

`CHANNEL_SECRET` signs button channel ids. Without it the feeds work and the button is off. To run it
on your machine instead, put `CHANNEL_SECRET=<random>` in `.dev.vars` and run `npx wrangler dev`
(the server is then at `http://127.0.0.1:8797/mcp`). Change `SOURCE_URL` in `wrangler.jsonc` to your
own repository, and the `name` there if you want another workers.dev address.

On the Workers free plan a day allows 100,000 requests and a limited amount of Durable Object time.
A button watch polls every 2 s (1,800 requests an hour); a feed watch every 30 s to 2 min.

## Tests

```bash
npm test                                   # unit tests, against recorded upstream responses (no network)
node --no-warnings test/smoke.ts <base>    # drives a running server over HTTP (reads the real upstreams)
node --no-warnings test/interop/run.ts     # the mcp-events client against the deployed server (see the file)
# the interop run and live/take.sh use the mcp-events polyfill's source: MCP_EVENTS_PLUGIN (default:
# ../../polyfills/claude-code/events in this repository)
```

- `test/sources.test.ts`: each event type's cursor logic on responses recorded on 24 November 2026
  (`test/fixtures/`): first poll, new items once and in order, late-indexed items, `maxEvents` and
  `hasMore`, gaps and `truncated`, `maxAgeMs`, filters, wrong arguments, upstream failures; and that
  no event of any type carries third-party text.
- `test/protocol.test.ts`: both protocol eras, header and `_meta` validation, every error code, the
  three tools (including `read_event_text`'s caps and refusals), request and cursor size
  limits, text cleaning, Origin checks, channel signing and expiry.
- `test/interop/run.ts` runs the `mcp-events` polyfill's helper process through its own test harness,
  as Claude Code's hooks module does: discovery, a watch, a button press waking the idle session, the
  same press not delivered twice, presses made while the client was closed delivered on reopen from
  the client's cursor, a refused watch, and a real new Hacker News story.
- `live/take.sh` records a real Claude Code session doing the button demo, with the browser page;
  `live/edit.json` cuts it into a short video with the polyfill's `video/cut.mjs`.

The upstream conformance suite (`@modelcontextprotocol/conformance`, 0.1.16) has no Events scenarios
yet; they are in an open pull request (modelcontextprotocol/conformance#521) and were not run.

## Layout

```
src/index.ts         routes: /, /mcp, /b/new, /b/<channel>, /api/press
src/mcp.ts           the MCP endpoint: eras, header validation, dispatch
src/events.ts        events/list, events/poll, and the refusals for push and webhook
src/snapshot.ts      the cursor and poll logic every event type shares
src/sources/*.ts     one file per upstream
src/upstream.ts      edge-cached, rate-limited, size-capped upstream reads
src/button-do.ts     the Durable Object that holds a channel's presses for an hour
src/gate-do.ts       the Durable Object that caps reads of one upstream host
src/tools.ts         new_demo_button, find_hn_story, read_event_text
src/channel.ts       signed channel ids
src/pages.ts         the two web pages
```

Apache-2.0, like the rest of MCPolyfill.
