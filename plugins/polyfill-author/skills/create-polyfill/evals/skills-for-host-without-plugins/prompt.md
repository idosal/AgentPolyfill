---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

My team uses a chat host that supports MCP servers but only their tools: it ignores the MCP Skills extension (SEP-2640, io.modelcontextprotocol/skills), and there is no way to run my own code inside it. All I control is which MCP servers it connects to. Our internal server serves about thirty skills through that extension. I want a polyfill so the host's model can find and use those skills.

Don't build anything yet and don't search the web. Write plan.md: the steps you'll take in order, what it will and won't do, and the decisions you're making and why. Be clear about what this version can't do compared with real support.
