# Security

This mod reads documents that strangers publish on the web: catalogs and Server Cards, and the answers of a search registry. It turns one of those cards into an entry in your Claude Code MCP configuration. Every rule below follows from that. What a catalog, card or registry says is someone else's claim, read before any connection. Claude Code's own permissions and sign-in are the boundary, and the mod adds no policy of its own.

The client rules it follows, from SEP-2127 and, for the parts marked ARD, from the ARD v0.91 draft, are listed with their tests in the [README](README.md#client-rules).

## What is trusted

- **You.** The servers you pick with **Add**, or approve when Claude asks.
- **Claude Code**: its permission dialog, its rules, its network policy, its sign-in.
- **Not the publishers.** A catalog can list anything, and a card can claim anything. The SEP says a card is advisory and never authoritative for security decisions.
- **Not the registry.** A search registry is a third party ranking other people's cards. Its score is relevance, never trust.

## What the mod does

**What it fetches.** Plain `GET`s, through Claude Code's own network path and under its web-fetch policy, with only `Accept` and `If-None-Match` headers: no cookies, no credentials. It reads:
- for a domain you name: `/.well-known/ai-catalog.json` and that page's `rel="ai-catalog"` links, plus, with the `ard` setting on (off by default), `/.well-known/ard.json` and `rel="ard"` links;
- the cards and nested catalogs those name;
- for search (only with `ard` on): one `POST` of your query text to the registry, and up to three registries it refers to;
- after a WebFetch: that site's catalogs, once per session.

Every fetch is bounded: at most 512 KiB per answer, 20 cards, 3 page links, 3 registries plus 3 referrals, 50 results per answer, 5 publisher checks, and nested catalogs 4 deep.

**Where it won't go.**
- A public catalog, card or registry can't send it to a local or private address: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local, unique-local, `.local` and `.internal` names, and single-label names. That holds whatever the spelling (`0x7f.1`, a trailing dot).
- Plain HTTP is used only for a loopback address you name yourself, for local development.

**Text that displays as something else.**
- A card is refused if any string in it holds a control character (C0, DEL, C1) or an invisible format or bidirectional mark. That rules out an ESC sequence that rewrites a line, an OSC 8 link, or a right-to-left override.
- A remote URL must be printable ASCII. So what the picker shows beside **Add** is what is added.
- Values Claude gives are held to the same rule.
- Everything shown (the picker, tool results, notices, toasts) also passes a plain-text filter.

**What reaches the model.** A card's fields, and a registry's names and descriptions. Each is labelled with whose claim it is, with control characters removed and lengths capped. A refused card shows only why it was refused. A secret's default value is never shown.

**What it writes.** Only your MCP configuration, through `claude mcp add`, for one server at a time.
- **Which server:** only a card a tool showed in this session.
- **Which URL:** when Claude adds it, only if the URL in Claude Code's approval prompt is the one the card gives. When you press **Add**, it is the URL shown beside the button.
- **Remotes:** a card from a public source may not name a private address.
- **Values:** a value put into a URL holds only letters, digits and `. _ ~ -`, so it can't change the host, path or query. The path written is the path reached, with no `.` or `..` segments.
- **Headers:** header names and values are checked for line breaks.

**Secrets.** A secret the card asks for never passes through Claude, the command line or the mod's store.
- The configuration holds a reference, `${MCP_<SERVER>__<INPUT>_<TAG>}`, for you to set. The tag is drawn from the card's name and endpoint, so no other card can be given a reference to it.
- Claude Code expands `${VAR}` in a server's URL and headers. So no text from a card or from Claude may contain `$`, and only the mod's own references carry one. Otherwise a card could aim that expansion at another secret in your environment.
- A secret may not stand in the host part of a URL.
- A card that sets a secret's value itself is refused: cards MUST NOT carry credentials.

**What it stores.** In its plugin store (`~/.claude/plugins/store/`):
- the catalogs and cards it fetched, with their `ETag` and expiry, for at most 40 entries of at most 64 KiB;
- for a page, only the catalog links found on it.

Query text is not stored. Search results and the picker's list are kept for the session.

**What it never does.** It never reads Claude Code's credentials, runs no sign-in of its own, and holds no token. It runs nothing a card says: the only command it runs is `claude mcp add`, with arguments it builds itself.

## What it does not protect against

- **A public name that resolves to a private address, or a redirect to one.** Claude Code's `$.http.fetch` resolves names and follows redirects without reporting either, so only addresses named directly are refused.
- **Knowing where a redirect led.** A catalog fetched through a redirect is shown under the domain asked for (`neon.tech` for what `neon.com` served). SEP-2127 permits following it. Its one same-origin rule is for `extensionsInfo` used in a security decision, and this mod never reads `extensionsInfo`, so no redirect feeds a decision. See [A domain that redirects](README.md#a-domain-that-redirects).
- **A publisher's own bad server.** A valid card from the real publisher can still point at a server that misbehaves once connected. What that server can then do is up to Claude Code's permissions for MCP tools, as for any server you add.
- **An unconfirmed search result you add anyway.** The mod says plainly when a server's publisher does not confirm it. Adding it is your call.
- **The card's claims about the live server.** They are not checked against the connection (SEP-2127's SHOULD), because a mod can't send `server/discover` over Claude Code's connection.

## Reporting

Report a security issue privately, through this repository's **Security → Report a vulnerability** form on GitHub, not in a public issue. Name the polyfill (`mcp-server-cards`), the Claude Code version, and the domain, catalog or card involved.
