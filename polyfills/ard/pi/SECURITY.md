# Security

This covers `ard-discovery` for Pi. The other forms have their own host
security notes: [Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md), [OpenCode](../opencode/SECURITY.md).

This extension reads a domain's ARD manifest and asks a registry for MCP
servers. Registries and publishers make claims; neither is trusted authority.
It bundles the same card checks and Pi add adapter as
[Server Cards for Pi](../../server-cards/pi/SECURITY.md). That form's rules
for fetching, saving, secrets, names and session connections apply here too.

## What is trusted

- **You:** you choose the registry and explicitly accept each search and
  each addition. No registry is configured by default.
- **Pi and its UI client:** an RPC client must relay questions honestly.
  Pi owns configuration, connections, tool permissions and OAuth.
- **Not registries, publishers or the model:** a ranking is relevance, not
  trust. A result is confirmed only by the publisher's own catalog, and
  confirmation still does not authorize an addition.

## What it sends, and where

### Each search discloses its query

`ard_search` sends a JSON POST containing the trimmed query text, a Server
Card type filter, `federation: "referrals"` and `pageSize: 10`. It includes
Content-Type, Accept and a User-Agent. No cookies, credentials, conversation
history, workspace files or secret headers are attached.

A registry argument or `ARD_DISCOVERY_REGISTRY` names the destination. With
neither, the search refuses before any request or question. If a registry
is given as a domain, its catalogs are fetched first without the query, to
resolve the endpoints that the question names.

Before every search, `ctx.ui.select` shows the exact normalized endpoints,
the complete query and the allowance for up to three referrals. **Don't send
it** comes first; only **Send the search** posts. No UI, a closed or failed
dialog, decline, cancellation, or another answer sends nothing. Print and
JSON modes refuse. The question supplies consent because Pi does not prompt
before every tool call; annotations also support permission extensions.

Queries over 300 characters or containing control characters, invisible
marks (default-ignorable code points such as tag characters and variation
selectors included), direction marks, backticks, angle brackets or square
brackets are refused. A registry's own words (its error messages, the
referrals it names, and each result's name and description) are shown on one
line, capped, with control and invisible characters taken out, so a registry
can't add lines of its own to the answer or carry text you don't see. A
result whose identifier holds such a character is skipped. Registry arguments
and settings are limited to 200 characters, without spaces, controls,
invisible characters or direction marks. Endpoints containing misleading
markup or userinfo are refused. The question shows the endpoint actually
used, after URL normalization.

At most three initial registries and three referrals are contacted, with
referrals followed one hop only. Every result names the registries asked.
A POST redirect is never followed to another origin or turned into a GET;
same-origin 307/308 redirects preserve the request. Once a query is sent,
cancellation cannot take it back.

### Discovery and result checking

`ard_discover` makes GET requests for AI Catalog and ARD sources, including
`/.well-known/ard.json` and `rel="ard"` links. After a search, cards and the
catalogs of up to five publishers are fetched by GET. These recipients see
the requested paths and network address, not the search query.

Only MCP Server Cards are shown. The publisher's own card is used when
confirmed; otherwise the result and add question say it is **NOT confirmed**.
The registry's score and description do not bypass card validation or consent.

### Bounds and address rules

Answers are capped at 512 KiB, cards at 64 KiB. Up to 50 results per registry
answer are read and ten are handed on for display. The shared catalog and
publisher limits apply too.

Public sources cannot lead to literal private addresses or private host
spellings. Plain HTTP is for loopback development only. Document redirects
are checked at every hop. Public DNS names that resolve to private addresses
remain a known gap, as in the Server Cards form.

## What it writes and stores

Search itself changes no configuration. Adding requires a separate **Add
it** answer naming the host, URL, headers, file and undo command. It uses
Pi's own `mcp add` without a shell and then `registerMcpServer`. Only a valid
card shown in the current session can be used. Existing names and unreadable
configuration are refused before and after consent.

Secret headers are generated `${VAR}` references, never values. Header
commands beginning with `!`, duplicate names and misleading markup are
refused. SSE and URL secrets are unsupported. Pi handles connection and
sign-in; the extension never reads `mcp-auth.json` or any stored credential.

Catalogs, cards and offered results are kept in memory for the session.
The extension writes no query log of its own; Pi may keep query text and
tool results in its ordinary session history. A new, resumed, forked or
reloaded session must discover or search again before adding.

## What it does not protect against

- The chosen registries retaining the query after you accept it.
- A registry ranking an unsafe server first, or a publisher operating one.
- A person accepting without reading, or an untrusted extension or RPC
  client answering the question on their behalf.
- DNS resolution to private addresses, or another process racing the final
  name check before Pi writes. Pi has no atomic add-if-absent operation.
- Differences between a card and the live server. There is no live
  `server/discover` comparison through Pi's connection in this adapter.

## Undoing an addition

Run `pi mcp remove <name>`. Refresh the running Pi with `/reload` or start
a new session after an external configuration removal.

## Reporting

Report privately through the repository's **Security → Report a
vulnerability** form on GitHub. Name `ard-discovery`, the Pi form, the Pi
version and the domain or registry involved. Do not include credentials.
