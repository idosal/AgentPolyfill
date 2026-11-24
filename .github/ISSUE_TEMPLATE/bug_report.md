---
name: Something does not work
about: A polyfill did not load, a server is missing, or an app, event or skill did not show up
labels: bug
---

**Which polyfill**

mcp-events, mcp-apps-cli, mcp-skills, mcp-server-cards, or polyfill-author.

**What happened, and what you expected**


**Versions**

- Claude Code (`claude --version`):
- The polyfill (`claude plugin list`):
- Node or Bun (`node --version`), for mcp-events and mcp-skills:
- Terminal, for mcp-apps-cli (iTerm2, kitty, Ghostty, Terminal.app, VS Code, tmux…):
- Operating system:
- Where Claude Code runs (terminal, desktop app, IDE, `claude -p`, Agent SDK):

**The MCP server**

Which server, and how it is configured (stdio or HTTP; a header, a
`headersHelper`, or neither). Leave tokens out.

**Log**

The relevant lines of the polyfill's log in its plugin data folder
(`~/.claude/plugins/data/`), or of `claude --debug`. Read it before pasting
and remove anything private.

<!-- For a security problem, do not open an issue: see SECURITY.md. -->
