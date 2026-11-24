# MCP Server Cards for Claude Code

`mcp-server-cards` lets Claude find the MCP servers a company publishes and connect Claude Code to one, starting from nothing more than a domain name, or from a description of what you need.

> Connect Claude Code to Buildkite.

Claude reads `buildkite.com`'s catalog, fetches the official Server Card it lists, and checks it against the schema. Once you approve, it adds the server to Claude Code's MCP configuration. Claude Code then connects the server itself, with its own sign-in, as if you had typed `claude mcp add`.

> My CI build failed and I don't have a tool for it. Find an MCP server that can check why.

Claude asks an Agentic Resource Discovery registry, checks each card the same way, and tells you which results their publisher confirms on its own domain.

It is a polyfill: the client side of one published extension, done as the spec says, to be turned off once Claude Code supports the extension itself. Server Cards are new, and Claude Code doesn't read them yet. This is a community project. It is not affiliated with or endorsed by Anthropic, the Model Context Protocol project, the Agentic AI Foundation or the Linux Foundation.

## The extension

| | |
|---|---|
| Extension | MCP Server Cards, `io.modelcontextprotocol/server-card` |
| Spec | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (extension stage: Beta), with [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) `schema.ts` and `docs/discovery.md` at commit `28db12c9b4` (2026-11-19) |
| Discovery layer it delegates to | [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD) v0.91 §5.1, a Proposal, at `f073b1ea9b` (2026-10-25); and its predecessor [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9, a release candidate, at `19208af2f8` (2026-11-19) |
| Registry search, a second spec kept apart | ARD v0.91 §5.3 and §5.4. Not part of SEP-2127; see [Registry search](#registry-search) |
| Host | Claude Code 2.1.329 or later, as a mod (the mod API is early access) |

A Server Card is a small public JSON document describing a remote MCP server: its name, version, description, and the endpoints and inputs needed to connect. A domain lists its cards in a catalog at `/.well-known/ard.json`, the name ARD gives. Most sites today use the older `/.well-known/ai-catalog.json`, which is the name the Server Cards discovery doc gives. Cards say nothing about tools on purpose: those come from the live connection, as always.

On 24 November 2026, Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa and Supabase each published at least one valid card.

## Install

```
/plugin install mcp-server-cards --marketplace idosal/MCPolyfill
```

In a terminal:

```bash
claude plugin install mcp-server-cards --marketplace idosal/MCPolyfill
```

Or in two steps:

```
/plugin marketplace add idosal/MCPolyfill
/plugin install mcp-server-cards@mcpolyfill
```

It needs Claude Code 2.1.329 or later and nothing else: no helper process, no runtime, no account. Adding a server uses the `claude` command, which is on your `PATH` wherever Claude Code was installed from a terminal.

## Using it, step by step

1. **Install.** Claude Code asks you to confirm the marketplace (`y`) and a scope, then shows the plugin's three settings with their defaults (below). Enter accepts them.
2. **Ask.** For example "connect Claude Code to Buildkite", "what MCP servers does neon.tech publish?", or "find an MCP server that can check why my CI build failed".
3. **Claude Code asks before the first lookup.** The first call to `discover_mcp_servers` or `search_mcp_servers` gets Claude Code's usual permission prompt, as any new tool does. If you say no, nothing is fetched.
4. **Claude shows what it found:** each server's card, whether the card is valid, and, for search results, whether the publisher's own domain confirms the server. A refused card says why; nothing refused can be added.
   - **The picker:** under the result, a box lists the servers you can add. Each shows its name, the URL it connects to and who stands behind it, with an **Add** button. Pressing **Add** adds that server, with the card as shown and its defaults, to the local scope. The press is your choice, so no further prompt follows. A server whose card needs an input (a tenant name, say) shows no button: ask Claude, who will ask you for it.
5. **Or Claude asks you, then calls `add_mcp_server`, and Claude Code asks again.** This prompt is for a change to your configuration. It shows the URL the server will connect to. The polyfill adds the server only if that is the URL the card shown in this session yields. If you say no, nothing is written.
6. **The server is added and connected.** By default it goes in the local scope (this project, only you). You can ask for `project` (`.mcp.json`, shared with the repository) or `user` (all your projects).
7. **If the server needs a sign-in,** run `/mcp`, pick the server and authenticate. The sign-in is Claude Code's own; the polyfill never sees it.
8. **If the card asks for a secret** (an API key, say), the polyfill never asks you for it and never shows it to Claude. The configuration holds a reference such as `${MCP_EXAMPLE__TOKEN_16WJ1KP}`, and Claude tells you its name. Set that environment variable and restart Claude Code. The tag at the end ties the name to this one card, so no other card can ever be given a reference to it.

### Settings

They are in `/config`, under the plugin.

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `registry` | `https://huggingface-hf-discover.hf.space` | The ARD registry that `search_mcp_servers` asks when Claude names none. The query text is sent there. Empty: only a registry named in the request is used. |
| `picker` | on | Shows the picker under discovery and search results. Off: you add servers by asking Claude only. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript: "buildkite.com publishes an MCP server (Server Card): Buildkite". Claude is not told. Only sites Claude has already contacted are checked. |

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `search_mcp_servers(query, registry?)` | Asks an ARD registry; checks each card it returns, and whether the publisher's own catalog lists the server. Sends the query text to the registry. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, scope?, values?)` | Adds a server one of the two tools above showed in this session, with `claude mcp add`, then asks Claude Code to connect it. `url` must be the URL the server will connect to. |

## Client rules

There is one row for each rule the specs put on a client, and the test that covers it. The tests are in [`mod/tests`](mod/tests); run them with `claude plugin test mod`.

### Discovery (SEP-2127, ARD §5.1, AI Catalog)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| D-1 | Fetch `https://{domain}/.well-known/ard.json` | ARD §5.1 (MUST) | D-1 D-2 | met |
| D-2 | Attempt `/.well-known/ai-catalog.json`, as an equivalent source | discovery.md (SHOULD); ARD §5.1 (MAY) | D-1 D-2, D-6 | met |
| D-3 | Honour `rel="ard"` (and `rel="ai-catalog"`) links, in a `Link` header or a `<link>` tag | ARD §5.1 (MUST); AI Catalog | D-7 | met |
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

This part implements a second spec, ARD v0.91 §5.3, for MCP Server Cards only. It shares the card checks above.

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

- **In the polyfill:** the client rules above.
- **Host presentation:** the three tools, and the one-line notice after a WebFetch. The extension's README describes that case: clients "can automatically discover Server Cards through AI Catalog entries advertised on domains present in agentic sessions".
- **Not in it:**
  - ARD `POST /explore`, `GET /agents` and `federation: "auto"`.
  - Verifying AI Catalog or ARD trust manifests and signatures. No card is ever called verified.
  - Agent skills, A2A cards and other artifact types in the same catalogs. They are counted, not used.
  - Local (stdio) servers, which cards do not describe.

## Proof

- **Per rule:** 83 tests, run with `claude plugin test mod`.
  - They cover the official example cards (`examples/ServerCard`, valid and invalid) and fixtures of my own for edge cases.
  - Six of them (B-1 to B-3, U-1 to U-3) run through the plugin as Claude Code loads it, with the engine's network, `claude mcp add` and connect stood in for.
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

**What it sends:**
- **Discovery:** plain `GET`s, through Claude Code's own network path and web-fetch policy. It reads `https://<domain>/.well-known/ard.json` and `/.well-known/ai-catalog.json`, the page you named (or the domain's home page) for `rel="ard"` links, and the card and nested-catalog URLs those catalogs name. The only headers are `Accept` and `If-None-Match`, with no cookies and no credentials.
- **Search:** a `POST` with your query text to the registry (the `registry` setting, or the one Claude names), up to three registries it refers to, and the publisher domains of the valid results.
- **The notice after a WebFetch:** the same `GET`s as discovery, only for a site Claude has just fetched from.
- **No local network:** a public catalog or registry can't send it to `localhost` or a private address. Local development (`http://localhost`) works only when you name a local address yourself.

**What it stores:** in its plugin store (`~/.claude/plugins/store/`), the catalogs and cards it fetched with their `ETag` and expiry, and for a page only the catalog links found on it. That is at most 300 entries; older ones are dropped. Query text is not stored. Search results are kept in memory for the session only.

**What it changes:** only your MCP configuration, through `claude mcp add`, in the scope you choose. That happens after you approve Claude's call, or when you press **Add** in the picker (always the local scope).
- A secret is stored as a `${VAR}` reference, never as its value.
- Claude Code expands `${VAR}` in a server's URL and headers. So no text from a card, or from Claude, may contain `$`; otherwise a card could aim that expansion at another secret in your environment. Only the polyfill's own references carry one, each named for one card.
- A value put into a URL holds only letters, digits and `. _ ~ -`, so it can't change the host, path or query. The path that is written is the path that is reached, with no `..`.
- The approval prompt shows the URL to be added, and nothing else is added. Only a card shown in this session can be added.

**What it trusts:**
- Text from a catalog, card or registry is someone else's claim. Claude sees it with control characters removed, lengths capped, and a label saying whose claim it is.
- A registry's ranking is never treated as trust. Only the publisher's own catalog confirms a server.
- It never reads Claude Code's credentials and runs no sign-in of its own.

Report security issues through this repository's **Security → Report a vulnerability** form.

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
