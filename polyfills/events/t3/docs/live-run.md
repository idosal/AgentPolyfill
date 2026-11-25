# A live run in T3 Code

mcp-events-t3 0.1.0 (bundle `plugin/dist/server.js`, SHA-256 starting
`6578709592cd`), in T3 Code 0.1.11 (`t3 serve`, the npm package) with
Codex CLI 0.172.0 (model `gpt-6.1-terra`), on macOS, 25 November 2026.

Everything ran in an isolated install: its own `HOME`, `T3CODE_HOME`,
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` (`$S` below, a scratch folder),
with a Codex sign-in made for it. The events server is the fixture server of
this repository's tests
([`../../claude-code/test/fixture-events-server.ts`](../../claude-code/test/fixture-events-server.ts)),
written by hand from SEP-3415, over stdio; an event is a line appended to its
upstream file. The isolated `config.toml` named it, and this server:

```toml
[mcp_servers.tickets]
command = "node"
args = ["--no-warnings", "<repo>/polyfills/events/claude-code/test/fixture-events-server.ts"]
env = { FIXTURE_UPSTREAM = "$S/live/upstream.jsonl", FIXTURE_POLL_MS = "500" }

[mcp_servers.mcp-events-t3]
command = "node"
args = ["<repo>/polyfills/events/t3/plugin/dist/server.js"]
env = { MCP_EVENTS_T3_BIN = "$S/bin/t3" }
env_vars = ["CODEX_HOME", "T3CODE_HOME"]
```

The thread was started with `t3 thread start`, so it ran in the project's
default permission mode, which in this fresh install was Full access:
`watch_event` ran without a prompt.

What it shows, in order:

1. A Codex thread in T3 Code sets a watch with the server's tools. The server
   Codex started for the thread starts the watcher.
2. T3 Code is stopped. Codex, its app server and the per-thread servers all
   end. Only the watcher is left (its parent is now pid 1).
3. A ticket is created while T3 Code is down. The watcher stores it and tries
   to wake the thread; `t3 thread send` says no T3 Code is running, and it
   tries again at 5, 10 and 20 seconds.
4. T3 Code is started again. The next try reaches it. T3 Code reopens the
   thread's Codex session (a new per-thread server starts), Codex reads the
   event with `get_event` and answers with the summary the watch's note asked
   for.

The watcher's log also shows it resuming, when it started, a watch another
thread had set in an earlier run (`…3fb44193`), and that thread reading the
event it had missed.

The log, with paths shortened:

```text
## 2026-11-25T00:45:46Z t3 thread start (Codex gpt-6.1-terra), bundle 6578709592cd
{"threadId":"mcp:7cc47697-27c8-40f4-88d5-26adf1a5cfdf","runId":"run:thread:mcp%3A7cc47697-27c8-40f4-88d5-26adf1a5cfdf:ordinal:1","status":"completed","reply":"Watch created: `w-85ddcd`.","error":null}
exit 0
## 2026-11-25T00:45:55Z processes
54909 93046 ~/.nvm/versions/node/v22.22.1/bin/node $S/t3inst/node_modules/t3/dist/bin.mjs serve --port 37731 --host 127.0.0.1
58356 54926 codex app-server -c thread_unload_delay_secs=0
58413 58356 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js
59762 58356 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js
61674 58356 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js
61784 61674 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js --watcher
61838 58356 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js
## 2026-11-25T00:46:06Z T3 Code stopped (SIGTERM to t3 serve); what is left
61784     1 ~/.nvm/versions/node/v22.22.1/bin/node <repo>/polyfills/events/t3/plugin/dist/server.js --watcher
## 2026-11-25T00:46:06Z a ticket is created while T3 Code is down
## 2026-11-25T00:46:24Z T3 Code started again (t3 serve)
## 2026-11-25T00:46:55Z the watcher's log ($CODEX_HOME/mcp-events-t3/mcp-events.log), this run
2026-11-25T00:45:51.951Z [watcher 61784] mcp-events 0.1.0 for T3 Code: watcher started (3 configured server(s))
2026-11-25T00:45:51.976Z [watcher 61784] list_event_types from thread …f1a5cfdf
2026-11-25T00:45:52.088Z [watcher 61784] tickets: 2 event type(s) (protocol revision 2026-07-28)
2026-11-25T00:45:52.272Z [watcher 61784] [3fb44193] runs 1 watch(es)
2026-11-25T00:45:52.273Z [watcher 61784] resumed the watches of 1 thread(s)
2026-11-25T00:45:54.357Z [watcher 61784] watch_event from thread …f1a5cfdf
2026-11-25T00:45:56.938Z [watcher 61784] get_event from thread …3fb44193
2026-11-25T00:46:08.385Z [watcher 61784] [f1a5cfdf] waking the thread failed: T3 Code is not running (no running T3 Code server uses its data folder); tried again later; trying again in 5 s
2026-11-25T00:46:14.191Z [watcher 61784] [f1a5cfdf] waking the thread failed: T3 Code is not running (no running T3 Code server uses its data folder); tried again later; trying again in 10 s
2026-11-25T00:46:24.773Z [watcher 61784] [f1a5cfdf] waking the thread failed: T3 Code is not running (no running T3 Code server uses its data folder); tried again later; trying again in 20 s
2026-11-25T00:46:49.643Z [watcher 61784] get_event from thread …f1a5cfdf
## 2026-11-25T00:46:55Z t3 thread show (the woken thread)
Use the mcp-events-t3 tools: watch ticket.created on the tickets server for hig…
mcp:7cc47697-27c8-40f4-88d5-26adf1a5cfdf  completed  codex/gpt-6.1-terra

[user]
Use the mcp-events-t3 tools: watch ticket.created on the tickets server for high-priority tickets, with the note 'Summarize the ticket in one line'. Then tell me the watch id and stop.

[assistant]
I’ll set up the requested watch and return its ID.

[assistant]
Watch created: `w-85ddcd`.

[user]
[mcp-events] (Sent by the mcp-events polyfill through T3 Code, not typed by the user.)
[mcp-events] tickets · ticket.created: 1 new event [event e1; watch w-85ddcd; get_event e1 returns it]. Note saved with this watch: "Summarize the ticket in one line".

[assistant]
I’ll read the new ticket and summarize it in one line.

[assistant]
High-priority ticket T-1043: Password reset emails are not being sent.
```

What Codex was handed for the wake, from its own session record: T3 Code's
line first, then the polyfill's.

```text
[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]

[mcp-events] (Sent by the mcp-events polyfill through T3 Code, not typed by the user.)
[mcp-events] tickets · ticket.created: 1 new event [event e1; watch w-85ddcd; get_event e1 returns it]. Note saved with this watch: "Summarize the ticket in one line".
```
