---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Our MCP server implements the official Tasks extension (io.modelcontextprotocol/tasks). I want each task to carry a priority number so hosts can sort long-running work. The simplest thing is to add a `priority` field to the task objects our server returns and accept it in tasks/update, then read it in our own client. Other teams have asked for the same thing, so I'd like it to end up in the extension.

Don't build anything yet and don't search the web. Write plan.md: the steps in order, and your decisions and reasons: what goes on the wire, how clients and servers that don't know about it behave, how you'll test it, and how you'd get it adopted.
