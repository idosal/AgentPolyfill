# Security

This plugin finds MCP servers through Agentic Resource Discovery (ARD v0.91): in a domain's `ard.json`, and by asking an ARD registry, a service someone else runs. Everything it finds is someone else's claim. It checks each card, and adds a server to Codex's MCP configuration only once you accept it in Codex's form. Codex's own permissions and sign-in are the boundary.

It runs the same registry client as the Claude Code form ([its SECURITY.md](../claude-code/SECURITY.md)) and the same Server Cards core as [`mcp-server-cards` for Codex](../../server-cards/codex/SECURITY.md), whose rules for fetching, checking, writing and secrets apply here unchanged. What is particular to this plugin is said here.

## What is trusted

- **You.** Every search is put to you first, in a form, and so is every server you add. The registry is yours to choose: none is set by default. A search uses the registry named in the request, or the one you set with `ARD_DISCOVERY_REGISTRY`.
- **Codex**: its form, its approval settings, its sign-in.
- **Not the registry.** It ranks other people's servers. Its score is relevance, never trust, and its descriptions are its own. A result counts as confirmed only when the publisher's own catalog lists the server, and then the publisher's card is the one shown and added.
- **Not the publishers**, and **not Codex's model**: what it writes in `query` is sent only once you have seen it and accepted.

## What it sends, and where

**Search sends your query to a third party.** `ard_search` makes one `POST` of the query text to the registry's `/search` endpoint, with a filter for Server Cards and `federation: "referrals"`, then the same `POST` to at most three registries that registry refers to, one hop, and no further. No registry is set by default: the registry is the one named in the request, or the one you set with `ARD_DISCOVERY_REGISTRY`. With neither, the search is refused before you are asked, and nothing is sent.
- **Each search asks you first,** through Codex's form (MCP elicitation): `<hosts>: send this search to <endpoints>, and to up to three registries it refers to?`, then the query. A registry named by domain is resolved first, by reading that domain's catalogs (a `GET`, no query), so the form names the exact endpoints.
- **Only your explicit choice sends.** The form is one required choice, **Don't send it** or **Send the search**. Nothing is sent if Codex's client offers no form, or if you decline or close it, choose **Don't send it**, or send it back without a choice. Under `--ask-for-approval never` and in `codex exec`, Codex declines the form itself, so nothing is sent. Codex 0.172 shows a form with a required choice to the person even under `--dangerously-bypass-approvals-and-sandbox` (it auto-accepts only forms with no fields: `can_auto_accept_elicitation` in `codex-mcp/src/elicitation.rs` at `rust-v0.172.0`). More exactly, in that mode it shows the form where the Codex client takes form input (it declares `openai/standard-form-input`, for a thread the person started), and otherwise declines it, so nothing is sent. This is Codex 0.172's behaviour, not something the MCP spec promises, and a later Codex may change it. See [the table](../../server-cards/codex/README.md#which-codex-modes-ask-you).
- **What is sent is what you saw:** a query over 300 characters, or with control characters, invisible characters, direction marks, or `` ` ``, `<`, `>` or square brackets (Markdown or HTML, which a host could render as something else in the form), is refused before you are asked. So is a registry, named or set, over 200 characters or with spaces, control characters or direction marks, so the form names exactly where the search goes.
- **Only where you were told.** A registry that redirects the search to another origin, or with a 301, 302 or 303 that would turn it into a `GET`, is not followed. A referral is a registry the first one names, and the form says up to three of those may be asked; every result names each registry that was.
- Only the words in `query` are sent, with `Content-Type`, `Accept` and a `User-Agent` naming the plugin: no cookie, no credential, no file. The query is not stored.

**Discovery sends no query.** `ard_discover` makes plain `GET`s to the domain for `/.well-known/ai-catalog.json`, `/.well-known/ard.json` and the page's catalog links, and for the cards they list.

**After a search,** it fetches each result's card and reads each publisher's own catalogs (`GET`s), at most five publishers per search.

**Bounds:** three registries asked, three referrals, 50 results read per answer, 10 shown, 512 KiB per answer.

## Text that displays as something else

The rules of `mcp-server-cards`: a result whose card URL or remote URL, a registry URL a catalog names, or where a result was found holds `` ` ``, `<`, `>` or a square bracket outside an IPv6 host, or names a user before its host, is refused, so the form can't show a link text, or one host, in place of the URL (security reviews C1 and C3). A registry the request names is held to the same rule before the form is shown. The query is shown verbatim, in quotes, and holds none of those characters either.

## Where it won't go

The address rules of `mcp-server-cards`, for registries and referrals as for catalogs and cards: HTTPS, plain HTTP only for a loopback address you name yourself (as for the demo registry), no step from a public source to a local or private address, and no redirect to one.

## What it writes and stores

It writes only Codex's MCP configuration, through `codex mcp add` (or `codex app-server` for headers), for a server you accept; see [mcp-server-cards](../../server-cards/codex/SECURITY.md). It keeps fetched catalogs and cards in memory for one session, and nothing on disk.

## What it does not protect against

- **The registry seeing your query, once you accept.** That is what a search is. Read the query in the form. Set `ARD_DISCOVERY_REGISTRY` only to a registry you trust with it, or leave it unset and name one each time.
- **A public name that resolves to a private address.** Node's `fetch` resolves names itself; only addresses named directly, and redirects, are checked.
- **A registry that ranks a bad server first.** The order is the registry's. A server whose publisher doesn't confirm it is marked so, and adding it is your call.
- **A later Codex that answers forms differently.** The plugin can't tell Codex's answer from yours, so it relies on Codex 0.172's rule that a form with a field is never accepted by itself. Codex putting the approval mode in a tool call's metadata is the proper fix.

## Reporting

Report a security issue privately, through this repository's **Security → Report a vulnerability** form on GitHub, not in a public issue. Name the plugin (`ard-discovery`, Codex form), the Codex version, and the domain or registry involved.
