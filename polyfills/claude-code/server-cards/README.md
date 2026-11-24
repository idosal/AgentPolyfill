# mcp-server-cards: connect Claude Code to a company's MCP server by its domain

A Claude Code mod that lets Claude find the MCP servers a domain publishes, and connect Claude Code to one. Name a company, and Claude reads that domain's catalog, fetches each Server Card it lists, checks the card against the schema, and shows you what it found. Under the result there is a list of the servers you can add, each with an **Add** button.

> What MCP servers does neon.tech publish?

Press **Add**, and the server goes into Claude Code's own MCP configuration, as if you had typed `claude mcp add`. Claude Code then connects it with its own sign-in. Nothing is installed besides that configuration entry, and the polyfill never sees a token.

It adds the client side of the MCP **Server Cards** extension, which Claude Code does not support by itself yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) at commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127 hands domain discovery to, v0.9 (a release candidate) at `19208af2f8`.

This is a community project. It is not affiliated with or endorsed by Anthropic, the Model Context Protocol project, the Agentic AI Foundation or the Linux Foundation.

### Beyond SEP-2127: the ARD draft parts

Some of what this mod does comes from [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD) v0.91, at `f073b1ea9b`. ARD is a draft ("Proposal") from Google, R.V. Guha and Hugging Face, not an MCP specification. These parts are therefore outside this repository's rule that a polyfill implements [one published extension and nothing else](../../../docs/polyfill-contract.md):

- **`/.well-known/ard.json`**, the catalog location ARD names, read beside the `/.well-known/ai-catalog.json` that SEP-2127 names. Most sites that publish one also publish the other.
- **`rel="ard"` links** in a page's `<head>` or `Link` header.
- **Registry search**, `search_mcp_servers`: asking an ARD registry for a server that can do a task. It sends your query to that registry; see [Registry search](#registry-search).

They are on by default. To turn them all off, set **`ard`** to off in `/config` (under the plugin). Discovery then reads only `/.well-known/ai-catalog.json` (and `rel="ai-catalog"`, from the AI Catalog), and `search_mcp_servers` is gone.

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-server-cards --marketplace idosal/MCPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-server-cards --marketplace idosal/MCPolyfill
```

Either adds the [MCPolyfill](../../../README.md) marketplace and installs the plugin in one step. With the marketplace already added, `/plugin install mcp-server-cards@mcpolyfill` does the same. To add the marketplace by itself, use `/plugin marketplace add idosal/MCPolyfill`.

That is the whole install. You need:

- **Claude Code 2.1.329 or newer**, with mods (on by default from Claude Code 2.1.287).
- Nothing else: no helper process, no Node, no account.
- To add a server, it runs the `claude` command. That is found on your `PATH`, or in the usual install folders (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`). If neither works, it gives you the exact command to run yourself.

The mod is one small folder, [`mod/`](mod/). To turn it off, set `disabled` in `/config`, or disable or uninstall the plugin (`/plugin`).

To run it from a clone of this repository instead, for one session:

```bash
git clone https://github.com/idosal/MCPolyfill
claude --plugin-dir MCPolyfill/polyfills/claude-code/server-cards/mod
```

## Try it

Ask Claude "What MCP servers does neon.tech publish?", then press **Add** on **Neon Docs**: it needs no account. To remove it again: `claude mcp remove neon-docs -s local`.

## Using it, step by step

1. **Ask.** For example "connect Claude Code to Buildkite", "what MCP servers does neon.tech publish?", or, with ARD on, "find an MCP server that can check why my CI build failed".
2. **Claude Code asks before the first lookup.** The first call to `discover_mcp_servers` or `search_mcp_servers` gets Claude Code's usual permission prompt, as any new tool does. If you say no, nothing is fetched.
3. **Claude shows what it found:** each server's card, whether the card is valid, and, for a search result, whether the publisher's own domain confirms the server. A refused card says why; nothing refused can be added.
4. **Pick one.** Under the result, a box lists the servers you can add. Each shows its name, the URL it connects to, and who stands behind it, with an **Add** button.
   - Pressing **Add** adds that server, with the card as shown and its defaults, to the local scope (this project, only you). The press is your choice, so no further prompt follows.
   - A server whose card needs an input (a tenant name, say) shows no button. Ask Claude, who will ask you for it.
5. **Or ask Claude to add it.** Claude calls `add_mcp_server`, and Claude Code's permission prompt shows the URL to be added. The polyfill adds the server only if that URL is the one the card shown in this session gives. Ask for the `project` scope (`.mcp.json`, shared with the repository) or the `user` scope (all your projects) if you want one of those. If you say no, nothing is written.
6. **The server is connected.** If it needs a sign-in, run `/mcp`, pick the server and authenticate. The sign-in is Claude Code's own; the polyfill never sees it. If Claude Code doesn't pick up the new server at once, `/mcp` or a restart connects it.
7. **If the card asks for a secret** (an API key, say), the polyfill never asks you for it and never shows it to Claude.
   - The configuration holds a reference such as `${MCP_EXAMPLE__TOKEN_16WJ1KP}`, and Claude tells you its name. Set that environment variable and restart Claude Code.
   - The tag at the end ties the name to this one card, so no other card can be given a reference to it.

### Settings

They are in `/config`, under the plugin.

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `ard` | on | The ARD draft parts above: `ard.json`, `rel="ard"`, registry search. Off: only what SEP-2127 names. |
| `registry` | `https://huggingface-hf-discover.hf.space` | The ARD registry that `search_mcp_servers` asks when Claude names none. The query text is sent there. Empty: only a registry named in the request is used. |
| `picker` | on | Shows the list of servers with **Add** buttons under discovery and search results. Off: you add servers by asking Claude. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript: "buildkite.com publishes an MCP server (Server Card): Buildkite". Claude is not told. Only sites Claude has already contacted are checked. |

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `search_mcp_servers(query, registry?)` | (ARD) Asks an ARD registry; checks each card it returns, and whether the publisher's own catalog lists the server. Sends the query text to the registry. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, scope?, values?)` | Adds a server one of the two tools above showed in this session, with `claude mcp add`, then asks Claude Code to connect it. `url` must be the URL the server will connect to. |

## Client rules

There is one row for each rule the specs put on a client, and the test that covers it. The tests are in [`mod/tests`](mod/tests); run them with `claude plugin test mod`.

### Discovery (SEP-2127, ARD §5.1, AI Catalog)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| D-1 | Fetch `https://{domain}/.well-known/ard.json` | ARD §5.1 (MUST); ARD draft, off with `ard` | D-1 D-2, B-5 | met |
| D-2 | Attempt `/.well-known/ai-catalog.json`, as an equivalent source | discovery.md (SHOULD); ARD §5.1 (MAY) | D-1 D-2, D-6 | met |
| D-3 | Honour `rel="ard"` (ARD draft, off with `ard`) and `rel="ai-catalog"` links, in a `Link` header or a `<link>` tag | ARD §5.1 (MUST); AI Catalog | D-7, D-13, D-15, B-5 | met |
| D-4 | Select the entries whose `type` is `application/mcp-server-card+json` | discovery.md, step 2 | D-3, E-1 | met |
| D-5 | Fetch a `url` entry's card with `Accept: application/mcp-server-card+json` | discovery.md (SHOULD) | D-3 | met |
| D-6 | Use a `data` entry's card inline | discovery.md, step 3 | D-4 | met |
| D-7 | Exactly one of `url` and `data` per entry | AI Catalog (MUST); ARD §4.3 (MUST NOT carry both) | D-5 | met |
| D-8 | Limit nested catalogs; depth 4 is recommended | AI Catalog (SHOULD) | D-8 | met: limit 4 |
| D-9 | Read `specVersion` first; reject an unsupported major version with an informative error | AI Catalog, Consumer Behavior (SHOULD) | D-9 | met (see [Findings](#findings-to-report-upstream)) |
| D-10 | The same `identifier` names the same artifact | AI Catalog | D-6 | met |
| V-1 | A card conforms to the schema: the v1 `$schema` URL, a reverse-DNS `name`, `version`, a `description` of 100 characters or fewer, remotes, inputs | schema.ts and schema.json | V-1 to V-5 | met: an invalid card is refused, never repaired |
| V-2 | `version` is one version, not a range | schema.ts, `ServerCard.version` | V-3 | met (see Findings) |
| C-1 | Respect `Cache-Control` | discovery.md, Caching and Denial of Service (SHOULD) | C-1, C-3 | met |
| C-2 | Send the `ETag` back as `If-None-Match`; accept `304` | discovery.md (SHOULD) | C-1, C-2, C-4 | met |
| C-3 | Avoid unnecessary polling | discovery.md (SHOULD) | by design: fetches happen only for a tool call, or once per site per session after a WebFetch | met |
| S-1 | HTTPS for cards; plain HTTP only for local development | discovery.md, Transport Security | S-1, T-1, A-7 | met |
| S-2 | Never treat a card as authoritative for security or access-control decisions | discovery.md (MUST NOT) | by design: a card only fills in `claude mcp add`; every permission and sign-in decision stays with Claude Code | met |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | discovery.md (SHOULD) | none | **not met**: see [Limits](#limits-and-the-host-changes-that-would-remove-them) |
| S-4 | Use `extensionsInfo` for a security decision only from a same-origin HTTPS card with no cross-origin redirect | discovery.md (MUST) | n/a | not applicable: `extensionsInfo` is never used |
| S-5 | Don't infer extension support from `extensionsInfo` | discovery.md (MUST NOT) | n/a | not applicable: never read |
| S-6 | Cards and catalogs MUST NOT carry credentials or private endpoints | discovery.md, Information Disclosure (a MUST on publishers) | A-12, A-13, P-1, P-4 | met on the client side: a card that pre-sets a secret, or a public card or catalog that names a local or private address, is refused |
| I-1 | Inputs: a pre-set `value` can't be changed; `choices` limit the value; `default` fills an unset one; required inputs are asked for | schema.ts, `Input` | A-2, A-4, A-6 | met |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | A-3, A-10, A-15, A-17, A-18, F-2 | met. A secret is never taken from Claude or printed. The configuration holds a `${ENV_VAR}` reference named for this card alone. A secret may not stand in the URL's host |
| I-3 | Choose a remote by its `supportedProtocolVersions` | schema.ts, `Remote` | A-5 | met: a remote with no revision Claude Code speaks is not added |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | A-1, A-6 | met |

### Registry search

This part implements a second spec, the ARD v0.91 draft (§5.3), for MCP Server Cards only. It is outside SEP-2127, and the `ard` setting turns it off. It shares the card checks above.

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| R-1 | A registry entry's `url` is a base URL; the client appends `/search` | §5.3 | R-1 | met |
| R-2 | `POST /search` with `query.text` (required), `filter` and `federation` | §5.3.1, §5.3.2, §5.4 | R-2 | met: `filter.type` is the Server Card type; `federation` is `"referrals"`, so the client decides which referrals to follow |
| R-3 | A referral's `url` is the complete search endpoint, and the client MUST NOT append `/search` | §5.3 (MUST NOT) | R-3 | met: one hop, at most three referrals |
| R-4 | A result MUST carry `identifier`; its `url` addresses the artifact (the card), not the ARD entry | §5.3.2 | R-4 | met: results without one are skipped; each card is fetched and checked as in discovery |
| R-5 | `score` is relevance only, and MUST NOT be read as trust | §5.3.2, §5.3.3 (MUST NOT) | R-5 | met: shown as relevance, used for nothing |
| R-6 | The publisher is the `<publisher>` domain of `urn:air:<publisher>:…` | Appendix C | R-8 | met |
| R-7 | A claim to a publisher's name needs that publisher's attestation | §4.5.1 | R-5, R-6 | partly: trust manifests are not verified. Instead the publisher's own catalog is read, and a result is **confirmed** only if it lists the server; the publisher's own card is then the one used |
| R-8 | Standard error codes | Appendix B | R-7 | met: reported as `HTTP <code> (<errorCode>: <message>)` |

`add_mcp_server` takes a search result by `identifier`, and only a result a registry returned in this session. A URL is never taken from the conversation.

The default registry, Hugging Face Discover, is the only public ARD registry found. On 24 November 2026 it answered searches and referred to its Spaces registry, which was followed. Every MCP result it returned pointed at an MCP Registry `server.json` rather than a Server Card, so every one is refused (see Findings). Until a public registry serves valid cards, the [demo registry](#demo) stands in.

## Stand-down

Claude Code has no Server Card support to detect yet. When it ships, turn on the `disabled` setting: the polyfill then registers nothing and fetches nothing.

## Scope

- **In the polyfill:** the SEP-2127 client rules above.
- **Beside it, from the ARD draft, on by default and off with `ard`:** `/.well-known/ard.json`, `rel="ard"`, and registry search.
- **Host presentation:** the tools, the picker under their results, and the one-line notice after a WebFetch. The extension's README describes that case: clients "can automatically discover Server Cards through AI Catalog entries advertised on domains present in agentic sessions".
- **Not in it:**
  - ARD `POST /explore`, `GET /agents` and `federation: "auto"`.
  - Verifying AI Catalog or ARD trust manifests and signatures. No card is ever called verified.
  - Agent skills, A2A cards and other artifact types in the same catalogs. They are counted, not used.
  - Local (stdio) servers, which cards do not describe.

## Proof

- **Per rule:** 85 tests, run with `claude plugin test mod`.
  - They cover the official example cards (`examples/ServerCard`, valid and invalid) and fixtures of my own for edge cases.
  - Eight of them (B-1 to B-5, U-1 to U-3) run through the plugin as Claude Code loads it, with the engine's network, `claude mcp add` and connect stood in for.
  - The picker is drawn on the terminal, desktop, VS Code and mobile surfaces, and a press of **Add** is followed to the exact `claude mcp add` it runs.
- **Independent review:** two read-only review rounds by a second agent (Codex), on 2026-11-24. The first found 18 issues; the second checked the fixes and found 9 incomplete and 7 more issues. All of them are fixed, and each has a test: those marked "Review findings" and "Second review pass".
- **Documents someone else wrote:** the catalogs and cards live on 2026-11-24 from Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier.
  - Ten of the eleven cards are valid; Zapier's is refused.
  - ajv, run with the official `schema.json`, gives the same verdict on all eleven.
  - Snapshots are in [`mod/tests/fixtures.ts`](mod/tests/fixtures.ts).
- **A registry someone else runs:** Hugging Face Discover, including its referral.
- **The real host (Claude Code 2.1.329 CLI, 2.1.330 engine):**
  - `discover_mcp_servers` returned the cards for buildkite.com, huggingface.co and neon.tech.
  - `search_mcp_servers` against the demo registry returned Buildkite, confirmed by `buildkite.com/.well-known/ard.json`.
  - A subagent's WebFetch of a Buildkite docs page set off discovery of buildkite.com.
- **Not yet run in the real host:** adding a server end to end, by `add_mcp_server` or by the picker's **Add**. Claude Code's auto-mode permission check stopped the tool call, as it should for a configuration change. A person pressing **Add**, or approving the call, is the run still to record.
- **Upstream conformance:** the MCP conformance suite has no Server Card or ARD scenarios (`modelcontextprotocol/conformance` at `96a6f9478b`).

## Limits, and the host changes that would remove them

- **The card is not compared with the live server** (rule S-3). With changes 1 and 2 of [What a host needs to expose](../../../docs/host-changes.md), the polyfill would send `server/discover` over Claude Code's connection and compare the name, version and protocol revisions.
- **Claude Code's protocol revisions are listed by hand:** 2026-07-28 back to 2024-11-05, from its docs. Change 2 would let the polyfill read the negotiated revision instead.
- **Redirects and DNS aren't visible.** Claude Code's `$.http.fetch` follows redirects without saying where they led, and resolves names itself. A private address named directly is refused. But a public URL that redirects to one, or a public name that resolves to one, is not caught. A host API that reports redirects and the resolved address, or refuses private ones, would close this.
- **A secret needs a restart:** you set the environment variable, then restart. No host change is needed; this is how Claude Code reads `${VAR}`.
- **Whether a server added mid-session connects without a restart** depends on Claude Code picking up `claude mcp add`. If it doesn't, Claude says so; `/mcp` or a restart connects it.

## Privacy and security

What it sends, what it stores, what it changes and what it trusts are in [SECURITY.md](SECURITY.md). In short:
- It reads public documents from the domain you name and the card URLs that domain's catalog lists. It never fetches a local or private address unless you name one yourself.
- Search sends your query to the registry.
- It changes only your MCP configuration, and only for the server you pick or approve.
- It never reads Claude Code's credentials, holds no token, and never puts a secret's value anywhere.

## Demo

[`demo/registry.mjs`](demo/registry.mjs) is a demo ARD registry, not a real one. When it starts, it reads the live catalogs of ten publishers (Buildkite, GitHub, Notion, Neon, Supabase, Netlify, Exa, Context7, Hugging Face, Zapier). It keeps their Server Card entries as published, and answers `POST /search` by word match. Every result points at the publisher's own card, so each comes back confirmed.

```bash
node demo/registry.mjs
```

It listens on `http://127.0.0.1:9011`. Then, in Claude Code:

> My CI build failed and I don't have a tool for it. Search the registry at http://127.0.0.1:9011 for an MCP server that can check why.

Claude finds Buildkite and says buildkite.com's own catalog confirms it. It asks you, adds it, and Claude Code asks you to sign in through `/mcp`.

## Findings to report upstream

Found on 24 November 2026, and not yet reported:

- **specVersion.** AI Catalog v0.9 says implementations of the release candidate use `"0.9"`, and that consumers "should not assume compatibility" with `"1.0"`. Yet the Server Cards discovery doc's examples, and every live catalog found, use `"1.0"`. This client accepts majors 0 and 1.
- **The well-known path.** ARD v0.91 makes `/.well-known/ard.json` a MUST and treats `ai-catalog.json` as optional. The Server Cards discovery doc names only `ai-catalog.json`. This client reads both.
- **Version ranges.** schema.ts says version ranges are rejected; the generated schema.json does not encode that rule.
- **Hugging Face Discover** answers searches with entries typed `application/mcp-server-card+json` whose `url` is an MCP Registry `server.json` (a date-versioned `$schema`, a name with no namespace), and so does the Spaces registry it refers to. Those fail the card schema.
- **Zapier.** `zapier.com/.well-known/mcp/server-card.json` has no `$schema`, and its description is over 100 characters.
- **JSON values.** schema.ts lets `extensionsInfo` values hold `null` and any JSON number; the generated schema.json allows neither `null` nor non-integers. This client follows schema.ts.
- **The ext-server-card README** still says "Experimental … not an accepted or official MCP extension", while the extensions overview lists it as Beta.

## Develop

```bash
claude plugin validate mod
```

```bash
claude plugin test mod
```

The code is in [`mod/hooks`](mod/hooks):

| File | What it does |
|---|---|
| `card.ts` | Validates a card. |
| `discover.ts` | Resolves a domain. |
| `search.ts` | The registry client. |
| `http.ts` | The cache. |
| `configure.ts` | Turns a remote into `claude mcp add`. |
| `format.ts` | What Claude reads. |
| `install.ts` | Runs `claude mcp add` and connects. |
| `register.tsx` | Wires it into Claude Code, and draws the picker. |
