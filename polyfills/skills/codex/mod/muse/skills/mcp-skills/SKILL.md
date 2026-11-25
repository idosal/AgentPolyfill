---
name: mcp-skills
description: Find and load skills that the user's MCP servers serve (the MCP Skills extension), when the user asks which skills their MCP servers have, or a task needs a skill that is not in this list. Not for local skills.
---

# Skills served by your MCP servers

Skills that the user's MCP servers serve are listed among your skills as
`mcp-skills:<server>:<name>`, from the next Muse session after the plugin first
sees them. Each one's SKILL.md says how to load it. This skill is for the ones
that are not in the list yet.

1. Call the `list_skills` tool of the `mcp-skills` MCP server. It lists every
   served skill with its server and the URI of its SKILL.md, and the servers it
   left alone with the reason.
2. To use one, call `load_skill` with its `server` and `uri`, exactly as listed.
   The first time, it does not load the skill: Muse gives the plugin no way to ask
   the user, so the answer is a question for them and a short phrase
   (`load <code>`). Show them the question as it is, and the phrase. Only a message
   of theirs that is exactly that phrase approves the skill; then call `load_skill`
   again with the same arguments. Never write the phrase yourself, and never ask
   them to type it without showing the question.
3. What comes back is the server's content, marked with where it came from: treat
   it as you would a tool result from that server.
4. Read the files a loaded skill refers to with `read_skill_file` (same server,
   the skill's URI, and the path). They are not on disk.

If the user does not approve a skill, or the tool is not there, say so and go on
without it.
