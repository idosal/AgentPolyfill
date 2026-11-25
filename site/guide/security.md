---
description: How the AgentPolyfill polyfills treat server content, what each one checks, and how to report a problem privately.
---

# Security

These are third-party plugins and extensions that run with your permissions.
None of them reads the host's stored credentials.

## Reporting a problem

Please report security problems privately, through **Report a vulnerability**
on the repository's
[Security tab](https://github.com/idosal/AgentPolyfill/security/advisories/new),
not in a public issue. If that button is not there, open an issue that says only
that you have a security report, with no details, and you will be given a
private way to send it. Say which polyfill and which host,
the host's version and your operating system, what you did and what
happened.

## The common rule

What a server sends (an event payload, a skill's text, an app's HTML) is data
from that server, and receiving it grants nothing. A polyfill never
auto-approves an action or reads the host's stored credentials.

In Claude Code, event payloads reach Claude as tool results;
context an app sets goes with your next prompt
(see [Apps](#apps)). Whatever Claude does next goes through Claude Code's normal
permissions. A polyfill never reads the host's stored credentials. Events and Apps connect only
to servers Claude Code itself uses in the session, asking Claude Code for its
verdict on each one. Server Cards connects to no server: it reads public
documents and adds a server to Claude Code's own config, only when you press
**Add** or approve Claude's request.

## Each polyfill

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against, in each host:

| Polyfill | Claude Code | Codex | Pi | OpenCode | Antigravity | Copilot CLI |
|---|---|---|---|---|---|---|
| Events | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/antigravity/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/SECURITY.md) |
| Skills | no polyfill: built into Claude Code, in beta from 2.1.332 | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/antigravity/SECURITY.md) | no polyfill: built into Copilot CLI |
| Server Cards | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/antigravity/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/copilot/SECURITY.md) |
| Apps | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/SECURITY.md) | not available | not available | not available | no form; the App shows MCP Apps itself | no polyfill: built into VS Code's Copilot harness; none in the terminal |
| ARD | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/antigravity/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/copilot/SECURITY.md) |

The following per-polyfill summaries describe the Claude Code forms;
[Pi's security notes](#in-pi), [OpenCode's](#in-opencode),
[Antigravity's](#in-antigravity) and [Copilot CLI's](#in-copilot-cli) follow
them.

### Events

- What a server sent reaches Claude only as a tool result, when Claude reads it.
  The message that wakes a session carries only which watch has new events, how
  many, and their ids.
- An event arrives without anyone asking. In a session that approves actions
  without asking, a server you watch can set work in motion; how often is
  bounded by the wake limits (by default once a minute per watch, 30 times an
  hour), not prevented.
- Webhooks are verified by the mod; a relay holds no signing secret and cannot
  make an event up. The operator of a relay can read webhook payloads: with your
  own relay that is you, and the opt-in public relay is run by the mod's author.

[Events `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/SECURITY.md)

### Apps

- The helper uses a server only when Claude Code says it is connected to it in
  this session under that name, and only the config entry Claude Code would use.
  Each request it sends waits for Claude Code's yes, asked for that request.
- An app's tool calls follow your permission rules by default; messages to
  Claude are asked about by default, and links and saving files always are.
- Each view runs in a sandboxed iframe in a dedicated headless Chrome, under the
  app's Content Security Policy. A view of a server on your machine or your
  local network may reach your local network.
- Context an app sets reaches the model with your next prompt, without being
  shown to you.

[Apps `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/SECURITY.md)
lists what it checks and what isn't protected.

### Skills

There is no Skills polyfill for Claude Code: Claude Code lists skills from MCP
servers itself, in beta from 2.1.332 ([Skills](./skills#claude-code)). That is
Claude Code's own feature, and this project doesn't describe or vouch for how
it handles a served skill. The Skills forms for
[Codex](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/SECURITY.md),
[Pi](#in-pi) and [OpenCode](#in-opencode) have their own accounts.

### Server Cards

- A catalog or card is someone else's claim, read before any connection with
  plain `GET`s and no cookies or credentials. It sends nothing to a third party:
  no query text, and no request that is not a `GET`.
- It writes only your MCP configuration, one server at a time, when you press
  **Add** or approve Claude's request (a question no allow rule or auto mode
  answers), and never over a server you have.
- A card with control characters or invisible marks is refused. A remote URL
  must be printable ASCII, without characters that let Markdown or HTML show
  other text in its place, and may not name a user before its host.
- A secret the card asks for never passes through Claude; the config holds an
  environment-variable reference for you to set.
- A public name that resolves to a private address, or a redirect to one, is
  not caught.

[Server Cards `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md)

### ARD discovery

- Search sends the words of your request to an ARD registry, a service someone
  else runs, and to at most three registries it refers to. It ships with no
  registry: you name one, or set one; with neither, nothing is sent. Each
  search asks you first, showing the query and where it goes; with nobody to ask, nothing is
  sent. This is why it is not in the `agent-polyfill` bundle.
- Discovery by domain sends no query, only plain `GET`s to that domain.
- Everything it finds goes through `mcp-server-cards`' checks. It writes nothing.

[ARD `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md)

## In Pi

Pi's own security model is the boundary: extensions run in its process with
your permissions, and Pi runs tool calls without asking unless a permission
extension asks. Each polyfill asks you before its consequential step. Its
tools carry `readOnlyHint` annotations so a permission extension can tell
reading from starting a watch, sending a query or adding a server.

- **Events:** every watch needs your yes in a Pi dialog naming the server,
  event type, filters and note in full, and saying that events will start
  turns. Without a UI, or if you decline, no watch starts. By default, the wake
  message contains no event payload; the payload arrives as a tool result
  when Pi reads it. Pi shows the wake as the extension's message, but the
  model receives it in the user's turn, so its first line says the extension
  sent it, not you. Default limits are one wake per minute per watch and
  30 per hour per session; after the cap the session is told once and waits
  until you write. A server you watch can still set work in motion within
  those limits.
- **Skills:** loading asks "Don't load it", "Show me its SKILL.md first" or
  "Load it". The preview is shown to you before the model sees it. An
  approval is bound to that skill's files and digests; changes ask again.
  A digest match shows consistency with the server's claim, not that its
  instructions are safe. X8 is met: while a served skill is loaded, reads
  against another server through Pi's resource tool or this extension's
  skill tools ask first, naming both servers, including codemode's nested
  calls. Another extension's own connection passes no such hook. Pi has no
  per-skill switch for extension skills; the server-level `skip` setting
  leaves out a server's skills.
- **Server Cards:** only "Add it" writes a server. The question names the
  host, URL, headers, destination `mcp.json` and undo command. The extension
  runs Pi's own `mcp add` and registers the saved server for the current
  session. Pi owns its connection and sign-in. A save does not prove the
  connection succeeded, and the card is not compared with the live server
  (S-3). Secret headers stay generated environment-variable references;
  header values starting with `!` are refused. Public names resolving to
  private addresses are not caught, and another process can still write a
  name between the final name check and Pi's write.
- **ARD:** no registry is selected by default. Every search names the exact
  query, endpoint and allowance for up to three referrals; only "Send the
  search" sends the query. Adding has its own question through
  `ard_add_mcp_server`, separate from search consent, and uses the Server
  Cards checks and limits. Checked in Pi 1.6.0: discovery and an approved
  search of the demo registry. Adding is checked by the form's tests only.
- **Apps:** no Pi form is built or tested.

Events and Skills use only Pi's accepted MCP configuration, including a
project's configuration only after it is trusted. Disabled or hidden servers
are left alone. With Pi's own MCP support off, these forms read no
configuration, run no command and reach no server. They open their own
connections and cannot use OAuth or `auth.provider` sign-ins. Headers
written in `mcp.json`, `${VARIABLE}` and `!command` work; each `!command`
runs at session start for each extension that reads it. None of the Pi forms
reads `mcp-auth.json`, `auth.json` or any stored credential.

Events stores watches and payloads in `mcp-events/` in Pi's agent folder;
Skills stores stubs and approvals in `mcp-skills/`, without skill content or
tokens. Server Cards and ARD keep their discovery state in memory; servers
you add stay in `mcp.json`. See [Turning one off](./getting-started#turning-one-off)
for off switches, uninstalling and removing saved data.

## In OpenCode

OpenCode's own security model is the boundary: a plugin runs inside
OpenCode's server with the same access as any other plugin there, and
OpenCode's shipped permission rules allow every action. Each polyfill puts
its own actions to those rules with `ctx.permission.assert` and asks you by
default: an `evaluate` hook turns OpenCode's `allow` into `ask` for those
actions only. It never turns anything into `allow` and never answers a
prompt; a `deny` or `ask` rule you write wins, and with nobody there to
answer, OpenCode refuses the question. An `allow` rule you write doesn't skip
the question, since the plugin can't tell it from OpenCode's default. With
`askByDefault: false` (or the form's `…_ASK_BY_DEFAULT=0`), OpenCode's rules
alone decide, and under their default nothing is asked. Where a form saves an
"Allow always", the plugin keeps its own record of it, so taking it back in
OpenCode doesn't make it ask again; an `ask` or `deny` rule for the action
does.

OpenCode 2.4.1's TUI shows a polyfill's request as only "Call tool
`<action>`", without the resource or metadata it carries; you read the details
on the model's call line above it. OpenCode Desktop shows the action and its
resource (checked for Events and Skills).

- **Events:** starting or stopping a watch is `mcp_events_watch` or
  `mcp_events_unwatch` on `<server>:<event type>`. "Allow always" covers that
  server and event type in that project, and is saved only when both names
  are plain, so an event type a server named `*` can't stand for all of its
  types. A watch's note or filter holding a control or hidden character, or
  too long, is refused before you're asked. The wake is a synthetic message:
  OpenCode stores it as synthetic, not as yours, but sends it to the model in
  the user's role, so by default it carries no event content, and its first
  line says the plugin sent it. The payload arrives as a tool result when the model
  reads it. Wakes are limited to once a minute per watch and 30 an hour per
  session; past that, the session is told once and waits until you write.
  Under OpenCode's default, what the model does after a wake isn't asked
  about. With both a watch and one of OpenCode's automations for an event
  type, an event wakes the session twice: the plugin tells the model to use
  one, and can't see an automation.
- **Skills:** OpenCode's skill list holds only a served skill's name, the
  server's description marked with the server, and the plugin's note; none of
  its text. A load is `mcp_skills_load` on
  `<server>:<uri>@sha256:<manifest digest>`: "Allow always" covers that skill
  as it is now, a changed skill is asked about again, and one the server
  generates is asked about every time. The text reaches the model only after
  its size, digest and frontmatter match the server's entry, fenced and
  marked as the server's. X8 is met: once a session loaded a served skill,
  OpenCode's own read of another server's resource is asked about per call,
  naming both servers, by either of its names, in subagents and after a
  restart. Its read of a file inside a loaded skill's folder is refused in
  favour of `mcp_skills_read_skill_file`, which checks the file (V4). There
  is no way to show you `SKILL.md` before you decide, and what the model does
  after a load goes through OpenCode's rules, whose default allows it.
- **Server Cards:** an addition is `mcp_server_cards_add` on `<name>=<url>`,
  asked every time; "Allow always" saves nothing. Only a card a tool showed
  in this session is added, at the URL it gives, and never over a server
  OpenCode already has. The server goes into OpenCode's MCP servers, kept in
  the plugin's storage for that project, and OpenCode connects it with its
  own client and sign-in; your configuration files aren't written. A card
  that needs a secret isn't added: the answer gives the `opencode.json` entry
  with `{env:VAR}` where the secret goes. In the TUI, the call line shows the
  name and URL, not the headers or the undo; an addition from OpenCode
  Desktop was not checked. The model can still edit `opencode.json` itself,
  unless your rules ask about edits.
- **ARD:** no registry is selected by default. Each search is `ard_search` on
  the registry hosts, asked every time; nothing is saved. A registry a
  referral names is asked about before the query goes there, and one that
  isn't allowed gets nothing. In the TUI that prompt shows only "Call tool
  ard_search", and nothing on screen names the referred registry: reject a
  prompt you can't read. ARD was not checked in the TUI or in OpenCode Desktop.
  Adding uses the Server Cards code, under the same actions.
- **Apps:** no OpenCode form is built.

Events and Skills connect only to servers in your OpenCode configuration,
with what it holds. They open their own connections and never read
OpenCode's stored credentials, OAuth tokens included, so a server you signed
in to with `opencode mcp auth` isn't used. Their logs have secrets taken out.

Events stores watches, webhook secrets and payloads in
`~/.local/share/opencode/mcp-events/`, readable only by you; Skills keeps a
log in `~/.local/share/opencode/mcp-skills/`, and no skill content anywhere.
"Allow always" answers, the skills each session loaded, and the servers
Server Cards and ARD added are in OpenCode's plugin storage (its own
database). See [Turning one off](./getting-started#turning-one-off) for off
switches, uninstalling and removing saved data.

## In Antigravity

Antigravity's own approval system is the boundary. Each form's own actions
(a watch, a new or changed skill load, an addition, a registry search) ask,
through a `PreToolUse` hook that answers `force_ask`: Antigravity's approval
card, with the hook's question. The CLI's card shows the question's first
two lines and hides the rest; the App greys out the card's "always allow"
choices, and the CLI's card still lists them. Nothing is auto-approved: no
`auto_approve`, no permission overrides. The hook leaves a one-use ticket for
exactly that call, and the MCP server acts only with it. No ticket, nothing
done. The other Events tools, an approved unchanged skill load, skill file
reads and the read-only tools pass with a ticket and then get Antigravity's
usual MCP question, which allow rules can skip. By default that question is
asked: in the App, its card; the interactive CLI starts in auto mode, where
an MCP tool call still asks; and headless `agy -p` reports `request-review`
and denies a call nobody answers (checked). Whether
`--dangerously-skip-permissions` also skips `force_ask` hasn't been checked.
In CLI 1.5.17, a `PreToolUse` hook that fails, times out or prints something
that isn't JSON makes the call fail. The IDE documents no plugin hooks, so
the forms aren't supported there, and their gated calls are refused.

- **Events:** a watch is put to you in the approval card, naming the event
  type, server, filters and note. The hook passes the conversation id to the
  call in the same ticket. New events reach the conversation at its next
  model call, through the plugin's `PreInvocation` hook (checked in CLI
  1.5.17; Antigravity's plugins page doesn't list `PreInvocation` among plugin
  hooks). It adds only fixed text with a count and the plugin's own watch
  ids, nothing a server wrote. The sidecar that wakes an idle App
  conversation is off until you turn it on; the plugin never edits
  `~/.gemini/config/config.json`. A webhook watch was not checked.
- **Skills:** loading a new or changed served skill is put to you in the
  approval card, yes or no. An approved, unchanged skill gets only
  Antigravity's usual MCP question. X8 isn't met: the plugin's hook asks before
  a `read_resource` from another server while a served skill is loaded,
  naming both, but Antigravity (CLI 1.5.17, App 2.35.1) ignores that
  question (no card; the read goes ahead).
- **Server Cards:** an addition is put to you in the approval card, then
  written to `~/.gemini/config/mcp_config.json`. A card that needs a secret
  can't be added: that file reads no `${VAR}`, and the plugin never writes a
  secret.
- **ARD:** no registry is set by default. Every registry search, and every
  addition, is put to you in the approval card. The form carries the Server
  Cards checks itself.
- **Apps:** no form. The App renders MCP Apps itself (v2.34.0 and later).

The forms read `~/.gemini/config/mcp_config.json`, which can hold header
values (API keys), to connect to your servers (Events, Skills) and to check
names (Server Cards). They never log or show those values. They never open
`~/.gemini/antigravity/mcp_oauth_tokens.json` or any sign-in store, and
servers that need Antigravity's own sign-in are skipped.

They write only their own folder, `~/.gemini/agentpolyfill/<plugin>/`;
Skills' placeholders, `~/.gemini/config/skills/mcp-skills-served--*`; and,
for Server Cards and ARD after your approval,
`~/.gemini/config/mcp_config.json`. Editors on `agy acp` see the tool and its
arguments in the card, not the question.

## In Copilot CLI

The Events plugin is an extension, a child process Copilot starts for the
session; Server Cards and ARD are MCP servers in plugins. Each form's tools
that act (`watch_event`, `unwatch_event`, `add_mcp_server`, `ard_search`) go
through Copilot's tool prompt. That prompt can be answered without you: in
Copilot's "assisted" mode an LLM reviews the call, and an organisation can
make that mode the default; allow-all approves every call. So each form then
asks its own question, and nothing is approved for you: Events in a Copilot
dialog, by default, and Server Cards and ARD in the plugin's form.

- **Events:** the first session asks once whether the extension may have
  elevated permissions ("skip tool permission prompts, register hooks"). It
  uses them only so its four tools that only read (`list_event_types`,
  `list_watches`, `get_event`, `recent_events`) skip Copilot's prompt, and to
  give the session its instructions. `watch_event` and `unwatch_event` go
  through Copilot's prompt; then, before a watch starts, the plugin asks
  you, naming the server, the event type, the filters and the note, and
  saying that events will start turns; **Don't watch it** comes first. Where
  nobody can be asked (`copilot -p`), the watch is refused.
  `MCP_EVENTS_ASK_BY_DEFAULT=0` turns that question off, leaving Copilot's
  rules alone to decide. A payload reaches Copilot only as a tool result. The
  wake carries nothing the server wrote, and goes in as an automation turn,
  which Copilot gives no human authority; its first line says the plugin sent
  it. A watch belongs to the session that set it. In a session that allows
  tools without asking (`--allow-all-tools`, `--yolo`), a server you watch
  can set work in motion, as often as the wake limits allow.
- **Server Cards:** only "Add it" in the form writes a server, through
  `copilot mcp add`, with no shell, into `~/.copilot/mcp-config.json`. The
  form names the server, host, URL, headers, the file and the undo command.
  Nothing a card says is read as an option, a name you have is never
  replaced, and a card's secret becomes a `${VAR}` reference, never a value.
  The card is not compared with the live server (S-3), and a public name that
  resolves to a private address isn't caught.
- **ARD:** no registry is selected by default. Every search names the exact
  query and the registry in the form; only "Send the search" sends it.
  `ard_search` is marked not read-only, since it sends your words to a third
  party, and VS Code's Copilot harness runs read-only tools without asking
  (Copilot CLI 1.0.115 asked before them).
  Adding uses the Server Cards form's checks and its own form.
- **Skills and Apps:** built into Copilot; there is no Copilot form.

Copilot declines a form where nobody can be asked: in `copilot -p`, even
with `--allow-all-tools` or `--yolo`, nothing is added or sent. Events uses
only the servers Copilot enables for the session, after folder trust, your
settings and your organisation's policy, and lets go of one you switch off.
None of the Copilot forms reads Copilot's stored credentials (the keychain,
`~/.copilot/mcp-oauth-config/`, signed-in accounts in `config.json`).

Events stores watches and payloads in `~/.copilot/mcp-events/`, readable only
by you. Server Cards and ARD store nothing on disk; servers you add stay in
`~/.copilot/mcp-config.json`. See
[Turning one off](./getting-started#turning-one-off) for off switches,
uninstalling and removing saved data.

## In T3 Code

T3 Code runs Codex, Claude Code or OpenCode, so their plugins' security
notes apply. Two things differ:

- **The T3 Events form** ([SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/t3/SECURITY.md))
  is an MCP server Codex starts and a watcher that keeps running after T3
  Code closes, until no thread has a watch, connecting to your servers with
  the credentials in your Codex configuration. It wakes a thread with T3
  Code's `t3 thread send`; the turn runs in the thread's own permission mode.
  It talks to its server over a socket in a folder only you can open, and
  reads no stored credentials, Codex's or T3 Code's.
- **Questions that are cancelled.** With Codex, T3 Code cancels any MCP
  elicitation it can't answer with Approve or Decline, without showing it.
  The Skills, Server Cards and ARD questions are such forms, so their steps
  are refused; none is approved for you.

## What was checked, and how

- **Tests.** A test for each client rule of Events and Skills. For Server Cards
  and ARD, one row per rule with the test that covers it (Server Cards: two
  rules met by design, and one not met; ARD: one partly met). For Apps,
  requirement-by-requirement compliance notes.
- **Formal models.**
  - Events: a model of delivery and of waking, in Quint and in TLA+, simulated,
    and model-checked with TLC to small, stated bounds. TLC checks the model,
    not the code, and says nothing past its bounds.
  - Apps: a TLA+ model of which server a view's app comes from and what it may
    make happen, checked with TLC within stated bounds; what TLC reports is
    exhaustive within them and says nothing past them.

Each `SECURITY.md` says what was considered, not that nothing is left.
