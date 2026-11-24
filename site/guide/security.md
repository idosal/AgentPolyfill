---
description: How the AgentPolyfill polyfills treat server content, what each one checks, how they were reviewed, and how to report a problem privately.
---

# Security

These are third-party plugins that run inside Claude Code with your
permissions, as every Claude Code mod does. None of them reads Claude Code's
stored credentials. They have been reviewed by an AI reviewer that did not
build them, and not audited by a person.

## Reporting a problem

Please report security problems privately, through **Report a vulnerability**
on the repository's
[Security tab](https://github.com/idosal/AgentPolyfill/security/advisories/new),
not in a public issue. If that button is not there, open an issue that says only
that you have a security report, with no details, and you will be given a
private way to send it. Say which polyfill, your Claude Code version and
operating system, what you did and what happened.

## The common rule

What a server sends (an event payload, a skill's text, an app's HTML) is data
from that server, and receiving it grants nothing. Event payloads and skill text
reach Claude as tool results; context an app sets goes with your next prompt
(see [Apps](#apps)). Whatever Claude does next goes through Claude Code's normal
permissions. A polyfill never reads the host's stored credentials. Events, Apps and Skills connect only
to servers Claude Code itself uses in the session, asking Claude Code for its
verdict on each one. Server Cards connects to no server: it reads public
documents and adds a server to Claude Code's own config, only when you press
**Add** or approve Claude's request.

## Each polyfill

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
- A card with control characters or invisible marks is refused, and a remote URL
  must be printable ASCII, so what is shown beside **Add** is what is added.
- A secret the card asks for never passes through Claude; the config holds an
  environment-variable reference for you to set.
- A public name that resolves to a private address, or a redirect to one, is
  not caught.

[Server Cards `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/server-cards/claude-code/SECURITY.md)

### ARD discovery

- Search sends the words of your request to an ARD registry, a service someone
  else runs, and to at most three registries it refers to. Each search asks you
  first, showing the query and where it goes; with nobody to ask, nothing is
  sent. This is why it is not in the `agent-polyfill` bundle.
- Discovery by domain sends no query, only plain `GET`s to that domain.
- Everything it finds goes through `mcp-server-cards`' checks. It writes nothing.

[ARD `SECURITY.md`](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/ard/claude-code/SECURITY.md)

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
  audited any of them.

Each `SECURITY.md` says what was considered, not that nothing is left.
