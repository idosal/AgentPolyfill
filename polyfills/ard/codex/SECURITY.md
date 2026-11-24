# Security

This plugin finds MCP servers through Agentic Resource Discovery (ARD v0.91): in a domain's `ard.json`, and by asking an ARD registry, a service someone else runs. Everything it finds is someone else's claim. It checks each card, and adds a server to Codex's MCP configuration only once you accept it in Codex's form. Codex's own permissions and sign-in are the boundary.

It runs the same registry client as the Claude Code form ([its SECURITY.md](../claude-code/SECURITY.md)) and the same Server Cards core as [`mcp-server-cards` for Codex](../../server-cards/codex/SECURITY.md), whose rules for fetching, checking, writing and secrets apply here unchanged. What is particular to this plugin is said here.

## What is trusted

- **You.** Every search is put to you first, in a form, and so is every server you add.
- **Codex**: its form, its approval settings, its sign-in.
- **Not the registry.** It ranks other people's servers. Its score is relevance, never trust, and its descriptions are its own. A result counts as confirmed only when the publisher's own catalog lists the server, and then the publisher's card is the one shown and added.
- **Not the publishers**, and **not Codex's model**: what it writes in `query` is sent only once you have seen it and accepted.

## What it sends, and where

**Search sends your query to a third party.** `ard_search` makes one `POST` of the query text to the registry's `/search` endpoint, with a filter for Server Cards and `federation: "referrals"`, then the same `POST` to at most three registries that registry refers to, one hop, and no further. With the default setting, that registry is a Hugging Face Space at `https://huggingface-hf-discover.hf.space`.
- **Each search asks you first,** through Codex's form (MCP elicitation): `Send this search to <endpoints>, and to up to three registries it refers to?`, then the query. A registry named by domain is resolved first, by reading that domain's catalogs (a `GET`, no query), so the form names the exact endpoints.
- **Nothing is sent** if Codex's client offers no form, or if you decline or close it. Under `--ask-for-approval never` and in `codex exec`, Codex declines the form itself, so nothing is sent. Under `--dangerously-bypass-approvals-and-sandbox`, Codex accepts the form itself, so the search is sent without asking you, as every tool runs without asking in that mode. See [the table](../../server-cards/codex/README.md#which-codex-modes-ask-you).
- **What is sent is what you saw:** a query over 300 characters, or with control characters, invisible characters or direction marks, is refused before you are asked.
- **Only where you were told.** A registry that redirects the search to another origin, or with a 301, 302 or 303 that would turn it into a `GET`, is not followed. A referral is a registry the first one names, and the form says up to three of those may be asked; every result names each registry that was.
- Only the words in `query` are sent, with `Content-Type`, `Accept` and a `User-Agent` naming the plugin: no cookie, no credential, no file. The query is not stored.

**Discovery sends no query.** `ard_discover` makes plain `GET`s to the domain for `/.well-known/ai-catalog.json`, `/.well-known/ard.json` and the page's catalog links, and for the cards they list.

**After a search,** it fetches each result's card and reads each publisher's own catalogs (`GET`s), at most five publishers per search.

**Bounds:** three registries asked, three referrals, 50 results read per answer, 10 shown, 512 KiB per answer.

## Text that displays as something else

The rules of `mcp-server-cards`: a result whose card URL or remote URL, a registry URL a catalog names, or where a result was found holds `` ` ``, `<`, `>` or a square bracket outside an IPv6 host is refused, so the form can't show a link text in place of a URL (security review C1). The query is shown verbatim, in quotes.

## Where it won't go

The address rules of `mcp-server-cards`, for registries and referrals as for catalogs and cards: HTTPS, plain HTTP only for a loopback address you name yourself (as for the demo registry), no step from a public source to a local or private address, and no redirect to one.

## What it writes and stores

It writes only Codex's MCP configuration, through `codex mcp add` (or `codex app-server` for headers), for a server you accept; see [mcp-server-cards](../../server-cards/codex/SECURITY.md). It keeps fetched catalogs and cards in memory for one session, and nothing on disk.

## What it does not protect against

- **The registry seeing your query, once you accept.** That is what a search is. Read the query in the form. Set `ARD_DISCOVERY_REGISTRY` to a registry you trust with it, or to empty and name one each time.
- **A public name that resolves to a private address.** Node's `fetch` resolves names itself; only addresses named directly, and redirects, are checked.
- **A registry that ranks a bad server first.** The order is the registry's. A server whose publisher doesn't confirm it is marked so, and adding it is your call.
- **Running Codex with `--dangerously-bypass-approvals-and-sandbox`.** Codex accepts the form itself, so a search Codex's model writes is sent, and a server it asks for is added, without asking you. That is your choice of mode, and the plugin does not override it: it can't tell Codex's answer from yours. Codex putting the approval mode in a tool call's metadata would let it.

## Reporting

Report a security issue privately, through this repository's **Security → Report a vulnerability** form on GitHub, not in a public issue. Name the plugin (`ard-discovery`, Codex form), the Codex version, and the domain or registry involved.
