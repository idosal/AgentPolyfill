# A live session

Recorded on 24 November 2026: Claude Code 2.1.329 in a terminal on macOS, with
the mod installed as a plugin from its marketplace (before it moved to this
repository).

The MCP server is the demo "deploys" server in `demo/`, built on Mastra's
`@mastra/mcp`, reached over Streamable HTTP with a bearer token from an
environment variable (`"Authorization": "Bearer ${DEPLOYS_DEMO_TOKEN}"`),
offering push and poll. Nothing else was set up.

What happened, in order: one typed prompt; Claude sets a watch and the session
goes idle; a deploy is made to fail from outside (one request to the demo
server); the event wakes the session with nobody typing; Claude reads the
deploy's log with the server's own tool and answers. The session was driven
through a pseudo-terminal by `tools/pty-drive.py`; this is its screen
afterwards, with blank lines and the banner removed.

```
❯ Watch the deploys server. When a deploy fails, read its log and tell me why in one line.
⏺ mcp-events - watch_event (MCP)(server: "deploys", event: "deploy.finished", arguments: {"status":"failed"}, note: "When a deploy fails, read its log
                                with get_deploy_log and tell the user why in one line.")
  ⎿  Watching deploys / deploy.finished {"status":"failed"} as w-2112c6, by push, from now on. Each event will arrive as a message from the mcp-e
     vents plugin that starts with "[mcp-events]". Stop with unwatch_event w-2112c6.
⏺ I'm now watching the deploys server for failed deploys. When one fails, I'll read its log and give you the cause in one line.
✻ Cogitated for 5s · done 12:43 AM
› Prompt from the mcp-events plugin
❯ [mcp-events] deploys · deploy.finished: id=d-101, service=api, status=failed, commit=2225bf1, seconds=2 [event e1, watch w-2112c6; get_event e1
  returns the record]. Note saved with this watch: "When a deploy fails, read its log with get_deploy_log and tell the user why in one line.".
  Called deploys
⏺ Deploy d-101 (api, commit 2225bf1) failed because migration 0042_orders_index references an orders_archive table that doesn't exist. The migration
  rolled back and the rollout never started.
✻ Cogitated for 5s · done 12:43 AM
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
```

The same thing in a session with no terminal (`claude -p --input-format
stream-json`, the shape an app or the Agent SDK hosts), against the fixture
server in `test/`: one message in, then nothing more was sent.

```
TOOL: mcp__mcp-events__list_event_types {"server": "tickets"}
TOOL: mcp__mcp-events__watch_event {"server": "tickets", "event": "ticket.created", "note": "When a new ticket arrives, reply with exactly: GOT <ticket id>"}
ASSISTANT: WATCHING
RESULT: success WATCHING
                         (28 seconds later a ticket is created on the server)
ASSISTANT: GOT T-9001
RESULT: success GOT T-9001
```
