---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I want MCP servers to be able to tell clients which of their tools are dangerous (they delete things or spend money), so a host can ask the user before running them. My plan is to add a `dangerous: true` field to each tool in my server's tools/list result and read it in my Claude Code plugin. I'd like this to become a standard eventually.

Don't build anything yet and don't search the web. Write plan.md: the steps in order, and your decisions and reasons: what goes on the wire, how clients that don't know about it behave, how you'll test it, and how you'd get it adopted.
