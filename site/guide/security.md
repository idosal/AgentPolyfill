---
description: How the AgentPolyfill polyfills treat server content, what each one checks, how they were reviewed, and how to report a problem privately.
---

# Security

These are third-party plugins and extensions that run with your permissions.
None of them reads the host's stored credentials. They have been reviewed by
an AI reviewer that did not build them, and not audited by a person. The Pi
forms had an independent AI review, fixes and a check of those changes too.
The OpenCode forms had fixes from a security review, and their live runs were
repeated after them. The Muse Code forms run the Codex forms' code, and no
Muse run used a real model.

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

In Claude Code, event payloads and skill text reach Claude as tool results;
context an app sets goes with your next prompt
(see [Apps](#apps)). Whatever Claude does next goes through Claude Code's normal
permissions. A polyfill never reads the host's stored credentials. Events, Apps and Skills connect only
to servers Claude Code itself uses in the session, asking Claude Code for its
verdict on each one. Server Cards connects to no server: it reads public
documents and adds a server to Claude Code's own config, only when you press
**Add** or approve Claude's request.

## Each polyfill

Each polyfill's own `SECURITY.md` describes what it checks and what it does
not protect against, in each host:

| Polyfill | Claude Code | Codex | Pi | OpenCode | Muse Code |
|---|---|---|---|---|---|
| Events | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/muse/SECURITY.md) |
| Skills | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/muse/SECURITY.md) |
| Server Cards | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/muse/SECURITY.md) |
| Apps | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/SECURITY.md) | not available | not available | not available | not available |
| ARD | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/opencode/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/muse/SECURITY.md) |

The following per-polyfill summaries describe the Claude Code forms;
[Pi's security notes](#in-pi), [OpenCode's](#in-opencode) and
[Muse Code's](#in-muse-code) follow them.

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
lists each finding of the review of 24 November 2026 and where it stands.

### Skills

- A skill is loaded only after you approved it, in Claude Code's own permission
  dialog, and your approval is bound to its content: a changed skill is asked
  about again.
- A loaded skill and its files reach Claude only after their size and SHA-256
  digest matched the server's entry. A skill's frontmatter grants nothing.
- Where nobody can be asked (`claude -p`), an unapproved skill can make Claude
  only read and search while it is loaded.
- A skill you approved whose instructions are harmful is not stopped by the mod:
  what Claude does next goes through Claude Code's ordinary permissions.
- A skill you disabled is not offered, loaded or read, whatever a rule or mode
  allows, until you enable it again; Claude cannot enable it.

[Skills `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/SECURITY.md)

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
  Cards checks and limits. The recorded live run showed discovery and an
  approved search of the demo registry, but did not complete an addition.
  Addition is covered by real-Pi tests with a scripted model and a local
  server.
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
resource (seen for Events and Skills).

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
  Desktop wasn't tried. The model can still edit `opencode.json` itself,
  unless your rules ask about edits.
- **ARD:** no registry is selected by default. Each search is `ard_search` on
  the registry hosts, asked every time; nothing is saved. A registry a
  referral names is asked about before the query goes there, and one that
  isn't allowed gets nothing. In the TUI that prompt shows only "Call tool
  ard_search", and nothing on screen names the referred registry: reject a
  prompt you can't read. ARD wasn't tried in the TUI or in OpenCode Desktop.
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

## In Muse Code

Muse's own approvals decide what Muse does, with an event or a skill as
with anything else in the session. Muse gives a plugin no way to put a
question to you: its MCP client offers no elicitation, and a tool call that
isn't read-only goes to Muse's approval judge, a model that can approve it
with nobody asked. A hook's `ask` goes to the same judge. So the forms don't
rely on the judge. Each consequential step waits for something only you can
do: type a phrase, or run a command.

- **Events:** starting a watch waits for a phrase you type, such as
  `watch tickets ticket.created 4821`, and stopping one waits for its own, such as
  `unwatch tickets ticket.created 3307`.
  The question gives the server, the event type, the filters and your note
  in full, with any hidden character written out. Only a message of yours
  that is exactly the phrase approves it, in the same session, within 15
  minutes. Muse runs the plugin's `UserPromptSubmit` hook for your messages,
  not for a turn Muse or a model starts, so the model can't send the phrase. Each
  phrase approves only its own verb. The phrase names the server and the
  event type, so you type the names of what you approve; for the filters and
  the note, you rely on Muse showing you the question as the answer gives it. New
  events reach the model with your next message, as a context block whose
  first line says the plugin sent it, with nothing the server wrote.
- **Skills:** a load waits for its phrase the same way, such as `load github git-workflow 4821`. After that the
  approval is kept as in Codex, bound to the skill's URI, its server and its
  digests, and asked again when they change. "Show me its SKILL.md first"
  isn't offered, because Muse has no way to show you text the model doesn't
  see. X8 is met: Muse gives the model no tool that reads an MCP resource,
  and `read_skill_file` reads only the skill's own server. The stubs go in
  Muse's own skill folder, `~/.config/muse/skills`, one folder each, named
  `mcp-skills-served--…`; the plugin writes or removes nothing else there.
- **Server Cards:** "add" writes nothing. It gives you the `muse mcp add …`
  command, with each word quoted for the shell, so what you see is what
  runs, with the URL and every header. A secret stays a reference
  (`--bearer-token-env-var VAR`, or a header whose whole value is `${VAR}`).
  The plugin reads no configuration file and no sign-in store, and runs
  `muse` only for `muse mcp get <name> --json`, with no shell.
- **ARD:** no registry search. `ard_search` isn't offered, and nothing is
  ever sent to a registry from Muse. Discovery sends only GETs, and adding
  works as for Server Cards.
- **Apps:** no Muse Code form: Muse gives a plugin no way to draw in its
  terminal.

Events and Skills read `mcpServers` in `~/.config/muse/settings.json`, which
can hold header values you wrote. They use them to connect, as Muse does,
and keep them out of their logs. They never read Muse's sign-in store or a
project's `.mcp.json`. A server signed in with `muse mcp login`, one whose
values come from `${VAR}`, and one with `enabled: false` are left out. Where
an organisation manages Muse (`muse config status` shows a defaults or
policy plane, or can't be read), they reach no server. While a plugin's MCP
server is rejected or not approved, its hook does nothing.

**Muse's experimental gates.** With
`MUSE_EXPERIMENTAL_TUI_MSP_CLIENT=1 MUSE_EXPERIMENTAL_TUI_SESSION_PROCESS=1`,
any local process of the same user can attach to the session and start
turns, with no prompt, and could type the phrases. Events' wake mode needs
these gates, and is off by default. No other form needs them.

Events keeps watches and stored events in its data folder,
`~/.local/share/muse/plugins/data/mcp-events`, private to you. Skills keeps
approvals, server notes and its log in
`~/.local/share/muse/plugins/data/mcp-skills`, and no skill content.
`muse plugins remove <name> --delete-data` removes a plugin's folder;
Skills' stubs stay until you delete them. See
[Turning one off](./getting-started#turning-one-off) for off switches,
uninstalling and removing saved data.

No Muse run used a real model. Every run used Muse's echo provider, or a
local stand-in for the Responses API on 127.0.0.1 with a made-up key, which
also answered the approval judge, in an isolated home with no `muse login`.

## What was checked, and how

- **Tests.** A test for each client rule of Events and Skills. For Server Cards
  and ARD, one row per rule with the test that covers it (Server Cards: two
  rules met by design, and one not met; ARD: one partly met). For Apps,
  requirement-by-requirement compliance notes.
- **Formal models.**
  - Events: a model of delivery and of waking, in Quint and in TLA+, simulated,
    and model-checked with TLC to small, stated bounds. TLC checks the model,
    not the code, and says nothing past its bounds.
  - Skills: a model of approval, loading and the gate, every reachable state to
    its bound, by an explorer of its own and, in TLA+, by TLC. The model is
    checked, not the code.
  - Apps: a TLA+ model of which server a view's app comes from and what it may
    make happen, checked with TLC within stated bounds; what TLC reports is
    exhaustive within them and says nothing past them.
- **Review.** The polyfills have been reviewed by an AI reviewer that did not
  build them. The Events, Apps, Server Cards and ARD `SECURITY.md` files record
  a review on 24 November 2026 and what became of its findings. No person has
  audited any of them. The Pi forms had a separate independent AI review,
  followed by fixes and a check of the changes. The OpenCode forms had fixes
  from a security review, and their live runs were repeated after them.

Each `SECURITY.md` says what was considered, not that nothing is left.
