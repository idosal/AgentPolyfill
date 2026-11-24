# Security

This mod finds MCP servers through Agentic Resource Discovery (ARD v0.91): in a domain's `ard.json`, and by asking an ARD registry. A registry is a service someone else runs. Everything this mod finds is someone else's claim, and it is handed to `mcp-server-cards`, which checks it before you see it. Claude Code's own permissions and sign-in are the boundary. The mod adds no policy of its own.

The client rules it follows are listed with their tests in the [README](README.md#client-rules). What `mcp-server-cards` does with what it is handed is in [its SECURITY.md](../server-cards/SECURITY.md).

## What is trusted

- **You.** The registry is your choice: the `registry` setting, or one you name. So is every server you add.
- **Claude Code**: its permission dialog, its rules, its network policy, its sign-in.
- **`mcp-server-cards`**, the declared dependency that checks, shows and adds what this mod finds.
- **Not the registry.** It ranks other people's servers. Its score is relevance, never trust, and its descriptions are its own. A result counts as confirmed only when the publisher's own catalog lists the server.
- **Not the publishers.** A catalog can list anything, and a card can claim anything.

## What the mod sends, and where

**Search sends your query to a third party.** `ard_search` makes one `POST` of the query text to the registry's `/search` endpoint, with a filter for Server Cards and `federation: "referrals"`. With the default setting, that registry is Hugging Face Discover (`https://huggingface-hf-discover.hf.space`), run by Hugging Face. It then makes the same `POST` to at most three registries that registry refers to, one hop, and no further.
- Only the words Claude puts in `query` are sent, with `Content-Type` and `Accept` headers: no cookie, no credential, no file.
- Every result names each registry asked, and the tool's description says the query is sent, so Claude can tell you.
- The query is not stored.

**Discovery sends no query.** `ard_discover` hands the domain to `mcp-server-cards`, which makes plain `GET`s to that domain for `/.well-known/ai-catalog.json`, `/.well-known/ard.json` and the page's catalog links, and for the cards they list.

**After a search,** `mcp-server-cards` fetches each result's card and reads each publisher's own catalogs, as described in its SECURITY.md.

**Bounds:** three registries asked, three referrals, 50 results read per answer, 10 handed on, 512 KiB per answer.

## Where it won't go

- A public registry can't refer it to a local or private address: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local, unique-local, `.local` and `.internal` names, and single-label names.
- Registries are reached over HTTPS. Plain HTTP is used only for a loopback address you name yourself, as for the demo registry.
- What the registry returns is read under `mcp-server-cards`' address rules too: a result from a public registry may not point at a private address.

## What it writes and stores

Nothing. It changes no configuration and keeps no store. Adding a server is `mcp-server-cards`' job, and needs you: you press **Add**, or approve Claude's request in Claude Code's prompt.

## What it does not protect against

- **The registry seeing your query.** That is what a search is. Choose the registry you trust with it, or set `registry` to empty and name one each time.
- **A public name that resolves to a private address, or a redirect to one.** Claude Code's `$.http.fetch` resolves names and follows redirects without reporting either, so only addresses named directly are refused.
- **A registry that ranks a bad server first.** The order is the registry's. A server whose publisher doesn't confirm it is marked so, and adding it is your call.

## Security review

The launch security review (24 November 2026, by an AI session, not a human audit) read registry search while it was still part of `mcp-server-cards`. It checked that a result can't impersonate a publisher: a result is "confirmed" only when the publisher's own domain (from `urn:air:<publisher>`) lists it with a valid card, and then the publisher's card is the one shown and installed, not the registry's. That check now lives in `mcp-server-cards`, and this mod hands it ARD's sources, so a publisher that lists its server only in `ard.json` still confirms it (mcp-server-cards O-8, B-12). The review found nothing specific to search to fix.

## Reporting

Report a security issue privately, through this repository's **Security → Report a vulnerability** form on GitHub, not in a public issue. Name the plugin (`ard-discovery`), the Claude Code version, and the domain or registry involved.
