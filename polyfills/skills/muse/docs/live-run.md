# Live runs of mcp-skills in Muse Code

Recorded on 25 November 2026 with the real Muse Code 1.4.25 binary on macOS.

**How every run was set up:**
- **Isolation.** Each ran with `env -i`, and with `HOME`, the XDG folders and
  `TMPDIR` in a scratch folder.
- **Model.** No run used a real model, and there was no `muse login`. Each used
  Muse's echo provider, or a stand-in for the Responses API on 127.0.0.1 with a
  made-up key. The stand-in also answered Muse's approval judge.
- **Install.** `muse plugins install mcp-skills@agent-polyfill`, then
  `muse plugins approve mcp-skills`, from this branch's worktree, as a local marketplace
  (`muse plugins marketplace add agent-polyfill <the worktree's folder>`).
  Adding the marketplace by its GitHub URL was checked too: Muse fetched it
  with Git and listed the four plugins, but `main` had no Muse manifests yet.
  So an install from GitHub, as the README gives it, can only be checked once
  this is merged.

## Hugging Face's public server

`muse mcp add huggingface --url https://huggingface.co/mcp`, then one session
whose model called `list_skills`:

```text
MCP server "huggingface": 25 skills, lists directories.
- hf-cli (server "huggingface", uri skill://hf-cli/SKILL.md): Hugging Face Hub CLI (`hf`) … [in Muse's skill list as mcp-skills:huggingface:hf-cli]
…
```

After that session, `muse skills list --source user --json` listed all 25
stubs (`mcp-skills:huggingface:hf-cli`, …). They come from
`~/.config/muse/skills/mcp-skills-served--huggingface-d203a2--…`.

## A load, typed yes

This used the hand-written skills server that was then the Claude Code form's
(now the shared one in [`../../core/test-fixtures`](../../core/test-fixtures)), with one
skill (`git-workflow`, two files). It was one session, over two `muse exec`
runs with the same `--session-id`.

1. **"use our git workflow skill".** The model calls `load_skill`, and the
   answer loads nothing:

   ```text
   The skill is not loaded yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:

   Load the skill "git-workflow" from the MCP server "skillsfx"?

   It is not a local skill: the server serves it, and its text will reach the model as that server's content. Once it is loaded, what the model does next goes through Muse's usual approvals.
   URI: skill://git-workflow/SKILL.md
   2 files, 130 bytes, each checked against the server's SHA-256 digest when read.
   The server's description: How this team uses git.

   To load it, they send a message that is exactly: load 7436
   ```

2. **"load 7436".** The hook records the yes. The model is given
   `[mcp-skills] The user's own message is the confirmation load_skill asked for: …`,
   and Muse's status line shows `mcp-skills: you approved: Load the skill
   "git-workflow" from the MCP server "skillsfx"?`. The model calls
   `load_skill` again:

   ```text
   Loaded the skill "git-workflow" from the MCP server "skillsfx" (skill://git-workflow/SKILL.md), which the user approved just now.
   Its SKILL.md matched the size, SHA-256 digest and frontmatter in the server's entry for it. …
   ```

**Since this run, the phrase also names the server and the skill**
(`load skillsfx git-workflow 7436`, not `load 7436`). That wasn't run live
again. The tests run the bundled hook and check it. Which of Muse's ways for a
model to put text into a session run the hook (none do, but the person's own
message) is in [mcp-events' live runs](../../../events/muse/docs/live-run.md#what-can-send-the-phrase):
the two plugins share the mechanism.

## Remove

After `muse plugins remove mcp-skills --delete-data`, the plugin's data folder
and approvals were gone. The stub folders stayed in `~/.config/muse/skills`,
as the README says.
