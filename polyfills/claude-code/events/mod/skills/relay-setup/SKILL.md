---
name: relay-setup
description: Set up the user's own relay for webhook-only MCP event types, on their own Cloudflare account. Run only when the user asks for it.
disable-model-invocation: true
---

# Set up a relay for webhook events

Some MCP servers deliver events only by webhook. A webhook needs a public https address, and Claude Code on a laptop has none. The relay is a small Cloudflare Worker that is that address: it keeps each delivery until this plugin collects it, including while Claude Code is closed. It never holds a signing secret, so it cannot make up an event.

This skill deploys the relay to **the user's own Cloudflare account**. Before anything else, tell the user in two or three plain sentences what will happen:

- a Worker named `mcp-events-relay` (with its Durable Objects) is created in their Cloudflare account, at a public `workers.dev` address;
- a random access key is stored as that Worker's secret and in `~/.mcp-events/relay.json` on this machine, readable only by them;
- event payloads their MCP servers send by webhook pass through that Worker and are stored there until collected (for at most a week).

Then ask whether to go ahead. Do nothing else until they say yes.

## Steps

The relay's source is in the `relay` folder of this plugin: from this skill's base directory, `../../relay`. Use that folder's absolute path below.

1. Check Node is 22.18 or newer (`node --version`).
2. Install the relay's tools: `npm install` in the relay folder.
3. Check Cloudflare sign-in: `npx wrangler whoami` in the relay folder. If it is not signed in, **ask the user to run `npx wrangler login` themselves** in that folder (it opens their browser), and wait for them to say it is done. Do not try to sign in for them, and never ask for a token or password.
4. Run `npm run setup` in the relay folder. It deploys, sets the access key, writes the settings file and checks the result. It never prints the key; do not print or read it either.
5. If it fails, show the user the message. Most failures are a sign-in that expired or a `workers.dev` address that needs a minute.
6. Tell the user to restart Claude Code, and that webhook-only event types now work.

## Afterwards

- A new access key: `npm run setup -- --rotate`.
- To remove everything: `npx wrangler delete` in the relay folder, then delete `~/.mcp-events/relay.json`. Only do this if the user asks.

Do not change the relay's limits or set `OPEN_RELAY` unless the user asks for that specifically: an open relay lets anyone who can reach it store data on the user's account.
