# mcp-server-cards: connect Claude Code to a company's MCP server by its domain

A Claude Code mod that lets Claude find the MCP servers a domain publishes, and connect Claude Code to one. Name a company, and Claude reads that domain's catalog, fetches each Server Card it lists, checks the card against the schema, and shows you what it found. Under the result there is a list of the servers you can add, each with an **Add** button.

> What MCP servers does buildkite.com publish?

Press **Add**, and the server goes into Claude Code's own MCP configuration, as if you had typed `claude mcp add`. Claude Code then connects it with its own sign-in. Nothing is installed besides that configuration entry, and the polyfill never sees a token.

It adds the client side of the MCP **Server Cards** extension, which Claude Code does not support by itself yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) at commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127 hands domain discovery to, v0.9 (a release candidate) at `19208af2f8`.

This is a community project. It is not affiliated with or endorsed by Anthropic, the Model Context Protocol project, the Agentic AI Foundation or the Linux Foundation.

### What it does not do: ARD

Agentic Resource Discovery (ARD) is a draft, not an MCP specification. Its `/.well-known/ard.json`, `rel="ard"` links and registry search are not in this plugin. They are in a separate plugin, [`ard-discovery`](../ard), which finds cards that way and hands them to this one, to be checked, shown and added in the same way. Installing `ard-discovery` is how you turn ARD on.

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

Either adds the [AgentPolyfill](../../../README.md) marketplace and installs the plugin in one step. With the marketplace already added, `/plugin install mcp-server-cards@agent-polyfill` does the same. To add the marketplace by itself, use `/plugin marketplace add idosal/AgentPolyfill`.

That is the whole install. You need:

- **Claude Code 2.1.329 or newer**, with mods (on by default from Claude Code 2.1.287).
- Nothing else: no helper process, no Node, no account.
- To add a server, it runs the `claude` command. That is found on your `PATH`, or in the usual install folders (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`). If neither works, it gives you the exact command to run yourself.

The mod is one small folder, [`mod/`](mod/). To turn it off, set `disabled` in `/config`, or disable or uninstall the plugin (`/plugin`).

To run it from a clone of this repository instead, for one session:

```bash
git clone https://github.com/idosal/AgentPolyfill
claude --plugin-dir AgentPolyfill/polyfills/server-cards/claude-code/mod
```

## Try it

Ask Claude "What MCP servers does buildkite.com publish?", then press **Add** under the answer. Claude Code asks you to sign in to Buildkite through `/mcp`. For one that needs no account, ask about neon.com and press **Add** on **Neon Docs**; `claude mcp remove neon-docs -s local` removes it again.

## Using it, step by step

1. **Ask.** For example "connect Claude Code to Buildkite", or "what MCP servers does neon.com publish?".
2. **Claude Code asks before the first lookup.** The first call to `discover_mcp_servers` gets Claude Code's usual permission prompt, as any new tool does. If you say no, nothing is fetched.
3. **Claude shows what it found:** each server's card, and whether the card is valid. A refused card says why; nothing refused can be added.
4. **Pick one.** Under the result, a box lists the servers you can add. Each shows its name, the URL it connects to and, on its own line, the host, who stands behind it, and the server name and headers it would write, with an **Add** button.
   - Pressing **Add** adds that server, with the card as shown and its defaults, to the local scope (this project, only you). The press is your choice, so no further prompt follows.
   - It never replaces a server you have. If the name is taken in any scope, it adds the server as `name-2` (up to `name-9`) and says so.
   - A server whose card needs an input (a tenant name, say) shows no button. Ask Claude, who will ask you for it.
5. **Or ask Claude to add it.** Claude calls `add_mcp_server`, and Claude Code always asks you: the polyfill makes that question itself, so no allow rule or auto mode answers it for you. It names the server, the URL, the headers, the scope and how to undo it. The polyfill adds the server only if that URL is the one the card shown in this session gives, and only if no server of that name exists. With nobody to ask (`claude -p`), it is refused. Ask for the `project` scope (`.mcp.json`, shared with the repository) or the `user` scope (all your projects) if you want one of those. If you say no, nothing is written.
6. **The server is connected.** If it needs a sign-in, run `/mcp`, pick the server and authenticate. The sign-in is Claude Code's own; the polyfill never sees it. If Claude Code doesn't pick up the new server at once, `/mcp` or a restart connects it.
7. **To undo an addition:** `claude mcp remove <name> -s local` (or `-s project`, `-s user`). The result gives the exact line. The `project` scope writes `.mcp.json`, which is shared with everyone who uses the repository.
8. **If the card asks for a secret** (an API key, say), the polyfill never asks you for it and never shows it to Claude.
   - The configuration holds a reference such as `${MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ}`, and Claude tells you its name. Set that environment variable and restart Claude Code.
   - The tag at the end is 80 bits of SHA-256 over the card's name and URL. So no other card can be given a reference to it: only the same card, which sends it to the same server.

### A domain that redirects

Some domains answer with a redirect to another domain: `neon.tech` sends `/.well-known/ai-catalog.json`, and every other path, to `neon.com`.
- Claude Code's fetch follows redirects without saying where they led. So the polyfill can't tell, and it shows the catalog under the domain you asked for: for `neon.tech`, "listed in https://neon.tech/.well-known/ai-catalog.json" and "listed by neon.tech", though `neon.com` served it. "Listed by" is all the polyfill can say: neon.tech's own server pointed there, as a catalog may point at cards on other domains.
- The card URLs inside are shown as the catalog wrote them (here, on `neon.com`).
- To see the origin that really serves a catalog, ask for the domain the company uses itself (`neon.com`).

This is within the spec:
- SEP-2127 and its discovery doc say nothing about following redirects for a catalog or a card, and a catalog "MAY reference Server Cards on different domains".
- Their one same-origin rule is for `extensionsInfo` used in a security decision: such information must come from a card fetched from the remote's own origin, with no cross-origin redirect (rule S-4). The polyfill never uses `extensionsInfo`, so no redirect can feed a decision.
- A redirect to a local or private address is a different matter: it is not caught (see [Limits](#limits-and-the-host-changes-that-would-remove-them)).

### Settings

They are in `/config`, under the plugin.

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `picker` | on | Shows the list of servers with **Add** buttons under discovery results, and under another plugin's results that it was handed. Off: you add servers by asking Claude. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript: "buildkite.com publishes an MCP server (Server Card): Buildkite". Claude is not told. Only sites Claude has already contacted are checked. |

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, scope?, values?)` | Adds a server shown in this session, with `claude mcp add`, then asks Claude Code to connect it. `url` must be the URL the server will connect to. |
| `present_server_cards` | For other plugins only, never the model: see [For other plugins](#for-other-plugins). |

## Client rules

There is one row for each rule the specs put on a client, and the test that covers it. The tests are in [`mod/tests`](mod/tests); run them with `claude plugin test mod`.

### Discovery (SEP-2127 and the AI Catalog it names)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| D-1 | Attempt `https://{domain}/.well-known/ai-catalog.json` | discovery.md (SHOULD) | D-1 D-2, DEF-1, B-5 | met |
| D-2 | Honour `rel="ai-catalog"` links, in a `Link` header or a `<link>` tag | AI Catalog, Link Relation Discovery | D-7, D-13, D-15, DEF-2 | met |
| D-3 | Select the entries whose `type` is `application/mcp-server-card+json` | discovery.md, step 2 | D-3, E-1 | met |
| D-4 | Fetch a `url` entry's card with `Accept: application/mcp-server-card+json` | discovery.md (SHOULD) | D-3 | met |
| D-5 | Use a `data` entry's card inline | discovery.md, step 3 | D-4 | met |
| D-6 | Exactly one of `url` and `data` per entry | AI Catalog (MUST) | D-5, O-1 | met |
| D-7 | Limit nested catalogs; depth 4 is recommended | AI Catalog (SHOULD) | D-8 | met: limit 4 |
| D-8 | Read `specVersion` first; reject an unsupported major version with an informative error | AI Catalog, Consumer Behavior (SHOULD) | D-9 | met (see [Findings](#findings-to-report-upstream)) |
| D-9 | The same `identifier` names the same artifact | AI Catalog | D-6 | met |
| V-1 | A card conforms to the schema: the v1 `$schema` URL, a reverse-DNS `name`, `version`, a `description` of 100 characters or fewer, remotes, inputs | schema.ts and schema.json | V-1 to V-5 | met: an invalid card is refused, never repaired |
| V-2 | `version` is one version, not a range | schema.ts, `ServerCard.version` | V-3 | met (see Findings) |
| P-1 | Never replace a server the person has | the polyfill's own, from the security review (SC2) | B-8, U-4 | met. A name taken in any scope is refused for Claude's add; the picker uses the next free name and says so |
| P-2 | A person approves every addition Claude asks for | the polyfill's own, from the security review (SC4, its re-check, and M1) | B-9, B-13, B-14, B-15 | met. A hook-made ask names the server, URL, headers, scope and undo. No rule or auto mode answers it, and it is refused with nobody to ask. Only Claude's own call is taken: a call from another plugin is refused, at the check and at the run. The add runs only for a call that was put to a person, and only as it was put (the same URL, scope and name); a check made before its card was shown is refused |
| V-3 | No text that displays as something else | the polyfill's own, from the security review: SEP-2127 says cards are untrusted ("Clients MUST NOT treat Server Card contents as authoritative") | X-1, X-2, X-3, X-4, X-5, A-21, A-24, A-25, P-6, P-7, O-9, O-10, U-5 | A card is refused if any string in it, key or value, holds a C0 or C1 control, DEL, or an invisible format or bidirectional mark. A remote URL must be printable ASCII, without `` ` ``, `<`, `>` or square brackets outside an IPv6 host, so Markdown or HTML can't show a link text in its place (security review of the Codex forms, C1); so must the URL a variable fills in, `websiteUrl`, `repository.url`, card and registry URLs, and a hand-over's `listedIn`. None of them may name a user before the host (an `@`, as in `https://good.example@evil.example/`) or hold a backslash (`https://evil.example\@good.example/`), either of which shows one host and connects to another (C3). The picker shows the host on its own line, and Claude's add names it. The same holds for every value Claude gives. Everything shown passes a plain-text filter. A card carries no command or environment (remotes only), so none can reach `claude mcp add` that way |
| C-1 | Respect `Cache-Control` | discovery.md, Caching and Denial of Service (SHOULD) | C-1, C-3 | met |
| C-2 | Send the `ETag` back as `If-None-Match`; accept `304` | discovery.md (SHOULD) | C-1, C-2, C-4 | met |
| C-3 | Avoid unnecessary polling | discovery.md (SHOULD) | by design: fetches happen only for a tool call, or once per site per session after a WebFetch | met |
| S-1 | HTTPS for cards; plain HTTP only for local development | discovery.md, Transport Security | S-1, T-1, A-7 | met |
| S-2 | Never treat a card as authoritative for security or access-control decisions | discovery.md (MUST NOT) | by design: a card only fills in `claude mcp add`; every permission and sign-in decision stays with Claude Code | met |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | discovery.md (SHOULD) | none | **not met**: see [Limits](#limits-and-the-host-changes-that-would-remove-them) |
| S-4 | "Extension information that a client relies on for a security decision … MUST only be used when the Server Card was retrieved over HTTPS from the same origin as that remote's `url` …, without following a redirect to another origin" | discovery.md, Consistency with Runtime Behavior (MUST) | S-4 | met by never using it: `extensionsInfo` is not read, shown or acted on. This is the only same-origin or redirect rule in SEP-2127 and its discovery doc; see [A domain that redirects](#a-domain-that-redirects) |
| S-5 | Don't infer extension support from `extensionsInfo` | discovery.md (MUST NOT) | S-4 | met: never read |
| S-6 | Cards and catalogs MUST NOT carry credentials or private endpoints | discovery.md, Information Disclosure (a MUST on publishers) | A-12, A-13, P-1, P-4 | met on the client side: a card that pre-sets a secret, or a public card or catalog that names a local or private address, is refused |
| I-1 | Inputs: a pre-set `value` can't be changed; `choices` limit the value; `default` fills an unset one; required inputs are asked for | schema.ts, `Input` | A-2, A-4, A-6 | met |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | A-3, A-10, A-15, A-17, A-18, F-2 | met. A secret is never taken from Claude or printed. The configuration holds a `${ENV_VAR}` reference named for this card alone. A secret may not stand in the URL's host |
| I-3 | Choose a remote by its `supportedProtocolVersions` | schema.ts, `Remote` | A-5 | met: a remote with no revision Claude Code speaks is not added |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | A-1, A-6 | met |

### Cards another plugin found

Servers another plugin found and handed over through `present_server_cards` (the `ard-discovery` plugin's search results, say) get every check above. Beyond those:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| H-1 | Each is an AI Catalog entry: an `identifier`, exactly one of `url` and `data`, and where it was found | AI Catalog | O-1 | met: anything else is skipped |
| H-2 | Who stands behind a server: the publisher is the domain in `urn:air:<publisher>:…`, never an address or a local name | AI Catalog, identifier format | O-5 | met |
| H-3 | A server is **confirmed** only when the publisher's own catalog lists the same identifier with a valid card; that card is then the one shown and added | the polyfill's own: a finder's word is not the publisher's | O-2 to O-4, O-8, B-10, B-12 | met: the publisher's domain is read with the finder's further sources too (ARD's `ard.json`) |
| H-4 | Only another plugin can hand cards over: the model is not shown the tool, and a call of its own is refused | the polyfill's own | B-7, B-11 | met |

`add_mcp_server` takes such a server by `identifier`, and only one handed over in this session. A URL is never taken from the conversation.

## Stand-down

Claude Code has no Server Card support to detect yet. When it ships, turn on the `disabled` setting: the polyfill then registers nothing and fetches nothing.

## Scope

- **In the polyfill:** the SEP-2127 client rules above.
- **For other plugins:** `present_server_cards`, so that a plugin which finds cards another way (`ard-discovery`) has them checked, shown and added here, with nothing duplicated.
- **Host presentation:** the tools, the picker under their results, and the one-line notice after a WebFetch. The extension's README describes that case: clients "can automatically discover Server Cards through AI Catalog entries advertised on domains present in agentic sessions".
- **Not in it:**
  - ARD, in [`ard-discovery`](../ard).
  - Verifying AI Catalog trust manifests and signatures. No card is ever called verified.
  - Agent skills, A2A cards and other artifact types in the same catalogs. They are counted, not used.
  - Local (stdio) servers, which cards do not describe.

## Proof

- **Per rule:** 108 tests, run with `claude plugin test mod`.
  - They cover the official example cards (`examples/ServerCard`, valid and invalid) and fixtures of my own for edge cases.
  - Nineteen of them (B-1 to B-15, U-1 to U-4) run through the plugin as Claude Code loads it, with the engine's network, `claude mcp add` and connect stood in for.
  - The picker is drawn on the terminal, desktop, VS Code and mobile surfaces, and a press of **Add** is followed to the exact `claude mcp add` it runs.
- **Independent security review** for the launch (24 November 2026), by an AI session, not a human audit. Its findings SC1 to SC7 are fixed and tested (V-3, P-1, P-2, A-21 to A-23, X-1 to X-3). So are the narrow paths around the SC4 ask that its re-checks found: a check made before the card was shown (B-14), a call from another plugin (B-13), and a run that differs from what was approved (B-15). B-13 tests that such a call is refused for coming from another plugin. The test kit gives such a call nobody to ask, so it can't show whether a real host would.
- **Earlier reviews:** two read-only review rounds by a second agent (Codex), on 2026-11-24. The first found 18 issues; the second checked the fixes and found 9 incomplete and 7 more issues. All of them are fixed, and each has a test: those marked "Review findings" and "Second review pass".
- **Documents someone else wrote:** the catalogs and cards live on 2026-11-24 from Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa, Supabase and Zapier.
  - Ten of the eleven cards are valid; Zapier's is refused.
  - ajv, run with the official `schema.json`, gives the same verdict on all eleven.
  - Snapshots are in [`mod/tests/fixtures.ts`](mod/tests/fixtures.ts).
- **The real host (Claude Code 2.1.329 CLI, 2.1.330 engine):**
  - `discover_mcp_servers` returned the cards for buildkite.com, huggingface.co, neon.com, and neon.tech (which redirects to neon.com).
  - A subagent's WebFetch of a Buildkite docs page set off discovery of buildkite.com.
  - With `ard-discovery` loaded beside it, `present_server_cards` read buildkite.com's `ard.json` for that plugin, and checked the results of two registry searches against their publishers, confirming Netlify through `netlify.com/.well-known/ard.json`.
- **Not yet run in the real host:** adding a server end to end, by `add_mcp_server` or by the picker's **Add**. Claude Code's auto-mode permission check stopped the tool call, as it should for a configuration change. A person pressing **Add**, or approving the call, is the run still to record.
- **Upstream conformance:** the MCP conformance suite has no Server Card scenarios (`modelcontextprotocol/conformance` at `96a6f9478b`).

## Limits, and the host changes that would remove them

- **The card is not compared with the live server** (rule S-3). With changes 1 and 2 of [What a host needs to expose](../../../docs/host-changes.md), the polyfill would send `server/discover` over Claude Code's connection and compare the name, version and protocol revisions.
- **Claude Code's protocol revisions are listed by hand:** 2026-07-28 back to 2024-11-05, from its docs. Change 2 would let the polyfill read the negotiated revision instead.
- **Redirects and DNS aren't visible.** Claude Code's `$.http.fetch` follows redirects without saying where they led, and resolves names itself. A catalog reached through a redirect is therefore shown under the domain asked for ([A domain that redirects](#a-domain-that-redirects)). A private address named directly is refused. But a public URL that redirects to one, or a public name that resolves to one, is not caught. A host API that reports redirects and the resolved address, or refuses private ones, would close this.
- **A secret needs a restart:** you set the environment variable, then restart. No host change is needed; this is how Claude Code reads `${VAR}`.
- **Whether a server added mid-session connects without a restart** depends on Claude Code picking up `claude mcp add`. If it doesn't, Claude says so; `/mcp` or a restart connects it.

## Privacy and security

What it sends, what it stores, what it changes and what it trusts are in [SECURITY.md](SECURITY.md). In short:
- It reads public documents from the domain you name and the card URLs that domain's catalog lists. It never fetches a local or private address unless you name one yourself.
- It changes only your MCP configuration, and only for the server you pick or approve.
- It never reads Claude Code's credentials, holds no token, and never puts a secret's value anywhere.

## For other plugins

`present_server_cards` lets another plugin have this one check, show and add cards it found. It is kept from the model: the model is not shown the tool, and a call of the model's own is refused. It takes:

- `by`: who found them, shown with the result.
- `under`: the caller's own `tool_use_id`, so the picker is drawn under the caller's row.
- `domain`, a domain to read as `discover_mcp_servers` does;
- or `entries`: AI Catalog entries found elsewhere, each with `listedIn` (where it was found);
- and, with either, `catalogs` (further catalog URLs, which may be relative to the domain, each with `requireVersion: false` for a manifest that needs no `specVersion`) and `rels` (further link relations to follow), at most three of each. They are read on `domain`, and on each entry's publisher domain when that is checked.

It answers with JSON text, `{ text, servers, registries }`: the text Claude reads, the number of valid cards, and the search registries the domain's catalogs list. (Claude Code holds a registered tool's result to text, so the object comes as JSON.) Everything it is handed is checked as if this plugin had found it, under the same address rules, and a server is confirmed only by its publisher's own catalog.

## Findings to report upstream

Found on 24 November 2026, and not yet reported:

- **specVersion.** AI Catalog v0.9 says implementations of the release candidate use `"0.9"`, and that consumers "should not assume compatibility" with `"1.0"`. Yet the Server Cards discovery doc's examples, and every live catalog found, use `"1.0"`. This client accepts majors 0 and 1.
- **The well-known path.** ARD v0.91 makes `/.well-known/ard.json` a MUST and treats `ai-catalog.json` as optional. The Server Cards discovery doc names only `ai-catalog.json`. This plugin reads `ai-catalog.json`; `ard-discovery` adds `ard.json`.
- **Version ranges.** schema.ts says version ranges are rejected; the generated schema.json does not encode that rule.
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
| `offer.ts` | Reads cards another plugin handed over, and checks them against their publisher. |
| `http.ts` | The cache. |
| `configure.ts` | Turns a remote into `claude mcp add`. |
| `format.ts` | What Claude reads. |
| `install.ts` | Runs `claude mcp add` and connects. |
| `register.tsx` | Wires it into Claude Code, and draws the picker. |
