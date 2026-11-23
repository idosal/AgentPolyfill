# MCPolyfill

MCP extensions for hosts that haven't shipped them yet. Claude Code first.

MCP now grows through extensions: Apps, Skills, Events, Tasks. Each is a
published spec with its own identifier. A server can adopt one quickly. A host
has to build, review and ship it, and no host ships all of them at once. Until
enough hosts do, server authors have little reason to implement an extension,
and hosts see little demand for it.

A polyfill closes that gap from the outside. It is third-party code that
implements an extension's client side inside a host, exactly as the spec says,
and steps aside when the host supports the extension itself. Servers need no
changes, and never know the difference.

## Polyfills

| Extension | Spec | Claude Code | Polyfill | State |
|---|---|---|---|---|
| Events (`io.modelcontextprotocol/events`) | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | not supported | `mcp-events` | Works: poll, push and webhook delivery; an event wakes an idle session. No OAuth servers. |
| Apps (`io.modelcontextprotocol/ui`) | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps), Stable | not supported | `mcp-apps-cli` | Prototype: renders app UIs inline in the terminal, with mouse and keyboard. No OAuth servers. |
| Skills (`io.modelcontextprotocol/skills`) | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | not supported | `mcp-skills` | In progress. |

"Claude Code" is what the official
[extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
showed on 23 November 2026: Tasks, and none of the three above. Hosts are
adding extensions steadily, so check the matrix for today's picture. The Skills
SEP notes that Claude Code support has been prototyped at Anthropic.

## What makes something a polyfill

1. It implements one published extension, client side, and nothing else. No
   extra protocol, no vendor additions.
2. It names the spec revision it implements.
3. Every client rule in the spec has a test, and it is run against a server
   someone else wrote.
4. It stands down when the host supports the extension natively.
5. It says plainly what it cannot do on each host, and what the host would
   need to change.

The full text is in [`docs/polyfill-contract.md`](docs/polyfill-contract.md).
For rule 4, `mcp-events` has a setting that turns it off; none of the three
detects native support yet.

## Build one

The `create-polyfill` skill walks an agent through building a polyfill to this
contract: the spec's client rules as a checklist, how each wire need is reached
on the host, stand-down, and what counts as proof.

```
/plugin install polyfill-author@mcpolyfill
```

Then ask for the extension you want, for example "polyfill MCP Server Cards in
Claude Code". It points the agent at the primary sources (the SEP, the
extension's spec, the core spec for the revision in use, the conformance
suite) and has it work from those.

### When the spec doesn't have what you want

A polyfill stays exact, so new behaviour does not go into one. The
`design-extension` skill, in the same plugin, covers that case: first check
whether the protocol already has a slot for it, then, if it really is new,
design it as its own extension under MCP's extension rules (your own
identifier, a declaration, defined behaviour when the other side lacks it, a
written spec, two implementations) and take it to the working group.

Both skills are plain `SKILL.md` files
([create-polyfill](plugins/polyfill-author/skills/create-polyfill/SKILL.md),
[design-extension](plugins/polyfill-author/skills/design-extension/SKILL.md)),
so other agents that read skills can use them too.

## Why this works in Claude Code, and where it stops

Claude Code's mods (early access) run third-party code inside the host. A mod
can register tools, draw UI, start a turn in an idle session, and call a
server's tools over Claude Code's own connection. That is the host half of
almost any extension.

The protocol half is missing. Over Claude Code's connection a mod can call a
tool, and nothing else: it cannot send `events/poll` or `skills/list`, see what
a server advertised, or receive a server's notifications. So each polyfill here
opens a second connection of its own, using the headers in your config. A
second connection cannot use Claude Code's sign-in, which is why none of them
reaches servers behind OAuth.

Four small, generic changes would remove that limit. None of them names an
extension:

| Change | Events | Skills | Apps |
|---|---|---|---|
| Send any MCP method over the host's connection | needed | needed | needed |
| Read what the server advertised | needed | needed | needed |
| Deliver server notifications to the plugin | push only | not needed | needed |
| Raw tool results in hooks; declare a client extension | not needed | not needed | needed |

The first two are enough for Events (by poll and webhook) and Skills on every
server. The details, and the questions they raise about permissions, are in
[`docs/host-changes.md`](docs/host-changes.md).

## Other hosts

We have not found a documented way for third-party code to send requests over
the host's MCP connection in Codex, Cursor or VS Code, and ChatGPT runs no
third-party code on the client side. For those hosts the only polyfill is a
gateway: an MCP server that presents an extension as plain tools. It is a
weaker form (for Events, the model has to poll and nothing wakes it), and none
is built here yet.

## Install

In Claude Code:

```
/plugin marketplace add idosal/MCPolyfill
/plugin install mcp-events@mcpolyfill
```

Each polyfill's own README lists its requirements and limits.

## Status

A community project. It is not part of the MCP specification and is not
affiliated with Anthropic.
