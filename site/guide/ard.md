---
description: ard-discovery adds the consumer side of Agentic Resource Discovery (ARD v0.91, a draft outside MCP) for MCP servers. Install, search approval and limits are listed per host. It's installed separately.
---

# ARD discovery

`ard-discovery` adds the consumer side of
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) (ARD)
for MCP servers. ARD is a draft ("Proposal") published by the ards-project
on GitHub. It is not an MCP specification, and it can still change. The
plugin finds servers in two ways:

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

In OpenCode, name the registry or set `ARD_DISCOVERY_REGISTRY`; with neither,
nothing is sent. Every search is put to OpenCode's permission rules and asked
about by default, and so is a registry a referral names, before the query
goes there. With nobody to answer, OpenCode refuses. OpenCode has no bundle;
this plugin is installed separately too.

In Antigravity, name the registry or set `ARD_DISCOVERY_REGISTRY` in the
environment Antigravity starts in; there is no default. Every search is put
to you in Antigravity's approval card, yes or no; the App greys out its
"always allow" choices, and the CLI's card still lists them. The plugin is
installed separately too.

In Copilot CLI, name the registry or set `ARD_DISCOVERY_REGISTRY`. Copilot's
tool prompt comes first, then the plugin's form names the registry and the
exact query. Where nobody can be asked (`copilot -p`, even with `--yolo`),
Copilot declines the form and nothing is sent. Copilot has no bundle; this
plugin is installed separately too.
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

```bash [OpenCode]
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/ard/opencode/plugin'
```

```bash [Antigravity]
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
agy plugin install ./polyfills/ard/antigravity/plugin
```

```bash [Copilot CLI]
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install ard-discovery@agent-polyfill
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

### In OpenCode

OpenCode 2.4 or newer (tested with 2.4.1). OpenCode runs the plugin itself,
so you don't need Node. The plugin isn't on npm: the command fetches it from
GitHub, with Git, and adds it to `plugins` in your global
`~/.config/opencode/opencode.json`, so it runs in every project from the next
time OpenCode opens one. A commit in place of `main` pins one version. From a
clone, put the folder `polyfills/ard/opencode/plugin` in `plugins` in an
`opencode.json` instead. To remove it, run `opencode plugin remove` with the
same text; OpenCode's downloaded copy stays in `~/.cache/opencode/npm/` (a
`git-AgentPolyfill-…` folder), which you can delete. Removing it stops adding
the servers it added, which were never in your configuration files. Its list
of them stays in OpenCode's plugin storage (OpenCode's own database) and
comes back if you install it again; remove a server with
`ard_remove_mcp_server` first to drop it from the list.

It works on its own; installing `mcp-server-cards` beside it is optional.
Adding a server it finds works as in
[`mcp-server-cards`](./server-cards#using-it-step-by-step) in OpenCode, with
the same code and the same permission actions.

### In Antigravity

Node 20 or newer on `PATH`. Nothing is published to Antigravity's
Marketplace; install from a clone, with the Antigravity CLI (the App doesn't
ship `agy`). `agy plugin install` copies the folder to
`~/.gemini/config/plugins/ard-discovery`, which the App and the CLI both
read. Remove it with `agy plugin uninstall ard-discovery`. Servers you added
stay in `~/.gemini/config/mcp_config.json`; remove one with
`agy mcp remove <name>` (in CLI 1.5.17's own help, not in Antigravity's
docs).

This form carries the Server Cards checks and add step itself, as the Codex
and Pi forms do; it doesn't need `mcp-server-cards` installed. It was run in
the App (2.35.1) and the CLI (1.5.17).

### In Copilot CLI

Copilot CLI 1.0.115 (the version tested), with Node 20 or newer on your
`PATH`. It is an MCP server in a plugin, so it needs no experimental mode. The
install from a clone is the one tested; keep the clone. From GitHub,
`copilot plugin marketplace add idosal/AgentPolyfill` adds the marketplace;
that was checked on 25 November 2026 with Copilot CLI 1.0.105 in an isolated home with no sign-in (the three plugins installed and loaded, byte-identical to main), not on 1.0.115, in the interactive TUI, or in VS Code. Start a new
Copilot session afterwards. Remove it with
`copilot plugin uninstall ard-discovery@agent-polyfill`. Servers you added
stay in `~/.copilot/mcp-config.json`; remove one with
`copilot mcp remove <name>`.

It works on its own, with its own `add_mcp_server`, the one from the Server
Cards Copilot form. Installing `mcp-server-cards` beside it is optional;
Copilot keeps the two tools apart by server name.

The sections below name the host where behavior differs. Full guides by host:

- [Claude Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code)
- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi)
- [OpenCode](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/opencode)
- [Antigravity](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity)
- [Copilot CLI](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/copilot)

## Try it

Ask the agent:

> What MCP servers does buildkite.com list through ARD?

Then ask to add it:

- **Claude Code:** press **Add** under the answer.
- **Codex:** accept Codex's form.
- **Pi:** choose "Add it" in the extension's dialog. This add step is
  covered by real-Pi tests with a scripted model and a local server; it was
  **not completed in the live run**.
- **OpenCode:** ask OpenCode to add it, and allow it when OpenCode asks.
  Adding through this plugin is covered by its tests in a real OpenCode,
  with a scripted model and a local server; the live runs didn't add a
  server through it.
- **Antigravity:** approve the addition in Antigravity's approval card. The
  plugin then writes the server to `~/.gemini/config/mcp_config.json`.
- **Copilot CLI:** after Copilot's tool prompt, accept the plugin's form.
  Run `/mcp reload`, and sign in when Copilot asks (`/mcp auth buildkite`).
  Adding through this plugin is covered by tests that run its server as
  Copilot starts it; the live run didn't add a server through it.

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
In OpenCode, a live search of the demo registry, sent after OpenCode asked,
returned Buildkite's and Netlify's servers, each confirmed by its
publisher's catalog. In Copilot CLI, with a scripted model, the search went
out only after Copilot's tool prompt and "Send the search" in the plugin's
form, and the result listed Buildkite and Netlify, both confirmed by their
publishers.

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

### In OpenCode

`ard_discover` reads a domain's `ard.json`, its `rel="ard"` links and the AI
Catalog, then fetches and checks each card. `ard_search` posts the query to
the registry you name or set with `ARD_DISCOVERY_REGISTRY` (none by
default), and follows its referrals one hop, to at most three registries.
Before anything is sent, OpenCode asks you about `ard_search` on the
registry's host; the request carries the exact query and endpoints. A
registry a referral names is asked about the same way before the query goes
there, and one you don't allow gets nothing. OpenCode's shipped rules allow
every action, so the plugin makes its own actions ask by default, and "Allow
always" saves nothing: each search is asked about on its own. A query is one
line of plain words, at most 300 characters. The plugin option
`askByDefault: false` (or `ARD_DISCOVERY_ASK_BY_DEFAULT=0`) leaves searches
and additions to OpenCode's rules alone, under whose default a search is
sent without a prompt.

One limit: OpenCode 2.4.1's TUI shows a plugin's own action as only "Call
tool `<action>`" (seen for the other three plugins; ARD wasn't tried in the
TUI). For a search, the model's call line just above the prompt names the
query and the registry you named. For a registry a referral names, nothing on
screen names its host, so reject a prompt you can't read. OpenCode Desktop
shows a plugin action's resource in its prompt (seen for Events and Skills),
but ARD wasn't tried there either.

`ard_add_mcp_server` and `ard_remove_mcp_server` add or remove a server
either tool showed, as `mcp-server-cards` does in OpenCode: asked about,
kept per project in the plugin's OpenCode storage, connected by OpenCode
itself, with `opencode mcp auth <name>` for a sign-in. With nobody there to
answer, as in a scheduled run, OpenCode refuses searches and additions.

### In Antigravity

There is no default registry: a search names one, or uses
`ARD_DISCOVERY_REGISTRY` from the environment Antigravity starts in. Every
registry search, and every addition, is put to you in Antigravity's
approval card, yes or no; the CLI's card shows the question's first two
lines, with the endpoints and the query. An addition writes
`~/.gemini/config/mcp_config.json` only after your yes. Editors on `agy acp`
see the tool and its arguments in the card, not the question: the query and
the registry argument, not the endpoints or the referrals. In CLI 1.5.17, a
search of Hugging Face's own registry went to that endpoint only after the
approval, and a declined one sent nothing.

### In Copilot CLI

`ard_discover` reads a domain's `ard.json` and AI Catalog sources and checks
their Server Cards; it only reads. `ard_search` uses a registry you name or
set with `ARD_DISCOVERY_REGISTRY`; none is configured by default. Copilot asks
before each tool runs, as for any MCP tool. Then the plugin's form names the
endpoints and the exact query, and says up to three referrals may receive it.
Only "Send the search", beside "Don't send it", sends the query.

Adding is a separate form from `add_mcp_server`, with "Don't add it" and "Add
it", as in [Server Cards](./server-cards#using-it-step-by-step). It writes with
`copilot mcp add` into `~/.copilot/mcp-config.json`, and the server connects
after `/mcp reload`. Where nobody can be asked (`copilot -p`, with
`--allow-all-tools` or `--yolo`), Copilot declines the form, so nothing is
sent or written.

## Settings

In Pi, use `ARD_DISCOVERY_REGISTRY` for your chosen registry and
`ARD_DISCOVERY_DISABLED=1` to turn the form off. It cannot detect native ARD
support: remove it or use the off switch when Pi supports ARD itself.

In OpenCode, `ARD_DISCOVERY_REGISTRY` sets the registry a search goes to
when the request names none (unset by default). `ARD_DISCOVERY_DISABLED=1`,
or the plugin option `off`, turns the plugin off, and
`ARD_DISCOVERY_ASK_BY_DEFAULT=0`, or `askByDefault: false`, leaves searches
and additions to OpenCode's rules alone. Set a variable in the environment
OpenCode starts in, and an option in the object form of the plugin's entry in
`plugins`.

In Antigravity, the same two settings apply, in the environment Antigravity
starts in: `ARD_DISCOVERY_REGISTRY` and `ARD_DISCOVERY_DISABLED=1`.
`agy plugin disable ard-discovery` turns it off too. It cannot detect native
ARD support either.

In Copilot CLI, `ARD_DISCOVERY_REGISTRY` sets the registry a search goes to
when the request names none (unset by default), and
`ARD_DISCOVERY_DISABLED=1` or
`copilot plugin disable ard-discovery@agent-polyfill` turns the plugin off. It
can't detect native ARD support. Copilot 1.0.115's own discovery, a built-in
`discover-resources` skill searching a catalogue Copilot is given (by its
text; not run), wasn't seen to read `ard.json` or speak ARD's registry search,
so the plugin doesn't stand down for it.

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

### In OpenCode

- **A search discloses its query** to the registry and the registries it
  refers to, once you allow it.
- **The Server Cards OpenCode limits apply** to adding: streamable HTTP only,
  secrets added by hand with `{env:VAR}`, per project, and no check against
  the live server. See [Server Cards](./server-cards#limits).
- **The TUI's referral prompt.** In OpenCode's TUI, nothing on screen names
  a referred registry's host (above).
- **No public registry was tried.** None that takes an unauthenticated
  search was found; searches ran against the repository's demo registry.
- **Not tried yet:** ARD in OpenCode's TUI and in OpenCode Desktop, and
  Windows by hand (CI runs the tests there). The live runs didn't add a
  server through it; additions are covered by its tests in OpenCode.

### In Antigravity

- **A search discloses its query** to the registry you chose, after your
  yes in the approval card.
- **The Server Cards Antigravity limits apply:** a card that needs a secret
  can't be added. See [Server Cards](./server-cards#limits).
- **Yes or no.** Editors on `agy acp` see the tool and its arguments, not
  the question.
- **Not in the IDE.** The IDE documents no plugin hooks, so the forms aren't
  supported there, and their gated calls are refused.

### In Copilot CLI

- **The query leaves your machine** once you accept that search.
- **Two questions per search or add:** Copilot's tool prompt, then the form.
- **The Server Cards Copilot limits apply:** no live card comparison (S-3),
  new servers need `/mcp reload`, adding works in the interactive session
  only, and a public name that resolves to a private address isn't caught.
  See [Server Cards](./server-cards#limits).
- **No public registry was tried.** Searches ran only against the
  repository's demo registry on 127.0.0.1.
- **Not run in VS Code.** In VS Code 1.147.0's Copilot harness the plugin's
  server loaded, but no search or add was run through it there. Its add form
  is the Server Cards form, which VS Code showed and answered there.
- **What the live run didn't cover:** the Copilot CLI run used a scripted
  model, and didn't add a server through `ard_search`. Adding is covered by
  tests that run the plugin's server as Copilot starts it.

### In T3 Code

T3 Code runs Codex, Claude Code or OpenCode for you, and this polyfill's
forms for them load there. With Codex, the question it asks before sending a registry search ("Send the search") is
an MCP elicitation form, and T3 Code shows such a form only when it can
answer it with Approve or Decline; it cancels this one without showing it, so
the step is refused as if you had said no. Nothing is approved for you.
Not run live in T3 Code.
[T3 Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md) has the details.

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

### In OpenCode

Each search is put to OpenCode's permission rules before anything is sent,
and asked about by default; nothing is saved by "Allow always". A registry a
referral names is put to them too, before the query goes there, so your
`allow` and `deny` rules hold for it. What is sent is what the request shows:
one line, at most 300 characters, with no control characters, direction
marks or markup. The plugin never answers a prompt and never turns anything
into `allow`. A result counts as confirmed only when its publisher's own
catalog lists it. Fetching, showing and adding a server are as in
`mcp-server-cards` for OpenCode. See
[OpenCode's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/SECURITY.md).

[OpenCode's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/docs/conformance.md)
records 19 rules: 17 met, 1 partly met (R-8, as in the other forms), and 1
met with a stated exception (Q-3: the TUI's prompt doesn't name a referred
registry). Its tests run the plugin in OpenCode 2.4.1 against a local web
with an `ard.json`, a card, a small MCP server and a registry, with a
scripted model; CI runs them on Linux, macOS and Windows. No upstream
conformance run or public-registry run is claimed. The
[live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md)
records buildkite.com's `ard.json` read and a search of the demo registry
sent after OpenCode asked; it added no server.
An AI reviewer who did not build the OpenCode forms reviewed them. They have
not been audited by a person.

### In Antigravity

Each search and each addition is put to you in Antigravity's approval card,
through `force_ask`, and nothing is auto-approved: no `auto_approve`, no
permission overrides. The hook leaves a one-use ticket for exactly that call,
and the MCP server acts only with it. Whether
`--dangerously-skip-permissions` also skips `force_ask` hasn't been
checked. The plugin writes only its own folder,
`~/.gemini/agentpolyfill/ard-discovery/`, and, after your approval,
`~/.gemini/config/mcp_config.json`. It never opens a sign-in store. See
[Antigravity's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/antigravity/SECURITY.md).
The independent AI review of the Antigravity forms is in progress.

### In Copilot CLI

Each search and each addition needs Copilot's tool prompt, then its own answer
in the plugin's form: only "Send the search" sends, and only "Add it" adds.
`ard_search` is marked not read-only, since it sends your words to a third
party, and VS Code's Copilot harness runs read-only tools without asking
(Copilot CLI 1.0.115 asked before them).
`ard_discover` is read-only. What is sent is what the form shows. The
plugin stores nothing on disk and never reads Copilot's stored credentials.
See [Copilot's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/copilot/SECURITY.md).

[Copilot's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/copilot/docs/conformance.md)
documents the shared ARD and Server Cards rules and Copilot's questions
(124 tests). No upstream conformance run is claimed. In Copilot CLI 1.0.115,
with a scripted model, `ard_discover` read buildkite.com's catalogs, and a
search of the demo registry on 127.0.0.1 went out only after the tool prompt
and "Send the search".

## More

On GitHub, in [`polyfills/ard/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/README.md),
with one row for each rule ARD v0.91 puts on a consumer of MCP Server Cards and
the test that covers it, the proof, and the findings to report upstream.
