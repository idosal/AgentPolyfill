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
  frame from another site inside it, also while the page keeps changing and
  is captured all the time; its own Claude domain, not another
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
- `MCP_SDK_V2=<folder> node revision-check.mjs`: the MCP revision the
  helper speaks (issue #5), against servers built on the TypeScript SDK:
  2.4.0 serving 2026-07-28 only (`legacy: "reject"`), 2.4.0 serving both
  revisions, and 1.x serving the 2025 ones. Each gets `/discover`, a view
  opened and drawn, and an app-only call from the view, and the check reads
  what each server received: no `initialize` and 2026-07-28 on every request
  for the first two, `initialize` at 2025-11-25 for the third. It also
  checks the "Structured results from text" setting (issue #6): on for one
  server, off for another. `<folder>`
  holds the 2.4.0 SDK (`npm install --prefix <folder>
  @modelcontextprotocol/server@2.4.0 zod@4.6.7`). It needs the Rust helper
  (`MCP_APPS_CLI_HELPER`): the Node one speaks only the 2025 revisions.

Every check here runs the Node helper by default, and the binary
`MCP_APPS_CLI_HELPER` names instead: the Rust helper
(`../mod/helper/bin/<os>-<arch>/mcp-apps-cli-helper`).
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
- `node change-check.mjs`: an app redrawing a canvas from a timer once a
  second (no DOM change, no animation frame), each time in a colour of its
  own; each redraw must become a picture of its own, in its colour. With the
  3 s full capture alone, most redraws would never be shown. It prints each
  redraw's delay to its picture.
- `SOAK_MIN=60 node soak-check.mjs`: three views that never stop (the 3D
  scene, live stats, a hover sweep) for an hour, memory sampled every 30 s;
  it passes when memory levels off and every view keeps drawing.
- `MAXROWS=36 node resize-check.mjs 12`: the cohort view opened at 100
  columns and resized to 137, as the mod does; each picture whole (header's
  right end drawn, bottom not left grey).
- `OPEN_COLS=100 COLORTERM=truecolor node cells-update-check.mjs 8`: the
  same in cells, then Period switched to Weekly; the "Dec 2025" row stays
  whole.

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
