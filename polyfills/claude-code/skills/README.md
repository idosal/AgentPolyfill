# Removed

The Skills polyfill for Claude Code (`mcp-skills`) was removed from this
repository on 25 November 2026. Claude Code lists skills from MCP servers
itself, in beta from 2.1.332: its
[changelog](https://code.claude.com/docs/en/changelog) says skills from MCP
servers were added as a beta, and that they show as `server:skill` in the `/`
menu while other skills keep their names. A beta may not be on for every
account or server yet.

The Skills forms for the other hosts are in
[`polyfills/skills`](../../skills): [Codex](../../skills/codex),
[Pi](../../skills/pi) and [OpenCode](../../skills/opencode).

## If you installed it

The marketplace no longer lists `mcp-skills` for Claude Code, and the
`agent-polyfill` bundle no longer depends on it (from bundle version 0.3.0).
An install you already have is no longer maintained here. Remove it at the
prompt of a `claude` session:

```
/plugin uninstall mcp-skills@agent-polyfill
```

Whether Claude Code removes it by itself when the bundle stops depending on
it isn't known here, so look in `/plugin` after the bundle updates.

What the mod kept on your machine, as its own README and SECURITY.md recorded
it:

- **Your approvals, and the skills you disabled,** in the mod's own store in
  your Claude Code configuration folder. `/mcp-skills forget` drops the
  approvals, so run it before you uninstall if you want them gone. Those
  pages don't say whether uninstalling the plugin removes that store.
- **A log, and a note of which of your servers serve skills,** in the plugin's
  data folder: `~/.claude/plugins/data/` followed by the plugin's folder, or
  the same under `CLAUDE_CONFIG_DIR`.
- **A copy of Bun,** in the `runtime` folder of that data folder, only if you
  ran `/mcp-skills setup`. `/mcp-skills setup remove` deletes it.

Uninstalling the plugin leaves the data folder in place, so run
`/mcp-skills setup remove` first, or delete the folder yourself afterwards.
The mod kept no skill content and no tokens.

## History

The form's source, tests and records are in the repository's history. The
last commit that has them is
[`ed2279a6`](https://github.com/idosal/AgentPolyfill/tree/ed2279a6a2979b90a3bb1a8673f34ee92cac87f6/polyfills/skills/claude-code)
(a link into history: that folder is not in the repository now).

What moved out of it, because the other forms use it:

| Was | Is now |
|---|---|
| `polyfills/skills/claude-code/test/harness.ts` (the fixture and the skill builders) | [`polyfills/skills/core/test-fixtures/harness.ts`](../../skills/core/test-fixtures/harness.ts) |
| `polyfills/skills/claude-code/test/fixture-skills-server.ts` | [`polyfills/skills/core/test-fixtures/fixture-skills-server.ts`](../../skills/core/test-fixtures/fixture-skills-server.ts) |
| `polyfills/skills/claude-code/tools/pty-drive.py` | [`polyfills/skills/core/tools/pty-drive.py`](../../skills/core/tools/pty-drive.py) |
| `polyfills/skills/claude-code/docs/conformance.md` (the rule ids and text; the Claude Code results went with the form) | [`polyfills/skills/core/docs/sep-2640-client-rules.md`](../../skills/core/docs/sep-2640-client-rules.md) |
