# Security

This covers `mcp-server-cards` for Claude Code. The Codex form has its own:
[SECURITY.md](../codex/SECURITY.md).

This mod reads documents that strangers publish on the web: catalogs and
Server Cards. It turns one of those cards into an entry in your Claude Code
MCP configuration. Every rule below follows from that. What a catalog or card
says is someone else's claim, read before any connection. Claude Code's own
permissions and sign-in are the boundary, and the mod adds no policy of its
own.

The client rules it follows, from SEP-2127 and the AI Catalog it names, are
listed with their tests in the [README](README.md#client-rules).

## What is trusted

- **You.** The servers you pick with **Add**, or approve when Claude asks.
- **Claude Code:** its permission dialog, its rules, its network policy, its
  sign-in.
- **Not the publishers.** A catalog can list anything, and a card can claim
  anything. The SEP says a card is advisory and never authoritative for
  security decisions.
- **Not another plugin.** Cards another plugin hands over through
  `present_server_cards` (a search registry's results, from `ard-discovery`)
  are someone else's finding. They get every check below, and a server counts
  as confirmed only when its publisher's own catalog lists it.

## What the mod does

### What it fetches

It makes plain `GET`s, through Claude Code's own network path and under its
web-fetch policy, with only `Accept` and `If-None-Match` headers: no cookies,
no credentials. It reads:

- for a domain you name: `/.well-known/ai-catalog.json` and that page's
  `rel="ai-catalog"` links;
- the cards and nested catalogs those name;
- for another plugin: the further catalog paths and link relations it names
  for a domain (at most three of each), or the cards of the entries it hands
  over, and each one's publisher catalog;
- after a WebFetch: that site's catalogs, once per session.

It sends nothing to a third party: no query text, and no request that isn't a
`GET`. `ard-discovery`'s registry search belongs to that plugin, and its
SECURITY.md says what it sends.

Every fetch is bounded: at most 512 KiB per answer, 64 KiB per card, 20 cards,
3 page links, 50 entries read and 10 shown from a hand-over, 5 publisher
checks, and nested catalogs 4 deep.

### Where it won't go

- A public catalog, card or finder can't send it to a local or private
  address: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
  link-local, unique-local, `.local` and `.internal` names, and single-label
  names. That holds whatever the spelling (`0x7f.1`, a trailing dot).
- Plain HTTP is used only for a loopback address you name yourself, for local
  development.

### Text that displays as something else

- A card is refused if any string in it holds a control character (C0, DEL,
  C1) or an invisible format or bidirectional mark. That rules out an ESC
  sequence that rewrites a line, an OSC 8 link, or a right-to-left override.
- A remote URL must be printable ASCII. It may hold no `` ` ``, `<`, `>`,
  backslash, or square brackets outside an IPv6 host (`https://[::1]/`). It
  may not name a user before its host: `https://good.example@evil.example/`
  connects to evil.example, and a URL parser reads `\` as `/`. So what the
  picker shows beside **Add** is what is added, and no host that renders
  Markdown or HTML can show a link text in its place.
- The same holds for the URL a variable fills in, a card's `websiteUrl` and
  `repository.url`, the card URLs a catalog or another plugin names, a
  registry's URL, and where another plugin says it found a card.
- The picker shows the host on its own line, and the question for Claude's
  add names it.
- Values Claude gives are held to the same rule.
- Everything shown (the picker, tool results, notices, toasts) also passes a
  plain-text filter.

### What reaches the model

A card's fields, and the names and descriptions a finder gave, as tool
results. Each comes with the URL it came from, with control characters and
invisible marks removed, and capped in length. A refused card shows only why
it was refused. A secret's default value is never shown.

### What it writes

Only your MCP configuration, through `claude mcp add`, for one server at a
time.

- **Who decides:** you. Either you press **Add**, or Claude asks and Claude
  Code puts the question to you.
  - The polyfill makes that question itself, so no allow rule or auto mode
    answers it. It names the server, URL, headers, scope and how to undo it.
  - With nobody to ask, the addition is refused.
  - Only Claude's own call is taken. A call from another plugin (its
    `$.tool.call`) is refused, at the check and at the run.
  - The add runs only for a call that question was put to, and only as it was
    put: the same URL, scope and name. A call checked before its card was
    shown is refused.
- **Never over a server you have.** A name taken in any scope isn't reused.
  Claude's add is refused, and the picker uses the next free name (`github-2`)
  and says so.
- **Which server:** only a card a tool showed in this session, or one that
  another plugin handed over and the picker showed.
- **Which URL:** when Claude adds it, only if the URL in Claude Code's
  approval prompt is the one the card gives. When you press **Add**, it is the
  URL shown beside the button.
- **Remotes:** a card from a public source may not name a private address.
- **Values:** a value put into a URL holds only letters, digits and
  `. _ ~ -`, so it can't change the host, path or query. The path written is
  the path reached, with no `.` or `..` segments.
- **Headers:** header names and values are checked for line breaks.

### Secrets

A secret the card asks for never passes through Claude, the command line or
the mod's store.

- The configuration holds a reference, `${MCP_<SERVER>__<INPUT>_<TAG>}`, for
  you to set. The tag is 80 bits of SHA-256 over the card's name and endpoint.
  So no other card can be given a reference to it, only the same card, which
  sends it to the same server. An earlier 32-bit tag could be matched in about
  a minute. That is fixed.
- Claude Code expands `${VAR}` in a server's URL and headers. So no text from a
  card or from Claude may contain `$`, and only the mod's own references carry
  one. Otherwise a card could aim that expansion at another secret in your
  environment.
- A secret may not stand in the host part of a URL.
- A card that sets a secret's value itself is refused: cards MUST NOT carry
  credentials.

### What it stores

In its plugin store (`~/.claude/plugins/store/`):

- the catalogs and cards it fetched, with their `ETag` and expiry, for at most
  40 entries of at most 64 KiB;
- for a page, only the catalog links found on it.

What another plugin handed over, and the picker's list, are kept for the
session.

### What it never does

It never reads Claude Code's credentials, runs no sign-in of its own, and
holds no token. It runs nothing a card says. The only commands it runs are
`claude mcp get` (to check whether a name is taken) and `claude mcp add`, with
arguments it builds itself.

### What another plugin can do through it

`present_server_cards` isn't offered to the model, and a call the model makes
is refused, so only a plugin's own code can call it. What a plugin hands over
is read as above.

A plugin can't add a server through this mod. `add_mcp_server` refuses any
call that isn't Claude's own, and only you can add one, with **Add** or by
approving Claude's request. A plugin can still run `claude mcp add` itself,
with the rights Claude Code gives it; see below.

## What it does not protect against

- **A public name that resolves to a private address, or a redirect to one.**
  Claude Code's `$.http.fetch` resolves names and follows redirects without
  reporting either, so only addresses named directly are refused.
- **Knowing where a redirect led.** A catalog fetched through a redirect is
  shown under the domain asked for (`neon.tech` for what `neon.com` served).
  SEP-2127 permits following it. Its one same-origin rule is for
  `extensionsInfo` used in a security decision, and this mod never reads
  `extensionsInfo`, so no redirect feeds a decision. See
  [A domain that redirects](README.md#a-domain-that-redirects).
- **A publisher's own bad server.** A valid card from the real publisher can
  still point at a server that misbehaves once connected. What that server can
  then do is up to Claude Code's permissions for MCP tools, as for any server
  you add.
- **An unconfirmed server you add anyway.** For a server another plugin found,
  the mod says plainly when its publisher doesn't confirm it. Adding it is your
  call.
- **A plugin you installed.** A plugin runs with the rights Claude Code gives
  it. This mod checks what a plugin hands over, but can't stop a plugin from
  doing harm by other means.
- **The card's claims about the live server.** They aren't checked against the
  connection (SEP-2127's SHOULD), because a mod can't send `server/discover`
  over Claude Code's connection.

## Undoing an addition

Run `claude mcp remove <name> -s local` (or `-s project`, `-s user`). Every
addition's result gives the exact line. The `project` scope writes
`.mcp.json`, which everyone who uses the repository shares.

## Reporting

Report a security issue privately, through this repository's
**Security → Report a vulnerability** form on GitHub, not in a public issue.
Name the polyfill (`mcp-server-cards`), the Claude Code version, and the
domain, catalog or card involved.
