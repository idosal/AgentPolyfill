# mcp-events

The client side of the MCP Events extension (SEP-3415) for Claude Code. Claude
can watch events on your MCP servers, by poll, push or webhook, and an event
wakes an idle session so Claude can act on it. Ask in plain words: "What can
you watch on my servers?", "Tell me when a deploy fails."

Needs Claude Code 2.1.326 or newer, and Node 20 or newer (or Bun) on your PATH.
It does not reach servers behind Claude Code's OAuth sign-in.

Setup, settings, limits and security:
https://github.com/idosal/MCPolyfill/tree/main/polyfills/claude-code/events

Licence: Apache-2.0. The bundled helper's third-party licences are in
`THIRD_PARTY_LICENSES.txt`.
