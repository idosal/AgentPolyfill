---
description: How the AgentPolyfill polyfills treat server content, what each one checks, how they were reviewed, and how to report a problem privately.
---

# Security

These are third-party plugins and extensions that run with your permissions.
None of them reads the host's stored credentials. They have been reviewed by
an AI reviewer that did not build them, and not audited by a person. The Pi
forms had an independent AI review, fixes and a check of those changes too.

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

| Polyfill | Claude Code | Codex | Pi |
|---|---|---|---|
| Events | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/pi/SECURITY.md) |
| Skills | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/skills/pi/SECURITY.md) |
| Server Cards | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/pi/SECURITY.md) |
| Apps | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/apps/claude-code/SECURITY.md) | not available | not available |
| ARD | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/codex/SECURITY.md) | [SECURITY.md](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/pi/SECURITY.md) |

The following per-polyfill summaries describe the Claude Code forms;
[Pi's security notes](#in-pi) follow them.

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

## In T3 Code

T3 Code runs Codex and Claude Code, so their plugins' security notes apply.
Two things differ:

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
  followed by fixes and a check of the changes.

Each `SECURITY.md` says what was considered, not that nothing is left.
