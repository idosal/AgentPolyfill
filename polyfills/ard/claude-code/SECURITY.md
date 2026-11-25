# Security

This covers `ard-discovery` for Claude Code. The Codex form has its own:
[SECURITY.md](../codex/SECURITY.md).

This mod finds MCP servers through Agentic Resource Discovery (ARD v0.91): in
a domain's `ard.json`, and by asking an ARD registry. A registry is a service
someone else runs. Everything this mod finds is someone else's claim, and it
is handed to `mcp-server-cards`, which checks it before you see it. Claude
Code's own permissions and sign-in are the boundary. The mod adds no policy of
its own.

The client rules it follows are listed with their tests in the
[README](README.md#client-rules). What `mcp-server-cards` does with what it is
handed is in [its SECURITY.md](../../server-cards/claude-code/SECURITY.md).

## What is trusted

- **You.** Every search is put to you first, and so is every server you add.
  The registry is yours to choose: none is set by default. A search uses the
  registry named in the request, or the one you set with the `registry`
  setting.
- **Claude Code:** its permission dialog, its rules, its network policy, its
  sign-in.
- **`mcp-server-cards`,** the declared dependency that checks, shows and adds
  what this mod finds.
- **Not the registry.** It ranks other people's servers. Its score is
  relevance, never trust, and its descriptions are its own. A result counts as
  confirmed only when the publisher's own catalog lists the server.
- **Not the publishers.** A catalog can list anything, and a card can claim
  anything.

## What the mod sends, and where

### A search sends your query to a third party

`ard_search` makes one `POST` of the query text to the registry's `/search`
endpoint, with a filter for Server Cards and `federation: "referrals"`.

- No registry is set by default. The registry is the one named in the
  request, or the one you set with `registry`. With neither, the search is
  refused before you are asked, and nothing is sent.
- It then makes the same `POST` to at most three registries that registry
  refers to, one hop, and no further.
- **Each search asks you first.** Before anything is sent, Claude Code shows
  you the query and where it goes:
  `Send this search to <registry>, and to up to three registries it refers to? "<query>"`.
  For a registry named by domain, it says
  `the registries that <domain> lists (up to three)`. The mod makes that question itself, so no allow rule or auto
  mode answers it. If you say no, nothing is sent.
- **What is sent is what you were shown.** A query is refused if it is longer
  than the 300 characters the question shows, or holds control characters,
  invisible characters (tag characters and variation selectors among them) or
  direction marks, which could make the question read differently from what
  is sent. A registry, named or set, is refused if it is over 200 characters
  or holds spaces, control characters, invisible characters or direction
  marks. So the question names exactly where the search goes.
- **A registry's own words are one line.** Its error messages, the referrals
  it names, and each result's name and description are shown on one line,
  capped, with control and invisible characters taken out. So a registry can't
  add lines of its own to the answer, or carry text you don't see. A result
  whose identifier holds such a character is skipped.
- **A session with nobody to ask can't search.** In `claude -p`, or a
  background loop, every search is refused and nothing is sent.
- Only the words Claude puts in `query` are sent, with `Content-Type` and
  `Accept` headers: no cookie, no credential, no file.
- Every result names each registry asked, and the tool's description says the
  query is sent, so Claude can tell you.
- The query isn't stored.

### Discovery sends no query

`ard_discover` hands the domain to `mcp-server-cards`. That plugin makes plain
`GET`s to the domain for `/.well-known/ai-catalog.json`,
`/.well-known/ard.json` and the page's catalog links, and for the cards they
list.

### After a search

`mcp-server-cards` fetches each result's card and reads each publisher's own
catalogs, as its SECURITY.md describes.

### Bounds

Three registries asked, three referrals, 50 results read per answer, 10
handed on, 512 KiB per answer.

## Where it won't go

- A public registry can't refer it to a local or private address: `localhost`,
  `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local, unique-local,
  `.local` and `.internal` names, and single-label names.
- Registries are reached over HTTPS. Plain HTTP is used only for a loopback
  address you name yourself, as for the demo registry.
- What the registry returns is read under `mcp-server-cards`' address rules
  too: a result from a public registry may not point at a private address.

## What it writes and stores

Nothing. It changes no configuration and keeps no store. Adding a server is
`mcp-server-cards`' job, and needs you: you press **Add**, or approve Claude's
request in Claude Code's prompt.

## What it does not protect against

- **The registry seeing your query, once you say yes.** That is what a search
  is. Read the query in the prompt before you allow it. Set `registry` only to
  a registry you trust with it, or leave it empty and name one each time.
- **A public name that resolves to a private address, or a redirect to one.**
  Claude Code's `$.http.fetch` resolves names and follows redirects without
  reporting either, so only addresses named directly are refused.
- **A registry that ranks a bad server first.** The order is the registry's. A
  server whose publisher doesn't confirm it is marked so, and adding it is your
  call.

## Security review

The launch security review (24 November 2026, by an AI session, not a human
audit) read registry search while it was still part of `mcp-server-cards`.

- It checked that a result can't impersonate a publisher. A result is
  "confirmed" only when the publisher's own domain (from
  `urn:air:<publisher>`) lists it with a valid card. Then the publisher's card
  is the one shown and installed, not the registry's.
- That check now lives in `mcp-server-cards`, and this mod hands it ARD's
  sources. So a publisher that lists its server only in `ard.json` still
  confirms it (mcp-server-cards O-8, B-12).
- Its pre-merge re-check of the split (M2) found that Claude decided when to
  search and what to write. Only Claude Code's ordinary permission for the
  tool was in the way, and nothing under auto mode or an allow rule. Every
  search is now put to you first, and refused with nobody to ask (A-7, A-8).

## Reporting

Report a security issue privately, through this repository's
**Security → Report a vulnerability** form on GitHub, not in a public issue.
Name the plugin (`ard-discovery`), the Claude Code version, and the domain or
registry involved.
