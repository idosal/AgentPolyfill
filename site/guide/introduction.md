---
description: What AgentPolyfill is, which MCP extensions it adds to Claude Code, and who it is for.
---

# Introduction

AgentPolyfill is a set of Claude Code plugins. Four of them each add the client
side of one published MCP extension that Claude Code does not support by itself
yet: Events, Apps, Skills and Server Cards. A fifth adds Agentic Resource
Discovery, an open draft beyond MCP.

## Why polyfills

MCP now grows through extensions: Apps, Skills, Events, Server Cards. A server can adopt one
quickly. Each host has to build and ship each one, on its own schedule. A
polyfill closes that gap from the outside: it implements one published
extension's client side as a plugin, follows that extension's spec (any
exception is listed in its README), and steps aside when the host ships its
own. Servers need no changes.

The aim is an open community around open specs, where anyone can use these
capabilities in the host they have, build the next polyfill, or propose a new
extension, and support does not depend on one host's roadmap. Today that is
Claude Code with four MCP extensions and one open draft beyond MCP (Agentic
Resource Discovery), and Codex with Events, Skills, Server Cards and ARD
([Other hosts](./how-it-works#other-hosts)).
More hosts are where it is meant to go.

## The polyfills

| Extension | Spec | Polyfill | State |
|---|---|---|---|
| [Events](./events) (`io.modelcontextprotocol/events`) | [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md), Final | `mcp-events` | Works: poll, push and webhook delivery; an event wakes an idle session. No OAuth servers. |
| [Apps](./apps) (`io.modelcontextprotocol/ui`) | [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 2026-01-26, Stable | `mcp-apps-cli` | Early: app UIs render inline in the terminal, with mouse and keyboard. No OAuth servers. |
| [Skills](./skills) (`io.modelcontextprotocol/skills`) | [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md), Final | `mcp-skills` | Early: skills served by an MCP server are listed, loaded and read in Claude Code, with the checks the spec asks of a client. No OAuth servers. |
| [Server Cards](./server-cards) | [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), Final (extension Beta) | `mcp-server-cards` | Early: finds the servers a domain publishes, checks each card against the schema, and adds one to Claude Code's own config with a click, so servers behind OAuth work. |

Beyond MCP, [`ard-discovery`](./ard) adds
[Agentic Resource Discovery](https://github.com/ards-project/ard-spec) v0.91, a
draft: it finds MCP servers through a domain's `ard.json` or by searching an
ARD registry, and hands the cards to `mcp-server-cards`. Its search sends the
words of your request to that registry, and asks you first every time; for that
reason it is not part of the `agent-polyfill` bundle. Install it by name.

On 23 November 2026 the official
[extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
showed Claude Code with Tasks, and none of Events, Apps or Skills (Server Cards
is not in the matrix). Hosts are adding
extensions steadily, so check the matrix for today's picture. The Skills SEP
notes that Claude Code support has been prototyped at Anthropic.

"No OAuth servers" is the same limit in Events, Apps and Skills: each opens a
second connection of its own to each server, and that connection cannot use
Claude Code's sign-in. Server Cards needs no connection: the server it finds is
added to Claude Code's own config, so Claude Code connects it with its own
sign-in. [How it works](./how-it-works) explains why, and which host changes
would remove the limit.

## Who it is for

- **People who use agents:** one line to install, one line to try. See
  [Getting started](./getting-started).
- **People who build:** the `create-polyfill` and `design-extension` skills,
  and the contract every polyfill here meets. New polyfills are welcome:
  [Build a polyfill](./build-a-polyfill).
- **Spec authors:** a polyfill can be the client half of the two
  implementations an extension needs to reach Stable:
  [For spec authors](./spec-authors).

## Before you install

These are third-party plugins that run with your permissions, as every Claude
Code mod does. None of them reads Claude Code's stored credentials. Each
polyfill's `SECURITY.md` says what it checks and what it does not protect
against; [Security](./security) collects them.

AgentPolyfill is a community project. It is not part of the MCP specification
and is not affiliated with or endorsed by the MCP project, the Agentic AI
Foundation, the Linux Foundation, Anthropic or any host vendor. See
[About](/about).
