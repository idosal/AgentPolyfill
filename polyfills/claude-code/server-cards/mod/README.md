# mcp-server-cards

MCP Server Cards (SEP-2127) for Claude Code. Claude finds the MCP servers a domain publishes in its catalog (`/.well-known/ard.json` or `/.well-known/ai-catalog.json`), or searches an Agentic Resource Discovery registry for a server that can do a task. It checks each Server Card against the schema, says which servers their publisher confirms, and, once you approve, adds one to Claude Code's MCP configuration with `claude mcp add`. Claude Code then connects the server with its own sign-in.

## Install

```
claude plugin marketplace add idosal/MCPolyfill
claude plugin install mcp-server-cards@mcpolyfill
```

It needs Claude Code 2.1.329 or later, and nothing else.

## Use

Ask, for example, "connect Claude Code to Buildkite", or "find an MCP server that can check why my CI build failed". Under the result, a picker lists the servers found, with an **Add** button for each. Or let Claude add one: Claude Code asks you first. A server that needs a sign-in asks for it in `/mcp`.

The full documentation, including the spec rules, limits, privacy and how to turn it off, is in [the polyfill's README](../README.md).
