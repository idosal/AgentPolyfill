---
description: ard-discovery adds the consumer side of Agentic Resource Discovery (ARD v0.91, a draft outside MCP) for MCP servers. Install, search approval and limits are listed per host. It's installed separately.
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
  alt="In Claude Code, What does buildkite.com list via ARD? shows Buildkite's MCP server, listed by buildkite.com, with an Add button. Then a search of a local demo ARD registry for a server that checks CI builds: Claude Code first asks whether to send the query to that registry and up to three it refers to, and after Yes the result lists Buildkite and Netlify, each confirmed by its own domain, and says where the query went."
  caption="A real session (16 s; waits sped up, with a badge saying how fast): buildkite.com's own listing, found from its domain, then a search of a local demo registry, asked about first."
/>

In Claude Code, it only finds. Each Server Card it finds goes to
[`mcp-server-cards`](./server-cards), which checks it against the schema and
shows it under the answer with an **Add** button. For a search result,
`mcp-server-cards` also asks the publisher's own domain whether the server is
theirs.

::: warning Search sends your query to a third party
`ard_search` posts the words of your request to an ARD registry, a service
someone else runs, which ranks other people's servers. In Claude Code, the
plugin ships with no registry: you name one in the request, or set one with the `registry` setting,
and the query also goes to up to three registries it refers to. With neither, a
search is refused and nothing is sent. Claude Code asks you before every search, showing
the query and where it goes; with nobody to ask (`claude -p`), nothing is sent.
For that reason the plugin is not part of the `agent-polyfill` bundle: you
install it by name.

In Pi, name the registry or set `ARD_DISCOVERY_REGISTRY`. Every search asks
in a Pi dialog, showing the exact query and endpoint; without a UI it is
refused. For the same reason, ARD is left out of
`pi install git:github.com/idosal/AgentPolyfill`, which installs Events,
Skills and Server Cards together. Install ARD separately from a clone.
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

```bash [Pi]
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/ard/pi/extension
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

### In Pi

Pi 1.6.0 (the version tested), with Node 22 or newer. Nothing for Pi is
published to npm or Pi's package gallery. ARD is installed on its own from
a clone: `pi install git:github.com/idosal/AgentPolyfill` installs Events,
Skills and Server Cards, leaving ARD out for the same reason as the Claude
Code bundle. Its search sends the words of your request to a registry after
asking each time. The extension is bundled, with nothing to build.
For one run without installing, use
`pi -e ./polyfills/ard/pi/extension`. Pi loads the path where it is, so keep
the clone. Remove it from the same folder with
`pi remove ./polyfills/ard/pi/extension`. Servers you added stay in
`mcp.json`; remove one with `pi mcp remove <name>`.

This form includes Server Cards checking and adding; no other polyfill is
required. Its add tool is `ard_add_mcp_server`, so it can run beside Server
Cards' `add_mcp_server`: Pi shares tool names across extensions and keeps
the first registration of a name.

The sections below name the host where behavior differs. Full guides by host:

- [Claude Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code)
- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi)

## Try it

Ask the agent:

> What MCP servers does buildkite.com list through ARD?

Then ask to add it:

- **Claude Code:** press **Add** under the answer.
- **Codex:** accept Codex's form.
- **Pi:** choose "Add it" in the extension's dialog. This add step is
  covered by real-Pi tests with a scripted model and a local server; it was
  **not completed in the live run**.

To try search, start the demo registry from a clone of the repository (it is a
demo, not a real registry: it reads the live catalogs of ten publishers and
answers by word match):

```bash
node polyfills/ard/claude-code/demo/registry.mjs
```

It listens on `http://127.0.0.1:9011`. Ask your host:

> My CI build failed and I don't have a tool for it. Search the registry at http://127.0.0.1:9011 for an MCP server that can check why.

Claude finds Buildkite, and says buildkite.com's own catalog confirms it.
In Pi, the recorded search returned publisher-confirmed Buildkite and
Netlify after the extension's search question. The query stays local with
this demo; fetching cards and checking publishers still makes public GETs.

## Using it, step by step

### In Claude Code

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

### In Pi

`ard_discover` reads a domain's `ard.json` and AI Catalog sources and checks
their Server Cards. `ard_search` uses a registry you name or set with
`ARD_DISCOVERY_REGISTRY`; none is configured by default. Before sending,
the extension shows the exact query and registry endpoint, and says that up
to three referrals may receive it. Only "Send the search", beside "Don't
send it", sends the query.

Adding is a separate question from `ard_add_mcp_server`, with "Don't add
it" and "Add it". It names the host, URL, headers, `mcp.json` in Pi's agent
folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) and
`pi mcp remove <name>`. On yes it runs Pi's own `pi mcp add` and registers
the server for the session. Use `/mcp` or `pi mcp login <name>` if sign-in
is needed. Print and JSON modes cannot ask, so searches and additions are
refused; RPC clients relay the dialogs.

## Settings

In Pi, use `ARD_DISCOVERY_REGISTRY` for your chosen registry and
`ARD_DISCOVERY_DISABLED=1` to turn the form off. It cannot detect native ARD
support: remove it or use the off switch when Pi supports ARD itself.

In Claude Code, in `/config`, under the plugin:

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the plugin fully off: no tools, nothing fetched or sent. `mcp-server-cards` keeps working on its own. |
| `registry` | empty | The ARD registry for `ard_search` to ask when the request names none. Empty by default: no registry is chosen for you, so each search names its own. Your query text is sent to the registry, once you say yes. |

## Limits

### In Claude Code

- **The query leaves your machine**, once you approve that search. Only the words
  Claude puts in the query are sent, with no cookie or credential, but the
  registry sees them.
- **Search results today.** The one public registry found returns MCP Registry
  entries, which are not Server Cards, so nothing it returns can be added yet.
  Until a public registry serves valid cards, the demo registry stands in.
- **The address limits of `mcp-server-cards` apply here too.** A public registry
  URL that redirects to a private address, or a public name that resolves to
  one, is not caught. Only addresses named directly are refused.

### In Pi

- **A search discloses its query.** The chosen registry and its referrals
  see it after approval; cancellation cannot recall it once sent.
- **The Server Cards Pi limits apply:** no live card comparison, SSE, URL
  secrets or command-valued headers; no check of DNS results for private
  addresses, and no atomic add-if-absent in Pi's CLI. See
  [Server Cards](./server-cards#limits).
- **Discover or search again after a session change.** New, resumed,
  forked and reloaded sessions forget shown cards.
- **The live run did not add a server.** It read buildkite.com's `ard.json`
  and searched the repository's demo registry after approval. The model then
  asked in chat instead of calling `ard_add_mcp_server`, and `mcp.json`
  stayed empty. Additions are covered by real-Pi tests with a scripted model
  and a local server, not by that live run.

## Security

### In Claude Code

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

### In Pi

Each search and each addition needs its own answer in the extension's
dialog. Pi runs tools without asking unless a permission extension asks;
the polyfill supplies those questions itself. Its `readOnlyHint`
annotations let permission extensions distinguish calls; search is marked
not read-only because it sends your query. The extension reads no stored
credentials. A publisher's catalog can confirm a result, but cannot approve
an addition. See
[Pi's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/SECURITY.md).
An AI reviewer who did not build the Pi forms reviewed them, and checked
the fixes again. They have not been audited by a person.

[Pi's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/conformance.md)
documents the shared ARD and Server Cards rules, Pi's questions and the
tested add path. No upstream conformance run or independent public-registry
run is claimed. The [live-run transcript](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/live-run.md)
shows discovery and the approved demo search, and stops before addition.

## More

On GitHub, in [`polyfills/ard/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/README.md),
with one row for each rule ARD v0.91 puts on a consumer of MCP Server Cards and
the test that covers it, the proof, and the findings to report upstream.
