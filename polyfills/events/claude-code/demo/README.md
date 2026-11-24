# The demo "deploys" server

A small MCP server to try the mod with: three pretend services, a page with a
**Deploy** and a **Deploy a bad commit** button for each, two tools
(`list_deploys`, `get_deploy_log`) and one event type, `deploy.finished`.

Its MCP side is [Mastra](https://mastra.ai)'s `@mastra/mcp`, whose support for
the Events extension (SEP-3415) is Mastra's own implementation, not this
project's code. That makes it a fair server to try the mod against.

## Run it

Node 22.18 or newer.

```bash
npm install
DEPLOYS_TOKEN=demo-token npm start
```

The page is at http://127.0.0.1:4010/ and the MCP server at
http://127.0.0.1:4010/mcp. Clients must send `Authorization: Bearer <DEPLOYS_TOKEN>`.

Tell Claude Code about it, from any project folder:

```bash
claude mcp add --transport http deploys http://127.0.0.1:4010/mcp --header "Authorization: Bearer demo-token"
```

Then, in a `claude` session with the mod installed:

> Watch the deploys server. When a deploy fails, tell me why in one line.

Press **Deploy a bad commit** on the page. The session wakes by itself and
answers.

## Settings

| Variable | |
|---|---|
| `DEPLOYS_TOKEN` | Required. The bearer token MCP clients must send. |
| `PORT` | Default 4010. |
| `DEPLOYS_DELIVERY` | Which delivery modes to offer, comma-separated: `push`, `poll`, `webhook` (default: all three). `webhook` alone behaves like a server built for hosts that only take webhooks; the mod then needs a relay. |
| `DEPLOYS_ALLOW_LOCAL=1` | Lets webhook addresses be plain http on this machine, for local experiments. |
