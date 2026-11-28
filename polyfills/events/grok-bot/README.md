# MCP Events for Grok Bot

Host polyfill implementing the client side of the MCP Events extension ([SEP-3415, Final](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md)) for **Grok Bot**.

Wake an idle Grok Bot routine only when a watched MCP server emits a matching event—with **zero scheduled model runs** and **zero idle token burn**. One always-on process (`bridge.mjs start`) watches all your MCP servers (push, poll, and signed webhooks), wakes Grok through one native webhook routine, and exposes the standard MCP Events tools to Grok over authenticated HTTPS.

- **[Step-by-step setup guide & Grok Bot prompts](REMOTE-SETUP.md)**
- **[Docker setup](docker-compose.example.yml)**

## Quickstart

With Node.js 22.18 or newer, the bundled CLI `plugin/dist/bridge.mjs` is self-contained and needs no dependency install.

```sh
node plugin/dist/bridge.mjs init
# Copy the Grok connector Authorization header (never prints the secret):
{ printf 'Bearer '; tr -d '\n' < ~/.grok-events/reader.key; } | pbcopy
# Start the unified watcher + MCP connector on 127.0.0.1:8787:
GROK_ROUTINE_URL="https://..." GROK_ROUTINE_KEY="..." node plugin/dist/bridge.mjs start
```

Expose `http://127.0.0.1:8787/mcp` over HTTPS (via a Cloudflare Tunnel, Tailscale Funnel, or reverse proxy) and add it in Grok Bot under **Connect apps → Add a custom connector → Remote HTTPS**.

## What Grok Bot can do with it

In unified `start` mode, the connector exposes 7 tools:

| You say | Tool | Access |
|---|---|---|
| *(Automatic on webhook wake)* | `read_batch` | Read-only (paginated events + subscription notices) |
| "What can you watch on my servers?" | `list_event_types` | Read-only |
| "Watch this T3 thread and let me know when it finishes." | `watch_event` | Creates a persistent watch |
| "What are you watching? Any delivery issues?" | `list_watches` | Read-only (includes delivery health & spool usage) |
| "Show me event `e12` in full." | `get_event` | Read-only |
| "Show the last 10 events." | `recent_events` | Read-only |
| "Stop watching that thread." | `unwatch_event` | Stops watch & unsubscribes on server |

Dynamic watches created with `watch_event` persist across restarts alongside any declarative watches in `config.json`.

## How it works

```
MCP servers (SEP-3415) ──push / poll / webhook──► bridge.mjs start (always-on host)
                                                     ├─ saves events & notices to disk
                                                     ├─ POSTs opaque batch ID to Grok webhook
                                                     └─ serves /mcp (read_batch + watch tools) & /health
Grok Bot routine ◄── native bearer webhook ──────────┘
Grok Bot ─────────── Remote HTTPS MCP (/mcp) ───────► reads untrustedEvents & manages watches
```

- **Zero idle token burn:** Stream heartbeats, reconnects, polling, webhook challenge verification, and subscription lease renewals all run purely in Node.
- **Resilient overnight delivery:** Definite transient Grok webhook failures (`408`, `429`, `5xx`, respecting `Retry-After`) automatically retry with exponential backoff using the exact same batch reference. Fatal config/auth errors (`400`, `401`, `403`, `404`) hold delivery until fixed and restarted with `--retry` or `--accepted BATCH`.
- **Actionable notices:** Subscription notices (replay truncation, terminated watches, server errors) are queued and surfaced in `read_batch` (`notices`) as well as logged.
- **No VM-sleep delays:** Running `bridge.mjs start` outside Grok's computer avoids Grok VM suspension pauses while still waking your bot via its native webhook.

## CLI commands

| Command | Purpose |
|---|---|
| `node plugin/dist/bridge.mjs init [--demo CHANNEL]` | Create `~/.grok-events` with `reader.key` (mode `600`) and starter `config.json` without overwriting existing files. |
| `node plugin/dist/bridge.mjs start [--retry \| --accepted BATCH]` | **Recommended.** Run the watcher and the full 7-tool MCP HTTP server in one process. |
| `node plugin/dist/bridge.mjs run [--retry \| --accepted BATCH]` | Watcher only (for local-disk mode on Grok's computer or split-process deployments). |
| `node plugin/dist/bridge.mjs serve` | Read-only MCP HTTP server (`read_batch`, `get_event`, `recent_events`) reading from an existing `GROK_EVENTS_HOME`. |
| `node plugin/dist/bridge.mjs list [SERVER]` | Discover and print event types advertised by configured servers. |
| `node plugin/dist/bridge.mjs read INBOX.eFIRST-eLAST` | Print stored events for a batch reference locally. |

## Settings

### `config.json` (in `$GROK_EVENTS_HOME`, default `~/.grok-events`)

- `servers`: Map of named HTTP (`upstream.url`) or stdio (`upstream.command`, `args`, `env`) MCP servers. For bearer auth, set `upstreamBearerEnv` to an env var name holding the token (or set `upstream.headers`).
- `watches` *(optional)*: Declarative array of `{ server, event, arguments?, name? }`. Omit or leave `[]` to manage watches purely through Grok Bot chat (`watch_event` / `unwatch_event`).
- Wake & retry limits *(optional)*: `batchMs` (default `1000`), `minGapSeconds` (default `60`), `maxWakesPerHour` (default `6`), `retryBaseMs` (default `10000`), `retryMaxMs` (default `300000`), `holdOnAmbiguous` (default `false`; set `true` to hold rather than auto-retry on ambiguous network timeouts).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GROK_EVENTS_HOME` | `~/.grok-events` | Profile directory (`config.json`, `reader.key`, `delivery.json`, watches, spool). |
| `GROK_ROUTINE_URL` | *(required)* | Grok Bot routine webhook **POST to** HTTPS URL. |
| `GROK_ROUTINE_KEY` | *(required)* | Grok Bot routine webhook **key** (sent as `Authorization: Bearer`). |
| `GROK_EVENTS_READER_KEY` | `<home>/reader.key` | Bearer secret required by Grok's Remote HTTPS MCP connector (32+ chars). |
| `GROK_EVENTS_READER_HOST` | `127.0.0.1` | Bind address for `/mcp` and `/health` (set `0.0.0.0` in Docker/containers). |
| `GROK_EVENTS_READER_PORT` | `8787` (or `PORT`) | Listen port for `/mcp` and `/health`. |
| `GROK_EVENTS_READER_ORIGIN` | *(unset)* | Optional public `https://` origin allowed in browser `Origin` headers. When unset, all requests bearing an `Origin` header are rejected (`403`) while non-browser MCP clients (like Grok Bot) work without extra setup. |
| `MCP_EVENTS_OFF` | *(unset)* | Set `1` to stand down cleanly (no upstream connections, no watches, zero MCP tools) when Grok adds native support. |
| `MCP_EVENTS_PRE_STANDARD` | *(all)* | Set `off` to require strict SEP-3415 `capabilities.extensions`, or a comma-separated list of server names allowed to use the pre-standard top-level `events` capability. |
| `MCP_EVENTS_PUBLIC_URL` / `MCP_EVENTS_RELAY` | *(unset)* | Optional webhook receiver or [shared Cloudflare relay](../claude-code/mod/relay) for upstream servers that only support webhook delivery. |

## Limits

- **Always-on host required for overnight watches:** Grok Bot's computer suspends when idle. Run `bridge.mjs start` on a non-suspending host (Docker/VPS/Mac mini) with persistent disk.
- **Separate credentials:** This polyfill never reads Grok Bot's stored OAuth sessions. Each upstream server in `config.json` needs its own configured header or bearer token env var.
- **Spool size cap:** The shared core spool caps `events.jsonl` at 64 MiB (plus 1 MiB notice reserve). `list_watches` and `/health` report `spoolBytes` / `maxSpoolBytes`.
- **Single-account connector scope:** Grok shares custom Remote HTTPS connectors across your bots. Keep sensitive sources in separate profiles/connectors if you isolate bots.

## Security

See [SECURITY.md](SECURITY.md).

## Spec and conformance

Implements [SEP-3415, Final](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), `io.modelcontextprotocol/events`, using the [shared Events core](../core). Accepts pre-standard top-level `events` servers unless `MCP_EVENTS_PRE_STANDARD=off` is set.

## Development

```sh
(cd ../core && npm ci)
npm ci
npm run build
npm test
```

After dependency changes, regenerate third-party notices:

```sh
node ../../../tools/bundle-notices.mjs . --plugin plugin --entry src/bridge.mjs --bundle dist/bridge.mjs
```

Other Events adapters are listed in the [repository host table](../../../README.md#polyfills).
