# ard-discovery for Codex

Codex finds MCP servers through Agentic Resource Discovery (ARD): in what a
domain lists, or by asking an ARD registry for a server that can do a task.
You choose the registry, and Codex shows you a form before every search.

Also available for Claude Code, Pi and OpenCode: [ard-discovery for Claude Code](../claude-code/README.md), [ard-discovery for Pi](../pi/README.md), [ard-discovery for OpenCode](../opencode/README.md).
The same plugin folder also holds the Muse Code form, with its own manifest and bundles: [ard-discovery for Muse Code](../muse/README.md).

> Find an MCP server that can check why my CI build failed.

This Codex plugin adds the consumer side of
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) for MCP
servers. It finds servers in two ways:

- **By domain.** It reads a domain's `/.well-known/ard.json` and the
  `rel="ard"` links on its home page, beside the AI Catalog.
- **By task.** It asks an ARD registry, in plain words, for a server that can
  do something.

Each Server Card it finds is checked against the schema. A search result
counts as confirmed only when the publisher's own domain lists it. To add a
server, Codex shows you a form, and only on your accept does the server go
into Codex's MCP configuration.

**A search sends your query to a third party.** `ard_search` posts the words
of your request to an ARD registry: a service someone else runs, which ranks
other people's servers.

- The plugin ships with no registry, so you choose which one sees your words.
  Name it in the request (a registry base URL, or a domain whose catalog lists
  one), or set it with `ARD_DISCOVERY_REGISTRY`. With neither, a search is
  refused and nothing is sent.
- Codex shows you a form before every search, naming the registry and the
  exact query. Nothing is sent unless you accept.
- Discovery by domain sends nothing but plain `GET`s to that domain.

ARD is a draft, not an MCP specification. The revision this plugin follows is
in [Spec and conformance](#spec-and-conformance).

## Install

In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add ard-discovery@agent-polyfill
```

With the marketplace already added, `codex plugin add ard-discovery@agent-polyfill`
is enough, and `codex plugin list` shows it. Start a new Codex session
afterwards. It works on its own. Installing
[`mcp-server-cards`](../../server-cards/codex/README.md) beside it is optional.

You need Codex CLI 0.170.0 or newer (tested with 0.170.0 and 0.172.0) and
Node.js 20 or newer on your `PATH`. Nothing else: no account, no key.

To remove it, run `codex plugin remove ard-discovery@agent-polyfill`.

## In Muse Code

This folder also holds the Muse Code form: its own manifest
(`.muse-plugin/plugin.json`) and bundles (`muse/`), built from
[`../muse`](../muse) with this form's sources unchanged. This form's bundle is
the same with or without it, and Codex doesn't read the Muse manifest or
anything in `muse/`: installed into a throwaway Codex home, the plugin gives
Codex the same skills, MCP server and tools as without them, and no hooks
([`tools/muse/codex-ignores-muse.mjs`](../../../tools/muse/codex-ignores-muse.mjs),
run with Codex 0.172.0). [ard-discovery for Muse Code](../muse/README.md) has the
install steps, what works differently there and why, its limits, and its
security notes.

## Try it

Ask Codex "What does buildkite.com list in its ard.json?", then "Add it".
Codex shows a form. Accept it, then run `codex mcp login buildkite` to sign
in.

To try search without sending anything to a third party, start the
[demo registry](../claude-code/README.md#demo-registry) from a clone. Run
`node polyfills/ard/claude-code/demo/registry.mjs`, which listens on
`http://127.0.0.1:9011`, and ask: "Search the registry at
http://127.0.0.1:9011 for an MCP server that can check why my CI build
failed."

## How it works

### Step by step

1. **Ask.** For example "find an MCP server that can check why my CI build
   failed", or "what does buildkite.com list in its ard.json?".
2. **By domain (`ard_discover`):** it reads the domain's
   `/.well-known/ai-catalog.json` and `/.well-known/ard.json`, and follows
   `rel="ai-catalog"` and `rel="ard"` links on the page. It fetches each Server
   Card listed and checks it. The tool is read-only.
3. **By task (`ard_search`):** if no registry is set and you named none, Codex
   asks you which one to search. If the registry is named by domain, the
   plugin first reads that domain's catalogs for the registries they list (a
   `GET`, no query). Then Codex shows you the form. Here it is for a registry
   named as `https://registry.example`:

   ```
   registry.example: send this search to https://registry.example/search, and to up to three registries it refers to?
   Query: "check why my CI build failed"
   A registry is a service someone else runs, and it sees the query.
   ```

   - **Accept**, and the query is posted, then sent on to at most three
     registries the first one refers to, one hop.
   - **Decline** or close it, and nothing is sent.
   - The query sent is the one shown: at most 300 characters, on one line,
     with no invisible characters or direction marks. It may hold no
     `` ` ``, `<`, `>` or square brackets, which a host could render as
     Markdown or HTML. Any other query is refused before you are asked.
   - The registry is the one named: at most 200 characters, with no spaces,
     control characters or direction marks, whether you named it or set it.
     Any other is refused before you are asked.
   - Each result's card is fetched and checked. Each publisher's own catalogs
     are read: `ai-catalog.json` and `ard.json` on the domain in the result's
     `urn:air:<publisher>:…` identifier. A server is confirmed only if its
     publisher lists it there with a valid card, and then the publisher's
     card is the one shown and added. Otherwise it is marked **NOT confirmed
     by its publisher**. The registry's order is its relevance ranking, not a
     judgement of trust.
4. **Add.** Ask Codex to add one. It calls this plugin's `add_mcp_server`,
   which works as in
   [`mcp-server-cards`](../../server-cards/codex/README.md#step-by-step): a
   form naming the server, its URL, its headers, the file written and the
   undo, then `codex mcp add` on your accept. For a search result, the form
   also says whether its publisher confirms it.

### Which Codex modes ask you

The same rules apply to a search as to an add. The table of which Codex modes
put a form to you, and which answer it themselves, is in
[mcp-server-cards' README](../../server-cards/codex/README.md#which-codex-modes-ask-you).

- A search's form is one required choice, **Don't send it** or **Send the
  search**, and only **Send the search** sends. No form, a decline, a close,
  or an accept without that choice sends nothing.
- Under `-a never` and in `codex exec`, Codex declines the form, so nothing is
  sent or added.
- Codex 0.172 shows a form with a required choice to the person even under
  `--dangerously-bypass-approvals-and-sandbox`. It auto-accepts only forms
  with no fields: see `can_auto_accept_elicitation` in
  `codex-mcp/src/elicitation.rs` at `rust-v0.172.0`. More exactly, in that mode
  it shows the form where the Codex client takes form input (it declares
  `openai/standard-form-input`, for a thread the person started). Otherwise it
  declines the form, so nothing is sent. This is Codex 0.172's behaviour, not
  something the MCP spec promises, and a later Codex may change it.

### The tools

| Tool | What it does |
|---|---|
| `ard_discover(domain)` | Reads the domain's ARD and AI Catalog sources, and reports each card. Read-only. |
| `ard_search(query, registry?)` | After your accept, posts `query` to an ARD registry, then reports the Server Cards it returns, each checked against its publisher. `registry` is a registry base URL, or a domain whose catalog lists a registry (an entry of type `application/ai-registry+json`). Required unless `ARD_DISCOVERY_REGISTRY` is set. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Adds a server one of the two showed in this session, after your accept. |

### What differs between Claude Code and Codex

Both forms run the same registry client, in
[`../claude-code/mod/hooks`](../claude-code/mod/hooks). This plugin bundles it
with the same Server Cards core as
[`mcp-server-cards`](../../server-cards/codex/README.md). Adding a server
differs as it does for `mcp-server-cards`: one configuration file,
environment variable names for secrets, SSE refused, and `codex mcp login`.
See [its table](../../server-cards/codex/README.md#what-differs-between-claude-code-and-codex).

| | Claude Code | Codex |
|---|---|---|
| Cards it finds | handed to `mcp-server-cards` (a declared dependency), which checks, shows and adds them | checked, shown and added by this plugin, with the same code: one Codex plugin's server can't call another's tools |
| Its own `add_mcp_server` | no | yes, for what this plugin showed |
| Consent to a search | a question the mod makes in Claude Code's permission prompt | a form through MCP elicitation, naming the exact endpoints and the query; refused without a form, or on a decline or close |
| A registry named by domain | asked about before the domain is read | the domain's catalogs are read first (a `GET`, no query), so the form names the exact endpoints |
| A redirect of the search | followed by Claude Code's fetch | never to another origin, and never turned into a `GET`: the query goes only where the form said |
| Redirects of documents | followed unseen, so one to a private address isn't caught | followed by the plugin under the address rule, so one to a private address is refused |
| Settings | `/config` | environment variables |
| Picker | under each result | none: you ask Codex to add a server |

## Settings

The plugin reads these from the environment Codex starts in. Its `.mcp.json`
passes them through.

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_REGISTRY` | unset | The base URL of an ARD registry (or a domain whose catalog lists one) for `ard_search` to ask when the request names none. It is unset by default: no registry is chosen for you, so each search names its own. Your query text is sent to the registry, once you accept. |
| `ARD_DISCOVERY_DISABLED` | unset | `1` turns the plugin off: no tools, nothing fetched or sent. |
| `CODEX_HOME`, `CODEX_CLI_PATH` | | As in [`mcp-server-cards`](../../server-cards/codex/README.md#settings). |

### When Codex supports ARD itself

ARD is a draft, and no host supports it natively yet. Remove or disable the
plugin (`codex plugin remove ard-discovery@agent-polyfill`), or set
`ARD_DISCOVERY_DISABLED=1`.

## Limits

- **The query leaves your machine** once you accept that search. That is what
  a search is. Only the words Codex puts in `query` are sent, with no cookie
  or credential, but the registry sees them.
- **Search results today.** The one public registry, Hugging Face Discover,
  returns MCP Registry `server.json` entries, not Server Cards, so nothing it
  returns can be added yet. See the
  [findings](../claude-code/README.md#findings-to-report-upstream).
- **A public name that resolves to a private address isn't caught,** because
  Node's `fetch` resolves names itself. Redirects are checked. Checking the
  resolved address in the plugin's own fetch (a `lookup` that refuses private
  results) is a known follow-up.
- **Bypass mode rests on Codex's behaviour.** Under
  `--dangerously-bypass-approvals-and-sandbox`, Codex 0.172 shows the form to
  the person or declines it, as described in
  [Which Codex modes ask you](#which-codex-modes-ask-you). This is Codex
  0.172's behaviour, not something the MCP spec promises, and a later Codex
  may change it. The proper fix is Codex putting the approval mode in a tool
  call's metadata.
- **The limits of adding a server** are
  [mcp-server-cards'](../../server-cards/codex/README.md#limits).

## Security

[SECURITY.md](SECURITY.md) says what the plugin sends, to whom, and what it
trusts. In short:

- Discovery by domain reads public documents from that domain.
- Search sends your query text to the registry, and to at most three
  registries it refers to, only after you accept that search in the form.
- It writes only Codex's MCP configuration, for a server you accept.

## Spec and conformance

It implements:

- **ARD v0.91** at commit
  [`f073b1ea9b`](https://github.com/ards-project/ard-spec): §5.1 (domain
  discovery: `ard.json` and `rel="ard"`), §5.3 (registry search) and Appendix
  B (error codes), for MCP Server Cards only. ARD is a draft ("Proposal") from
  Google, R.V. Guha and Hugging Face. It isn't an MCP specification, and it
  can still change.
- MCP Server Cards
  ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9,
  for the cards it finds.

### Client rules

Both forms follow the same ARD rules (W-1 to W-6, R-1 to R-8, P-1, B-1) and
Server Cards rules, with the same code. The full tables are with the Claude
Code forms: [ARD's client rules](../claude-code/README.md#client-rules) and
[mcp-server-cards'](../../server-cards/claude-code/README.md#client-rules).
Here, their tests run against the built
[`plugin/dist/server.mjs`](plugin/dist/server.mjs), with `npm test`. These are
the rows where Codex differs:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| Q-1 | Say where the query went | this plugin's own | A-1, A-5 | met: the tool's description names the registry, and every result names each one asked |
| Q-2 | The person chooses the registry | this plugin's own | A-5, A-7 | met: none is set by default. A registry named in the request is used, or the one in `ARD_DISCOVERY_REGISTRY`. With neither, the search is refused before any form, and nothing is sent |
| Q-3 | Every search is put to the person first, naming the query and the registry | this plugin's own (security review M2) | A-3, A-4, A-11 | met: a form naming the exact endpoints and the query, with a required choice. Only **Send the search** sends. Codex 0.172 doesn't answer such a form by itself, even under `--dangerously-bypass-approvals-and-sandbox` |
| Q-4 | What is sent is what was shown | this plugin's own (security review R1, and C1 for markup) | A-6, A-9, A-12, A-13 | met: the query is at most 300 characters, on one line, with no invisible characters (tag characters among them) or direction marks, and no `` ` ``, `<`, `>` or square brackets. The registry, named or set, is at most 200 characters, with no spaces, control characters, invisible characters or direction marks |
| Q-5 | The query goes only where the form said | this plugin's own | mcp-server-cards F-5 | met: a redirect to another origin, or one that would turn the `POST` into a `GET`, isn't followed |
| Q-6 | A registry's own words are shown as one line, with nothing hidden | this plugin's own | L-1 to L-4, A-14 | met: its error messages, the referrals it names, and each result's name and description are one line, capped, with control and invisible characters out. A result whose identifier holds one is skipped |
| V-3 | No URL that displays as something else | the polyfills' own (security review C1) | A-8, A-10; mcp-server-cards X-4, X-5, P-6, P-7, O-9, O-10 (run here) | met: a result's card URL, its card's remote URL, a registry URL a catalog names, and where a result was found may hold no `` ` ``, `<`, `>` or square bracket outside an IPv6 host. Such a result is refused and never put in a form. Nor may they, or a registry the request names, name a user before the host (C3). A search to such a registry is refused before the form |
| D-1 | Domain discovery reads `ard.json`, which needs no `specVersion` | §5.1 | A-2 | met |
| H-3 | A search result is confirmed only by its publisher's own catalog | the polyfills' own | mcp-server-cards O-2 to O-4, O-8 (run here) | met |

### Proof

- **Per rule:** 118 tests, run with `npm test`.
  - ARD's 12 registry rule tests and the Server Cards core's 90 rule tests,
    from the Claude Code forms' test folders, run against the committed
    bundle.
  - 14 of this form's own (A-), over stdio, with a stand-in `codex` command
    and a local registry on 127.0.0.1.
  - 2 bundle checks: it is byte-identical to a fresh build, and a copy of
    `plugin/` alone starts and lists its tools.
- **The real host,** 24 November 2026, with the user's own Codex login, the
  plugin's server, and every add going to a throwaway `CODEX_HOME`:
  - `codex exec` (0.172.0): `ard_discover` for buildkite.com read
    `ai-catalog.json` and `ard.json` (one entry each) and returned Buildkite's
    valid card.
  - Through app-server (0.172.0), as the TUI runs, against the
    [demo registry](../claude-code/README.md#demo-registry) on 127.0.0.1, so
    no query left the machine:
    - `ard_search` put the form to the client, naming
      `http://127.0.0.1:9031/search` and the query. On the accept (after two
      seconds), it returned Buildkite and Netlify, both confirmed by their
      publishers.
    - `add_mcp_server` for Buildkite, by identifier, put its own form
      ("confirmed by buildkite.com's own catalog"). On the accept,
      `codex mcp add` wrote the entry and was stopped at its sign-in, and the
      result said to run `codex mcp login buildkite`.
      `codex mcp remove buildkite` removed it.
  - Installed from this repository's marketplace into a throwaway
    `CODEX_HOME`: the server started and listed `ard_discover`, `ard_search`
    and `add_mcp_server`.
  - Not run: a search of Hugging Face Discover from Codex. The Claude Code
    form's run found that every result it returns is refused as not a Server
    Card.
- **Upstream conformance:** the MCP conformance suite has no Server Card or
  ARD scenarios.

### Findings to report upstream

The findings concern the specs and the public registry, so they apply to both
forms. They are listed once, with the Claude Code form's
[findings](../claude-code/README.md#findings-to-report-upstream): Hugging Face
Discover's results, and the well-known path.

## Development

```bash
npm ci
npm run build       # plugin/dist/server.mjs, from src/, ../claude-code/mod/hooks and ../../server-cards
npm run check       # fails if plugin/dist/server.mjs is not what the sources build
npm run typecheck
npm test            # against the committed plugin/dist/server.mjs: run npm run build first
```

| Path | What it is |
|---|---|
| `src/main.ts` | The server: `ard_discover`, `ard_search`, and mcp-server-cards' `add_mcp_server`. |
| `build.mjs` | The bundle and the tests' build, through `../../server-cards/codex/build.mjs`. |
| `plugin/` | What Codex installs: `.codex-plugin/plugin.json`, `.mcp.json`, a skill and `dist/server.mjs`. |
| `test/adapter.test.ts` | The adapter tests, on mcp-server-cards' harness. |

## Licence

Apache-2.0, like the rest of this repository ([LICENSE](../../../LICENSE)).

This is a community project. It isn't affiliated with or endorsed by OpenAI,
Anthropic, the Model Context Protocol project, the Agentic AI Foundation, the
Linux Foundation, or the authors of ARD. Claude and Claude Code are trademarks
of Anthropic, PBC. OpenAI and Codex are trademarks of OpenAI.
