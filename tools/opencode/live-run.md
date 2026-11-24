# Live runs of the OpenCode plugins

Two runs of [`live.ts`](live.ts), 25 November 2026, and a run in OpenCode's
TUI ([below](#in-opencodes-tui)): OpenCode 2.4.1 (`opencode serve`, driven over
its HTTP API, or by the TUI attached to it), in a throwaway home with no sign-in, with a
real model, OpenCode's free `opencode/deepseek-v4.1-flash-free`, and real
public servers: Hugging Face's MCP server (skills) and neon.com and
buildkite.com (Server Cards, ARD). Events used the fixture events server,
since no public server delivers events by poll. Every plugin action had an
`ask` rule, and each request was answered "once". Not tried: the desktop app
as a client.

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

## Later runs: the cross-server check, a registry search, push

Two more runs of `live.ts`, after the fixes from the security review.

**X8 live.** After the skills loaded, the model was asked to read a resource of
the tickets server. It did so from a Code Mode program
(`tools.opencode.read_mcp_resource(...)`), and OpenCode asked first:

```
mcp_skills_cross_server on huggingface->tickets:fixture://status
metadata: {"skillsFrom":["huggingface"],"server":"tickets","uri":"fixture://status","note":"A skill served by \"huggingface\" may have led to this read from \"tickets\"."}
```

**A registry search.** To the repository's demo registry
(`polyfills/ard/claude-code/demo/registry.mjs`, which reads ten publishers'
live catalogs), on loopback:

```
ard_search on 127.0.0.1:63205
metadata: {"question":"127.0.0.1:63205: send this search to http://127.0.0.1:63205/search, and to up to three registries it refers to?","query":"check why my CI build failed",…}
```

It returned Buildkite's and Netlify's servers, each confirmed by its
publisher's own catalog.

**Push.** With the fixture offering `ticket.created` by poll and push
(`LIVE_TICKET_DELIVERY=poll,push`), the model watched it, by push, and set up
no automation beside it; the event woke the session once. OpenCode's own log
showed it skips both fixture event types ("skipping MCP event type with a
schema that can't be checked"), which is why the plugin no longer leaves push
to OpenCode. In that run the free model's usage limit was reached after the
Events part.

## In OpenCode's TUI

The same world, kept running by [`tui-world.ts`](tui-world.ts), with
OpenCode's TUI attached (`opencode --server <url> <project>`), driven in a
pseudo-terminal by the repository's `pty-drive.py`, which types and presses
keys and saves the screen. Shell and edits denied. Each permission prompt was
answered with the keyboard.

**Events.** The model's call, then OpenCode's prompt:

```
     ⠹ mcp_events_watch_event [server=tickets, event=ticket.created, note=When a new ticket is created,
       tell the user its title in exactly one sentence. Do not summarize anything else.]
  ┃  △ Permission required
  ┃    ⚙ Call tool mcp_events_watch
  ┃  Tool: mcp_events_watch
  ┃   Allow once   Always allow   Reject
```

After "Allow once" the watch started. With the session idle and the TUI
open, an event was written to the fixture server, and the TUI showed the
wake as an entry of its own, not as a message from you, then the model's
answer:

```
     ◈ mcp-events: new events
     + 1 tool
     A new high-priority ticket was created titled "Printer on fire on floor 3."
```

**Skills.** Two `mcp_skills_load_skill` calls, each with its server and URI on
the call line, and a prompt for each. "Always allow" shows the exact pattern
it would save, bound to the skill's digest:

```
  ┃    ⚙ Call tool mcp_skills_load
  ┃  This will always allow the following patterns for this project.
  ┃  - huggingface:skill://hf-mem/SKILL.md@sha256:
  ┃  4261a02ca396665e946f4ebc93a5c1abc6e4b1bfe726ba0e8f70914438d1f453
```

After "Allow once" for both, the model answered from the skills (Q4_K_M, with
the skill's size table).

**Server Cards.** The call line names the identifier and the URL; nothing is
saved for an addition, so the prompt offers only "Allow once" and "Reject":

```
     ⠇ server_cards_add_mcp_server [identifier=urn:air:neon.com:mcp:neon-docs, url=https://neon.com/docs/
       mcp, domain=neon.com, remote=0, name=neon-docs]
  ┃    ⚙ Call tool mcp_server_cards_add
  ┃   Allow once   Reject
```

Neon Docs was added and connected, and its four tools listed.

**What the TUI doesn't show.** For an action it doesn't know, OpenCode 2.4.1's
TUI shows only "Call tool <action>" (`packages/tui/src/util/permission.ts`,
its fallback): not the request's resources or metadata. So what the person
sees is the model's call line above the prompt (the server, event type, URI
or URL as the model passed them) and, under "Always allow", the pattern to be
saved. The digest, the file count and the "not a local skill" note in the
request's metadata aren't shown.

## To repeat

```bash
cd tools/opencode && npm ci && cd ../..
node --no-warnings tools/opencode/live.ts                 # the default free model
node --no-warnings tools/opencode/live.ts provider/model  # another model that needs no sign-in here
```

The transcript goes to a folder the script names; the throwaway home is kept
for reading, and can be deleted afterwards.

For the TUI, start `tui-world.ts <out>`, then attach OpenCode's TUI with the
environment `<out>/world.json` gives (its own `HOME` and XDG folders and the
throwaway server's password): `opencode --server <url> <project>`. Touching
`<out>/emit` writes a ticket to the fixture server.
