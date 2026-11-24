---
description: ard-discovery adds the consumer side of Agentic Resource Discovery (ARD v0.91, a draft outside MCP) to Claude Code and Codex, for MCP servers. It's installed by name, not with the bundle.
---

# ARD discovery

`ard-discovery` adds the consumer side of
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD)
for MCP servers. ARD is a draft ("Proposal") from Google, R.V. Guha and Hugging
Face. It is not an MCP specification, and it can still change. The plugin finds
servers in two ways:

- **By domain.** It reads a domain's `/.well-known/ard.json` and the `rel="ard"`
  links on its pages, beside the AI Catalog.
- **By task.** It asks an ARD registry for a server that can do something, in
  plain words.

<Recording
  cut="ard"
  alt="In Claude Code, What does buildkite.com list via ARD? shows Buildkite's MCP server with an Add button. Then a search of an ARD registry for a server that checks CI builds: Claude Code first asks whether to send the query to the registry and up to three it refers to, and after Yes the result says where the query went."
  caption="A real session (21 s): buildkite.com's own listing, found from its domain, then a registry search, asked about first. It was recorded with an earlier build that searched Hugging Face Discover when no registry was named; ard-discovery now ships with none, and asks which one to search. That registry returned no MCP servers for this query."
/>

It only finds. Each Server Card it finds goes to
[`mcp-server-cards`](./server-cards), which checks it against the schema and
shows it under the answer with an **Add** button. For a search result,
`mcp-server-cards` also asks the publisher's own domain whether the server is
theirs.

::: warning Search sends your query to a third party
`ard_search` posts the words of your request to an ARD registry, a service
someone else runs, which ranks other people's servers. The plugin ships with no
registry: you name one in the request, or set one with the `registry` setting,
and the query also goes to up to three registries it refers to. With neither, a
search is refused and nothing is sent. Claude Code asks you before every search, showing
the query and where it goes; with nobody to ask (`claude -p`), nothing is sent.
For that reason the plugin is not part of the `agent-polyfill` bundle: you
install it by name.
:::

It implements ARD v0.91 at commit `f073b1ea9b`: §5.1 (domain discovery), §5.3
(registry search) and Appendix B (error codes), for MCP Server Cards only.

## Install

::: code-group

```txt [Claude Code]
/plugin install ard-discovery --marketplace idosal/AgentPolyfill
```

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add ard-discovery@agent-polyfill
```

:::

### In Claude Code

The terminal form is `claude plugin install ard-discovery --marketplace idosal/AgentPolyfill`.
It lists `mcp-server-cards` as a dependency, and Claude Code installs that from
the same marketplace. You need Claude Code 2.1.329 or newer, with mods, and
nothing else: no helper process, no Node, no account.

### In Codex

Codex 0.170 or newer, with Node 20 or newer. As in Claude Code, no registry is
set: name one in the request, or set `ARD_DISCOVERY_REGISTRY`. To add a server
it finds, Codex shows you a form, and the server is added only if you accept.

The sections below describe the Claude Code plugin. Where the Codex plugin
differs, its README says so:
[`polyfills/ard/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex).

## Try it

Ask the agent:

> What MCP servers does buildkite.com list through ARD?

Then add it: press **Add** under the answer in Claude Code, or accept Codex's
form.

To try search, start the demo registry from a clone of the repository (it is a
demo, not a real registry: it reads the live catalogs of ten publishers and
answers by word match):

```bash
node polyfills/ard/claude-code/demo/registry.mjs
```

It listens on `http://127.0.0.1:9011`. Then, in Claude Code:

> My CI build failed and I don't have a tool for it. Search the registry at http://127.0.0.1:9011 for an MCP server that can check why.

Claude finds Buildkite, and says buildkite.com's own catalog confirms it.

## Using it, step by step

1. **Ask.** For example "find an MCP server that can check why my CI build
   failed", or "what does buildkite.com list in its ard.json?".
2. **Claude Code asks first.** Before the first `ard_discover`, as for any new
   tool. And before **every** `ard_search`: the plugin puts each search to you
   itself, with the query and the registry it goes to, so no allow rule or auto
   mode answers it. The query sent is the one shown: at most 300 characters, on
   one line, with no invisible characters or direction marks; the registry is
   the one named, at most 200 characters, with no spaces, control characters or
   direction marks. If you say no, nothing is sent. With nobody to ask (`claude -p`), every search is refused.
3. **By domain (`ard_discover`):** `mcp-server-cards` reads the domain's
   `ai-catalog.json` and `ard.json`, and follows `rel="ai-catalog"` and
   `rel="ard"` links. It fetches each Server Card listed and checks it.
4. **By task (`ard_search`):** if no registry is set and you named none, Claude
   asks you which one to search. The plugin posts your query to that registry
   and follows the referrals it gives, one hop. Then each publisher's own catalogs
   are read. A server is **confirmed** only if its publisher lists it there with
   a valid card, and then the publisher's card is the one shown and added;
   otherwise it is marked **NOT confirmed by its publisher**. The registry's
   order is its relevance ranking, not a judgement of trust.
5. **Add.** Press **Add**, or ask Claude. The rules are those of
   [`mcp-server-cards`](./server-cards#using-it-step-by-step).

## Settings

In `/config`, under the plugin:

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the plugin fully off: no tools, nothing fetched or sent. `mcp-server-cards` keeps working on its own. |
| `registry` | empty | The ARD registry for `ard_search` to ask when the request names none. Empty by default: no registry is chosen for you, so each search names its own. Your query text is sent to the registry, once you say yes. |

## Limits

- **The query leaves your machine**, once you approve that search. Only the words
  Claude puts in the query are sent, with no cookie or credential, but the
  registry sees them.
- **Search results today.** The one public registry found returns MCP Registry
  entries, which are not Server Cards, so nothing it returns can be added yet.
  Until a public registry serves valid cards, the demo registry stands in.
- **The address limits of `mcp-server-cards` apply here too.** A public registry
  URL that redirects to a private address, or a public name that resolves to
  one, is not caught. Only addresses named directly are refused.

## Security

Everything this plugin finds is someone else's claim, and it is handed to
`mcp-server-cards`, which checks it before you see it. It writes nothing and
keeps no store: adding a server is `mcp-server-cards`' job, and needs you.

- **Search** makes one `POST` of the query text to the registry, and the same to
  at most three registries it refers to. Each search asks you first.
- **Discovery by domain** sends no query: only plain `GET`s to that domain.
- A public registry can't refer it to a local or private address.

The launch security review (24 November 2026, by an AI session, not a human
audit) checked that a search result can't impersonate a publisher, and its
re-check found that searches were not each put to you; every search now is.

The full account:
[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md).

## More

On GitHub, in [`polyfills/ard/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/README.md),
with one row for each rule ARD v0.91 puts on a consumer of MCP Server Cards and
the test that covers it, the proof, and the findings to report upstream.
