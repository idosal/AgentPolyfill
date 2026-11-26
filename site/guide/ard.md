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
  alt="Claude Code lists the MCP server published by buildkite.com. The user approves searching a local registry, which returns servers from Buildkite and Netlify."
  caption="Domain discovery and an approved registry search in Claude Code."
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

In Hermes, name the registry or set `ARD_DISCOVERY_REGISTRY` in the
gateway's environment. Every search goes through Hermes's approval, naming
the exact endpoint and query. Session and always cover only that exact query
to that endpoint; different words ask again. A referral needs a separate
call and approval; a decline or an unanswerable approval sends no query.

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
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity/plugin
```

```bash [Copilot CLI]
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install ard-discovery@agent-polyfill
```

```bash [Hermes]
hermes plugins install idosal/AgentPolyfill/polyfills/ard/hermes/plugin --enable
```

:::

Install ARD separately. In Claude Code it also installs Server Cards. Registry searches require approval before the query leaves the host.

See [Getting started](./getting-started) for host prerequisites and configuration.

## Try it

Ask the agent:

> What MCP servers does buildkite.com list through ARD?

Then ask to add it:

- **Claude Code:** press **Add** under the answer.
- **Codex:** accept Codex's form.
- **Pi:** choose "Add it" in the extension's dialog. This add step is
  checked by the form's tests only.
- **OpenCode:** ask OpenCode to add it, and allow it when OpenCode asks.
  Adding through this plugin is checked by the form's tests only.
- **Antigravity:** approve the addition in Antigravity's approval card. The
  plugin then writes the server to `~/.gemini/config/mcp_config.json`.
- **Copilot CLI:** after Copilot's tool prompt, accept the plugin's form.
  Run `/mcp reload`, and sign in when Copilot asks (`/mcp auth buildkite`).
  Adding through this plugin is checked by the form's tests only.
- **Hermes:** approve the addition, then run `/reload-mcp`. If the result
  names an OAuth challenge, use `hermes mcp login <name>` first. The README's
  first question is "Use ARD to discover the MCP servers neon.com publishes."
  Checked in Hermes v0.23.4: discovery of buildkite.com's `ard.json` and card.
  Search and adding are checked by the form's tests only.

To try search, start the demo registry from a clone of the repository (it is a
demo, not a real registry: it reads the live catalogs of ten publishers and
answers by word match):

```bash
node polyfills/ard/claude-code/demo/registry.mjs
```

It listens on `http://127.0.0.1:9011`. Ask your host:

> My CI build failed and I don't have a tool for it. Search the registry at http://127.0.0.1:9011 for an MCP server that can check why.

Claude finds Buildkite, and says buildkite.com's own catalog confirms it.
The query stays local with this demo; fetching cards and checking publishers
still makes public GETs. This search was checked in Pi 1.6.0, OpenCode 2.4.1
and Copilot CLI 1.0.115: it goes out only after the host's or the plugin's
search question.

Not checked in Hermes: a search of a public registry. The form's tests cover
an approved search, a referral approved separately and an addition.

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
tool `<action>`" (checked for the other three plugins; ARD was not checked
in the TUI). For a search, the model's call line just above the prompt names the
query and the registry you named. For a registry a referral names, nothing on
screen names its host, so reject a prompt you can't read. OpenCode Desktop
shows a plugin action's resource in its prompt (checked for Events and
Skills), but ARD was not checked there either.

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

### In Hermes

`ard_discover` reads a domain's ARD manifest and AI Catalog sources, and
checks the cards. It is read-only. `ard_search` sends up to 300 plain
characters to one registry endpoint after Hermes's approval. No registry
is built in. The question shows the endpoint and full query. Session and
always cover only that exact query to that endpoint. The approval key includes
the endpoint, query and referral; different words ask again. Where Hermes
approves without asking (`--yolo`, `/yolo`, `hermes -z`, `approvals.mode: off`), the
plugin refuses the search, and an addition, instead: Hermes would answer for
you, and both need your own yes. Hermes's unattended approve modes
(`approvals.cron_mode`, `single_query_mode` or `unattended_mode: approve`)
still approve them where nobody is present, and a kept "session" or "always"
answer covers its exact search or addition.

A referral is returned for another `ard_search` call with `referral: true`.
It needs its own approval and must be a referral this session received for
that exact query. Referrals stop after one hop. The plugin checks publisher
catalogs, labels unconfirmed results and prefers a publisher's own card.

Adding needs a separate approval through `ard_add_mcp_server`, using the
[Server Cards Hermes flow](./server-cards#using-it-step-by-step). It writes
`mcp_servers` in `config.yaml`; `/reload-mcp` connects the server. The
`ard_remove_mcp_server` tool removes only unchanged entries this plugin added,
with another approval. Neither operation removes secrets or token files.

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
text; not checked), wasn't seen to read `ard.json` or speak ARD's registry search,
so the plugin doesn't stand down for it.

In Hermes, `ARD_DISCOVERY_REGISTRY` goes in the gateway's environment.
`hermes plugins disable ard-discovery` or `ARD_DISCOVERY_DISABLED=1` turns
the plugin off, leaving approved servers in Hermes's configuration. Hermes
v0.23.4 has no native ARD support to detect.

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
- **Adding is checked by the form's tests only.** Checked in Pi 1.6.0:
  reading buildkite.com's `ard.json`, and a search of the repository's demo
  registry after approval.

### In OpenCode

- **A search discloses its query** to the registry and the registries it
  refers to, once you allow it.
- **The Server Cards OpenCode limits apply** to adding: streamable HTTP only,
  secrets added by hand with `{env:VAR}`, per project, and no check against
  the live server. See [Server Cards](./server-cards#limits).
- **The TUI's referral prompt.** In OpenCode's TUI, nothing on screen names
  a referred registry's host (above).
- **No public registry was checked.** None that takes an unauthenticated
  search was found; search was checked against the repository's demo
  registry only.
- **Not checked yet:** ARD in OpenCode's TUI and in OpenCode Desktop, and
  Windows outside CI (CI runs the tests there). Adding is checked by the
  form's tests only.

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
- **No public registry was checked.** Search was checked against the
  repository's demo registry only.
- **Not checked in VS Code.** In VS Code 1.147.0's Copilot harness the
  plugin's server loads, but no search or add was checked there. Its add
  form is the Server Cards form, which was checked there.
- **Adding is checked by the form's tests only.**

### In Hermes

- **A lasting approval covers one request.** Session and always cover that
  exact query to that endpoint only; different words ask again.
- **Referrals require separate calls and approvals.** Receiving one is not
  permission to send your query there.
- **The Server Cards limits apply.** Connecting needs `/reload-mcp`; there
  is no live card comparison, OAuth detection is bounded, and cards with
  only the stateless 2026 protocol are refused pending verification.
- **Only MCP cards are offered for addition.** Other artifact types are ignored.
- **No live registry search was sent.** The live run covered domain discovery
  with a scripted model; searches and additions used local test fixtures.

### In T3 Code

T3 Code runs Codex, Claude Code or OpenCode for you, and this polyfill's
forms for them load there. With Codex, the question it asks before sending a registry search ("Send the search") is
an MCP elicitation form, and T3 Code shows such a form only when it can
answer it with Approve or Decline; it cancels this one without showing it, so
the step is refused as if you had said no. Nothing is approved for you.
Not checked in T3 Code.
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

A search result can't impersonate a publisher, and every search is put to
you.

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

[Pi's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/docs/conformance.md)
documents the shared ARD and Server Cards rules, Pi's questions and the
tested add path. No upstream conformance run or independent public-registry
run is claimed. Checked in Pi 1.6.0: discovery and the approved demo search.
Adding is checked by the form's tests only.

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
registry). Its tests run the plugin in OpenCode 2.4.1; CI runs them on Linux, macOS
and Windows. No upstream
conformance run or public-registry run is claimed. Checked in OpenCode
2.4.1: buildkite.com's `ard.json` read, and a search of the demo registry
sent after OpenCode asked. Adding is checked by the form's tests only.

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
(124 tests). No upstream conformance run is claimed. Checked in Copilot CLI
1.0.115: `ard_discover` reading buildkite.com's catalogs, and a search of
the demo registry going out only after the tool prompt and "Send the
search".

### In Hermes

Every search goes through Hermes's approval, naming the endpoint and query,
and none is sent where Hermes approves without asking. A kept session or
always answer covers that exact query to that endpoint only; different words
ask again. A referral needs its own approval. Adding
uses the Server Cards checks and a separate approval. Fetching checks the
address at connection time, refusing private addresses behind public names.
The plugin reads no credential files. See
[Hermes's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/hermes/SECURITY.md).

The [README](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/hermes/README.md#tests)
records tests in Hermes v0.23.4 for declined and approved searches, separate
referral approvals, additions and coexistence with Server Cards. With a
scripted model, the live run read buildkite.com's `ard.json` and validated
its card. No live registry search or upstream ARD conformance run is claimed.

## More

On GitHub, in [`polyfills/ard/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/README.md),
with one row for each rule ARD v0.91 puts on a consumer of MCP Server Cards and
the test that covers it, test results and interoperability notes.
