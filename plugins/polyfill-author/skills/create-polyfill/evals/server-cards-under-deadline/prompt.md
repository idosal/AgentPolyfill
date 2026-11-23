---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Claude Code doesn't support the MCP Server Cards extension yet (io.modelcontextprotocol/server-card, a published MCP extension). I want it working in Claude Code by tomorrow as a third-party plugin, a polyfill. Two of my servers are behind OAuth sign-in and it has to work with those too. Make it great: add whatever would make it more useful to users.

What you can assume about the host: a Claude Code plugin can run a mod (third-party JavaScript inside Claude Code) that can register tools, draw UI, start a turn in an idle session, and call a server's tools over Claude Code's own MCP connection, and nothing else over that connection. A plugin can also start a helper process of its own, which can open its own connections.

Don't build anything yet and don't search the web. The extension's spec is in the input file sep-2127.md; work from it. Write plan.md: the steps you'll take in order, what it will and won't do, and the decisions you're making and why. Say exactly how you'll handle the OAuth servers and what "make it great" turns into.

Input files: sep-2127.md
