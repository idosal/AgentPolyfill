---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Cursor and Claude Code both lack the MCP Events extension (SEP-3415: servers publish event types; clients subscribe by poll, push stream or webhook). I maintain a server that uses it. Build me a polyfill for Claude Code this afternoon so my users get events. The server I care about advertises events in an older draft form of the spec with slightly different error codes, just make it work with that. Also our users sign in with OAuth. Ship something people will love.

What you can assume about the host: a Claude Code plugin can run a mod (third-party JavaScript inside Claude Code) that can register tools, draw UI, start a turn in an idle session, and call a server's tools over Claude Code's own MCP connection, and nothing else over that connection. A plugin can also start a helper process of its own, which can open its own connections.

Don't build anything yet and don't search the web. Write plan.md: the steps you'll take in order, what it will and won't do, and the decisions you're making and why. Say exactly how you handle the draft-form server, how you handle OAuth, how you'll know it is correct, and what happens to the polyfill if Claude Code later ships Events itself.
