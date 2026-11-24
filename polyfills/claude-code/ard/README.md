# ard-discovery: find MCP servers through Agentic Resource Discovery

A Claude Code mod that adds the consumer side of [Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD) for MCP servers. It finds servers in two ways:

- **By domain.** It reads a domain's `/.well-known/ard.json` and the `rel="ard"` links on its pages, beside the AI Catalog.
- **By task.** It asks an ARD registry for a server that can do something, in plain words.

> Search for an MCP server that can check why my CI build failed.

It only finds. Each Server Card it finds goes to [`mcp-server-cards`](../server-cards), which checks it against the schema and shows it under the answer with an **Add** button. For a search result, `mcp-server-cards` also asks the publisher's own domain whether the server is theirs. Pressing **Add** puts the server into Claude Code's own MCP configuration, and Claude Code connects it with its own sign-in. `mcp-server-cards` is a declared dependency, installed with this plugin.

**Search sends your query to a third party.** `ard_search` posts the words of your request to an ARD registry, a service someone else runs, which ranks other people's servers. The default is Hugging Face Discover (`https://huggingface-hf-discover.hf.space`); the `registry` setting changes it. Every result says which registries were asked. Discovery by domain sends nothing but plain `GET`s to that domain.

It implements:

- **ARD v0.91** at commit [`f073b1ea9b`](https://github.com/ards-project/ard-spec): §5.1 (domain discovery: `ard.json` and `rel="ard"`), §5.3 (registry search) and Appendix B (error codes), for MCP Server Cards only. ARD is a draft ("Proposal") from Google, R.V. Guha and Hugging Face. It is not an MCP specification, and it can still change.
- Through `mcp-server-cards`: MCP Server Cards ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md)) and the [AI Catalog](https://github.com/Agent-Card/ai-catalog) v0.9.

This is a community project. It is not affiliated with or endorsed by Anthropic, the Model Context Protocol project, the Agentic AI Foundation, the Linux Foundation, or the authors of ARD.

## Install

At the prompt of a `claude` session:

```
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

Or in a terminal:

```bash
claude plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

Either adds the [AgentPolyfill](../../../README.md) marketplace and installs the plugin. It lists `mcp-server-cards` as a dependency, and Claude Code installs that from the same marketplace. With the marketplace already added, `/plugin install ard-discovery@agent-polyfill` does the same.

You need **Claude Code 2.1.329 or newer**, with mods (on by default from Claude Code 2.1.287), and nothing else: no helper process, no Node, no account.

To turn it off, set `disabled` in `/config`, or disable or uninstall the plugin (`/plugin`). `mcp-server-cards` keeps working on its own.

To run both from a clone of this repository, for one session:

```bash
git clone https://github.com/idosal/AgentPolyfill
claude --plugin-dir AgentPolyfill/polyfills/claude-code/server-cards/mod --plugin-dir AgentPolyfill/polyfills/claude-code/ard/mod
```

## Try it

Ask Claude "What MCP servers does buildkite.com list through ARD?", then press **Add** under the answer. To try search, start the [demo registry](#demo-registry) and ask Claude to search it for "check why my CI build failed".

## Using it, step by step

1. **Ask.** For example "find an MCP server that can check why my CI build failed", or "what does buildkite.com list in its ard.json?".
2. **Claude Code asks before the first call** of `ard_discover` and of `ard_search`, as for any new tool. If you say no, nothing is fetched or sent.
3. **By domain (`ard_discover`):** `mcp-server-cards` reads the domain's `/.well-known/ai-catalog.json` and `/.well-known/ard.json`, and follows `rel="ai-catalog"` and `rel="ard"` links on the page. It fetches each Server Card listed and checks it. The result and the **Add** picker appear under the `ard_discover` call.
4. **By task (`ard_search`):** the plugin posts your query to the registry and follows the referrals it gives, one hop. It hands the Server Card results to `mcp-server-cards`, which fetches and checks each card. Then it reads each publisher's own catalogs (`ai-catalog.json` and `ard.json` on the domain in the result's `urn:air:<publisher>:…` identifier).
   - A server is **confirmed** only if its publisher lists it there with a valid card, and then the publisher's card is the one shown and added.
   - Otherwise it is marked **NOT confirmed by its publisher**. Adding it is your call.
   - The registry's order is its relevance ranking, not a judgement of trust, and Claude is told to say so.
5. **Add.** Press **Add**, or ask Claude, who calls `mcp-server-cards`' `add_mcp_server`. Claude Code then asks you, naming the server, its URL and how to undo it. The rules are those of [`mcp-server-cards`](../server-cards/README.md#using-it-step-by-step).

### Settings

They are in `/config`, under the plugin.

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the plugin fully off: no tools, nothing fetched or sent. |
| `registry` | `https://huggingface-hf-discover.hf.space` | The base URL of the ARD registry that `ard_search` asks when the request names none. Your query text is sent there. Empty: search only a registry named in the request. |

### The tools

| Tool | What it does |
|---|---|
| `ard_discover(domain)` | Reads the domain's ARD and AI Catalog sources through `mcp-server-cards`, and shows each card it finds. Read-only. |
| `ard_search(query, registry?)` | Posts `query` to an ARD registry, then shows the Server Cards it returns through `mcp-server-cards`. `registry` is a registry base URL, or a domain whose catalog lists a registry (an entry of type `application/ai-registry+json`, as `huggingface.co` publishes). |

## Client rules

There is one row for each rule ARD v0.91 puts on a consumer of MCP Server Cards, and the test that covers it. Tests named A-, R- and P- are in [`mod/tests`](mod/tests), run with `claude plugin test mod`. Those named `mcp-server-cards` D-, B- or O- are in [that plugin's tests](../server-cards/mod/tests), which hold the checks this plugin hands over to.

### Domain discovery (§5.1)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| W-1 | Fetch `https://{domain}/.well-known/ard.json` | §5.1 (MUST) | A-1; mcp-server-cards D-1, B-6 | met |
| W-2 | Honour `rel="ard"` links, in a `Link` header or a `<link>` tag | §5.1 (MUST) | A-1; mcp-server-cards D-7, B-6 | met |
| W-3 | `/.well-known/ai-catalog.json` may be read as well | §5.1 (MAY) | mcp-server-cards D-1 | met: always read, by `mcp-server-cards` |
| W-4 | An `ard.json` manifest need not carry an AI Catalog `specVersion` | ARD manifest | A-1; mcp-server-cards D-9 | met |
| W-5 | An entry carries `url` or `data`, never both | §4.3 (MUST NOT carry both) | mcp-server-cards D-5 | met |
| W-6 | The same `identifier` in `ard.json` and `ai-catalog.json` is one server | AI Catalog | mcp-server-cards D-6 | met |

### Registry search (§5.3)

| # | Rule | Source | Test | State |
|---|---|---|---|---|
| R-1 | A registry entry's `url` is a base URL; the client appends `/search` | §5.3 | R-1 | met |
| R-2 | `POST /search` with `query.text` (required), `filter` and `federation` | §5.3.1, §5.3.2, §5.4 | R-2 | met: `filter.type` is the Server Card type; `federation` is `"referrals"`, so the client decides which referrals to follow |
| R-3 | A referral's `url` is the complete search endpoint, and the client MUST NOT append `/search` | §5.3 (MUST NOT) | R-3 | met: one hop, at most three referrals |
| R-4 | A result MUST carry `identifier`; its `url` addresses the artifact (the card), not the ARD entry | §5.3.2 | R-4 | met: results without one are skipped; each card is fetched and checked by `mcp-server-cards` |
| R-5 | `score` is relevance only, and MUST NOT be read as trust | §5.3.2, §5.3.3 (MUST NOT) | R-5 | met: it orders the results as the registry ranked them, and is used for nothing else |
| R-6 | Standard error codes | Appendix B | R-6 | met: reported as `HTTP <code> (<errorCode>: <message>)` |
| R-7 | The publisher is the `<publisher>` domain of `urn:air:<publisher>:…` | Appendix C | mcp-server-cards O-5 | met |
| R-8 | A claim to a publisher's name needs that publisher's attestation | §4.5.1 | mcp-server-cards O-2 to O-4, O-8, B-12; A-2 | partly: trust manifests are not verified. Instead the publisher's own catalogs (`ai-catalog.json` and `ard.json`) are read, and a result is **confirmed** only if they list the server; the publisher's card is then the one used |
| Q-1 | Say where the query went | this plugin's own | A-2 | met: the tool's description says it, and every result names each registry asked |
| Q-2 | The registry is the person's choice | this plugin's own | A-5 | met: the `registry` setting, or one named in the request |
| P-1 | A public registry can't refer the client to a local or private address | this plugin's own | P-1 | met |
| B-1 | Bounds | this plugin's own | R-7 | three registries, three referrals, 50 results read per answer, 10 handed on, 512 KiB per answer |

The default registry, Hugging Face Discover, is the only public ARD registry found. On 24 November 2026 it answered searches and referred to its Spaces registry, which was followed. But every MCP result it returned pointed at an MCP Registry `server.json` rather than a Server Card, so `mcp-server-cards` refuses every one (see [Findings](#findings-to-report-upstream)). Until a public registry serves valid cards, the [demo registry](#demo-registry) stands in.

## Demo registry

[`demo/registry.mjs`](demo/registry.mjs) is a demo ARD registry, not a real one. When it starts, it reads the live catalogs of ten publishers: Buildkite, GitHub, Notion, Neon, Supabase, Netlify, Exa, Context7, Hugging Face and Zapier. It keeps their Server Card entries as published, and answers `POST /search` by word match. Every result points at the publisher's own card, so each one comes back confirmed.

```bash
node demo/registry.mjs
```

It listens on `http://127.0.0.1:9011`. Then, in Claude Code:

> My CI build failed and I don't have a tool for it. Search the registry at http://127.0.0.1:9011 for an MCP server that can check why.

Claude finds Buildkite, and says buildkite.com's own catalog confirms it. Press **Add**, and Claude Code asks you to sign in to Buildkite through `/mcp`.

## Scope

- **In the plugin:** the ARD v0.91 consumer rules above, for MCP Server Cards.
- **In `mcp-server-cards`:** reading catalogs and cards, the schema checks, the publisher check, the picker and the add. This plugin duplicates none of them. It only names its sources (`ard.json`, `rel="ard"`) and speaks the registry protocol.
- **Not in it:**
  - ARD `POST /explore`, `GET /agents` and `federation: "auto"`.
  - Verifying ARD or AI Catalog trust manifests and signatures. No server is ever called verified.
  - Agent cards, skills and other artifact types: only MCP Server Cards are asked for and handed on.

## Proof

- **Per rule:** 14 tests in this plugin, run with `claude plugin test mod`, and the `mcp-server-cards` tests named above.
  - A-1 to A-6 run through the plugin as Claude Code loads it, with `mcp-server-cards` and the network stood in for.
  - R-1 to R-7 and P-1 test the registry client.
- **A registry someone else runs:** Hugging Face Discover, including its referral (24 November 2026).
- **The real host (Claude Code 2.1.329), with both plugins loaded:**
  - `ard_discover` for buildkite.com read `ai-catalog.json` and `ard.json`, and returned Buildkite's card with the picker.
  - `ard_search` against the demo registry returned Buildkite and Netlify, both confirmed. Netlify was confirmed by `netlify.com/.well-known/ard.json`, the case where only ARD's sources list a server.
  - `ard_search` with the default registry asked Hugging Face Discover and the Spaces registry it referred to, and every result was refused as not a Server Card.
- **Not yet run in the real host:** adding a server found this way. That is `mcp-server-cards`' add, with the same state as described in [its README](../server-cards/README.md#proof).
- **Upstream conformance:** the MCP conformance suite has no Server Card or ARD scenarios (`modelcontextprotocol/conformance` at `96a6f9478b`).

## Limits

- **The query leaves your machine.** That is what a search is. Only the words Claude puts in `query` are sent, with no cookie or credential, but the registry sees them.
- **Search results today.** The one public registry returns MCP Registry entries, which are not Server Cards, so nothing it returns can be added yet.
- **The address limits of `mcp-server-cards` apply here too.** Claude Code's `$.http.fetch` follows redirects and resolves names without reporting either. So a public registry URL that redirects to a private address, or a public name that resolves to one, is not caught. Only addresses named directly are refused.

## Privacy and security

What it sends, to whom, and what it trusts are in [SECURITY.md](SECURITY.md). In short:
- Discovery by domain reads public documents from that domain, through `mcp-server-cards`.
- Search sends your query text to the registry, and to at most three registries it refers to.
- It writes nothing: adding a server is `mcp-server-cards`' job, and needs you.

## Findings to report upstream

Found on 24 November 2026, and not yet reported:

- **Hugging Face Discover** answers searches with entries typed `application/mcp-server-card+json` whose `url` is an MCP Registry `server.json` (a date-versioned `$schema`, a name with no namespace), and so does the Spaces registry it refers to. Those fail the card schema.
- **The well-known path.** ARD v0.91 makes `/.well-known/ard.json` a MUST and treats `ai-catalog.json` as optional. The Server Cards discovery doc names only `ai-catalog.json`. Together, the two plugins read both.

## Develop

```bash
claude plugin validate mod
```

```bash
claude plugin test mod
```

```bash
node --check demo/registry.mjs
```

The code is in [`mod/hooks`](mod/hooks):

| File | What it does |
|---|---|
| `register.ts` | The two tools, and the hand-over to `mcp-server-cards`. |
| `registry.ts` | The registry client: `POST /search`, referrals, error codes, bounds. |
| `urls.ts` | Which addresses the registry client may reach. |
