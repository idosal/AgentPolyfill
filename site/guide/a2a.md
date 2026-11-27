---
title: A2A delegation
description: Connect a named Agent2Agent peer, review its questions and receive the result in the originating chat.
---

# A2A delegation

Connect a chat to a named A2A agent and review its questions before it finishes the job. This first-party client implements A2A 1.0 JSON-RPC and Structured Input v1 with the official Python SDK. On hosts with MCP Tasks, the originating chat can continue working and wake when a question or result arrives.

## Install locally

From an AgentPolyfill checkout with uv installed, run the installer for your host and agent URL.

```sh
./polyfills/a2a/install codex --name swatch --url https://agent.example.org
```

The same command accepts `pi`, `t3`, `opencode`, `hermes`, `copilot`, `claude` and `antigravity`. Use `--serve-credentials /absolute/path/to/a2a-serve` for a paired Serve endpoint. Open a new chat and ask it to delegate a message to the named agent.

## Host coverage

Codex Desktop, Pi, the Pi provider in T3, the OpenCode session API, the Hermes gateway, and the interactive Copilot CLI Tasks fallback have completed two successive questions and retrieved the artifact against A2A Serve in disposable profiles. Claude Code completed the same replay through native Tasks in its interactive terminal. Antigravity CLI completed it during an active ACP turn using its own permission cards. Longer Antigravity jobs can be resumed in the same chat.

For a native Tasks client, add `--tasks native`. To disconnect an agent, run `./polyfills/a2a/install HOST --name NAME --remove`. See the [Tasks guide](/guide/tasks) for the background job and session behavior on each host.

## Operating a connection

Keep the checkout at a stable path. Repeat the installer after updating it, then restart the host or gateway. Rotate a bearer credential using its owner-only token file. Keep the existing routing database when resuming pending jobs. If delivery was interrupted, check the agent before submitting the request again.

For native A2A takeover, remove this registration or append `--disabled` to its stdio arguments. The [verification guide](https://github.com/idosal/AgentPolyfill/blob/main/polyfills/a2a/VERIFICATION.md) describes the protocol profile, security boundaries and reproducible checks.
