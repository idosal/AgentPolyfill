# mcp-apps-cli bench

Scripts behind the timings in [the README](../README.md): they drive a real
`claude` with the plugin in a pseudo-terminal, or the plugin's helper on its
own, and measure what reaches the terminal. Run them on your machine; they
need `claude` on PATH, Chrome, Node 22+, Python 3 with `pyte`
(`pip install pyte`), and the helper's packages (`npm install` in
`../mod/helper`).

## The example servers

The example servers are the ones in the MCP Apps SDK repository. In a
checkout of [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps),
after `npm install` and `npm run build:all`, each in its own terminal:

```bash
PORT=3212 node examples/cohort-heatmap-server/dist/index.js
```

```bash
PORT=3202 node examples/threejs-server/dist/index.js
```

```bash
PORT=3203 node examples/system-monitor-server/dist/index.js
```

```bash
PORT=3205 node examples/basic-server-vanillajs/dist/index.js
```

`mcp-examples.json` points at these ports.

## A real Claude Code session: `session.py`

```bash
python3 session.py /tmp/bench scenarios/iterm-redraw.json
```

```bash
python3 bursts.py /tmp/bench/iterm-redraw.cast
```

`session.py` starts `claude` with this plugin in a pseudo-terminal that
answers as iTerm2 3.5, kitty 0.50 or Ghostty 1.4 (the scenario's
`terminal`), types each step's prompt, waits for its `expect` text and holds
for `hold` seconds. It writes the cast (all output, timestamped), a text
snapshot of the screen after each step and, with `"debug": true`, Claude
Code's debug log. The session starts in this polyfill's folder
(`polyfills/apps/claude-code`, the parent of `bench/`), or the folder a
scenario's `cwd` names (relative to the scenario file); Claude Code asks whether to trust a folder
the first time it runs there, so run `claude` in it once yourself before the
first scenario. It sends the model's prompts for real, so it uses your
Claude Code account, and your Claude Code settings: a step that changes one
(`/theme`, `/config`) changes it for you, so none of these do.

`bursts.py` lists the pictures in a cast: for iTerm2, each burst of inline
images with its size, how long Claude Code took to write it, and the PNG
colour types (3 is 256 colours); for kitty and Ghostty, the count of
graphics commands.

| Scenario | What it shows | On the reference machine |
| --- | --- | --- |
| `iterm-redraw.json` | The cohort view, then a four-line reply under it: each streamed line moves the view, and Claude Code writes its picture again | each redraw 89 KB over 0.15 s (224 KB over 0.38 s in full colour) |
| `kitty-redraw.json` | The same as kitty, which reads pictures from files | short graphics commands, no picture bytes |
| `open-iterm.json`, `open-cells.json` | One prompt, the cohort view opening, as iTerm2 and as a plain terminal | picture whole and kept (`shown.py`), legend drawn |
| `iterm-drag.json` | The bloom scene at the page's pixel ratio, dragged for 3 s at 18 moves a second (`drag_view`), cell coordinates as iTerm2 sends | 10.7 pictures a second reach the terminal while dragging |
| `stream-3d.json` | A three.js scene Claude writes, its tool allowed outright; then a click into the view, ctrl+] and a key | the view opens as Claude starts the call, 53 partial copies of the arguments over 6 s, then the whole 2,276 characters and the result; ctrl+] reaches the app as Escape |
| `input-keys.json` | The vanilla example in cells: a double click into its text field, then ctrl+a, space, é, an emoji, shift+tab and F5 | the second press a double click; each key arrives as named; F5 pressed as F5, not typed |
| `stream-3d-auto.json` | The same in auto mode, the tool not allowed outright: auto mode's classifier decides | the view opens as Claude starts the call, no arguments until the classifier allows it 7 s later, then all of them |
| `doom.json` | DOOM through the arcade example server (`mcp-arcade.example.json`, port 3301): power button, sound card, menus, a held arrow, three clicks, then ctrl+] | in game, walked, ammo 50 → 48, status bar whole; ctrl+] opens DOOM's menu |

## Checks

Each prints what it found and exits 1 on a failure; the example servers above
must be up for the last two.

- `node store-check.mjs`: view stores. The same view keeps its localStorage
  and IndexedDB when opened again and after the helper restarts (even one
  ended outright); another view of the same app has its own; one file per
  view, readable by the person only; a request without the helper's token
  is refused. `MCP_APPS_CLI_TRANSPORT=tcp` runs it over the Windows
  connection.
- `node host-check.mjs`: what the host page tells an app (arguments while
  Claude writes them, then whole; a theme change; a picture's alt text from
  the app's accessibility tree) and what a view may reach (no WebRTC; not
  another server on this machine its CSP names, but its own; nothing sent
  away by a form or by navigating; double clicks, emoji and text, unknown
  key sequences dropped; clicks in a tall view scrolled down, and in a
  frame from another site inside it; its own Claude domain, not another
  server's; out of sight, its page paused, a frame from another site in it
  too, while it still answers a request, and running again when back), and
  what happens when an app's page crashes, Chrome stops, or
  no view is open for a while (`MCP_APPS_CLI_CHROME_IDLE_S`). Then the first
  view's time, Chrome cold
  and started ahead (`RUNS`, 3; needs the cohort example). On the reference
  machine: 0.9 s cold, Chrome starts in 0.25–0.3 s, 0.65 s after that.
- `node contract-check.mjs`: the helper's contract with no view: the ready
  line, the token (socket and TCP), `/ping`, `/discover` against a small MCP
  server (UI, app-only and structured tools) over streamable HTTP, the older
  SSE transport and stdio, Chrome started, closed when idle and started
  again after it was killed, and the helper leaving on SIGTERM with its
  socket and folder gone; then the helper's own memory.

Every check here runs the Node helper by default, and the binary
`MCP_APPS_CLI_HELPER` names instead: the Rust helper
(`../mod/helper/bin/<os>-<arch>/mcp-apps-cli-helper`). Real sessions (`session.py`) run whichever helper
the plugin picks, the Rust one where it carries a binary; set
`MCP_APPS_CLI_HELPER=node` to compare.
- `node leak-check.mjs`: a helper ended outright, with views open, leaves no
  Chrome running, and the next helper removes its profile.
- `host-check.mjs` also checks that a view of a server elsewhere doesn't reach
  this machine. It serves its test server as `localtest.me`, a public name
  that resolves here, and skips this case without DNS. It also checks that
  frames an app makes get no WebRTC, and that a hung app is closed.
- `node smoke-check.mjs`: a helper's essentials with nothing but Node and
  Chrome (no `ps` or `pgrep`), so CI runs it on Windows too: ready line and
  token, `/discover`, Chrome, a view's first frame, and no Chrome left once
  the helper is ended outright.
- `node change-check.mjs`: an app redrawing a canvas from a timer (no DOM
  change, no animation frame); each redraw must become a picture within
  600 ms (about 50 ms in practice: the page tells the helper). Before the
  helpers counted canvas draws, a redraw showed only at the 3 s capture.
- `SOAK_MIN=60 node soak-check.mjs`: three views that never stop (the 3D
  scene, live stats, a hover sweep) for an hour, memory sampled every 30 s;
  it passes when memory levels off and every view keeps drawing.
- `MAXROWS=36 node resize-check.mjs 12`: the cohort view opened at 100
  columns and resized to 137, as the mod does; each picture whole (header's
  right end drawn, bottom not left grey).
- `OPEN_COLS=100 COLORTERM=truecolor node cells-update-check.mjs 8`: the
  same in cells, then Period switched to Weekly; the "Dec 2025" row stays
  whole.

`shown.py` replays a cast with each inline image's cells marked and tells
how many are still on screen just before the session exits: an image that
text or an erase wrote over is gone in iTerm2 too.

## The helper alone: `helper-driver.mjs`

```bash
node helper-driver.mjs <seconds> <port> <server> <tool> [input.json] [image|cells]
```

It calls the tool itself, opens its view in the helper (no Claude Code),
answers the helper's requests, and prints each picture's time and size,
pictures a second, and CPU of the helper and its Chrome. Environment:

- `DRIVER_TERM=iTerm.app|ghostty|kitty`: which terminal the helper draws for
  (iTerm2 gets inline 256-colour strips; kitty and Ghostty files).
- `HOVER=1 HOPS=1`: six hops of the pointer between heatmap cells, with the
  time from each move to its picture.
- `HOVER=1 SWEEP=1`: a long pointer sweep.
- `DRAG=1`: a 4 s drag (OrbitControls in a 3D scene); `DRAG_HZ` moves a
  second (20), `DRAG_FINE=0` whole cells only (a terminal without pixel
  mouse reports).
- `PAUSE=1`: in sight, out of sight, and back, with CPU for each.
- `MCP_APPS_CLI_PALETTE=0`, `MCP_APPS_CLI_STRIPS=0` and the other settings
  in the README pass through to the helper.

| Run | On the reference machine |
| --- | --- |
| `DRIVER_TERM=iTerm.app HOVER=1 HOPS=1 node helper-driver.mjs 20` (cohort) | hops 145–166 ms, 41 KB a picture |
| `DRAG=1 DRIVER_TERM=iTerm.app node helper-driver.mjs 5 3202 studio3d show_threejs_scene scenarios/bloom-scene.json` | 11–12 pictures a second, the drag on time (4.3 s) |
| the same with `DRIVER_TERM=ghostty` | about 16 pictures a second |
| `PAUSE=1 DRIVER_TERM=ghostty node helper-driver.mjs 6 3202 studio3d show_threejs_scene scenarios/bloom-scene.json` | 38% CPU in sight, 0% paused, about 90 pictures in 6 s on return |

The numbers are for comparing before and after a change on one machine, not
across machines.
