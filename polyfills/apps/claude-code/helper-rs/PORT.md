# Porting the helper to Rust

The helper (`mod/helper/*.mjs`, Node and Playwright) runs headless Chrome,
hosts each app view, and draws it as pictures or cells. With three picture
views it takes about 430 MB of its own, beside Chrome's 1 GB: about 140 MB is
two V8 heaps (the main one and the strips worker's), the rest native memory
left by short-lived picture buffers. A Rust helper should stay under about
80 MB, encode pictures faster, and need no `npm install` (nor Node) on the
person's machine.

What stays as it is: the mod (`mod/hooks/*.tsx`, Claude Code's plugin API is
JavaScript), the host page (`mod/helper/host/host.ts`, it runs in Chrome),
and Chrome. The port replaces one process, behind a protocol the mod and the
bench checks already speak, so the checks in `bench/` are its acceptance
tests: they run whatever `MCP_APPS_CLI_HELPER` names.

## The contract

### Started as

`<helper> [--mcp-config <file|json> ...] [--cwd <dir>]`, by the mod (the
binary it carries for the machine). Environment: the person's, plus
`CLAUDE_PLUGIN_DATA`.

### stdout: one JSON object a line

| `type` | Fields | When |
|---|---|---|
| `ready` | `socket` (Unix) or `url` (TCP), `token`, `pid`, `images`, `swapEveryDraw`, `truecolor`, `env` (`CLAUDE_CODE_NO_FLICKER`, `MCP_APPS_CLI_SLEEP_S`, `TMUX`: a hook sees only the session's own variables) | listening |
| `frame` | `viewId`, `gen`, `v`, and `frame` (`cols`, `rows`, `cells` base64 u32 triples, or `styled` runs; `scroll`) or `image` (`png` or `file`, `strips` + `stripCount`, `cols`, `rows`, `scroll`, `generation`) | a new picture |
| `request` | `id`, `viewId`, `gen`, `method`, `params` | the mod must answer (`/reply`, naming `gen`): `tools/call`, `ui/allow-tool` (with `appOnly`), `ui/allow-read`, `ui/message`, `ui/open-link`, `ui/allow-download`, `ui/request-display-mode`. A yes to `ui/allow-tool` or `ui/allow-read` carries its `epoch` |
| `check` | `id`, `server` | before each request the helper writes to a server: the mod answers (`/reply`) `{ allow: true, epoch }` on Claude Code's yes asked then, or `{ allow: false }` (0.1.3) |
| `busy` | `server`, `busy` | the helper starts (`true`) or stops (`false`) waiting on a server: the mod asks Claude Code again meanwhile (0.1.3) |
| `notify` | `viewId`, `gen`, `method`, `params` | `ui/update-model-context`, `log`, `ui/copy`, `ui/downloaded`, `ui/app-modes` |
| `describe` | `viewId`, `gen`, `text`, `title` | alt text for a picture view; the app page's title, any view |
| `closed` | `viewId`, `gen`, `reason` | Chrome stopped, or the app's page crashed |

`gen` is the generation of the open the page is for (0.1.3): the mod's
nonce from `/open`. The mod acts only on what names its view's own; every
route below that names a `viewId` names it too, and the helper refuses one
for another generation (a `/close` of another closes nothing).
| `status` / `fatal` / `log` | `text` | status line, toast, debug log |

### Requests: HTTP POST, JSON body, header `x-mcp-apps-cli-token`

Over a Unix socket (mode 0600) or, on Windows and with
`MCP_APPS_CLI_TRANSPORT=tcp`, loopback TCP. Without the token: 403.

| Route | Body | Does |
|---|---|---|
| `/ping` | | `{ ok, views, rowHeights }` |
| `/discover` | `server`, `refresh` | tools with UI, app-only tools, structured tools, definitions |
| `/browser` | | whether app views have a browser: `{ ok, found, path }`, or `{ ok, found: false, error, fetchable }` |
| `/fetch-browser` | | only on the person's yes (the mod asks): fetches Chrome for Testing's current Stable headless shell into the plugin's data folder: `{ ok, path, version }` |
| `/activity` | `viewId` | the view's own network: `{ ok, sockets, inflight, quietMs }`, for resting a view that reaches other sites |
| `/prewarm` | `server`, `tool`, `theme` (each optional) | starts Chrome; given the theme, keeps a tab ready for the next view of that server (see below), and given the tool, reads its UI resource ahead |
| `/open` | `viewId`, `gen`, `server`, `toolName`, `toolInput`, `streaming`, `partialInput`, `toolResult`, `cols`, `maxRows`, `theme`, `mode`, `userAgent` | opens a view: `{ ok, mode, domains }` |
| `/args` | `viewId`, `arguments`, `partial` | tool-input-partial, then tool-input |
| `/result`, `/cancel` | `viewId`, `result` / `reason` | tool-result, tool-cancelled |
| `/input` | `viewId`, `event` (pointer, key, wheel) | clicks, keys, wheel |
| `/resize` | `viewId`, `cols`, `maxRows`, `display` | new size or display mode |
| `/shown` | `viewId`, `shown` | in or out of sight (paused) |
| `/theme` | `viewId`, `theme` | host-context-changed |
| `/reply` | `id`, `gen`, `result` or `error` | answers a `request` (refused for another generation than the page that asked), or a `check` |
| `/revoke` | `server`, `epoch` | Claude Code stopped using the server: what is in flight to it fails, its connection closes, a view of it still opening fails, a yes older than `epoch` is refused: `{ ok, revoked }` (0.1.3) |
| `/refresh`, `/inline-png` | `viewId` | send the picture again; PNG bytes instead of a file |
| `/mode` | `viewId`, `mode` | cells instead of pictures |
| `/close` | `viewId`, `discard` | teardown, store saved (or dropped) |
| `/locate` | `text` | debug only: where an element is, in cells |

### Settings

`MCP_APPS_CLI_*`: `MODE`, `STRIPS`, `PALETTE`, `TRUECOLOR`, `SEXTANTS`,
`CELL_ASPECT`, `SNAP`, `GROUP`, `PAINTS`, `IMAGE_FILES`, `RESOURCE_CACHE`, `STORAGE_DIR`, `TRANSPORT`,
`CHROME`, `CHROME_ARGS`, `CHROME_IDLE_S`, `NO_SANDBOX`, `DEBUG`,
`SOCKET_FILE`, `DUMP`; and the terminal's own (`TERM_PROGRAM`,
`KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `TMUX`, `COLORTERM`,
`COLORFGBG`, `SSH_*`).

### Host page

`host/host.js` (built from `host.ts`) is served as it is. The helper calls
`__openView`, `__toolArgs`, `__toolResult`, `__toolCancelled`,
`__setContainer`, `__setShown`, `__setTheme`, `__teardown`; the page calls
the binding `__cliHost(kind, payload)` with `size`, `initialized`, `log`,
`copy`, `tools/call`, `resources/read|list|templates/list`, `ui/message`,
`ui/open-link`, `ui/download-file`, `ui/request-display-mode`,
`ui/update-model-context`. The init scripts (canvas text, change and store
hooks, no WebRTC, instant transitions, clipboard) move to `helper/js/` so
both helpers read the same files.

## What Playwright gives today, and its replacement

Chrome is driven over CDP on `--remote-debugging-pipe` (fds 3 and 4, NUL
separated JSON): no WebSocket, no Playwright.

| Today | In Rust |
|---|---|
| `chromium.launch` (installed Chrome, flags, sandbox, temp profile) | find Chrome per platform, same flags, own profile folder |
| a context per view, `newPage` | `Target.createBrowserContext`, `Target.createTarget`, flat sessions |
| `page.route` / `fulfill` / `abort` | `Fetch.enable` with patterns, `Fetch.fulfillRequest` / `failRequest` |
| `exposeBinding` (host page only) | `Runtime.addBinding` + `Runtime.bindingCalled`, checked against the main frame's context |
| `addInitScript` | `Page.addScriptToEvaluateOnNewDocument` (all frames) |
| `evaluate` in the app's frame | `Runtime.evaluate` in the frame's execution context |
| `screenshot` with clip, `captureBeyondViewport` | `Page.captureScreenshot` |
| `mouse`, `keyboard`, `insertText` | `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` |
| `storageState({ indexedDB })` | cookies over CDP; localStorage and IndexedDB read and written by a script in the app's origin |
| `ariaSnapshot` | `Accessibility.getFullAXTree`, to the same short text |
| `page.on("crash")`, `disconnected` | `Inspector.targetCrashed`, the pipe closing |
| MCP SDK client (HTTP, SSE, stdio) | `rmcp`, the official Rust SDK; SSE, which rmcp no longer has, in `src/sse.rs` |
| strips worker, quantize, PNG | `crates/pictures` (blocking threads, `flate2`) |
| `render.mjs` (cells) | `crates/render`, ported as is, with its tests |

## Status

All eight milestones are done (2026-11-18). Since 2026-11-20 the plugin runs
only the Rust helper: the packaged plugin carries a binary for each
platform (`mod/helper/bin/<os>-<arch>/`; `helperArgv` in
`mod/hooks/helper.ts` picks this machine's). There is no Node fallback, no
download and no package install: a machine with no binary, or whose binary
can't start, gets one toast saying why, and no views. The bench checks
still run whatever `MCP_APPS_CLI_HELPER` names.

| Milestone | State |
|---|---|
| 1. Skeleton | done |
| 2. Picture views | done |
| 3. Input and visibility | done |
| 4. Host calls and consent | done |
| 5. Stores | done (both transports) |
| 6. iTerm2 strips and palette | done: `crates/pictures` |
| 7. Cells | done: `crates/render`, 320 fixture frames byte-identical to `render.mjs` |
| 8. Platforms and the switch | macOS (arm64, x64) bundled and default. Windows written, compiles, untested. Linux builds where a Linux toolchain is |

### Acceptance (Rust binary from `build-into-plugin.sh --mac`)

| Check | Rust helper |
|---|---|
| `contract-check.mjs` (now also discovers over SSE and stdio, and sends 64 concurrent 200 KB requests) | all pass, Node too |
| `smoke-check.mjs`, `change-check.mjs`; `host-check.mjs` now 28 checks (hung app, nested-frame WebRTC, a non-local server, workers paused) | all pass, Node too |
| `soak-check.mjs`, 10 min: three views never still (3D, live stats, hover) | helper flat after warm-up (23 MB under that load, +2 MB); Chrome +57 MB at ~16 pictures a second per view; every view drawing in every 30 s window |
| `host-check.mjs` | 25/25; 10 repeated runs clean |
| `store-check.mjs`, socket and `MCP_APPS_CLI_TRANSPORT=tcp` | 10/10 each |
| `leak-check.mjs` (helper killed outright with views open) | passes: no Chrome left |
| `resize-check.mjs` (`MAXROWS=36`, 12 views), `cells-update-check.mjs` (truecolor, 8 views) | 0/12 bad; 0/8 garbled in each of three runs |
| the darwin-x64 binary under Rosetta, `contract-check.mjs` | all pass |
| `cargo test --workspace` | all pass, fuzz-style tests of every parser among them (the render parity test needs its fixtures made first; see `crates/render/README.md`) |

Real `claude` sessions (`bench/session.py`), the Rust helper confirmed in
each one's debug log (`open-iterm` and `doom` again on the final binary):
- `open-iterm`: 60 pictures, every cell still on screen (`shown.py`).
- `open-cells`: the same cell layout as the Node helper's, line for line.
- `stream-3d-auto`, `system-poll`, `kitty-redraw`: one file placement for
  kitty, updated in place.
- `input-keys`: the field reads what the Node helper's does.
- `doom`: in game; ammo 50 → 48 after three clicks; status bar whole;
  ctrl+] opens the game's menu.

### Gains, against the Node helper on the same machine (M-series Mac)

The helper's own physical footprint (`vmmap`; ps RSS counts memory macOS
can take back):

| | Node | Rust |
|---|---|---|
| Idle, and with Chrome started | 161–165 MB | 9–13 MB |
| Three picture views (iTerm2 strips) | 229–240 MB, 33–36% CPU | 42 MB, 10–13% CPU |
| The same, out of sight 9 s | 252 MB | 16 MB |
| Three cell views | 204 MB, 24% CPU | 46 MB, 6% CPU |
| First picture of a view (`host-check.mjs`): Chrome cold, Chrome started ahead | 0.9 s, 0.65 s | 0.76 s, 0.27 s |
| Dragging in a view: Ghostty, iTerm2 strips | 50%, 112% CPU | 40%, 69% CPU (same 18 fps) |
| On disk | Node, plus about 40 MB of packages installed on first run | an 8.2 MB binary (x64: 9.8 MB) |

What brought it there:
- Strip state keeps a 128-bit hash per band, not the last frame's pixels.
- Freed buffers go back to the system once the helper has been quiet for
  4 s (`malloc_zone_pressure_relief`, `malloc_trim`).
- Events fan out without loss.
- Resources and host pages are shared between views.

Chrome is the same in both, about 480 MB with three views:
- browser 96 MB, GPU 105 MB;
- a renderer per app, 60–90 MB each, plus 12 MB for the host pages.

Tried with no gain: `--in-process-gpu` (500 MB), `--disable-gpu` (494 MB),
and a memory-pressure notice to every process when quiet (445 → 442 MB). Site
isolation stays on, which is what keeps one renderer per app.

Measured with `footprint` (physical memory; summed RSS counts shared pages
in every process), one view of the cohort app comes to about 285 MB:
- the helper, 10 MB;
- Chrome's browser process, 70 MB, and its GPU process, 71 MB;
- the app's renderer, 102 MB, and the host page's, 12 MB;
- the network and storage services, 17 MB.

`--disable-gpu` would save 28 MB, but the 3D scene drops from 26.7 to 6.7
pictures a second, at 532% CPU.

**A tab kept ready** (since 2026-11-19). While Chrome runs, the helper keeps
one tab made ahead for the next view: its own context, set up, the host page
loaded, for the theme, mode and network reach of the last view (or of the
view /prewarm says is coming). A view that fits takes it and skips the
tab's making and the host page, about 140 ms of a 340 ms open; the next one
is made while the view settles. A view with saved storage, clipboard
access, another theme or another origin makes its own, as does one whose
kept tab died (its renderer crashed). It never keeps Chrome running nor
starts it. Measured:
- **Helper alone** (`open-timing.mjs`, cohort app, Chrome running): an open
  went from 333–356 ms to 188–197 ms. The finished picture came at
  355–396 ms instead of 478–487 ms; without the spare the first picture is
  often the app's loading state.
- **Real sessions** (first view in the session, Chrome started on
  ToolSearch): from the view's header to its first picture, iTerm2
  575 → 416 ms, kitty 532 → 292 ms, cells 657 → 462 ms; `/open` 457 → 242 ms.
- **Cost:** with one view open, Chrome's footprint grows by 25–43 MB (one
  renderer); alone in Chrome, about 80 MB, most of it the GPU process a
  view wakes anyway. The mod asks for a tab only where a view is likely: on
  ToolSearch loading a tool with an app, or for a server known to have apps.
- `MCP_APPS_CLI_SPARE=0` turns it off.
- A kept tab serves no view document until a view sets its HTML and CSP
  (set together, under one lock): a request for the view's origin with no
  CSP yet fails closed.

**Where no Chrome is installed** (since 2026-11-19). The helper falls back
to Chrome for Testing's headless shell where Puppeteer or Playwright fetched
it, the newest at version 152 or later (it doesn't update itself). It gets
`--site-per-process` (the shell runs the host page and the app in one
process otherwise; Chrome doesn't) and, on macOS, `--use-angle=metal` (else
3D draws in software at about a quarter of the rate). With both, every
helper check passes on shell 153, and against Chrome 157:
- one cohort view, 188 MB instead of about 250 MB (renderers: host 11, app 84);
- the 3D scene, 142–153 pictures in 6 s instead of 155;
- Chrome up in about 100 ms instead of about 330 ms.

**Tried and left out** (2026-11-19, measured):
- **Chrome's low-memory flags** (one cohort view): `--enable-low-end-device-mode`
  saves about 22 MB, but by putting the host page and the app in one renderer
  process: less isolation than Chrome's default, so no. `--js-flags=--lite-mode`
  saves 8 MB and slows JavaScript; `--disable-gpu-compositing` nets 14 MB;
  `--num-raster-threads=1` saves nothing.
- **The first picture at 1x, then 2x:** no sooner (first pictures 290–368 ms
  against 291–398 ms). What decides it is the app drawing its data, not the
  screenshot.
- **One context per app server:** two views of the cohort app, 367 MB with a
  context each, 326–331 MB in one, 300 MB in one with `--process-per-site`.
  The last shares one renderer and so one main thread (two animated views
  slow each other), shares storage between the views and changes how it's
  kept, and leaves the kept-ready tab out for a server's second view.
  Claude gives each server one origin, so it would meet the security bar,
  but the cost outweighs it for now.

**Fetching a headless shell** (fetch_browser.rs, since 2026-11-19). On the
person's yes, the helper reads Chrome for Testing's version list
(googlechromelabs.github.io) and downloads the Stable shell for the machine
from storage.googleapis.com only (HTTPS; any other host, or a look-alike, is
refused), at most 400 MB, unzips it with the system's `unzip` (`tar` on
Windows) into `<plugin data>/browsers/<version>/`, checks it runs, and drops
older ones. In a real fetch: Stable 158.0.8127.36 in 8 s, 205 MB unpacked;
smoke, host and network checks all pass on it. The lookup (chrome.rs) takes
it with Puppeteer's and Playwright's, the newest first; while it's in use the
helper checks for a newer Stable at most once a day (`browsers/.checked`).

**A view's own network** (page.rs, since 2026-11-19). The page's Network
events (each frame's session) keep WebSockets open, requests in flight and
when any of it last moved; `/activity` answers with them. The mod rests a
view that reaches other sites only when no socket is open, nothing is in
flight and nothing moved for its APP_POLL_MS (3 min). bench/network-check.mjs
opens a WebSocket from a real view and watches it open, close and go quiet.

**Snapping, only for rows** (snap.rs, since 2026-11-19). On by default for
a picture whose long edges include a run of four rows at one height (within
1.5 px; a thin gap's two edges count as one): a table, a heatmap. The cohort
heatmap's horizontal partial blocks: 604 to 344. The clock's picture is
left exactly as it was, and the system monitor's text stays on its rows.

**Clicks on grouped text.** Line grouping (lines.rs) can draw a text a row
below where the page has it. The cells frame keeps which texts moved
(`group_moves`), and a pointer on one goes to where the text is on the page
(input.rs, cells mode only).

On Claude Code's main screen a view takes no input. One that has stopped
changing gives up its page (the mod's restWhenStill). Once no view is left,
Chrome closes after 60 s, where it used to wait 300 s; an MCP call starts it
ahead again, if its server has apps. In a real session the view rested
4 minutes in, and Chrome went from 7 processes to none.

At rest, since 2026-11-19 (one view, a real `claude` session, `open-iterm`):
Claude Code 7.6% → 1.8% CPU, Chrome 8.2% → 3.8%. The changes:
- **Input layer.** The mod's input layer reports only input, or a new
  width. Before, it posted 14 times a second.
- **Chrome paints.** Chrome says when it paints (`Page.startScreencast`,
  16 px frames used only as a signal). An unannounced change is caught
  within 0.5 s, and the timed backstop drops from every 3 s to every 10 s.
  - Paints right after a capture are the capture's own and are ignored.
  - Three captures in a row from paints that found nothing rest them for 5 s.
  - A backstop change with no paint ends the signal.
  - On the still cohort view, helper plus Chrome went from 1.8–2.3% to
    0.9–1.0%. The Node helper showed no difference.
  - `MCP_APPS_CLI_PAINTS=0` turns it off.
- **Cells text.** A cells frame reads the page's text only when a DOM
  counter (`__cliDom`) moved since the last read; otherwise it re-reads just
  the canvas's text. A theme change, the backstop, and input in the last
  300 ms read it afresh.

Cells, since 2026-11-19 (`src/lines.rs`): texts that share a visual line go
on one row, before the renderer (crates/render is untouched).
- **The problem:** the cohort heatmap's month labels sat a row above their
  numbers in 3 of 12 rows.
- **One line:** two boxes overlapping by half the smaller one's height, and
  not side by side across. A box 1.5 cells tall or more stays a line of its own.
- **Moves:** a line on two rows goes to its majority row, taken bottom-up.
  A line in the way moves down one row whole, only if that row is free and
  on the picture. A moved text's old glyphs are painted over with the
  commonest colour around them.
- **Result:** 0 of 12 split. `MCP_APPS_CLI_GROUP=0` turns it off.

`src/snap.rs` lines long horizontal edges up with cell rows. It stays off
(`MCP_APPS_CLI_SNAP=1`): it clears the partial-block rows only in part, and
a click isn't mapped back through it yet.

A closed view keeps its last picture file (kitty, Ghostty), so the transcript
can still draw it; the helper's folder goes at exit.

### Found on the way

The server closed each connection as soon as it had answered. A client
still finishing a large request then got EPIPE with the answer unread: 59 of
64 concurrent 200 KB requests over the socket failed. In real use that's
the mod passing a big tool result back. It now half-closes and drains until
the client closes (RFC 9112's lingering close): 300 of 300 at sizes up to
2 MB, socket and TCP. `contract-check.mjs` checks it.

Claude Code draws no tree with more than 2 MiB of Image source. DOOM's
title screen at 2x came to 4.8 million characters of strips (full colour),
and Claude Code refused those renders. Both helpers now add up the bands
the mod holds. A picture past 1.9 million characters isn't sent: the view
is taken again at half the scale, down to 0.5x, until it's resized. A whole
picture past 1.5 MB steps down the same way. In the `doom` session there
were 6 refused renders before, and none after.

### Beyond Node's helper

- Chrome can't be orphaned:
  - Unix: a watcher (`--reap`) stops it within 3 s of the helper being
    killed outright; Node's lingered about 10 s.
  - Windows: Chrome runs in a kill-on-close job object.
  - Either helper's sweep stops Chromes left in a dead helper's folder.
- Another Chromium-based browser is used where Chrome isn't installed:
  - Edge, which comes with Windows;
  - Chromium, Edge or Brave on macOS and Linux;
  - Node's helper needs Google Chrome.
- On Windows, a server's command is found the way the TypeScript SDK finds
  it (`npx` is `npx.cmd`), and each server starts with no console window.
- MCP's older SSE transport: rmcp has no client for it, so `src/sse.rs` is
  one (GET stream, `endpoint` event, POSTs on the same origin, headers from
  the config).

### Windows (written, compiles, not run)

`cargo check --target x86_64-pc-windows-msvc` passes with no warnings.
TLS there is Windows' own (native-tls), since rustls' default crypto needs
a C cross-compiler. `src/win.rs` covers:
- Chrome on `--remote-debugging-io-pipes=<read>,<write>`: two inherited
  pipe handles, and nothing else inherited (a handle list), started
  suspended, put in its job, then resumed;
- the token from `BCryptGenRandom`;
- the parent's id (a Toolhelp snapshot), its command line (PowerShell, as
  Node's helper reads it), and its exit (a handle taken at start);
- Ctrl-C, Ctrl-Break, console close and shutdown.

The release workflow (Distribution, below) builds it on Windows and runs
the smoke, store and change checks there, the job object included; they
pass on GitHub's Windows runners. It has not yet been used in a Claude Code
session on Windows.

### Linux

The code is the macOS code (Linux-specific: `malloc_trim`, the browser
search). It ships as static musl builds (`x86_64-unknown-linux-musl`,
`aarch64-unknown-linux-musl`), so one binary runs on any distribution;
building needs musl-gcc (Debian's `musl-tools`), as rustls' crypto (aws-lc)
is C. Checked in Docker on Linux arm64 (Debian 12, Chromium, Chrome's
sandbox on): the Rust tests pass on the musl target, and so do the smoke,
host (28), contract, change, store, leak and network checks. Linux x64 is
built and checked only by the release workflow.

### Distribution

The plugin carries every platform's binary: `package/package.sh` packs
`mod/helper/bin/<os>-<arch>/` for all five into one zip with the hooks
module, and the marketplace installs that zip as an `archive` source pinned
by its SHA-256 (`docs/DESIGN.md`: Packaging and releasing). Nothing is fetched at run
time. A binary that lost its executable bit on the way is copied into the
plugin's data folder (0700) under a temporary name, marked executable and
renamed; the plugin's own copy is left as installed.

`.github/workflows/mcp-apps-cli-release.yml`, at the repository's root,
builds natively on macOS (arm64, x64),
Linux (x64, arm64; static) and Windows (x64). On each it:
- runs `cargo test` for the shipped target;
- runs `bench/smoke-check.mjs`: the ready line, the token, discovery, Chrome,
  a view's first frame, and no Chrome left after the helper is killed
  (Unix: the watcher; Windows: the job object);
- runs the host (not on Windows), store, change and network (not on
  Windows) checks.

Each run then packs the plugin with all five and keeps the zip as an
artifact. A tag `mcp-apps-cli-v<version>` also records build provenance for
the zip and each binary, publishes the release and opens a pull request
that points the mcp-apps-cli entry of the root
`.claude-plugin/marketplace.json` at it. The old
`mcp-apps-cli-helper.yml` (the fetch path) is gone, and with it
`fetch-helper.mjs`, `binaries.json` and the Node helper's installer
(`start.mjs`).

### How a view's changes are seen

**Pushed, not polled.** The change hook (`js/change_hook.js`, the same in both
helpers) calls a CDP binding, `__cliChanged`, at most once per 16 ms. The
helper captures on each call, within the pace. The hook counts:
- DOM mutations;
- canvas draw calls (2D, WebGL, bitmap, WebGPU submits);
- web fonts loading;
- running CSS animations, transitions and playing media, with a notice
  every 100 ms from when one starts until nothing moves.

Frames the app embeds notify too. Asking for an animation frame no longer
counts: an idle `requestAnimationFrame` loop draws nothing, and it looked
like constant change. Store writes are pushed the same way, then saved
about a second later.

**Behind it:**
- **A backstop:** a full capture every 3 s. After one finds a change nothing
  announced (an animated GIF, a caret), it captures every 500 ms for 5 s.
- **A liveness check** every 2 s, which closes an app that misses three in a
  row ("the app stopped responding"; `host-check.mjs`).

| | Before | Now |
|---|---|---|
| `change-check.mjs`, timer-drawn canvas | 0 of 8 redraws in 600 ms (shown only at the 3 s capture) | 8 of 8 every run, 34–74 ms (Node 47–70 ms) |
| 3D scene, Ghostty | 13.9 fps | 25.5 fps |
| 3D scene, iTerm2 strips | 9.9 fps, 39% CPU | 16 fps (its 60 ms pace), 45% CPU |
| 3D scene, cells | ~10 fps | 26 fps, 48% CPU |
| Three still views, helper + Chrome | 7.0% / 6.5% CPU | 6.7% / 5.8% CPU (same machine, back to back) |

**Where the frame rate came from** (`MCP_APPS_CLI_TIMINGS=1` logs each
stage's p50/p95):
- **Chrome's screenshot is almost all of a capture.**
  - Ghostty: 31 ms, then 1 ms after it.
  - iTerm2: 33 ms; bands are encoded off the capture.
  - Cells: 26 ms, then 6 ms for cells and text.
- **Two changes:**
  - Chrome's fast PNG encoding everywhere. It was only on for picture
    files; the shot is decoded here anyway. iTerm2 went from 41 to 33 ms and
    55% to 45% CPU; cells from 40 to 26 ms and 20 to 26 fps.
  - The pace counts from a capture's start, not its end.
- **Measured, no gain:**
  - `captureBeyondViewport` off: 24.5 fps against 24.2, the resize check
    unchanged. It stays on.
  - iTerm2's lower resolution while moving: iTerm2 is capped by its pace,
    not its capture.
- **Refuted:** Fable guessed the 3D scene was shot twice per frame (a
  retake when a PNG passes 1.5 MB). All 106 frames were one 2× shot. The
  retake now applies only to pictures that go to the terminal whole, not to
  iTerm2's bands.

**Tried first and abandoned: Chrome's screencast notices** as the signal.
They took 9–64 ms when they came. But in about one run in three they stopped
for good half a second after a view opened, once its window was resized,
though every frame was acknowledged. Restarting them didn't help.

### Security fixes from the second review

Fable reviewed the code; each finding below was checked against the code
before it was fixed.
- **No user activation from the helper's own evaluations.** Every page
  evaluation granted it (`userGesture: true`), the 400 ms poll included, so
  every app held user activation all along: clipboard writes, popups and
  fullscreen were all open to it.
  - Rust grants it only for input handled on the person's behalf.
  - Node bypasses Playwright, whose evaluations always grant it: the
    helper's own looks (liveness, cell text) go over CDP, and alt text now
    comes from Chrome's accessibility tree (`alt.mjs`, `altFromTree`).
- **Local-network checks on.**
  - They were off for every view, and the CSP judges names, not addresses.
    A remote server's app could name a public host that resolves to
    127.0.0.1 or the LAN.
  - Now only views of local servers (a loopback, private or `.local` host,
    or stdio) get Chrome's local-network permission (`Page::new`).
  - The address checks parse IPs: `127.0.0.1.example` is a name.
  - `host-check.mjs` serves its test server as `localtest.me` (which
    resolves to this machine) and checks that view is refused. The previous
    binary fails that check.
- **WebRTC.** Blank, `srcdoc` and `blob:` frames an app makes get no WebRTC
  either (`host-check.mjs`), and Chrome runs with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` as a backstop.
- **Model context** an app sets is cleaned of control characters, as app
  messages are, and goes to the model as a block per view at most as large as
  Claude Code shows a prompt's context inline: 100,000 characters a block,
  200,000 together (past that it's cut, and says so). Beside a typed prompt it
  is prompt context; with an app's own message (`ui/message`) it is a note the
  model reads with that turn (`$.session.append`), since a plugin's own
  submit passes none of its own hooks. The person sees neither.
- **A hung app is closed** (above).
- **Workers pause with their page.** Out of sight, a view's page was paused
  but its workers ran on: a spinning worker kept the renderer at 100% CPU.
  Chrome's freeze (`Page.setWebLifecycleState`) doesn't stop them in
  headless either.
  - Rust pauses each dedicated worker's session with its page.
  - Node attaches to them through its own page session
    (`Target.setAutoAttach`, not flattened; Playwright gives no worker
    session).
  - Both now go from 100% to 0% out of sight and back to 100% in sight.
    `host-check.mjs` checks it with a counting worker: the previous binary
    let it run, +48 ticks in 2.4 s.
  - Memory while paused is a non-issue either way: an app receiving 17 MB of
    WebSocket messages over 3 paused minutes grew its renderer by 1 MB
    (debugger pause) or 3 MB (freeze).
- **Picture files are written atomically** (a temporary name, then a rename),
  so kitty and Ghostty never read half a PNG.
- **Windows:** the Downloads folder (and every home path) comes from
  `USERPROFILE` where `HOME` isn't set.
- **The release workflow:**
  - actions are pinned by commit;
  - each binary gets build provenance;
  - Linux x64 runs with Chrome's sandbox on;
  - the host and store checks run there too.

### Fuzz-style tests

Seeded, dependency-free property tests feed random and adversarial input to
every parser. `FUZZ_SEED` replays a failure. They cover:
- HTTP heads and bodies, at any read boundary;
- SSE streams, split at every byte;
- input events;
- CSP and origins;
- command lines.

They found six bugs, each fixed and kept as a regression test:
- a CSP domain containing a tab let `*` into the CSP;
- a head over `MAX_HEAD` was accepted;
- a negative, overflowing or conflicting `content-length` was accepted;
- body allocation could pass 64 MiB;
- SSE events ended by CR alone were dropped;
- pointer coordinates of `1e308` reached Chrome.

### Chrome's memory

Chrome holds about 480 MB with three views:
- browser 96 MB, GPU 105 MB;
- 55–90 MB per app renderer.

The plugin keeps at most three views live. Two things changed here:
- **Views sleep.** A view out of sight for 10 minutes that the person never
  used (`MCP_APPS_CLI_SLEEP_S`) closes, keeping its picture and store. It
  opens again from its call as soon as any of it is back in sight. Once all
  views sleep, Chrome closes after its idle wait (5 minutes): about 480 MB
  back.
- **The Node helper doesn't orphan Chrome anymore.** Killed outright, it used
  to leave its Chrome running until the next helper's cleanup sweep. Now a
  watcher stops it, like the Rust one's: a shell loop on Unix,
  `Wait-Process` on Windows.

Tried, and not adopted:
- **`chrome-headless-shell`:** 437–442 MB against 464 MB, about 5% less. The
  copies on a machine come from Playwright's or Puppeteer's caches and get no
  security updates, so it isn't picked up by itself. `MCP_APPS_CLI_CHROME`
  can name one.
- **`--in-process-gpu`, `--disable-gpu`, memory-pressure notices:** no gain.

### A sandbox for the helper itself

Under a macOS sandbox profile, even `(allow default)`, Chrome stops as soon
as a view opens: its renderers can't set up their own sandbox inside
another. The helper would have to turn off Chrome's sandbox, and that
sandbox is what stands between untrusted app code and the machine. So the
helper isn't sandboxed. It runs no app code; what it parses is covered by
the fuzz-style tests above.

## Milestones

Each ends with checks passing against the Rust helper
(`MCP_APPS_CLI_HELPER=<binary> node bench/<check>.mjs`).

1. **Skeleton.** Transport and token, `ready`, `/ping`, `/discover` over
   `rmcp`, `/prewarm` launching Chrome over the pipe, idle shutdown, Chrome
   stopping. Checks: the token refusal; discovery.
2. **Picture views.** Contexts, routes and CSP, navigation block, bindings,
   init scripts, `__openView`, screenshots as PNG (files for kitty and
   Ghostty, whole PNGs for iTerm2), `/args`, `/result`, `/cancel`,
   `/theme`, `/resize`, `/close`, page crashes. Checks: host-check's
   arguments, theme, alt text, WebRTC, CSP, navigation, crash and idle.
3. **Input.** Pointer with click counts, held keys, keys and text,
   PgUp/PgDn, selects, hover pacing, pausing out of sight. Checks:
   host-check's input, scroll and nested frame; a real `claude` session.
4. **Host calls and consent.** Tool calls through the mod, app-only tools
   over `rmcp`, resources, downloads with their limits, copies, messages,
   links.
5. **Stores.** Per-view cookies, localStorage, IndexedDB, saved and given
   back, private folder. Check: store-check, both transports.
6. **iTerm2 strips and the 256-colour palette.**
7. **Cells.** `render.mjs` with its tests (lines, Braille, sextants,
   truecolor, text placement, the colour-pair budget).
8. **The rest, then the switch.** Windows (TCP, the parent's command line),
   prebuilt binaries per platform in the plugin (or fetched on first run,
   as the packages are today), the mod starting the binary, and Node's
   helper removed once every check and the real sessions pass.

Node's helper stays as the fallback (platforms with no binary, a binary that
doesn't start) until binaries are distributed for every platform.
