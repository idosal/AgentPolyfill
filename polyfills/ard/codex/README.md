# ard-discovery for Codex: find MCP servers through Agentic Resource Discovery

A Codex plugin that adds the consumer side of [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD) for MCP servers. It finds servers in two ways:

- **By domain.** It reads a domain's `/.well-known/ard.json` and the `rel="ard"` links on its home page, beside the AI Catalog.
- **By task.** It asks an ARD registry for a server that can do something, in plain words.

> Find an MCP server that can check why my CI build failed.

Each Server Card it finds is checked against the schema, and a search result counts as **confirmed** only when the publisher's own domain lists it. To add one, Codex shows you a form; only on your accept does the server go into Codex's MCP configuration.

**Search sends your query to a third party.** `ard_search` posts the words of your request to an ARD registry, a service someone else runs, which ranks other people's servers. The default is a Hugging Face Space at `https://huggingface-hf-discover.hf.space`, which huggingface.co's own catalog lists as its "Hugging Face Discover Registry". Codex shows you a form before every search, naming the registry and the exact query; nothing is sent unless you accept. Discovery by domain sends nothing but plain `GET`s to that domain.

It implements:

- **ARD v0.91** at commit [`f073b1ea9b`](https://github.com/ards-project/ard-spec): §5.1 (domain discovery: `ard.json` and `rel="ard"`), §5.3 (registry search) and Appendix B (error codes), for MCP Server Cards only. ARD is a draft ("Proposal") from Google, R.V. Guha and Hugging Face. It is not an MCP specification, and it can still change.
- MCP Server Cards ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9, for the cards it finds.

This is the Codex form of [`ard-discovery`](../claude-code) for Claude Code. It runs the same registry client ([`../claude-code/mod/hooks`](../claude-code/mod/hooks)) and the same Server Cards core as [`mcp-server-cards`](../../server-cards/codex), bundled. [What differs](#what-differs-from-the-claude-code-form) is listed below.

This is a community project. It is not affiliated with or endorsed by OpenAI, Anthropic, the Model Context Protocol project, the Agentic AI Foundation, the Linux Foundation, or the authors of ARD.

## Install

In a terminal:

```bash
codex plugin marketplace add idosal/AgentPolyfill && codex plugin add ard-discovery@agent-polyfill
```

With the marketplace already added, `codex plugin add ard-discovery@agent-polyfill` is enough, and `codex plugin list` shows it. Start a new Codex session afterwards. It works on its own; installing [`mcp-server-cards`](../../server-cards/codex) beside it is optional.

You need **Codex CLI 0.170.0 or newer** (tested with 0.170.0 and 0.172.0) and **Node.js 20 or newer** on your `PATH`. Nothing else: no account, no key.

To remove it: `codex plugin remove ard-discovery@agent-polyfill`.

## Try it

Ask Codex "What does buildkite.com list in its ard.json?", then "Add it". Codex shows a form; accept it, then run `codex mcp login buildkite` to sign in.

To try search without sending anything to a third party, start the [demo registry](../claude-code/README.md#demo-registry) from a clone (`node polyfills/ard/claude-code/demo/registry.mjs`, on `http://127.0.0.1:9011`) and ask: "Search the registry at http://127.0.0.1:9011 for an MCP server that can check why my CI build failed."

## Using it, step by step

1. **Ask.** For example "find an MCP server that can check why my CI build failed", or "what does buildkite.com list in its ard.json?".
2. **By domain (`ard_discover`):** it reads the domain's `/.well-known/ai-catalog.json` and `/.well-known/ard.json`, and follows `rel="ai-catalog"` and `rel="ard"` links on the page. It fetches each Server Card listed and checks it. Read-only.
3. **By task (`ard_search`):** first, if the registry is named by domain (`huggingface.co`), it reads that domain's catalogs for the registries they list (a `GET`, no query). Then Codex shows you the form:

   ```
   Send this search to https://huggingface-hf-discover.hf.space/search, and to up to three registries it refers to?
   Query: "check why my CI build failed"
   A registry is a service someone else runs, and it sees the query.
   ```

   - **Accept**, and the query is posted, then sent on to at most three registries the first one refers to, one hop.
   - **Decline** or close it, and nothing is sent.
   - The query sent is the one shown: at most 300 characters, on one line, with no invisible characters or direction marks, and no `` ` ``, `<`, `>` or square brackets, which a host could render as Markdown or HTML. Any other query is refused before you are asked.
   - Each result's card is fetched and checked, and each publisher's own catalogs (`ai-catalog.json` and `ard.json` on the domain in the result's `urn:air:<publisher>:…` identifier) are read. A server is **confirmed** only if its publisher lists it there with a valid card, and then the publisher's card is the one shown and added. Otherwise it is marked **NOT confirmed by its publisher**. The registry's order is its relevance ranking, not a judgement of trust.
4. **Add.** Ask Codex to add one. It calls this plugin's `add_mcp_server`, which works as in [`mcp-server-cards`](../../server-cards/codex/README.md#using-it-step-by-step): a form naming the server, its URL, its headers, the file written and the undo, and `codex mcp add` on your accept. For a search result, the form also says whether its publisher confirms it.

Which Codex modes put a form to you, and which answer it themselves, is in [mcp-server-cards' table](../../server-cards/codex/README.md#which-codex-modes-ask-you). The same rules apply to a search. Its form is one required choice, **Don't send it** or **Send the search**, and only **Send the search** sends: no form, a decline, a close, or an accept without that choice sends nothing. Under `-a never` and in `codex exec`, Codex declines the form, so nothing is sent or added. Codex 0.172 shows a form with a required choice to the person even under `--dangerously-bypass-approvals-and-sandbox` (it auto-accepts only forms with no fields: `can_auto_accept_elicitation` in `codex-mcp/src/elicitation.rs` at `rust-v0.172.0`). More exactly, in that mode it shows the form where the Codex client takes form input (it declares `openai/standard-form-input`, for a thread the person started), and otherwise declines it, so nothing is sent. This is Codex 0.172's behaviour, not something the MCP spec promises, and a later Codex may change it.

### Settings

Read from the environment Codex starts in; the plugin's `.mcp.json` passes them through.

| Variable | Default | What it does |
|---|---|---|
| `ARD_DISCOVERY_REGISTRY` | `https://huggingface-hf-discover.hf.space` | The base URL (or a domain whose catalog lists one) of the registry `ard_search` asks when the request names none. Set it to empty to search only a registry named in the request. |
| `ARD_DISCOVERY_DISABLED` | unset | `1` turns the plugin off: no tools, nothing fetched or sent. |
| `CODEX_HOME`, `CODEX_CLI_PATH` | | As in [`mcp-server-cards`](../../server-cards/codex/README.md#settings). |

### The tools

| Tool | What it does |
|---|---|
| `ard_discover(domain)` | Reads the domain's ARD and AI Catalog sources, and reports each card. Read-only. |
| `ard_search(query, registry?)` | After your accept, posts `query` to an ARD registry, then reports the Server Cards it returns, each checked against its publisher. |
| `add_mcp_server(identifier, url, domain?, remote?, name?, values?)` | Adds a server one of the two showed in this session, after your accept. |

## What differs from the Claude Code form

| | Claude Code form | Codex form |
|---|---|---|
| Cards it finds | handed to `mcp-server-cards` (a declared dependency), which checks, shows and adds them | checked, shown and added by this plugin, with the same code: one Codex plugin's server can't call another's tools |
| Its own `add_mcp_server` | no | yes, for what this plugin showed |
| Consent to a search | a question the mod makes in Claude Code's permission prompt | a form through MCP elicitation, naming the exact endpoints and the query; refused without a form, or on a decline or close |
| A registry named by domain | asked about before the domain is read | the domain's catalogs are read first (a `GET`, no query), so the form names the exact endpoints |
| A redirect of the search | followed by Claude Code's fetch | never to another origin, and never turned into a `GET`: the query goes only where the form said |
| Redirects of documents | followed unseen, so one to a private address is not caught | followed by the plugin under the address rule, so one to a private address is refused |
| Settings | `/config` | environment variables |
| Picker | under each result | none: you ask Codex to add a server |

The differences in adding a server (one configuration file, environment variable names for secrets, SSE refused, `codex mcp login`) are [mcp-server-cards'](../../server-cards/codex/README.md#what-differs-from-the-claude-code-form).

## Client rules

The ARD rules (W-1 to W-6, R-1 to R-8, P-1, B-1) and the Server Cards rules are those of the Claude Code forms: see [ARD's client rules](../claude-code/README.md#client-rules) and [mcp-server-cards'](../../server-cards/claude-code/README.md#client-rules). Their tests run here against the built [`plugin/dist/server.mjs`](plugin/dist/server.mjs), with `npm test`. What Codex changes:

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| Q-1 | Say where the query went | this plugin's own | A-1, A-5 | met: the tool's description names the registry, and every result names each one asked |
| Q-2 | The registry is a setting | this plugin's own | A-8 | met: `ARD_DISCOVERY_REGISTRY`, which can be empty |
| Q-3 | Every search is put to the person first, naming the query and the registry | this plugin's own (security review M2) | A-3, A-4, A-11 | met: a form naming the exact endpoints and the query, with a required choice; only **Send the search** sends. Codex 0.172 does not answer such a form by itself, even under `--dangerously-bypass-approvals-and-sandbox` |
| Q-4 | What is sent is what was shown | this plugin's own (security review R1, and C1 for markup) | A-6, A-9 | met: at most 300 characters, one line, no invisible characters or direction marks, and no `` ` ``, `<`, `>` or square brackets |
| Q-5 | The query goes only where the form said | this plugin's own | mcp-server-cards F-5 | met: a redirect to another origin, or one that would turn the `POST` into a `GET`, is not followed |
| V-3 | No URL that displays as something else | the polyfills' own (security review C1) | A-8, A-10; mcp-server-cards X-4, X-5, P-6, P-7, O-9, O-10 (run here) | met: a result's card URL, its card's remote URL, a registry URL a catalog names, and where a result was found may hold no `` ` ``, `<`, `>` or square bracket outside an IPv6 host; such a result is refused and never put in a form. Nor may they, or a registry the request names, name a user before the host (C3): a search to such a registry is refused before the form |
| D-1 | Domain discovery reads `ard.json`, which needs no `specVersion` | §5.1 | A-2 | met |
| H-3 | A search result is confirmed only by its publisher's own catalog | the polyfills' own | mcp-server-cards O-2 to O-4, O-8 (run here) | met |

## Stand-down

ARD is a draft; no host supports it natively yet. Remove or disable the plugin (`codex plugin remove ard-discovery@agent-polyfill`), or set `ARD_DISCOVERY_DISABLED=1`.

## Proof

- **Per rule:** 109 tests, run with `npm test`: ARD's 8 registry rule tests and the Server Cards core's 88 rule tests, all from the Claude Code forms and run against the committed bundle; 11 of this form's (A-), over stdio, with a stand-in `codex` command and a local registry on 127.0.0.1; and 2 bundle checks (byte-identical to a fresh build; a copy of `plugin/` alone starts and lists its tools).
- **The real host:** below.
- **Upstream conformance:** the MCP conformance suite has no Server Card or ARD scenarios.

### Proof in the real host

24 November 2026, with the user's own Codex login, the plugin's server, and every add going to a throwaway `CODEX_HOME`:

- `codex exec` (0.172.0): `ard_discover` for buildkite.com read `ai-catalog.json` and `ard.json` (one entry each) and returned Buildkite's valid card.
- Through app-server (0.172.0), as the TUI runs, against the [demo registry](../claude-code/README.md#demo-registry) on 127.0.0.1 (so no query left the machine):
  - `ard_search` put the form to the client, naming `http://127.0.0.1:9031/search` and the query; on the accept (after two seconds), it returned Buildkite and Netlify, both confirmed by their publishers.
  - `add_mcp_server` for Buildkite, by identifier, put its own form ("confirmed by buildkite.com's own catalog"); on the accept, `codex mcp add` wrote the entry and was stopped at its sign-in, and the result said to run `codex mcp login buildkite`. `codex mcp remove buildkite` removed it.
- Installed from this repository's marketplace into a throwaway `CODEX_HOME`: the server started and listed `ard_discover`, `ard_search` and `add_mcp_server`.
- Not run: a search of the default Hugging Face registry from Codex (the Claude Code form's run found that every result it returns is refused as not a Server Card).

## Limits

- **The query leaves your machine** once you accept that search. That is what a search is. Only the words Codex puts in `query` are sent, with no cookie or credential, but the registry sees them.
- **Search results today.** The one public registry, Hugging Face Discover, returns MCP Registry `server.json` entries, not Server Cards, so nothing it returns can be added yet (see the Claude Code form's [findings](../claude-code/README.md#findings-to-report-upstream)).
- **A public name that resolves to a private address** is not caught: Node's `fetch` resolves names itself. Redirects are checked. Checking the resolved address in the plugin's own fetch (a `lookup` that refuses private results) is a known follow-up.
- **Bypass mode rests on Codex's behaviour.** Codex 0.172 shows a form with a required choice to the person even under `--dangerously-bypass-approvals-and-sandbox` (it auto-accepts only forms with no fields: `can_auto_accept_elicitation` in `codex-mcp/src/elicitation.rs` at `rust-v0.172.0`). More exactly, in that mode it shows the form where the Codex client takes form input (it declares `openai/standard-form-input`, for a thread the person started), and otherwise declines it, so nothing is sent. This is Codex 0.172's behaviour, not something the MCP spec promises, and a later Codex may change it. The proper fix is Codex putting the approval mode in a tool call's metadata.
- The limits of adding a server are [mcp-server-cards'](../../server-cards/codex/README.md#limits-and-the-host-changes-that-would-remove-them).

## Privacy and security

What it sends, to whom, and what it trusts are in [SECURITY.md](SECURITY.md). In short:
- Discovery by domain reads public documents from that domain.
- Search sends your query text to the registry, and to at most three registries it refers to, only after you accept that search in the form.
- It writes only Codex's MCP configuration, for a server you accept.

## Develop

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
