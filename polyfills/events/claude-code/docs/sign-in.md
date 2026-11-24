# Servers that need sign-in

**In short.** The mod works with a server that needs credentials when those
credentials are in the server's configuration: a header (including `${VAR}`),
or a `headersHelper`. It does not work with a server whose only way in is
Claude Code's interactive OAuth sign-in (`/mcp`), or with claude.ai connectors,
because Claude Code does not share that connection or its tokens with a mod.

| The server's configuration | Works | How |
|---|---|---|
| No credentials | Yes | |
| `"headers": { "Authorization": "Bearer ${DEPLOYS_TOKEN}" }` | Yes | The mod expands `${VAR}` as Claude Code does and sends the same header. |
| `"headersHelper": "<command>"` | Yes | The mod runs the command as Claude Code does and sends what it prints. |
| OAuth through `/mcp` (no header, no helper) | No | Claude Code's grant is not available to a mod. |
| A claude.ai connector | No | It is not in the configuration files, and is reached with your claude.ai sign-in. |

When a server is out of reach for this reason, the mod says so: ask Claude
"what can you watch?" and the server is listed as unavailable, with the
reason.

## Setting it up

### A token in a header

Create a token at the service (an API key or personal access token), keep it
in an environment variable with a name of your own, and refer to it from the
server's entry:

```json
{
  "mcpServers": {
    "deploys": {
      "type": "http",
      "url": "https://deploys.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DEPLOYS_TOKEN}" }
    }
  }
}
```

The mod writes nothing down. The token is in the environment of Claude Code
and of everything Claude Code starts, the helper included; the mod removes it
from its log and from anything it shows. Note that a variable in the
environment can be read by any command Claude runs: that is how `${VAR}`
headers work in Claude Code, with or without this mod.

### A `headersHelper`

Set `headersHelper` on the server's entry to a command that prints the headers
as JSON, as
[Claude Code's documentation](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)
describes: for example a script that reads a token from your keychain or
password manager, or a cloud CLI that prints a short-lived access token.

```json
{
  "mcpServers": {
    "deploys": {
      "type": "http",
      "url": "https://deploys.example.com/mcp",
      "headersHelper": "~/bin/deploys-headers.sh"
    }
  }
}
```

The mod runs the same command Claude Code runs, the same way: through a shell,
given up on after 10 seconds, told which server it is for in
`CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`, expecting a
JSON object of string values, which go over static headers of the same name.
It runs before each connection and again after a request is refused with `401`
or `403`.

- It runs only for a server Claude Code itself is using in the session. For a
  server from the project's `.mcp.json` or the local scope, only in a folder
  you have marked trusted.
- A helper that came with the repository is not handed `ANTHROPIC_*`,
  `CLAUDE_*` or `MCP_EVENTS_*` variables.
- What it prints is held in memory for the life of the connection and never
  written down. The secret stays wherever your command keeps it.
- Your command runs twice per session (once for Claude Code, once for the
  mod), which matters only if it has a side effect or a cost.
- On Windows the mod runs it through `cmd.exe`, which may not be the shell
  Claude Code itself uses there.

## Why interactive OAuth is out of reach

The Events client opens a connection of its own to each MCP server. It has to:
the mod API's `$.mcp.call(server, tool, args)` sends `tools/call` over Claude
Code's connection and nothing else, so `events/list`, `events/poll`,
`events/stream` and `events/subscribe` cannot go through it.

A second connection needs the credentials again. When they are in the server's
configuration, the mod reads them from the same place Claude Code does. When
they are an OAuth grant you gave Claude Code through `/mcp`, they are in Claude
Code's own store, and nothing in the mod API hands them out (checked against
the API's type definitions for Claude Code 2.1.330):

- `$.mcp` has `call` and `connect`. `connect` answers with Claude Code's
  verdict on a server (`auth` when it waits for a sign-in); neither returns a
  token or sends another method.
- `$.session.authorize()` and `$.http.fetch(url, { auth })` carry the session's
  *Anthropic* credential, "only for a first-party host". Nothing like it exists
  for an MCP server's grant.
- `$.settings.read()` says of itself: "The OAuth session and the global config
  (~/.claude.json) are not settings and are never read."

## What was considered, and why the mod does not sign in by itself

| Option | Status | Why |
|---|---|---|
| A header with a token from an environment variable | Supported | The credential Claude Code already sends; the mod stores nothing. |
| The server's `headersHelper` | Supported | The mechanism Claude Code already has for credentials that need no browser; can mint short-lived tokens. |
| The mod runs its own OAuth sign-in | Not built | See below. |
| Claude Code lets a mod use its connection | Not available yet | The right fix; see below. |
| Reading Claude Code's stored tokens | Ruled out | They are Claude Code's, given by you to Claude Code; their location and format are not documented; and two parties refreshing one rotating refresh token end the session for both. |

**Its own sign-in.** The mod could run OAuth for each server itself: its own
client registration, authorization code with PKCE, a redirect to a loopback
address, tokens kept only in the operating system's keychain, a sign-out that
revokes. The protocol would be as sound as Claude Code's. What would be worse
is everything around it: a second long-lived refresh token per server on your
machine; a second consent screen, naming an application your organisation has
not vetted; a grant that an organisation's settings for MCP sign-in neither
see nor control; servers that accept only known clients refusing it; and a
keychain item that any program running as you can ask for. The mod holds no
grant today, and that is worth keeping unless there is no other way.

**Using Claude Code's connection.** If the mod API gained
`$.mcp.request(server, method, params)`, any MCP method over Claude Code's own
connection as `$.mcp.call` does for tools, OAuth servers would work with no
second sign-in and no credential leaving Claude Code. A smaller step in a
shape the API already has would be an opaque handle for a server's grant,
spent only at that server's address, the way `$.session.authorize()` works
for Anthropic's own hosts.
[`claude-code-and-mcp-events.md`](claude-code-and-mcp-events.md) has the
details.

## How this compares

*Claude Code's own sign-in.* You run `/mcp` and sign in through the browser
(OAuth 2.1 with PKCE). Tokens are stored and refreshed by Claude Code, and
"Clear authentication" in `/mcp` revokes them. With a header or a
`headersHelper`, the mod sends exactly the credential Claude Code sends, from
two processes instead of one.

*ChatGPT.* A hosted client: it signs in with OAuth 2.1 and holds the grant at
the service, so nothing is on your machine. A token in an environment variable
is weaker on lifetime and scope than that; a `headersHelper` that mints
short-lived tokens can be as good, for services that offer a way to get a
token without a browser.
