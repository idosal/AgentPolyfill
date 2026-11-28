---
description: mcp-server-cards adds the client side of MCP Server Cards (SEP-2127). The agent finds the MCP servers a domain publishes, checks each card, and adds the one you pick to the host's own config. Install and limits are listed per host.
---

# Server Cards

In Claude Code, `mcp-server-cards` lets Claude find the MCP servers a domain
publishes, and connect Claude Code to one. Name a company, and Claude reads
that domain's catalog, fetches each Server Card it lists, checks the card against the schema,
and shows you what it found. Under the result there is a list of the servers you
can add, each with an **Add** button.

Press **Add**, and the server goes into Claude Code's own MCP configuration, as
if you had typed `claude mcp add`. Claude Code then connects it with its own
sign-in, so servers behind OAuth work. Nothing is installed besides that
configuration entry, and the polyfill never sees a token.

The host forms below add the client side of the MCP **Server Cards**
extension, which these hosts don't support natively yet:

- [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md),
  Final. The extension's stage is Beta, so it can still change.
- The schema and discovery rules in
  [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card) at
  commit `28db12c9b4` (2026-11-19).
- The [AI Catalog](https://github.com/Agent-Card/ai-catalog) that SEP-2127 hands
  domain discovery to, v0.9 (a release candidate).

<Recording
  cut="server-cards"
  alt="Claude Code and Codex each list the servers published by neon.com. The user selects Neon Docs and approves adding it to the host configuration."
  caption="Adding Neon Docs to Claude Code and Codex."
/>

## Install

::: code-group

```txt [Claude Code]
/plugin install mcp-server-cards --marketplace idosal/AgentPolyfill
```

```bash [Codex]
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add mcp-server-cards@agent-polyfill
```

```bash [Cursor IDE]
# From a clone of AgentPolyfill, with Node.js 20+ installed
mkdir -p ~/.cursor/plugins/local/mcp-server-cards
cp -R polyfills/server-cards/codex/plugin/. ~/.cursor/plugins/local/mcp-server-cards/
```

```bash [Pi]
pi install git:github.com/idosal/AgentPolyfill
```

```bash [OpenCode]
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'
```

```bash [Antigravity]
agy plugin install https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity/plugin
```

```bash [Copilot CLI]
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install mcp-server-cards@agent-polyfill
```

```bash [Hermes]
hermes plugins install idosal/AgentPolyfill/polyfills/server-cards/hermes/plugin --enable
```

:::

After installation, start a new session and ask for a domain’s MCP servers. The Pi command installs Events, Skills and Server Cards together.

See [Getting started](./getting-started) for host prerequisites and configuration.

## Try it

Nothing to set up. Start your host:

- **Claude Code:** `claude`.
- **Codex:** `codex`.
- **Cursor IDE** — Restart the editor after copying the plugin.
- **Pi:** `pi`.
- **OpenCode:** `opencode`.
- **Antigravity:** the App or `agy`.
- **Copilot CLI:** `copilot`.
- **Hermes:** `hermes`.

Ask:

> What MCP servers does neon.com publish?

Then add **Neon Docs** (no sign-in):

- **Claude Code:** press **Add**.
- **Codex:** choose "Add it" in Codex's own form.
- **Cursor IDE** — Open the returned install link and review the server name and URL. **Install** adds the server to your user MCP settings. **Cancel** dismisses the dialog. The plugin offers links for Streamable HTTP remotes without headers or secrets and checks for a name collision before generating a link.
- **Pi:** ask "Add Neon Docs", then choose "Add it" in Pi's dialog. It is
  saved and registered for the current session, without a restart.
- **OpenCode:** ask "Add Neon Docs", then allow it when OpenCode asks. It is
  in OpenCode's MCP servers at once, and OpenCode connects it.
- **Antigravity:** approve the addition in Antigravity's approval card. The
  plugin then writes the server to `~/.gemini/config/mcp_config.json`.
- **Copilot CLI:** ask "Add Neon Docs". Copilot's tool prompt comes first,
  then the plugin's form: choose "Add it". Run `/mcp reload` (or start a new
  session) to use it. `copilot mcp remove neon-docs` removes it again.
- **Hermes:** ask "Add Neon Docs" and approve Hermes's prompt. The entry
  goes in `mcp_servers` in `config.yaml`. Run `/reload-mcp` or start a new
  session to connect it. `hermes mcp remove neon-docs`, then `/reload-mcp`,
  removes it again. If the result calls for OAuth, use
  `hermes mcp login <name>` before reloading.

For one behind a sign-in, ask about
buildkite.com; once it's added, the host asks you to sign in (in Claude Code,
through `/mcp`). In OpenCode, sign in with `opencode mcp auth <name>`, in a
terminal. In Antigravity, use Authenticate in Customizations > Installed >
MCP Servers (`/mcp` in the CLI); signing in after an addition hasn't been
checked yet. In Claude Code, `claude mcp remove neon-docs -s local`
removes it again; in OpenCode, ask for it to be removed, which OpenCode asks
you about too.

## Using it, step by step

### In Cursor IDE

1. Ask which MCP servers a domain publishes. Discovery checks its catalog and returns the server names and remote URLs.
2. Pick a server and ask for its install link. Cursor Server Cards supports Streamable HTTP remotes without headers or secrets. If the name is already taken in your user or current workspace MCP settings, choose a different name.
3. Open the link. Compare **Name** and the full **Server URL** with the discovery result. Choose **Install** to save it across projects, or **Cancel** to dismiss it. You can remove a saved server in **Customize → MCPs**.

<Recording
  src="/media/cursor-server-cards.mp4"
  poster="/media/cursor-server-cards.jpg"
  :width="960"
  :height="800"
  :autoplay="false"
  :loop="false"
  alt="The discovery result for the synthetic Atlas Docs server and the matching name and loopback URL in Cursor’s install dialog."
  caption="Reviewing Atlas Docs in Cursor IDE 3.32.4. The clip ends at the install decision."
/>

The plugin checks for an existing name when it prepares the link. If you change your settings before opening it, request a fresh link. [Security and privacy details](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/codex/SECURITY.md#cursor-install-link).

### In Claude Code

1. **Ask.** For example "connect Claude Code to Buildkite", or "what MCP servers
   does neon.com publish?".
2. **Claude Code asks before the first lookup.** The first call to
   `discover_mcp_servers` gets Claude Code's usual permission prompt, as any new
   tool does. If you say no, nothing is fetched.
3. **Claude shows what it found:** each server's card, and whether the card is
   valid. A refused card says why; nothing refused can be added.
4. **Pick one.** Under the result, a box lists the servers you can add: each
   one's name, the URL it connects to and, on its own line, the host, who
   stands behind it, and the server name and headers it would write, with an
   **Add** button.
   - **Add** adds that server, with the card as shown and its defaults, to the
     local scope (this project, only you). The press is your choice, so no
     further prompt follows.
   - It never replaces a server you have. If the name is taken in any scope, it
     adds the server as `name-2` (up to `name-9`) and says so.
   - A server whose card needs an input (a tenant name, say) shows no button.
     Ask Claude, who will ask you for it.
5. **Or ask Claude to add it.** Claude calls `add_mcp_server`, and Claude Code
   always asks you: the polyfill makes that question itself, so no allow rule
   or auto mode answers it for you. It names the server, the URL, the headers,
   the scope and how to undo it. With nobody to ask (`claude -p`), it is
   refused.
6. **The server is connected.** If it needs a sign-in, run `/mcp`, pick the
   server and authenticate. The sign-in is Claude Code's own.
7. **To undo an addition:** `claude mcp remove <name> -s local` (or
   `-s project`, `-s user`). The result gives the exact line.
8. **If the card asks for a secret** (an API key, say), the polyfill never asks
   you for it and never shows it to Claude. The configuration holds a reference
   such as `${MCP_EXAMPLE__TOKEN_4GQXEC3IVEMVBYCQ}`, and Claude tells you its
   name. Set that environment variable and restart Claude Code.

### In Pi

`discover_mcp_servers` reads the domain's AI Catalog and checks each card.
Ask to add one it found: `add_mcp_server` asks a Pi dialog with "Don't add
it" and "Add it". It names the host, URL, headers, the file it writes
(`~/.pi/agent/mcp.json`, or `mcp.json` under `PI_CODING_AGENT_DIR`) and the
undo command, `pi mcp remove <name>`.

Only "Add it" runs Pi's own `pi mcp add` and registers the server for the
session. A saved entry and a successful connection are separate results;
check `/mcp` if connection fails. For sign-in, use `/mcp` or
`pi mcp login <name>`. The extension never reads Pi's stored credentials.
Print and JSON modes cannot ask, so additions are refused. RPC clients
relay the dialog to you.

### In OpenCode

`server_cards_discover_mcp_servers` reads the domain's
`/.well-known/ai-catalog.json` and the `rel="ai-catalog"` links on its home
page, then fetches and checks each card. Ask to add one it found:
`server_cards_add_mcp_server` adds only a card a discovery showed in this
session, at the URL that card gives, and only if OpenCode has no server of
that name from anywhere else. OpenCode asks you first. Its shipped rules
allow every action, so the plugin makes additions ask by default, and "Allow
always" saves nothing: each addition is asked about on its own. In OpenCode
2.4.1's TUI the prompt says only "Call tool mcp_server_cards_add" and offers
only "Allow once" and "Reject". The model's call line just above it gives
the name, the card's identifier and the URL; the host, headers and undo the
request carries aren't shown. With nobody there to answer, OpenCode refuses
the question.

Approved, the server is in OpenCode's MCP servers at once, and OpenCode
connects it with its own client, so its tools, its sign-in and its
permission rules are OpenCode's. For a server behind a sign-in, run
`opencode mcp auth <name>`. What it adds is kept per project, in the plugin's
OpenCode storage, and added again each time OpenCode loads the plugin there.
It never writes your configuration files, and never replaces a server you
have. `server_cards_remove_mcp_server` takes away a server it added, after
OpenCode asks. A card that needs a secret isn't added: the answer gives you
the entry for `opencode.json`, with `{env:VAR}` where the secret goes, and
the variable to set.

### In Antigravity

Ask to add a server it found. The addition is put to you in Antigravity's
approval card, yes or no; the CLI's card shows the question's first two
lines, with the URL, header names and file. The App greys out the card's
"always allow" choices; the CLI's card still lists them. Only a yes writes
the server to `~/.gemini/config/mcp_config.json`; the plugin reads that file
first to check names. Editors on `agy acp` see the tool and its arguments in
the card, not the question; the call must carry the server's name, URL,
header names and file, so those are among the arguments.

### In Copilot CLI

`discover_mcp_servers` reads the domain's AI Catalog and checks each card;
Copilot asks before it runs, as for any MCP tool. Ask to add one it found:
Copilot asks before `add_mcp_server` runs, and then the plugin asks in
Copilot's form, with "Don't add it" first and "Add it". The form names the
server, host, URL, headers, the file it writes (`~/.copilot/mcp-config.json`,
for all your projects) and the undo command, `copilot mcp remove <name>`.

Only "Add it" writes, with `copilot mcp add`. Copilot connects the server
after `/mcp reload`, or in your next session; if it needs a sign-in, Copilot
offers it then (`/mcp auth <name>`). The plugin never reads Copilot's stored
credentials. Where nobody can be asked (`copilot -p`, even with
`--allow-all-tools` or `--yolo`), Copilot declines the form, and nothing is
written.

### In Hermes

`discover_mcp_servers` reads the domain's AI Catalog and checks each card.
Refused cards remain visible with their reasons. Only a valid card shown in
this session can be added, at its exact endpoint. Ask to add one; Hermes's
approval names the server, URL, headers with their values (secrets as `${VAR}` references), transport, configuration file and undo
action. A decline writes nothing, and an unanswerable approval fails closed.
Hermes owns once/session/always choices; a lasting approval covers matching
actions. Existing names are refused. Where Hermes approves without asking
(`--yolo`, `/yolo`, `hermes -z`, `approvals.mode: off`), an addition is refused instead,
since Hermes would answer for you; a removal still goes to Hermes. Hermes's
unattended approve modes (`approvals.cron_mode`, `single_query_mode` or
`unattended_mode: approve`) still approve an addition where nobody is present,
and a kept "session" or "always" answer covers its exact addition.

The plugin writes `mcp_servers.<name>` in your profile's `config.yaml` with
Hermes's own config API. Run `/reload-mcp` to connect it and refresh the
tools, or start a new session. Secret inputs stay environment-variable
references for you to set; never send their values to the agent. The plugin
reads no credential files. After approval, an anonymous probe of an endpoint
without secret inputs can detect a Bearer challenge. The result then tells
you to run `hermes mcp login <name>` before reloading; the plugin never signs in.

`remove_mcp_server` asks before removing an unchanged entry this plugin
recorded in `added.json`. If you edited it, use Hermes's own remove command.
Removal leaves environment variables and OAuth tokens alone; `/reload-mcp`
disconnects the server.

### A domain that redirects

Some domains answer with a redirect to another domain: `neon.tech` sends its
catalog, and every other path, to `neon.com`. Claude Code's fetch follows
redirects without saying where they led, so the polyfill shows the catalog under
the domain you asked for ("listed by neon.tech", though `neon.com` served it).
To see the origin that really serves a catalog, ask for the domain the company
uses itself. SEP-2127 says nothing about following redirects for a catalog or a
card; its one same-origin rule is for `extensionsInfo` used in a security
decision, and the polyfill never uses `extensionsInfo`.

## Settings

In Pi, `MCP_SERVER_CARDS_DISABLED=1` registers no tools and fetches nothing.

In OpenCode, `MCP_SERVER_CARDS_DISABLED=1`, or the plugin option `off`, does
nothing without being uninstalled. `MCP_SERVER_CARDS_ASK_BY_DEFAULT=0`, or
`askByDefault: false`, leaves additions and removals to OpenCode's rules
alone, under whose default a server is added without a prompt. Set a
variable in the environment OpenCode starts in, and an option in the object
form of the plugin's entry in `plugins`.

In Antigravity, `MCP_SERVER_CARDS_DISABLED=1` in the environment Antigravity
starts in turns the plugin off; so does `agy plugin disable mcp-server-cards`.

In Copilot CLI, `MCP_SERVER_CARDS_DISABLED=1` registers no tools and fetches
nothing.

In Hermes, `hermes plugins disable mcp-server-cards` stops its tools and
helper. `MCP_SERVER_CARDS_DISABLED=1` also registers nothing. Added servers
stay in Hermes's configuration.

In Claude Code, in `/config`, under the plugin:

| Setting | Default | What it does |
|---|---|---|
| `disabled` | off | Turns the polyfill fully off: no tools, nothing fetched. |
| `picker` | on | Shows the list of servers with **Add** buttons under discovery results, and under another plugin's results that it was handed. Off: you add servers by asking Claude. |
| `notice_on_fetch` | on | After Claude fetches a page with WebFetch, the polyfill reads that site's catalog once per session. If the site publishes a server, you see one line in the transcript. Claude is not told. Only sites Claude has already contacted are checked. |

## The tools

In Pi, `discover_mcp_servers` reads and checks the cards, and `add_mcp_server`
asks before running `pi mcp add` and registering the server for the session.
There is no `present_server_cards` tool in the Pi form.

In OpenCode, `server_cards_discover_mcp_servers` reads and checks the cards,
`server_cards_add_mcp_server` adds one after OpenCode's rules allow it, and
`server_cards_remove_mcp_server` removes one it added. There is no
`present_server_cards` tool in the OpenCode form.

In Copilot CLI, the tools are `discover_mcp_servers` and `add_mcp_server`,
which adds a server only after your accept in the form. There is no
`present_server_cards` tool in the Copilot form either.

In Hermes, the tools are `discover_mcp_servers`, `add_mcp_server` and
`remove_mcp_server`. Adding and removing go through Hermes's own approval.

The table below is for Claude Code.

| Tool | What it does |
|---|---|
| `discover_mcp_servers(domain)` | Reads the domain's catalogs and every card they list; reports each card, valid or refused. Read-only. |
| `add_mcp_server(identifier, url, …)` | Adds a server shown in this session, with `claude mcp add`, then asks Claude Code to connect it. |
| `present_server_cards` | For other plugins only, never the model, so that a plugin which finds cards another way (`ard-discovery`) has them checked, shown and added here. |

## Limits

### In Claude Code

- **The card is not compared with the live server.** SEP-2127 says a client
  SHOULD check a card's claims against the live connection; this rule is not
  met. With changes 1 and 2 of [the host changes](./how-it-works#the-four-changes),
  the polyfill would send `server/discover` over Claude Code's connection and
  compare the name, version and protocol revisions.
- **Claude Code's protocol revisions are listed by hand**, from its docs. Change 2
  would let the polyfill read the negotiated revision instead.
- **Redirects and DNS aren't visible.** A private address named directly is
  refused, but a public URL that redirects to one, or a public name that resolves
  to one, is not caught. A host API that reports redirects and the resolved
  address, or refuses private ones, would close this.
- **A secret needs a restart:** you set the environment variable, then restart.
- **Whether a server added mid-session connects without a restart** depends on
  Claude Code picking up `claude mcp add`. If it doesn't, `/mcp` or a restart
  connects it.

Not in it: ARD (in [`ard-discovery`](./ard)), verifying AI Catalog trust
manifests and signatures (no card is ever called verified), other artifact types
in the same catalogs, and local (stdio) servers, which cards do not describe.

### In Pi

- **No live card comparison.** S-3 is not met: the card is not compared with
  the live server through `server/discover`.
- **Streamable HTTP only.** Pi 1.6.0 does not support SSE. Secret variables in
  URLs are refused; secret headers use generated environment references,
  which you set before restarting Pi. Header values starting with `!` are
  refused because Pi would execute them as commands.
- **DNS is not checked for private addresses.** Literal private addresses
  and private host spellings are blocked, including at redirects; public
  names that resolve to private addresses are not caught.
- **No atomic add-if-absent.** Existing names are checked before and after
  the question, but another process could write the same name before Pi's
  write.
- **Discover again after a session change.** New, resumed, forked and
  reloaded sessions forget shown cards. Disabled or replaced MCP support,
  or a failed connection, can prevent added tools from becoming available.

### In OpenCode

- **No live card comparison.** S-3 is not met: comparing a card with the
  live server (`server/discover`) needs a request over OpenCode's
  connection, which a plugin can't send.
- **Streamable HTTP only.** OpenCode 2.4 connects remote servers over
  streamable HTTP; a card whose remote is SSE is refused.
- **Secrets by hand.** A card that needs a secret, in a header or the URL,
  isn't added. The answer gives you the entry for `opencode.json`, with
  `{env:VAR}` where the secret goes, and the variable to set.
- **Per project.** An added server is in the project it was added in only.
  To have it in every project, put it in your global `opencode.json`.
- **What the TUI's prompt shows.** Only "Call tool mcp_server_cards_add",
  with "Allow once" and "Reject"; the name and URL are on the model's call
  line above it, and the host, headers and undo aren't on screen. The plugin
  refuses a URL other than the one the card gives.
- **DNS is not checked for private addresses.** As in the Codex form, whose
  fetch code it bundles: addresses named directly are refused, at every
  redirect hop too, but a public name that resolves to a private address is
  not caught.
- **Not checked yet:** an addition from OpenCode Desktop, and Windows outside
  CI (CI runs the tests there).

### In Antigravity

- **No card that needs a secret.** Antigravity's personal `mcp_config.json`
  reads no `${VAR}`, and the plugin never writes a secret, so such a card
  can't be added.
- **Yes or no.** The approval card has no other choices. Editors on
  `agy acp` see the tool and its arguments, not the question.
- **Not checked yet:** signing in to a server after an addition, and these
  builds in the App.
- **Not in the IDE.** The IDE documents no plugin hooks, so the forms aren't
  supported there, and their gated calls are refused.

### In Copilot CLI

- **No live card comparison.** S-3 is not met: the plugin can't send
  `server/discover` over Copilot's connection.
- **Two questions for one add.** Copilot asks before every MCP tool call,
  and the form is the plugin's own question. "Don't ask again" on Copilot's
  prompt removes the first; the form stays.
- **New servers need `/mcp reload`,** or a new session.
- **Interactive sessions only.** Copilot declines the form in `copilot -p`,
  even with `--yolo`, so adding works only in the interactive session.
- **DNS is not checked for private addresses.** A public name that resolves
  to a private address isn't caught. Redirects are checked hop by hop.
- **In VS Code, the form is one paragraph.** Checked in VS Code 1.147.0's
  Copilot harness: an add goes through VS Code's tool prompt, then the
  plugin's form ("Your answer", **Don't add it** first), and **Add it**
  writes the server. VS Code runs the question's lines together in one
  paragraph.

### In Hermes

- **Connecting is separate.** `/reload-mcp` or a new session connects a saved
  server. Saving alone does not mean it is connected.
- **No live card comparison.** The card isn't compared with
  `server/discover` metadata (S-3).
- **No custom picker.** The model presents results and asks for missing
  non-secret inputs; Hermes owns the approval choices.
- **OAuth detection is bounded.** Secret-bearing endpoints aren't probed;
  endpoints without a Bearer challenge need manual `auth: oauth` setup.
- **Rediscover after a restart.** The displayed cards and cache live in
  memory per session. Removal records persist.
- **Protocol filtering stops at the pinned handshake revisions.** A card
  advertising only the stateless 2026 protocol is refused pending verification.
  External edits can still race a removal; the plugin checks what was saved.

### In T3 Code

T3 Code runs Codex, Claude Code or OpenCode for you, and this polyfill's
forms for them load there. With Codex, the question it asks before adding a server ("Add it") is
an MCP elicitation form, and T3 Code shows such a form only when it can
answer it with Approve or Decline; it cancels this one without showing it, so
the step is refused as if you had said no. Nothing is approved for you.
Not checked in T3 Code.
[T3 Code](https://github.com/idosal/AgentPolyfill/blob/main/docs/t3-code.md) has the details.

## Security

### In Claude Code

The polyfill reads documents that strangers publish on the web, and turns one of
them into an entry in your Claude Code MCP configuration. What a catalog or card
says is someone else's claim, read before any connection.

- **What it fetches:** plain `GET`s, through Claude Code's own network path,
  with no cookies or credentials, bounded in size and number. It sends nothing to
  a third party: no query text, and no request that is not a `GET`. A public
  catalog or card can't send it to a local or private address.
- **What it writes:** only your MCP configuration, through `claude mcp add`, for
  one server at a time, and only when you press **Add** or approve Claude's
  request. Never over a server you have.
- **Text that displays as something else:** a card is refused if any string in
  it holds a control character or an invisible format or bidirectional mark. A
  remote URL must be printable ASCII, without `` ` ``, `<`, `>` or square
  brackets outside an IPv6 host, so Markdown or HTML can't show other text in
  its place, and may not name a user before its host.
- **Secrets** never pass through Claude, the command line or the polyfill's
  store, and a card that sets a secret's value itself is refused.
- **It never reads Claude Code's credentials**, runs no sign-in of its own, and
  holds no token.

It does not protect against a publisher's own bad server, an unconfirmed server
you add anyway, or a public name that resolves to a private address, or a
redirect to one.

How it is checked (the Claude Code form): 108 tests for the client rules, run with Claude Code's own
test kit (two rules are met by design, and the one about the live server is not
met); the live catalogs and
cards of Buildkite, GitHub, Hugging Face, Neon, Netlify, Notion, Context7, Exa,
Supabase and Zapier (ten of the eleven cards valid, Zapier's refused, and ajv
with the official schema gives the same verdict on all eleven). Adding a
server end to end in Claude Code (added, then connected and used) was not
checked; the recording at the top of this page shows **Add** pressed and the
server written to the config, not connected. The MCP conformance suite has no
Server Card scenarios.

The full account:
[`SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md).

### In Pi

Discovery sends plain GETs without cookies or credentials. Every addition
needs "Add it" in the extension's dialog and uses Pi's own command to write
the checked server to `mcp.json`. A card cannot supply a command to execute;
the extension never reads `mcp-auth.json`, `auth.json` or any stored
credential. Pi runs tools without asking unless a permission extension asks;
the polyfill supplies its own add question, and its `readOnlyHint`
annotations let permission extensions distinguish discovery from addition.
See [Pi's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/SECURITY.md).

[Pi's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/conformance.md)
records the shared client rules and Pi-specific checks; S-3 remains unmet.
There is no upstream Server Cards scenario run to report. Checked in Pi
1.6.0: neon.com's servers listed, the add question, and Neon Docs saved in
`mcp.json` and connected for the session. Not checked: a completed Neon Docs
tool call.

### In OpenCode

Discovery sends plain GETs, with no cookies or credentials, bounded in size
and number. It takes no step from a public catalog, card or redirect to a
local or private address, and follows redirects itself, holding each hop to
that rule. Every addition is put to OpenCode's permission rules and asked
about by default; the plugin never answers a prompt and never turns anything
into `allow`. A URL is taken only from a card a discovery showed in this
session, and a secret never passes through the model or the plugin. It never
reads OpenCode's stored credentials, runs no sign-in of its own, and holds no
token. Under OpenCode's default rules the model can still edit
`opencode.json` itself, and add a server that way, unless your rules ask
about edits. See
[OpenCode's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/SECURITY.md).

[OpenCode's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/docs/conformance.md)
records 28 rules: 26 met, 1 met with a stated exception (I-4: an SSE remote
is refused), and 1 not met, S-3, the check against the live server. Its tests
run the plugin in OpenCode 2.4.1; CI runs them on Linux, macOS and Windows.
There is no upstream Server Cards scenario run to report. Checked in
OpenCode 2.4.1: neon.com's two cards found, Neon Docs added after OpenCode
asked and connected, with its four tools in the model's tools, and its
`search_docs` tool called with results. Adding and connecting Neon Docs was
also checked in the TUI.

### In Antigravity

Every addition is put to you in Antigravity's approval card, through
`force_ask`, and nothing is auto-approved: no `auto_approve`, no permission
overrides. The hook leaves a one-use ticket for exactly that call, and the
MCP server adds only with it. Read-only tools get Antigravity's usual MCP
question, which allow rules can skip. Whether
`--dangerously-skip-permissions` also skips `force_ask` hasn't been
checked. The plugin reads
`~/.gemini/config/mcp_config.json`, which can hold API keys in headers, to
check names, and never logs or shows those values. It writes only that file,
after your approval, and its own folder, `~/.gemini/agentpolyfill/mcp-server-cards/`.
It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json`. See
[Antigravity's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/antigravity/SECURITY.md).

### In Copilot CLI

Discovery sends plain GETs without cookies or credentials. Every addition
needs Copilot's tool prompt and then "Add it" in the form, and is written with
`copilot mcp add`, with no shell; nothing a card says is read as one of its
options. A card's secret becomes a `${VAR}` reference, never a value. The
plugin never reads Copilot's stored credentials, and stores nothing on disk.
See [Copilot's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/SECURITY.md).

[Copilot's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/docs/conformance.md)
records the shared client rules and the Copilot-specific checks (114 tests);
S-3 remains unmet. Checked in Copilot CLI 1.0.115: the plugin finds Neon and
Neon Docs on neon.com and, after Copilot's tool prompt and **Add it**,
writes `neon-docs` with `copilot mcp add`. In `copilot -p`, with `--yolo`
too, Copilot declines the form and nothing is written.

### In Hermes

Discovery checks the address when it connects, so a public name resolving
to a private address is refused. Routing headers such as `Host` are refused
too. Adding and removing go through Hermes's approval, keyed to the entry,
and no addition is made where Hermes approves without asking.
Secret inputs stay references, and the plugin never handles OAuth tokens.
Removal is limited to unchanged entries it recorded. See
[Hermes's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/hermes/SECURITY.md).

The [README's test and interop record](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/hermes/README.md#interop)
shows neon.com's catalog and cards read through Hermes v0.23.4 with a
scripted model, Neon Docs added after approval, and five tools offered to
the model after `/reload-mcp`. Local tests cover declines, removals, OAuth
challenges, secret references and session isolation. There are no upstream
Server Cards client scenarios.

## When the host supports Server Cards itself

- **Claude Code:** there is no Server Card support to detect yet. When it
  ships, turn on the `disabled` setting: the polyfill then registers nothing
  and fetches nothing.
- **Pi:** native support cannot be detected automatically. Remove the
  extension or set `MCP_SERVER_CARDS_DISABLED=1` when it ships.
- **OpenCode:** 2.4.1 has no Server Card support to detect. When it ships,
  set `MCP_SERVER_CARDS_DISABLED=1` or remove the plugin.
- **Antigravity:** native support can't be detected: Antigravity tells
  plugins nothing about its MCP client's extensions. Disable or uninstall
  the plugin, or set `MCP_SERVER_CARDS_DISABLED=1`, when it ships.
- **Copilot CLI:** 1.0.115 doesn't read Server Cards from a domain, so there
  is nothing to detect yet. Its SDK types declare a catalogue API that
  accepts the card media type (`mcp.planInstall`), and a built-in
  `discover-resources` skill searches a catalogue Copilot is given; neither
  was checked, and neither is SEP-2127's discovery from a domain, so the plugin
  doesn't stand down for them. When Copilot reads a domain's catalog,
  uninstall the plugin, disable it
  (`copilot plugin disable mcp-server-cards@agent-polyfill`), or set
  `MCP_SERVER_CARDS_DISABLED=1`.
- **Hermes:** v0.23.4 has no native Server Cards support to detect. Disable
  the plugin with `hermes plugins disable mcp-server-cards`, or set
  `MCP_SERVER_CARDS_DISABLED=1`, when that ships.

## More

On GitHub, in [`polyfills/server-cards/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/README.md),
with one row for each client rule and the test that covers it, and interoperability notes.
