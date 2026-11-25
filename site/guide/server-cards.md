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
  alt="In Claude Code, What MCP servers does neon.com publish? lists Neon and Neon Docs from neon.com's own catalog, each with an Add button, and Add on Neon Docs marks it added, with a note to run /mcp to connect or sign in. Then the same in Codex, in the ChatGPT desktop app: Codex lists the two servers, and asked to add Neon Docs, shows its own form naming the host, the URL, the headers (none) and the Server Card it came from, with Don't add it and Add it. After Add it, neon-docs is in Codex's config; codex mcp remove neon-docs undoes it."
  caption="Real sessions (27 s; waits sped up, with a badge saying how fast): neon.com's two servers, found from its domain, in Claude Code and then in Codex. Adding one writes it to the host's own config, and the host connects it."
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

```bash [Pi]
pi install git:github.com/idosal/AgentPolyfill
```

```bash [OpenCode]
opencode plugin add 'github:idosal/AgentPolyfill#main::path:polyfills/server-cards/opencode/plugin'
```

```bash [Copilot CLI]
git clone https://github.com/idosal/AgentPolyfill.git
copilot plugin marketplace add ./AgentPolyfill
copilot plugin install mcp-server-cards@agent-polyfill
```

:::

### In Claude Code

The terminal form is `claude plugin install mcp-server-cards --marketplace idosal/AgentPolyfill`.
It's also part of the `agent-polyfill` bundle. You need:

- **Claude Code 2.1.329 or newer**, with mods.
- Nothing else: no helper process, no Node, no account.
- To add a server, it runs the `claude` command. That is found on your `PATH`,
  or in the usual install folders. If neither works, it gives you the exact
  command to run yourself.

### In Codex

Codex 0.170 or newer, with Node 20 or newer. The same discovery and checks,
and a server is added to Codex's config only after you choose "Add it" in
Codex's own form.

### In Pi

Pi 1.6.0 (the version tested), with Node 22 or newer. The command above
installs Events, Skills and Server Cards together.
Pi clones the repository under `~/.pi/agent/git/` and loads the three
extensions from there. Nothing is published to npm or Pi's package gallery,
and nothing is built.

Update installed packages with `pi update --extensions`. Remove all three
and Pi's copy of the repository with
`pi remove git:github.com/idosal/AgentPolyfill`. For one run of all three
without installing, use `pi -e git:github.com/idosal/AgentPolyfill`.

To install only Server Cards, use a clone:

```bash
git clone https://github.com/idosal/AgentPolyfill.git
cd AgentPolyfill
pi install ./polyfills/server-cards/pi/extension
```

Pi loads the local path where it is, so keep the clone. From the same folder,
`pi remove ./polyfills/server-cards/pi/extension` removes that local install;
`pi -e ./polyfills/server-cards/pi/extension` runs it once without installing.
Use one way per form: Pi tells packages apart by repository address or local
path, so a form installed both ways loads twice.

[ARD](./ard#install) is left out of the one-line install, as it is from the
Claude Code bundle: its search sends the words of your request to a registry
after asking each time. Install it separately from a clone.

Removal leaves watches and events in `mcp-events/`, and approvals and skill
stubs in `mcp-skills/`, in Pi's agent folder (`~/.pi/agent`, or
`PI_CODING_AGENT_DIR`); delete those folders too to remove that data.
Servers you added stay in `mcp.json`; remove one with
`pi mcp remove <name>`.

### In OpenCode

OpenCode 2.4 or newer (tested with 2.4.1), and nothing else: no account, no
key, no Node. The plugin isn't on npm: the command fetches it from GitHub,
with Git, and adds it to `plugins` in your global
`~/.config/opencode/opencode.json`, so it runs in every project from the next
time OpenCode opens one. A commit in place of `main` pins one version. From a
clone, put the folder `polyfills/server-cards/opencode/plugin` in `plugins`
in an `opencode.json` instead. To remove it, run `opencode plugin remove`
with the same text; OpenCode's downloaded copy stays in
`~/.cache/opencode/npm/` (a `git-AgentPolyfill-…` folder), which you can
delete. Removing it stops adding the servers it added, which were never in
your configuration files. Its list of them stays in OpenCode's plugin storage
(OpenCode's own database) and comes back if you install it again; remove a
server with `server_cards_remove_mcp_server` first to drop it from the list.

### In Copilot CLI

Copilot CLI 1.0.115 (the version tested), with Node 20 or newer on your
`PATH`. The plugin is an MCP server, so it needs no experimental mode. The
install from a clone is the one tested; Copilot loads the plugin where it is,
so keep the clone. From GitHub,
`copilot plugin marketplace add idosal/AgentPolyfill` adds the marketplace;
that was checked on 25 November 2026 with Copilot CLI 1.0.105 in an isolated home with no sign-in (the three plugins installed and loaded, byte-identical to main), not on 1.0.115, in the interactive TUI, or in VS Code. Start a new Copilot session afterwards.
Remove it with `copilot plugin uninstall mcp-server-cards@agent-polyfill`.
Servers you added stay in `~/.copilot/mcp-config.json`; remove one with
`copilot mcp remove <name>`.

The sections below name the host where behavior differs. Full guides by host:

- [Claude Code](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/claude-code)
- [Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex)
- [Pi](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/pi)
- [OpenCode](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/opencode)
- [Copilot CLI](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/copilot)

## Try it

Nothing to set up. Start your host:

- **Claude Code:** `claude`.
- **Codex:** `codex`.
- **Pi:** `pi`.
- **OpenCode:** `opencode`.
- **Copilot CLI:** `copilot`.

Ask:

> What MCP servers does neon.com publish?

Then add **Neon Docs** (no sign-in):

- **Claude Code:** press **Add**.
- **Codex:** choose "Add it" in Codex's own form.
- **Pi:** ask "Add Neon Docs", then choose "Add it" in Pi's dialog. It is
  saved and registered for the current session, without a restart.
- **OpenCode:** ask "Add Neon Docs", then allow it when OpenCode asks. It is
  in OpenCode's MCP servers at once, and OpenCode connects it.
- **Copilot CLI:** ask "Add Neon Docs". Copilot's tool prompt comes first,
  then the plugin's form: choose "Add it". Run `/mcp reload` (or start a new
  session) to use it. `copilot mcp remove neon-docs` removes it again.

For one behind a sign-in, ask about
buildkite.com; once it's added, the host asks you to sign in (in Claude Code,
through `/mcp`). In OpenCode, sign in with `opencode mcp auth <name>`, in a
terminal. In Claude Code, `claude mcp remove neon-docs -s local`
removes it again; in OpenCode, ask for it to be removed, which OpenCode asks
you about too.

## Using it, step by step

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

In Copilot CLI, `MCP_SERVER_CARDS_DISABLED=1` registers no tools and fetches
nothing.

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
- **Not tried yet:** an addition from OpenCode Desktop, and Windows by hand
  (CI runs the tests there).

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
- **In VS Code, the form is one paragraph.** In VS Code 1.147.0's Copilot
  harness an add worked: VS Code's tool prompt, then the plugin's form
  ("Your answer", **Don't add it** first), then **Add it** wrote the server.
  VS Code runs the question's lines together in one paragraph. For that run,
  the person testing signed in with their own GitHub account, in a throwaway
  VS Code profile since deleted, with GitHub's Claude Haiku 4.5 as the model.

### In T3 Code

T3 Code runs Codex, Claude Code or OpenCode for you, and this polyfill's
forms for them load there. With Codex, the question it asks before adding a server ("Add it") is
an MCP elicitation form, and T3 Code shows such a form only when it can
answer it with Approve or Decline; it cancels this one without showing it, so
the step is refused as if you had said no. Nothing is approved for you.
Not run live in T3 Code.
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
with the official schema gives the same verdict on all eleven); and runs in the
real host. Adding a server end to end in the real host (added, then connected
and used) is the run still to record; the recording at the top of this page
shows **Add** pressed and the server written to the config, not connected. The MCP conformance suite has no Server Card scenarios. An independent
security review for the launch (24 November 2026), by an AI session, not a human
audit: its findings SC1 to SC7 are fixed and tested.

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
An AI reviewer who did not build the Pi forms reviewed them, and checked
the fixes again. They have not been audited by a person.

[Pi's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/conformance.md)
records the shared client rules and Pi-specific checks; S-3 remains unmet.
There is no upstream Server Cards scenario run to report. The
[live run](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/docs/live-run.md)
records neon.com's servers being listed, the add question, and Neon Docs
saved in `mcp.json` and connected for the session. It does not establish a
completed Neon Docs tool call.

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
run the plugin in OpenCode 2.4.1, in a throwaway home, against a local web
with a catalog, two cards and a small MCP server, with a scripted model; CI
runs them on Linux, macOS and Windows. There is no upstream Server Cards
scenario run to report. The
[live run](https://github.com/idosal/AgentPolyfill/blob/main/tools/opencode/live-run.md)
records neon.com's two cards found, Neon Docs added after OpenCode asked and
connected, with its four tools in the model's tools, and, in one run, its
`search_docs` tool called with results. In the TUI too, Neon Docs was added
and connected.
An AI reviewer who did not build the OpenCode forms reviewed them. They have
not been audited by a person.

### In Copilot CLI

Discovery sends plain GETs without cookies or credentials. Every addition
needs Copilot's tool prompt and then "Add it" in the form, and is written with
`copilot mcp add`, with no shell; nothing a card says is read as one of its
options. A card's secret becomes a `${VAR}` reference, never a value. The
plugin never reads Copilot's stored credentials, and stores nothing on disk.
See [Copilot's SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/SECURITY.md).

[Copilot's conformance report](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/docs/conformance.md)
records the shared client rules and the Copilot-specific checks (114 tests);
S-3 remains unmet. In Copilot CLI 1.0.115, with a scripted model, the plugin
found Neon and Neon Docs on neon.com and, after Copilot's tool prompt and
**Add it**, wrote `neon-docs` with `copilot mcp add`. In `copilot -p`, with
`--yolo` too, Copilot declined the form and nothing was written.

## When the host supports Server Cards itself

- **Claude Code:** there is no Server Card support to detect yet. When it
  ships, turn on the `disabled` setting: the polyfill then registers nothing
  and fetches nothing.
- **Pi:** native support cannot be detected automatically. Remove the
  extension or set `MCP_SERVER_CARDS_DISABLED=1` when it ships.
- **OpenCode:** 2.4.1 has no Server Card support to detect. When it ships,
  set `MCP_SERVER_CARDS_DISABLED=1` or remove the plugin.
- **Copilot CLI:** 1.0.115 doesn't read Server Cards from a domain, so there
  is nothing to detect yet. Its SDK types declare a catalogue API that
  accepts the card media type (`mcp.planInstall`), and a built-in
  `discover-resources` skill searches a catalogue Copilot is given; neither
  was run, and neither is SEP-2127's discovery from a domain, so the plugin
  doesn't stand down for them. When Copilot reads a domain's catalog,
  uninstall the plugin, disable it
  (`copilot plugin disable mcp-server-cards@agent-polyfill`), or set
  `MCP_SERVER_CARDS_DISABLED=1`.

## More

On GitHub, in [`polyfills/server-cards/claude-code`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/claude-code):
the full [`README.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/README.md),
with one row for each client rule and the test that covers it, and the findings
to report upstream.
