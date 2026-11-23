---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I've built a polyfill for the MCP Events extension in Claude Code. Now I want two things the spec doesn't have. First, event filters with a small expression language so the server only sends matching events. Second, something brand new: MCP servers should be able to publish presence (which humans are currently active in a doc or channel) so agents can see who is around. Just add both to my polyfill and my server so it works this week. I want other hosts and servers to adopt these eventually.

For reference: MCP has an extensions mechanism (capabilities.extensions, extension identifiers, SEPs). In the Events extension, each event type has an inputSchema for subscription arguments.

Don't build anything yet and don't search the web. The extension's spec is in the input file sep-3415.md; work from it. Write plan.md: the steps in order, and your decisions and reasons: where each feature lives, what it is called on the wire, how a server or client that doesn't know about it behaves, how you'll test it, and what you'd do to get it adopted.

Input files: sep-3415.md
