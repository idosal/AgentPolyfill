# Live runs of the OpenCode plugins

Two runs of [`live.ts`](live.ts), 25 November 2026: OpenCode 2.4.1 (`opencode
serve`, driven over its HTTP API), in a throwaway home with no sign-in, with a
real model, OpenCode's free `opencode/deepseek-v4.1-flash-free`, and real
public servers: Hugging Face's MCP server (skills) and neon.com and
buildkite.com (Server Cards, ARD). Events used the fixture events server,
since no public server delivers events by poll. Every plugin action had an
`ask` rule, and each request was answered "once" by the script. Not tried:
the TUI and the desktop app as clients.

## What happened

**Events.** Asked to watch new tickets and say each one's title, the model
listed the event types (`ticket.created` by poll, `deploy.finished` by
webhook), and OpenCode asked:

```
mcp_events_watch on tickets:ticket.created
metadata: {"server":"tickets","event":"ticket.created","arguments":{},"note":"A new support ticket was created. Reply to the user with the ticket's title in one sentence."}
```

The session went idle. An event was then written to the fixture server, and
nobody typed anything. The session woke with the plugin's synthetic message:

```
[mcp-events] (Sent by the mcp-events plugin, not typed by the user.)
[mcp-events] tickets · ticket.created: 1 new event [event e1; watch w-e7e976; get_event e1 returns it]. Note saved with this watch: "A new support ticket was created. Reply to the user with the ticket's title in one sentence.".
```

and the model answered: *A new high-priority ticket was created titled
"Printer on fire on floor 3."* Both runs.

**Skills.** Hugging Face's 25 served skills were in OpenCode's own skill list,
each as `mcp-skills:huggingface:<name>`, described `[MCP server "huggingface",
not a local skill] …`. Asked which GGUF quantization to use for a 7B model on
a 16 GB Mac, the model loaded two of them, and OpenCode asked about each,
bound to its digest:

```
mcp_skills_load on huggingface:skill://huggingface-local-models/SKILL.md@sha256:c7091c9d…
metadata: {"server":"huggingface","skill":"huggingface-local-models","files":4,"bytes":15849,"note":"Not a local skill: its text is the MCP server \"huggingface\"'s content."}
```

It then read the skill's reference files and answered from them.

In the first run, shell commands were allowed (OpenCode's default), and the
model, following the `hf-mem` skill, ran `uvx hf-mem …`, which fetched that
tool from PyPI into the throwaway home and ran it, without a prompt. That is
the default-allow limit the READMEs state: once a served skill is loaded,
what it tells the model to do goes through OpenCode's rules, and by default
those allow it. `live.ts` now denies `shell` and `edit` for a run by hand. In
the second run the model answered without trying a command.

**Server Cards.** Asked what neon.com publishes, the model found its two
servers in the AI Catalog, both valid. Asked to add Neon Docs, OpenCode asked:

```
mcp_server_cards_add on neon-docs=https://neon.com/docs/mcp
metadata: {"question":"neon.com: add the MCP server \"neon-docs\" to OpenCode? It connects to https://neon.com/docs/mcp.","headers":"none","card":"com.neon/docs-mcp","from":"listed in https://neon.com's catalog","undo":"server_cards_remove_mcp_server {\"name\": \"neon-docs\"}"}
```

After the answer, OpenCode connected the server (status `connected`) and its
four tools were in the model's tools; in the first run the model called
`search_docs` and got results.

**ARD.** Asked what buildkite.com lists in its `ard.json`, the model reported
its one entry, `com.buildkite/remote-mcp-server`, with a valid card. No
registry search was sent: the plugin ships with none, and none was named.

## To repeat

```bash
cd tools/opencode && npm ci && cd ../..
node --no-warnings tools/opencode/live.ts                 # the default free model
node --no-warnings tools/opencode/live.ts provider/model  # another model that needs no sign-in here
```

The transcript goes to a folder the script names; the throwaway home is kept
for reading, and can be deleted afterwards.
