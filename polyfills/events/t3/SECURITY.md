# Security

This covers mcp-events for T3 Code. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md).

"The server" below means `plugin/dist/server.js` as Codex starts it for each
T3 Code thread. "The watcher" is the same file started with `--watcher`: one
process, started by the server, that runs every thread's watches. Both hold
the Events client that every form shares, in [`../core`](../core).

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". This form does
that in two parts:

- What the server sent (the payload) reaches the agent only as a tool result,
  when it reads it with `get_event` or `recent_events`.
- The message that wakes a thread isn't a tool result. It's sent into the
  thread with `t3 thread send`, T3 Code's own command for messaging a thread
  from the machine it runs on, and T3 Code shows it as a message in the
  thread. So it carries no event content: it says which watch has new events,
  how many and their ids, names the server and the event type, and repeats the
  watch's note. Its first line says it was sent by the mcp-events polyfill
  through T3 Code, not typed by the user.

Receiving an event gives the agent no permission it didn't already have. The
turn a wake starts runs in the thread's own permission mode, and what the
agent does goes through that mode's approvals. This form adds no policy of its
own on top, and never answers an approval.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle thread. In a thread whose mode approves
actions without asking (**Full access**), an event from a server can lead to
actions without a prompt, as a tool result from the same server could. How
often is bounded (below), not prevented. In a fresh install of T3 Code
0.1.11, a thread started with `t3 thread start` runs in the project's default
mode, which is Full access: check the mode of a thread you leave watching.

T3 Code shows the wake as a message in the thread, as it shows anything sent
with `t3 thread send`. What it hands the agent starts with a line of T3
Code's own saying the message "came through T3 Code's tools, not from the user
typing in this chat", then the polyfill's own first line. Those lines, and the
instructions given to the model, are what tell it apart from what you typed.

## What it does

- **What a server sent is read as a tool result.** The wake message carries no
  payload text. `get_event` returns a payload in full and `recent_events` a
  few short fields of each event (flattened, quoted, cut short). Both are tool
  results from that server. `MCP_EVENTS_WAKE_VALUES=1` puts those few fields
  into the wake message; that's yours to choose, and it puts text a server
  wrote into the thread.
- **Events wake a thread only so often.** A watch can start a wake at most once
  a minute. A thread is woken at most 30 times in an hour. Past that, it's told
  once that events are waiting, and isn't woken again for an hour. Nothing is
  dropped. `MCP_EVENTS_WAKE_GAP_S` and `MCP_EVENTS_WAKES_PER_HOUR` change the
  numbers. The count is kept on disk, and each wake is recorded before
  `t3 thread send` runs, so a wake the watcher never heard back about still
  counts and its events aren't handed over again.
  - Unlike the Codex form, the pause doesn't end early when you write: T3 Code
    gives an MCP server no way to tell your turns from a wake's, so a woken
    turn can't lift the cap, and neither can you, until the hour is up.
- **A watch belongs to one thread.** The thread is the one T3 Code names in
  `T3CODE_THREAD_ID`, in the environment of the server Codex starts for that
  thread. The model can't set it. Only an id in T3 Code's own form (letters,
  digits, `:`, `_`, `.`, `-`, not starting with `-`) is accepted. Another
  thread's calls see none of its watches or events.
- **`t3 thread send` is run without a shell.** Its arguments are fixed
  (`thread send --json <thread> -`); the message goes on its standard input,
  never on its command line. None of this form's settings, and not the thread
  id the watcher was started from, are in its environment. What T3 Code prints
  isn't repeated, only what it means (sent; not running, tried again later; no
  such thread, not tried again).
  - **On macOS and Linux** that is `MCP_EVENTS_T3_BIN` if set (a full path),
    else the first `t3` on PATH, else `~/.local/bin/t3`, where T3 Code's own
    installer puts it. It's started directly.
  - **On Windows** (not checked) only `t3.exe`, or Node with the package's
    `dist/bin.mjs`, is run, never a `.cmd` or `.bat`.
- **Watch changes follow the thread's permission mode.** In T3 Code 0.1.13,
  **Supervised** shows approval for `watch_event` and `unwatch_event`.
  **Full access** accepts those Codex prompts automatically. The four tools
  that only read are marked read-only.
- **It connects only where Codex does, and with only what Codex would use.**
  The watcher reads `[mcp_servers.*]` from `$CODEX_HOME/config.toml` with the
  Codex form's reader, so the same rules hold: a server with `enabled = false`
  stays off; a server that signs in through Codex (`codex mcp login`, OAuth,
  `auth = "chatgpt"`) is left alone; where an organisation manages Codex, it
  connects to none; credentials come only from the server's own
  configuration. Its own entry is skipped.
  - **It never reads stored credentials**: not Codex's, not T3 Code's. It runs
    `t3 thread send`, and T3 Code's own command signs itself in to its own
    server.
- **Everything else is in its own words.** A server's or the relay's error text
  is never repeated. Tokens from your configuration, webhook secrets and
  addresses, and the relay's keys are removed from every tool result, from the
  wake messages and from the log.
- **It sends `events/*` only to a server that advertised events**, as the
  extension defines. By default it also accepts the form from before the
  standard; `MCP_EVENTS_PRE_STANDARD=off` refuses that.
- **Webhooks are verified by the watcher**, through the same relay and client
  as the other forms ([the Codex form's SECURITY.md](../codex/SECURITY.md)
  has the details).

## The watcher, and its socket

The watcher is the part that differs most from the other forms. It exists
because T3 Code closes a thread's agent session when the thread has been idle,
and the servers Codex started for it end with it.

- **It outlives T3 Code's agent sessions, and T3 Code itself.** It's started
  detached, in its own process group. It keeps running the watches, and so
  keeps connecting to your servers with the credentials in your configuration,
  while T3 Code is closed. It ends by itself when no thread has a watch and
  nothing has asked for a minute, and `node plugin/dist/server.js --stop` ends
  it at once. A restart of your machine ends it; the next call starts it again,
  and it resumes every saved watch.
- **The server and the watcher talk over a local socket.** On macOS and Linux
  it's `watcher.sock` in the state folder, or, when that path is too long for a
  socket, a folder of your own in the temporary directory (made `0700`, and
  refused if it belongs to someone else or others can enter it). On Windows
  (not checked) it's a named pipe.
- **Any process of yours can ask the watcher anything**, for any thread:
  set or stop a watch, read a thread's events. It can already do more than
  that: T3 Code lets the machine's own user message any thread with
  `t3 thread send`, with no sign-in. Nobody else can reach the socket.
- **It listens on nothing else**, unless a webhook watch uses
  `MCP_EVENTS_PUBLIC_URL` (a receiver on 127.0.0.1 for your own forwarder). It
  downloads nothing.

## What is stored

Everything is in `$CODEX_HOME/mcp-events-t3/` (or `MCP_EVENTS_STATE`),
readable only by you:

- each thread's watches, with their cursors and webhook secrets
  (`threads/<thread>/`);
- each thread's events (`sessions/<thread>/`), removed two weeks after the last
  one;
- the servers found to have no events, for a day;
- a log, with secrets taken out.

## What it does not protect against

- **A server you configured that sends misleading events.** They are its data,
  and the agent may act on them within the thread's permission mode.
- **Someone who can run programs as you**, who can talk to the watcher, as they
  can run `t3 thread send`.
- **Someone who can read your files.** The state folder holds webhook secrets
  and payloads.
- **A relay operator reading webhook payloads**, or delaying or dropping them,
  as with the other forms.

## Reporting a vulnerability

Report it privately, through this repository's **Security → Report a
vulnerability** form on GitHub, not in a public issue. Name `mcp-events` for
T3 Code.
