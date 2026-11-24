---
description: What makes something a polyfill, why the AgentPolyfill polyfills work in Claude Code, where they stop, and the four generic host changes that would remove the limits.
---

# How it works

## What makes something a polyfill

1. It implements one published extension, client side, and nothing else. No
   extra protocol, no vendor additions. The one exception allowed is an earlier
   form of the same extension that servers still speak, listed in the
   polyfill's README and switched off by one setting.
2. It names the spec revision it implements.
3. Every client rule in the spec has a test, and it is run against a server
   someone else wrote.
4. It stands down when the host supports the extension natively.
5. It says plainly what it cannot do on each host, and what the host would need
   to change.

The full text is in
[`docs/polyfill-contract.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/polyfill-contract.md).
For rule 1, `mcp-events` uses that exception: by default it also talks to
servers that advertise events in the form from before SEP-3415, and
`MCP_EVENTS_PRE_STANDARD=off` makes it follow the SEP exactly.

For rule 4, `mcp-events` and `mcp-skills` each have a setting that turns them
off (`MCP_EVENTS_OFF=1`, `MCP_SKILLS_OFF=1`), `mcp-server-cards` and
`ard-discovery` have a `disabled` setting in `/config`, and any of them is
turned off by disabling its plugin (`/plugin disable mcp-apps-cli`). None can yet detect
native support reliably, because a mod cannot see what Claude Code's own MCP
client supports. So when Claude Code ships one of these extensions, disable that
polyfill; its page says how.

## Why this works in Claude Code

Claude Code's mods (on by default since Claude Code 2.1.287) run third-party
code inside the host. A mod can register tools, draw UI, start a turn in an idle
session, and call a server's tools over Claude Code's own connection. That is
the host half of almost any extension.

As of the mod API for Claude Code 2.1.330:

| Need | Today |
|---|---|
| Add tools the model can call | `$.tool.register` |
| Draw UI | `ui.render` hooks |
| Start a turn in an idle session | `$.prompt.submit` |
| Call a server's tool over Claude Code's connection, with its sign-in | `$.mcp.call(server, tool, args)` |
| Ask whether Claude Code would use a server | `$.mcp.connect(server)` returns its verdict |
| Read a resource over Claude Code's connection | Indirectly: `$.tool.call` on the built-in `ReadMcpResourceTool`. Text or a saved file, without the resource's `_meta`. |
| Send any other MCP method | No |
| See a server's capabilities or the negotiated revision | No |
| Receive a server's notifications | No |
| See a tool's `_meta` or `outputSchema`, or a tool result as the server sent it | No |

## Where it stops

The protocol half is missing. Over Claude Code's connection a mod can call a
tool and read a resource's contents, and nothing else: it cannot send
`events/poll` or `skills/list`, see what a server advertised, or receive a
server's notifications. So Events, Skills and Apps each open a second
connection of their own, using the headers in your config. A second connection
cannot use Claude Code's sign-in, which is why none of those three reaches
servers behind OAuth, and a local server is started twice.

Server Cards needs no connection: a card is a public document, and the server it
describes is added to Claude Code's own config, so Claude Code connects it with
its own sign-in.

## Four host changes

Four small, generic changes would remove that limit. None of them names an
extension.

1. **Send any MCP method over the host's connection.**
   `$.mcp.request(server, method, params)` returns the raw result. The host does
   not need to understand the method; a connection already carries any method
   name. The transport sets the standard routing headers for the method, or
   accepts them from the caller.
2. **Read what the server advertised.** The server's capabilities, including
   `extensions`, and the negotiated protocol revision. Extensions forbid a
   client from sending their methods to a server that has not declared them, so
   a polyfill has to be able to check.
3. **Deliver server notifications to the plugin**, including notifications that
   arrive on the stream of a request the plugin made.
4. **Raw tool results in hooks, and a way to declare a client extension.** Hooks
   see a tool result as the model reads it; some extensions carry data in
   `structuredContent` and `_meta`. And some servers offer a feature only to
   clients that declare its extension, which today only the host can do.

| Change | Events (SEP-3415) | Skills (SEP-2640) | Apps | Server Cards (SEP-2127) |
|---|---|---|---|---|
| 1. Any method | `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe` | `skills/list`, `skills/get`, `resources/directory/read` | `resources/read` with `_meta`, `tools/list` with `_meta`, app-only tools | `server/discover`, to check a card against the live server |
| 2. Server capabilities | needed | needed | needed | needed: the negotiated revision and `serverInfo` |
| 3. Notifications | push delivery (`events/stream`), `list_changed` | not needed | `tools/list_changed`, resource updates | not needed |
| 4. Raw results, client extension | not needed (declaring is optional) | not needed | both needed | not needed |

Changes 1 and 2 are enough for Events by poll and webhook, and for Skills, on
every server the user has signed in to. With them, the second connection in
those polyfills is deleted.

Server Cards need none of the four to work: a card is a public document read
before any connection, and the server is then added to the host's own
configuration, so the host connects it with its own sign-in. Changes 1 and 2
are only for the spec's SHOULD to check a card against the live server.

### Questions these changes raise

- **Permissions for a raw `tools/call`.** A general pipe could call a tool
  without the host's permission rules. Either the pipe routes `tools/call`
  through the same checks as a normal tool call, or it refuses that method and
  tools stay on the existing path.
- **Scope.** A plugin could declare in its manifest the extension it implements
  and the method prefixes it will send (`events/`, `skills/`), so the grant is
  visible when the plugin is installed and the pipe is not open-ended.
- **Credentials.** The request goes out with the user's sign-in. That is the
  point, and it is also why the scope above matters.

### What these changes do not cover

- Events: a public address for webhook delivery, and sessions that run when
  nobody is at the keyboard.
- Apps: terminal input and drawing limits.
- Anything on hosts with no in-process extension layer (below).

The source of this section is
[`docs/host-changes.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/host-changes.md).

## Other hosts

OpenAI Codex is the second host. A Codex plugin brings an MCP server, every
tool call it receives names the session (`_meta.threadId`), and
`codex queue --resume` starts a turn in an idle session from outside, so
Events works there as a plugin:
[`polyfills/events/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex). Codex also
lists the skills a plugin's folder holds with its own, so Skills works there as
a plugin too: [`polyfills/skills/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex).
Both share their logic with the Claude Code forms, in
`polyfills/<extension>/core/`. Server Cards and ARD run in Codex as plugins too
([`polyfills/server-cards/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex),
[`polyfills/ard/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex)), on the same card,
discovery and registry code as the Claude Code forms.

| Extension | Spec | Polyfill | State |
|---|---|---|---|
| Events | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | [`mcp-events` for Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex) | Early, run in the Codex CLI (the TUI and `codex exec`): poll, push and webhook; an event wakes an idle Codex session through `codex queue`. No OAuth servers; a resumed session's watches start at its first mcp-events tool call; in the ChatGPT desktop app a watch records events but can't wake the chat (ask for `recent_events`). |
| Skills | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | [`mcp-skills` for Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex) | Early: served skills in Codex's skill list (from the session after a server first serves them), loaded after a per-skill yes in Codex's own form, verified against the server's digests. No OAuth servers; a cross-server resource read (X8) is not gated. |
| Server Cards | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (extension Beta) | [`mcp-server-cards` for Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex) | Early: the same discovery and checks; a server is added to Codex's config only after you choose "Add it" in Codex's own form. |

Beyond MCP, `ard-discovery` runs in Codex too, installed by name and not with
the others, because its search sends your words to a third party
([`polyfills/ard/codex`](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex)).

How to install them is in [Getting started](./getting-started#codex).

Codex has no documented way for third-party code to send requests over its
own MCP connection, so as in Claude Code, servers behind OAuth are out of
reach ([`docs/host-changes.md`](https://github.com/idosal/AgentPolyfill/blob/main/docs/host-changes.md)). We have
not found such a way in Cursor or VS Code, and ChatGPT runs no third-party code
on the client side; for those the only polyfill is a gateway (an MCP server
that presents an extension as plain tools), a weaker form, and none is built
here yet.
