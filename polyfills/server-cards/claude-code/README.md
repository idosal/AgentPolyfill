# mcp-server-cards for Claude Code

Name a company, and Claude finds the MCP servers its domain publishes. Press
**Add** under the answer, and Claude Code connects the server with its own
sign-in.

Also available for Codex, Pi and OpenCode: [mcp-server-cards for Codex](../codex/README.md), [mcp-server-cards for Pi](../pi/README.md), [mcp-server-cards for OpenCode](../opencode/README.md).

> What MCP servers does buildkite.com publish?

Claude reads that domain's catalog, fetches each Server Card it lists, checks
the card against the schema, and shows you what it found. Under the result is
a list of the servers you can add, each with an **Add** button. A press puts
the server into Claude Code's own MCP configuration, as if you had typed
`claude mcp add`. Nothing is installed besides that configuration entry, and
the polyfill never sees a token.

This Claude Code mod implements the client side of the MCP Server Cards
extension (SEP-2127), which Claude Code doesn't support itself yet. The
revisions it follows are in [Spec and conformance](#spec-and-conformance).

Agentic Resource Discovery (ARD) isn't in this plugin. ARD is a draft, not an
MCP specification. Its `/.well-known/ard.json`, its `rel="ard"` links and its
registry search are in a separate plugin,
[`ard-discovery`](../../ard/claude-code/README.md), because a search sends
your words to a third party. `ard-discovery` hands the cards it finds to this
plugin, which checks, shows and adds them in the same way. Installing
`ard-discovery` is how you turn ARD on.

## Install

At the prompt of a `claude` session:

```
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

Or in a terminal:

```bash
claude plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

Either one adds the [AgentPolyfill](../../../README.md) marketplace and
installs the plugin. With the marketplace already added,
`/plugin install mcp-server-cards@agent-polyfill` does the same. To add the
marketplace by itself, run `/plugin marketplace add idosal/AgentPolyfill`.

That is the whole install. You need:

- Claude Code 2.1.329 or newer, with mods (on by default from Claude Code
  2.1.287).
- Nothing else: no helper process, no Node, no account.

To add a server, the mod runs the `claude` command. It looks for it on your
`PATH`, then in the usual install folders (`~/.local/bin`, `~/.claude/local`,
`/opt/homebrew/bin`, `/usr/local/bin`). If neither works, it gives you the
exact command to run yourself.

The mod is one small folder, [`mod/`](mod/). To turn it off, set `disabled`
in `/config`, or disable or uninstall the plugin (`/plugin`).

To run it from a clone of this repository instead, for one session:

```bash
git clone https://github.com/idosal/AgentPolyfill
claude --plugin-dir AgentPolyfill/polyfills/server-cards/claude-code/mod
```

## Try it

Ask Claude "What MCP servers does neon.com publish?" and press **Add** on
**Neon Docs**, which needs no account. `claude mcp remove neon-docs -s local`
removes it again.

For a server behind a sign-in, ask "What MCP servers does buildkite.com
publish?" and press **Add** under the answer. Claude Code then asks you to
sign in to Buildkite through `/mcp`.

## How it works

### Step by step

1. **Ask.** For example "connect Claude Code to Buildkite", or "what MCP
   servers does neon.com publish?".
2. **Claude Code asks before the first lookup.** The first call to
   `discover_mcp_servers` gets Claude Code's usual permission prompt, as any
   new tool does. If you say no, nothing is fetched.
3. **Claude shows what it found:** each server's card, and whether the card is
   valid. A refused card says why, and nothing refused can be added.
4. **Pick one.** Under the result, a box lists the servers you can add. Each
   shows its name, the URL it connects to, the host on a line of its own, who
   stands behind it, and the server name and headers it would write, with an
   **Add** button.
   - Pressing **Add** adds that server, with the card as shown and its
     defaults, to the local scope (this project, only you). The press is your
     choice, so no further prompt follows.
   - It never replaces a server you have. If the name is taken in any scope,
     it adds the server as `name-2` (up to `name-9`) and says so.
   - A server whose card needs an input, such as a tenant name, shows no
     button. Ask Claude, and Claude asks you for it.
5. **Or ask Claude to add it.** Claude calls `add_mcp_server`, and Claude Code
   always asks you. The polyfill makes that question itself, so no allow rule
   or auto mode answers it for you. The question names the server, the URL,
   the headers, the scope and how to undo it.
   - The polyfill adds the server only if that URL is the one given by the
     card shown in this session, and only if no server of that name exists.
   - With nobody to ask (`claude -p`), the add is refused.
   - If you say no, nothing is written.
   - To use the `project` scope (`.mcp.json`, shared with the repository) or
     the `user` scope (all your projects), ask for it.
6. **Claude Code connects the server.** If it needs a sign-in, run `/mcp`,
   pick the server and authenticate. The sign-in is Claude Code's own, and the
   polyfill never sees it. If Claude Code doesn't pick up the new server at
   once, `/mcp` or a restart connects it.
7. **To undo an addition,** run `claude mcp remove <name> -s local` (or
   `-s project`, `-s user`). The result gives the exact line. The `project`
   scope writes `.mcp.json`, which everyone who uses the repository shares.
8. **If the card asks for a secret,** such as an API key, the polyfill never
   asks you for it and never shows it to Claude.
   - The configuration holds a reference such as
     `${MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ}`, and Claude tells you its name.
     Set that environment variable and restart Claude Code.
   - The tag at the end is 80 bits of SHA-256 over the card's name and URL. So
     no other card can be given a reference to it, only the same card, which
     sends it to the same server.

### A domain that redirects

Some domains answer with a redirect to another domain. `neon.tech`, for
example, sends `/.well-known/ai-catalog.json`, and every other path, to
`neon.com`.

- Claude Code's fetch follows redirects without saying where they led, so the
  polyfill can't tell. It shows the catalog under the domain you asked for.
  For `neon.tech`, that is "listed in
  https://neon.tech/.well-known/ai-catalog.json" and "listed by neon.tech",
  though `neon.com` served it.
- "Listed by" is all the polyfill can say. neon.tech's own server pointed
  there, as a catalog may point at cards on other domains.
- The card URLs inside are shown as the catalog wrote them (here, on
  `neon.com`).
- To see the origin that really serves a catalog, ask for the domain the
  company uses itself (`neon.com`).

This is within the spec:

- SEP-2127 and its discovery doc say nothing about following redirects for a
  catalog or a card, and a catalog "MAY reference Server Cards on different
  domains".
- Their one same-origin rule is for `extensionsInfo` used in a security
  decision. Such information must come from a card fetched from the remote's
  own origin, with no cross-origin redirect (rule S-4). The polyfill never
  uses `extensionsInfo`, so no redirect can feed a decision.
- A redirect to a local or private address is a different matter. It isn't
  caught: see [Limits](#limits).

### The tools

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list, and reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, scope?, values?)` | Adds a server shown in this session with `claude mcp add`, then asks Claude Code to connect it. `url` must be the URL the server will connect to. |
| `present_server_cards` | For other plugins only, never the model. See [For other plugins](#for-other-plugins). |

### For other plugins

`present_server_cards` lets another plugin have this one check, show and add
cards it found. It is kept from the model: the model isn't shown the tool, and
a call the model makes is refused. It takes:

- `by`: who found the cards, shown with the result.
- `under`: the caller's own `tool_use_id`, so the picker is drawn under the
  caller's row.
- Either `domain`, a domain to read as `discover_mcp_servers` does, or
  `entries`, AI Catalog entries found elsewhere, each with `listedIn` (where
  it was found).
- With either, optionally `catalogs` and `rels`, at most three of each.
  `catalogs` are further catalog URLs, which may be relative to the domain;
  each can carry `requireVersion: false` for a manifest that needs no
  `specVersion`. `rels` are further link relations to follow. Both are read
  on `domain`, and on each entry's publisher domain when that is checked.

It answers with JSON text, `{ text, servers, registries }`: the text Claude
reads, the number of valid cards, and the search registries the domain's
catalogs list. The object comes as JSON because Claude Code holds a registered
tool's result to text.

Everything a plugin hands over is checked as if this plugin had found it,
under the same address rules, and a server is confirmed only by its
publisher's own catalog.

### What differs between Claude Code and Codex

Both forms run the same card, discovery and configuration code, in
[`mod/hooks`](mod/hooks). The Codex form bundles it with a Codex front: an MCP
server, a form for consent, and `codex mcp add`.

| | Claude Code | Codex |
|---|---|---|
| What runs | a mod (hooks) inside Claude Code | a stdio MCP server in a Codex plugin, started with Node |
| Consent to an add | a question the mod makes in Claude Code's permission prompt | a form through MCP elicitation; refused without a form, or on a decline or close |
| A picker with **Add** buttons | under each result | none: the TUI draws no third-party UI, so you ask Codex to add a server |
| Where it's written | `claude mcp add`, in the scope you choose (local, project, user) | `codex mcp add`, into Codex's one configuration file (all projects). There is no `scope` |
| A name you already have | refused for Claude's add; the picker takes `name-2` | refused; pass another `name` |
| Secrets | `${VAR}` references in the URL and headers | names of environment variables (`bearer_token_env_var`, `env_http_headers`). Codex reads no `${VAR}`, so a card with a secret in its URL, or a secret mixed into a header (`Token {key}`), is refused |
| SSE remotes | added | refused: Codex connects to streamable HTTP servers only |
| Sign-in | `/mcp` | `codex mcp login <name>` |
| Redirects | followed by Claude Code's fetch, unseen, so one to a private address isn't caught | followed by the plugin, each hop under the same address rule, so a redirect to a local or private address is refused |
| Protocol revisions it adds for | Claude Code's: 2026-07-28 back to 2024-11-05 | Codex's: 2025-06-18 back to 2024-11-05. Codex 0.170.0 asks for 2025-06-18, and 2026-07-28 is behind its `mcp_2026_07_28` feature, which is off |
| The cache | the plugin store, kept between sessions | in memory, for one session |
| A notice after a web fetch | yes (`notice_on_fetch`) | no: a plugin can't see Codex's web fetches |
| Cards from another plugin (`present_server_cards`) | yes | no: one Codex plugin's server can't call another's tools, so `ard-discovery` carries the same core instead |
| Settings | `/config` | environment variables |

## Settings

The settings are in `/config`, under the plugin.

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `picker` | on | Shows the list of servers with **Add** buttons under discovery results, and under results another plugin handed over. Off: you add servers by asking Claude. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript: "buildkite.com publishes an MCP server (Server Card): Buildkite". Claude isn't told. Only sites Claude has already contacted are checked. |

### When Claude Code supports Server Cards itself

Claude Code has no Server Card support to detect yet. When it ships, turn on
the `disabled` setting. The polyfill then registers nothing and fetches
nothing.

## Limits

Each limit below names the host change that would remove it, where there is
one. The changes are described in
[What hosts would need to change](../../../docs/host-changes.md).

- **The card isn't compared with the live server** (rule S-3). With changes 1
  and 2, the polyfill would send `server/discover` over Claude Code's
  connection and compare the name, version and protocol revisions.
- **Claude Code's protocol revisions are listed by hand,** from its docs:
  2026-07-28 back to 2024-11-05. Change 2 would let the polyfill read the
  negotiated revision instead.
- **Redirects and DNS aren't visible.** Claude Code's `$.http.fetch` follows
  redirects without saying where they led, and resolves names itself. So a
  catalog reached through a redirect is shown under the domain you asked for
  ([A domain that redirects](#a-domain-that-redirects)). A private address
  named directly is refused. But a public URL that redirects to one, or a
  public name that resolves to one, isn't caught. A host API that reports
  redirects and the resolved address, or refuses private ones, would close
  this.
- **A secret needs a restart.** You set the environment variable, then
  restart. No host change is needed: this is how Claude Code reads `${VAR}`.
- **A server added mid-session may not connect at once.** That depends on
  Claude Code picking up `claude mcp add`. If it doesn't, Claude says so, and
  `/mcp` or a restart connects it.

## Security

[SECURITY.md](SECURITY.md) says what the polyfill sends, what it stores, what
it changes and what it trusts. In short:

- It reads public documents from the domain you name, and the card URLs that
  domain's catalog lists. It never fetches a local or private address unless
  you name one yourself.
- It changes only your MCP configuration, and only for the server you pick or
  approve.
- It never reads Claude Code's credentials, holds no token, and never puts a
  secret's value anywhere.

## Spec and conformance

It implements the client side of the MCP Server Cards extension, which Claude
Code doesn't support itself yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in
  [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card)
  at commit `28db12c9b4` (2026-11-19): `schema.ts` and `docs/discovery.md`.
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127
  hands domain discovery to: v0.9, a release candidate, at `19208af2f8`.

### Client rules

There is one row for each rule the specs put on a client, with the test that
covers it. The tests are in [`mod/tests`](mod/tests); run them with
`claude plugin test mod`. The Codex form runs the same code and tests for
these rules, and [its client rules](../codex/README.md#client-rules) list the
rows where Codex differs.

#### Discovery (SEP-2127 and the AI Catalog it names)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| D-1 | Attempt `https://{domain}/.well-known/ai-catalog.json` | discovery.md (SHOULD) | D-1 D-2, DEF-1, B-5 | met |
| D-2 | Honour `rel="ai-catalog"` links, in a `Link` header or a `<link>` tag | AI Catalog, Link Relation Discovery | D-7, D-13, D-15, DEF-2 | met |
| D-3 | Select the entries whose `type` is `application/mcp-server-card+json` | discovery.md, step 2 | D-3, E-1 | met |
| D-4 | Fetch a `url` entry's card with `Accept: application/mcp-server-card+json` | discovery.md (SHOULD) | D-3 | met |
| D-5 | Use a `data` entry's card inline | discovery.md, step 3 | D-4 | met |
| D-6 | Exactly one of `url` and `data` per entry | AI Catalog (MUST) | D-5, O-1 | met |
| D-7 | Limit nested catalogs; depth 4 is recommended | AI Catalog (SHOULD) | D-8 | met: limit 4 |
| D-8 | Read `specVersion` first, and reject an unsupported major version with an informative error | AI Catalog, Consumer Behavior (SHOULD) | D-9 | met (see [Findings](#findings-to-report-upstream)) |
| D-9 | The same `identifier` names the same artifact | AI Catalog | D-6 | met |
| V-1 | A card conforms to the schema: the v1 `$schema` URL, a reverse-DNS `name`, `version`, a `description` of 100 characters or fewer, remotes, inputs | schema.ts and schema.json | V-1 to V-5 | met: an invalid card is refused, never repaired |
| V-2 | `version` is one version, not a range | schema.ts, `ServerCard.version` | V-3 | met (see Findings) |
| P-1 | Never replace a server the person has | the polyfill's own | B-8, U-4 | met. For Claude's add, a name taken in any scope is refused. The picker uses the next free name and says so |
| P-2 | A person approves every addition Claude asks for | the polyfill's own | B-9, B-13, B-14, B-15 | met. A hook-made ask names the server, URL, headers, scope and undo. No rule or auto mode answers it, and it is refused with nobody to ask. Only Claude's own call is taken: a call from another plugin is refused, at the check and at the run. The add runs only for a call that was put to a person, and only as it was put (the same URL, scope and name). A check made before its card was shown is refused |
| V-3 | No text that displays as something else | the polyfill's own. SEP-2127 says cards are untrusted ("Clients MUST NOT treat Server Card contents as authoritative") | X-1, X-2, X-3, X-4, X-5, X-6, A-21, A-24, A-25, A-26, P-6, P-7, O-9, O-10, U-5 | A card is refused if any string in it, key or value, holds a C0 or C1 control, DEL, or an invisible format or bidirectional mark. A remote URL must be printable ASCII, with no `` ` ``, `<`, `>` or square brackets outside an IPv6 host, so Markdown or HTML can't show a link text in its place. The same goes for the URL a variable fills in, `websiteUrl`, `repository.url`, card and registry URLs, and a hand-over's `listedIn`. None of them may name a user before the host (an `@`, as in `https://good.example@evil.example/`) or hold a backslash (`https://evil.example\@good.example/`). Either one shows one host and connects to another. The picker shows the host on its own line, and Claude's add names it. Every value Claude gives is held to the same rules. Everything shown passes a plain-text filter, which also takes out characters that show as nothing (a soft hyphen, variation selectors, tag characters); those don't get a card refused, but a header value that would be written holding one is refused. A card carries no command or environment (remotes only), so none can reach `claude mcp add` that way |
| C-1 | Respect `Cache-Control` | discovery.md, Caching and Denial of Service (SHOULD) | C-1, C-3 | met |
| C-2 | Send the `ETag` back as `If-None-Match`, and accept `304` | discovery.md (SHOULD) | C-1, C-2, C-4 | met |
| C-3 | Avoid unnecessary polling | discovery.md (SHOULD) | by design: fetches happen only for a tool call, or once per site per session after a WebFetch | met |
| S-1 | HTTPS for cards; plain HTTP only for local development | discovery.md, Transport Security | S-1, T-1, A-7 | met |
| S-2 | Never treat a card as authoritative for security or access-control decisions | discovery.md (MUST NOT) | by design: a card only fills in `claude mcp add`, and every permission and sign-in decision stays with Claude Code | met |
| S-3 | Check the card's claims against the live connection, preferring the runtime values | discovery.md (SHOULD) | none | not met: see [Limits](#limits) |
| S-4 | "Extension information that a client relies on for a security decision … MUST only be used when the Server Card was retrieved over HTTPS from the same origin as that remote's `url` …, without following a redirect to another origin" | discovery.md, Consistency with Runtime Behavior (MUST) | S-4 | met by never using it: `extensionsInfo` isn't read, shown or acted on. This is the only same-origin or redirect rule in SEP-2127 and its discovery doc; see [A domain that redirects](#a-domain-that-redirects) |
| S-5 | Don't infer extension support from `extensionsInfo` | discovery.md (MUST NOT) | S-4 | met: never read |
| S-6 | Cards and catalogs MUST NOT carry credentials or private endpoints | discovery.md, Information Disclosure (a MUST on publishers) | A-12, A-13, P-1, P-4 | met on the client side: a card that pre-sets a secret is refused, and so is a public card or catalog that names a local or private address |
| I-1 | Inputs: a pre-set `value` can't be changed, `choices` limit the value, `default` fills an unset one, and required inputs are asked for | schema.ts, `Input` | A-2, A-4, A-6 | met |
| I-2 | Handle `isSecret` values securely | schema.ts, `Input` | A-3, A-10, A-15, A-17, A-18, F-2 | met. A secret is never taken from Claude or printed. The configuration holds a `${ENV_VAR}` reference named for this card alone. A secret may not stand in the URL's host |
| I-3 | Choose a remote by its `supportedProtocolVersions` | schema.ts, `Remote` | A-5 | met: a remote with no revision Claude Code speaks isn't added |
| I-4 | Transport `streamable-http` or `sse` | schema.ts, `Remote.type` | A-1, A-6 | met |

#### Cards another plugin found

Servers another plugin found and handed over through `present_server_cards`,
such as the `ard-discovery` plugin's search results, get every check above.
These rules apply on top:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| H-1 | Each is an AI Catalog entry: an `identifier`, exactly one of `url` and `data`, and where it was found | AI Catalog | O-1 | met: anything else is skipped |
| H-2 | Who stands behind a server: the publisher is the domain in `urn:air:<publisher>:…`, never an address or a local name | AI Catalog, identifier format | O-5 | met |
| H-3 | A server is confirmed only when the publisher's own catalog lists the same identifier with a valid card. That card is then the one shown and added | the polyfill's own: a finder's word isn't the publisher's | O-2 to O-4, O-8, B-10, B-12 | met: the publisher's domain is read with the finder's further sources too (ARD's `ard.json`) |
| H-4 | Only another plugin can hand cards over: the model isn't shown the tool, and a call of its own is refused | the polyfill's own | B-7, B-11 | met |

`add_mcp_server` takes such a server by `identifier`, and only one handed over
in this session. A URL is never taken from the conversation.

### Scope

- **In the polyfill:** the SEP-2127 client rules above.
- **For other plugins:** `present_server_cards`. A plugin that finds cards
  another way (`ard-discovery`) has them checked, shown and added here, with
  nothing duplicated.
- **Host presentation:** the tools, the picker under their results, and the
  one-line notice after a WebFetch. The extension's README describes that
  case: clients "can automatically discover Server Cards through AI Catalog
  entries advertised on domains present in agentic sessions".
- **Not in it:**
  - ARD, which is in [`ard-discovery`](../../ard/claude-code/README.md).
  - Verifying AI Catalog trust manifests and signatures. No card is ever
    called verified.
  - Agent skills, A2A cards and other artifact types in the same catalogs.
    They are counted, not used.
  - Local (stdio) servers, which cards don't describe.

### Proof

- **Per rule:** 110 tests, run with `claude plugin test mod`.
  - They cover the official example cards (`examples/ServerCard`, valid and
    invalid) and fixtures of my own for edge cases.
  - Nineteen of them (B-1 to B-15, U-1 to U-4) run through the plugin as
    Claude Code loads it. The engine's network, `claude mcp add` and connect
    are stood in for.
  - The picker is drawn on the terminal, desktop, VS Code and mobile
    surfaces, and a press of **Add** is followed to the exact `claude mcp add`
    it runs.
- **No audit by a person.** The polyfill was reviewed by an AI reviewer.
- **A limit of one test:** B-13 tests that a call from another plugin is
  refused for coming from another plugin. The test kit gives such a call
  nobody to ask, so it can't show whether a real host would.
- **Documents someone else wrote:** the catalogs and cards as served on
  2026-11-24 by Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion,
  Context7, Exa, Supabase and Zapier.
  - Ten of the eleven cards are valid. Zapier's is refused.
  - ajv, run with the official `schema.json`, gives the same verdict on all
    eleven.
  - Snapshots are in [`mod/tests/fixtures.ts`](mod/tests/fixtures.ts).
- **Checked in Claude Code 2.1.329** (CLI, 2.1.330 engine):
  `discover_mcp_servers`, discovery after a WebFetch, and
  `present_server_cards` called by `ard-discovery`.
- **Not checked in Claude Code:** adding a server end to end, by
  `add_mcp_server` or by the picker's **Add**.
- **Upstream conformance:** the MCP conformance suite has no Server Card
  scenarios (`modelcontextprotocol/conformance` at `96a6f9478b`).

### Findings to report upstream

Not yet reported upstream:

- **specVersion.** AI Catalog v0.9 says implementations of the release
  candidate use `"0.9"`, and that consumers "should not assume compatibility"
  with `"1.0"`. Yet the Server Cards discovery doc's examples, and every live
  catalog found, use `"1.0"`. This client accepts majors 0 and 1.
- **The well-known path.** ARD v0.91 makes `/.well-known/ard.json` a MUST and
  treats `ai-catalog.json` as optional. The Server Cards discovery doc names
  only `ai-catalog.json`. This plugin reads `ai-catalog.json`, and
  `ard-discovery` adds `ard.json`.
- **Version ranges.** schema.ts says version ranges are rejected, but the
  generated schema.json doesn't encode that rule.
- **Zapier.** `zapier.com/.well-known/mcp/server-card.json` has no `$schema`,
  and its description is over 100 characters.
- **JSON values.** schema.ts lets `extensionsInfo` values hold `null` and any
  JSON number. The generated schema.json allows neither `null` nor
  non-integers. This client follows schema.ts.
- **The ext-server-card README** still says "Experimental … not an accepted or
  official MCP extension", while the extensions overview lists it as Beta.

## Development

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

## Licence

Apache-2.0, like the rest of this repository ([LICENSE](../../../LICENSE)).

This is a community project. It isn't affiliated with or endorsed by
Anthropic, OpenAI, the Model Context Protocol project, the Agentic AI
Foundation or the Linux Foundation. Claude and Claude Code are trademarks of
Anthropic, PBC. OpenAI and Codex are trademarks of OpenAI.
