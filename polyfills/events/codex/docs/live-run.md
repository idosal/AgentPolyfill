# A live run in Codex

24 November 2026, macOS, Codex CLI 0.172.0, this plugin at 0.1.0. One Codex
session in a scratch folder, with a read-only sandbox, sets a watch on the
demo button of [`servers/event-feeds`](../../../../servers/event-feeds) (the
hosted copy, `https://event-feeds.idosalomon.workers.dev/mcp`) and goes idle.
The button is pressed with a message. The idle session wakes by itself,
reads the event, and answers.

## How it was set up

Nothing was added to `~/.codex/config.toml` for the run: the helper and the
feeds server were given to a Codex app server of its own, as one-off `-c`
overrides on that process, and the TUI attached to it, as `codex --remote`
does. The helper's `MCP_EVENTS_CODEX_REMOTE` sends its wake to the same
server.

```bash
codex app-server --listen ws://127.0.0.1:47811 \
  -c check_for_update_on_startup=false -c 'model_reasoning_effort="low"' --disable multi_agent \
  -c 'mcp_servers.feeds.url="https://event-feeds.idosalomon.workers.dev/mcp"' \
  -c 'mcp_servers.mcp-events.command="node"' \
  -c 'mcp_servers.mcp-events.args=["…/polyfills/events/codex/plugin/dist/helper.js"]' \
  -c 'mcp_servers.mcp-events.env.MCP_EVENTS_STATE="…/state"' \
  -c 'mcp_servers.mcp-events.env.MCP_EVENTS_CONFIG="…/servers.toml"' \
  -c 'mcp_servers.mcp-events.env.MCP_EVENTS_CODEX_REMOTE="ws://127.0.0.1:47811"'

cd <scratch folder>
codex --remote ws://127.0.0.1:47811 --sandbox read-only -c check_for_update_on_startup=false
```

`servers.toml` named the same feeds server for the helper
(`[mcp_servers.feeds] url = "…"`). The TUI was driven in a pseudo-terminal
by `polyfills/events/claude-code/tools/pty-drive.py`, and the button was
pressed with `POST /api/press`, as its page does. The same plugin folder,
installed with `codex plugin marketplace add` and `codex plugin add
mcp-events@agent-polyfill` into a throwaway `CODEX_HOME`, was started by
Codex and listed its six tools (`mcpServerStatus/list`).

## The session

The prompt, typed in the TUI:

> Use the feeds server's new_demo_button tool to make me a demo button, then
> watch its demo.button event with the mcp-events watch_event tool, with a
> note saying: tell me in one line what I typed. Then give me the watch id and
> stop; do not open the page.

The screen at the end (the start banner left out):

```
› Use the feeds server's new_demo_button tool to make me a demo button, then watch its demo.button event with the mcp-events watch_event tool, with a
  note saying: tell me in one line what I typed. Then give me the watch id and stop; do not open the page.
• I'll create the demo button and watch its event with your note, without opening the page.
• Called feeds.new_demo_button
  └ Button page: https://event-feeds.idosalomon.workers.dev/b/bWQH8RGR2racGawWlag0p3YCisR7ULe
    Channel: bWQH8RGR2racGawWlag0p3YCisR7ULe
    Watch it with the demo.button event, arguments {"channel": "bWQH8RGR2racGawWlag0p3YCisR7ULe"}, then ask the user to open the page and press the b…
• Called mcp-events.watch_event
  └ Watching feeds / demo.button {"channel":"bWQH8RGR2racGawWlag0p3YCisR7ULe"} as w-7b51b7, by poll, from now on. New events will be announced in a m…
• Watch ID: w-7b51b7
  Demo button (https://event-feeds.idosalomon.workers.dev/b/bWQH8RGR2racGawWlag0p3YCisR7ULe)
  Note: "tell me in one line what I typed"
  Page not opened.
  Worked for 17s • 16:55
› [mcp-events] (Sent by the mcp-events plugin, not typed by the user.)
  [mcp-events] feeds · demo.button: 1 new event [event e1; watch w-7b51b7; get_event e1 returns it]. Note saved with this watch: "tell me in one line
  what I typed".
• Called mcp-events.get_event
  └     "pressedAt": "2026-11-24T14:56:01Z"
      }
    }
• Called feeds.read_event_text
  └  "message": "blue pelican 42",
     "pressedAt": "2026-11-24T14:56:01Z"
    }
• You typed: "blue pelican 42".
  Worked for 11s • 16:56
```

The second `›` turn was not typed: `codex queue` put it in the session, and
the session, idle, started a turn with it. The wake message names the
server, the event type and the ids, and nothing the server wrote; Codex read
the event with `get_event`, then the press's message with the feeds server's
own tool, as the event told it to.

## Timings (UTC)

| | |
|---|---|
| 14:55:45.4 | `watch_event` from session `01a20e0e…` (the helper's log: "turn started by user") |
| 14:56:01.2 | the button pressed (`{"ok":true,"press":1}`) |
| 14:56:02.6 | the event stored (the watch's `lastEventAt`), then handed to `codex queue` a second later |
| 14:56:09.5 | `get_event` from the same session ("turn started by queue") |

Eight seconds from the press to Codex reading the event, poll interval
included.

## The same session, resumed

The TUI was closed, and the app server unloaded the session a minute later;
the helper ended with it. Seven minutes on, the session was resumed
(`codex --remote … resume 01a20e0e-…`):

- Asked "What are you watching?", Codex answered from the conversation and
  called no tool. Codex 0.172 does not start a resumed session's MCP
  servers until one of their tools is called, so the watch stayed asleep.
- Asked "Check my watches with the mcp-events list_watches tool.", Codex
  called it; the helper started, and its log says `runs 1 watch(es)`. The
  button was pressed again ("green heron 7"); six seconds later the session
  was woken with `[event e2; watch w-7b51b7; …]`, read it, and answered
  "You typed: "green heron 7"."

| | |
|---|---|
| 15:03:24.0 | helper started; `list_watches` from session `01a20e0e…` ("turn started by user"); the watch resumes from its saved cursor |
| 15:03:32.7 | the button pressed again |
| 15:03:38.0 | `get_event` ("turn started by queue") |

## What the run showed about Codex

- Codex starts the plugin's server as a child of the app server that runs the
  session (here the private one; normally the app-server daemon the TUI
  starts), not of the TUI. It started with the session.
- Every `tools/call` carried `_meta.threadId`, and the turn metadata said what
  started the turn: `user` for the prompt typed in the TUI, `queue` for the
  wake.
- After the TUI was closed, the helper kept running until the app server
  unloaded the session, about a minute later (61 and 70 seconds in two runs),
  and then ended when its standard input closed.
- A resumed session's MCP servers start at the first call of one of their
  tools, not when the session opens.
- Codex did not ask before `watch_event` in this session: its configuration
  has `approvals_reviewer = "auto_review"`, which reviewed the call itself.
  The reading tools are marked read-only, which Codex runs without asking.
