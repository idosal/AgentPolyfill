---
description: MCP extensions available for each agent host, including built-in support and links to the plugins.
---

# Introduction

An MCP extension defines behavior for both a server and a client. AgentPolyfill
implements the client side in a host plugin. A server that implements the
extension can work with that host without changing its code.

## The polyfills

- **[Events](./events)** — Watch an MCP server for events such as failed deployments or new releases.
- **[Skills](./skills)** — List skills an MCP server publishes and load their instructions and files on demand.
- **[Server Cards](./server-cards)** — Find the MCP servers a domain publishes and add a selected server to your host.
- **[Apps](./apps)** — Use an MCP tool’s interface inline in the Claude Code terminal with the mouse and keyboard.
- **[ARD](./ard)** — Look up a domain’s `ard.json` or search an Agentic Resource Discovery registry.

ARD is a draft protocol separate from MCP. Domain lookups read a public catalog.
Registry searches send the query to your chosen registry after approval.

| Host | Events | Skills | Server Cards | Apps | ARD |
|---|---|---|---|---|---|
| [Claude Code](./getting-started#claude-code) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/claude-code) | Native (beta) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/claude-code) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/apps/claude-code) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/claude-code) |
| [Codex](./getting-started#codex) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/codex) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/codex) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/codex) | — | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/codex) |
| [Pi](./getting-started#pi) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/pi) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/pi) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/pi) | — | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/pi) |
| [OpenCode](./getting-started#opencode) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/opencode) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/opencode) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/opencode) | — | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/opencode) |
| [Google Antigravity](./getting-started#antigravity) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/antigravity) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/antigravity) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/antigravity) | Native in App | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/antigravity) |
| [GitHub Copilot CLI](./getting-started#github-copilot-cli) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/copilot) | Native¹ | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/copilot) | VS Code only¹ | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/copilot) |
| [Hermes Agent](./getting-started#hermes-agent) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/hermes) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/skills/hermes) | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/server-cards/hermes) | — | [Plugin](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/ard/hermes) |

¹ Copilot CLI advertises Skills. Its VS Code integration enables Apps. See the [Copilot compatibility notes](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/events/copilot/README.md#skills-and-apps-in-copilot) for the tested scope.

## T3 Code

T3 Code runs the plugins installed for its underlying agent. Codex threads use a
[dedicated Events adapter](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/events/t3). T3 Code
renders MCP Apps itself. Its Codex integration cancels the approval forms used
by Skills, Server Cards and ARD. See [T3 Code setup](./getting-started#t3-code).

The [Tasks plugin for Codex](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/tasks/codex) has a separate source install.

## Install a plugin

The [installation guide](./getting-started) lists prerequisites and commands
for each host. Each plugin documents its supported specification revision and
known limits. See [how the adapters connect to servers](./how-it-works) for
transport and authentication details, and [security](./security) for permissions
and data handling.
