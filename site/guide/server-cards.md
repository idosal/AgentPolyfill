---
description: mcp-server-cards adds the client side of MCP Server Cards (SEP-2127) to Claude Code. Claude finds the MCP servers a domain publishes, checks each card, and adds one to Claude Code's own config with a click.
---

# Server Cards

`mcp-server-cards` lets Claude find the MCP servers a domain publishes, and
connect Claude Code to one. Name a company, and Claude reads that domain's
catalog, fetches each Server Card it lists, checks the card against the schema,
and shows you what it found. Under the result there is a list of the servers you
can add, each with an **Add** button.

Press **Add**, and the server goes into Claude Code's own MCP configuration, as
if you had typed `claude mcp add`. Claude Code then connects it with its own
sign-in, so servers behind OAuth work. Nothing is installed besides that
configuration entry, and the polyfill never sees a token.

It adds the client side of the MCP **Server Cards** extension, which Claude Code
does not support by itself yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in
  [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) at
  commit `28db12c9b4` (2026-11-19).
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127 hands
  domain discovery to, v0.9 (a release candidate).

<Recording
  cut="server-cards"
  alt="In Claude Code, the question What MCP servers does neon.com publish? lists Neon and Neon Docs from neon.com's own catalog, each with an Add button. Add is pressed on Neon Docs, which is marked added, with a note to run /mcp to connect or sign in."
  caption="A real session (21 s, recorded with 0.1.0): neon.com's two servers, found from its domain. Add on Neon Docs writes it to Claude Code's config; connecting is left to /mcp."
/>

## Install

```
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

Or in a terminal, `claude plugin install mcp-server-cards --marketplace idosal/AgentPolyfill`.
It is also part of the `agent-polyfill` bundle. You need:

- **Claude Code 2.1.329 or newer**, with mods.
- Nothing else: no helper process, no Node, no account.
- To add a server, it runs the `claude` command. That is found on your `PATH`,
  or in the usual install folders. If neither works, it gives you the exact
  command to run yourself.

## Try it

Nothing to set up. Start `claude` and ask:

> What MCP servers does neon.com publish?

Then press **Add** on **Neon Docs** (no sign-in). `claude mcp remove neon-docs -s local`
removes it again. For one behind a sign-in, ask about buildkite.com; after
**Add**, Claude Code asks you to sign in through `/mcp`.

## Using it, step by step

1. **Ask.** For example "connect Claude Code to Buildkite", or "what MCP servers
   does neon.com publish?".
2. **Claude Code asks before the first lookup.** The first call to
   `discover_mcp_servers` gets Claude Code's usual permission prompt, as any new
   tool does. If you say no, nothing is fetched.
3. **Claude shows what it found:** each server's card, and whether the card is
   valid. A refused card says why; nothing refused can be added.
4. **Pick one.** Under the result, a box lists the servers you can add: each
   one's name, the URL it connects to, who stands behind it, and the server name
   and headers it would write, with an **Add** button.
   - **Add** adds that server, with the card as shown and its defaults, to the
     local scope (this project, only you). The press is your choice, so no
     further prompt follows.
   - It never replaces a server you have. If the name is taken in any scope, it
     adds the server as `name-2` (up to `name-9`) and says so.
   - A server whose card needs an input (a tenant name, say) shows no button.
     Ask Claude, who will ask you for it.
5. **Or ask Claude to add it.** Claude calls `add_mcp_server`, and Claude Code
   always asks you: the polyfill makes that question itself, so no allow rule
   or auto mode answers it for you. It names the server, the URL, the headers,
   the scope and how to undo it. With nobody to ask (`claude -p`), it is
   refused.
6. **The server is connected.** If it needs a sign-in, run `/mcp`, pick the
   server and authenticate. The sign-in is Claude Code's own.
7. **To undo an addition:** `claude mcp remove <name> -s local` (or
   `-s project`, `-s user`). The result gives the exact line.
8. **If the card asks for a secret** (an API key, say), the polyfill never asks
   you for it and never shows it to Claude. The configuration holds a reference
   such as `${MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ}`, and Claude tells you its
   name. Set that environment variable and restart Claude Code.

### A domain that redirects

Some domains answer with a redirect to another domain: `neon.tech` sends its
catalog, and every other path, to `neon.com`. Claude Code's fetch follows
redirects without saying where they led, so the polyfill shows the catalog under
the domain you asked for ("listed by neon.tech", though `neon.com` served it).
To see the origin that really serves a catalog, ask for the domain the company
uses itself. SEP-2127 says nothing about following redirects for a catalog or a
card; its one same-origin rule is for `extensionsInfo` used in a security
decision, and the polyfill never uses `extensionsInfo`.

## Settings

In `/config`, under the plugin:

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `picker` | on | Shows the list of servers with **Add** buttons under discovery results, and under another plugin's results that it was handed. Off: you add servers by asking Claude. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript. Claude is not told. Only sites Claude has already contacted are checked. |

## The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, …)` | Adds a server shown in this session, with `claude mcp add`, then asks Claude Code to connect it. |
| `present_server_cards` | For other plugins only, never the model, so that a plugin which finds cards another way (`ard-discovery`) has them checked, shown and added here. |

## Limits

- **The card is not compared with the live server.** SEP-2127 says a client
  SHOULD check a card's claims against the live connection; this rule is not
  met. With changes 1 and 2 of [the host changes](./how-it-works#four-host-changes),
  the polyfill would send `server/discover` over Claude Code's connection and
  compare the name, version and protocol revisions.
- **Claude Code's protocol revisions are listed by hand**, from its docs. Change 2
  would let the polyfill read the negotiated revision instead.
- **Redirects and DNS aren't visible.** A private address named directly is
  refused, but a public URL that redirects to one, or a public name that resolves
  to one, is not caught. A host API that reports redirects and the resolved
  address, or refuses private ones, would close this.
- **A secret needs a restart:** you set the environment variable, then restart.
- **Whether a server added mid-session connects without a restart** depends on
  Claude Code picking up `claude mcp add`. If it doesn't, `/mcp` or a restart
  connects it.

Not in it: ARD (in [`ard-discovery`](./ard)), verifying AI Catalog trust
manifests and signatures (no card is ever called verified), other artifact types
in the same catalogs, and local (stdio) servers, which cards do not describe.

## Security

The polyfill reads documents that strangers publish on the web, and turns one of
them into an entry in your Claude Code MCP configuration. What a catalog or card
says is someone else's claim, read before any connection.

- **What it fetches:** plain `GET`s, through Claude Code's own network path,
  with no cookies or credentials, bounded in size and number. It sends nothing to
  a third party: no query text, and no request that is not a `GET`. A public
  catalog or card can't send it to a local or private address.
- **What it writes:** only your MCP configuration, through `claude mcp add`, for
  one server at a time, and only when you press **Add** or approve Claude's
  request. Never over a server you have.
- **Text that displays as something else:** a card is refused if any string in
  it holds a control character or an invisible format or bidirectional mark; a
  remote URL must be printable ASCII, so what the picker shows beside **Add** is
  what is added.
- **Secrets** never pass through Claude, the command line or the polyfill's
  store, and a card that sets a secret's value itself is refused.
- **It never reads Claude Code's credentials**, runs no sign-in of its own, and
  holds no token.

It does not protect against a publisher's own bad server, an unconfirmed server
you add anyway, or a public name that resolves to a private address, or a
redirect to one.

How it is checked: 99 tests for the client rules, run with Claude Code's own
test kit (two rules are met by design, and the one about the live server is not
met); the live catalogs and
cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa,
Supabase and Zapier (ten of the eleven cards valid, Zapier's refused, and ajv
with the official schema gives the same verdict on all eleven); and runs in the
real host. Adding a server end to end in the real host (added, then connected
and used) is the run still to record; the recording at the top of this page
shows **Add** pressed and the server written to the config, not connected. The MCP conformance suite has no Server Card scenarios. An independent
security review for the launch (24 November 2026), by an AI session, not a human
audit: its findings SC1 to SC7 are fixed and tested.

The full account:
[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/server-cards/SECURITY.md).

## When Claude Code supports Server Cards itself

Claude Code has no Server Card support to detect yet. When it ships, turn on the
`disabled` setting: the polyfill then registers nothing and fetches nothing.

## More

On GitHub, in [`polyfills/claude-code/server-cards`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/claude-code/server-cards):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/claude-code/server-cards/README.md),
with one row for each client rule and the test that covers it, and the findings
to report upstream.
