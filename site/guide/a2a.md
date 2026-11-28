---
title: A2A delegation
description: Connect a named Agent2Agent peer, review its questions and receive the result in the originating chat.
---

# A2A delegation

Connect a chat to a named A2A agent and review its questions before it finishes the job. This first-party client implements A2A 1.0 JSON-RPC and Structured Input v1 with the official Python SDK. On hosts with MCP Tasks, the originating chat can continue working and wake when a question or result arrives.

## Codex marketplace

Install **A2A Delegation** from the AgentPolyfill marketplace. The plugin includes the shared Tasks client. You can start with zero agents.

```sh
codex plugin marketplace add idosal/AgentPolyfill
codex plugin add a2a@agent-polyfill
```

In Codex, ask to connect a named agent at its URL. The model can suggest the settings, and Codex shows you the change before saving. Add more agents, edit or remove them, and delegate in that chat. Paired agents use the official Serve CLI on your machine. [Marketplace setup and operating notes](https://github.com/idosal/AgentPolyfill/tree/main/polyfills/a2a#install-from-the-agentpolyfill-codex-marketplace)

## Install from a checkout

From an AgentPolyfill checkout with uv installed, enable A2A for your host:

```sh
./polyfills/a2a/install codex
```

You can start with zero agents. Open the local settings with `./polyfills/a2a/agents codex` to add, edit, or remove named connections. Or add agents directly:

```sh
./polyfills/a2a/agents codex add swatch --url https://swatch.example.org
./polyfills/a2a/agents codex add research --url https://research.example.org
```

Ask your chat to list its configured A2A agents. After adding a connection, reload the host or open a fresh chat and ask it to delegate to the agent by name. The same setup supports `pi`, `t3`, `opencode`, `hermes`, `copilot`, `claude` and `antigravity`. For a paired Serve endpoint, add `--serve-credentials /absolute/path/to/a2a-serve` when configuring that agent.

## Host coverage

Codex Desktop, Pi, the Pi provider in T3, the OpenCode session API, the Hermes gateway, and the interactive Copilot CLI Tasks fallback have completed two successive questions and retrieved the artifact against A2A Serve in disposable profiles. Claude Code completed the same replay through native Tasks in its interactive terminal. Antigravity CLI completed it during an active ACP turn using its own permission cards. Longer Antigravity jobs can be resumed in the same chat.

For a native Tasks client, add `--tasks native`. To disconnect an agent, run `./polyfills/a2a/agents HOST remove NAME`. See the [Tasks guide](/guide/tasks) for the background job and session behavior on each host.

## Operating a connection

Keep the checkout at a stable path. Repeat the installer once per host profile after updating the checkout, then restart the host or gateway. Rotate a bearer credential using its owner-only token file. Editing an agent to use a different destination clears its credential reference. Keep the existing routing database when resuming pending jobs. If delivery was interrupted, check the agent before submitting the request again.

For native A2A takeover, remove this registration or append `--disabled` to its stdio arguments. The [verification guide](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/a2a/VERIFICATION.md) describes the protocol profile, security boundaries and reproducible checks.
