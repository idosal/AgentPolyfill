# Performance

Measured on one machine, on macOS, against the fixture events server in
`test/`, which runs as a local process. Reproduce with:

```bash
npm run perf                                             # the bundle, on the Node on your PATH
PERF_RUNTIME="bun" node --no-warnings test/perf.ts       # the same bundle on another runtime
```

CPU time and memory come from `ps`, which counts CPU time in steps of 10 ms, so
the idle figures are small numbers read coarsely. Nothing here was measured on
Linux or Windows, or against a remote server.

## 0.5.0 against 0.4.1

Both bundles on Node 22.23.1, by `test/perf.ts` (the idle CPU figures move by
tens of milliseconds between runs):

| | 0.4.1 | 0.5.0 |
|---|---|---|
| Bundle (`mod/dist/helper.js`) | 540,760 bytes | 544,029 bytes (+0.6 %) |
| Start → ready, median of 9 | 135 ms | 130 ms |
| Start → catalog, one local server, median of 9 | 375 ms | 359 ms |
| Idle, 4 push watches: memory / CPU over 30 s | 55 MiB / 40 ms | 55 MiB / 90 ms |
| Idle, 4 poll watches every 5 s: memory / CPU over 30 s | 57 MiB / 40 ms | 56 MiB / 70 ms |
| **1,000 events through one push watch, until all are on disk** | **5.5 s (180 a second)** | **11.4 s (88 a second)** |
| Helper CPU per event | 0.69 ms | 1.18 ms |
| One event: server has it → helper says it waits, median of 10 | 45 ms | 44 ms |
| 20 local servers, 10 with events: start → catalog | 830 ms | 816 ms |

**The event rate halved, on purpose.** 0.5.0 flushes `watches.json` to disk
before it replaces the old one, so that a power cut leaves the old file or the
new one, never an empty one that reads as no watches at all. On macOS each
flush is a full one (`F_FULLFSYNC`, about 5 ms), and the watch is saved with
every event, so every event now costs two flushes instead of one. A first
version also flushed the folder after the rename: 16.6 ms an event, 60 a
second; that third flush bought nothing the second does not (if the rename is
what a crash loses, the old file comes back and a starting helper recovers the
rest from the spools), and was taken out. 88 events a second from one watch is
far above what a session can use: a watch wakes it at most once a minute.

**Start with what an earlier session left behind.** A starting helper reads the
end of the spools of the sessions listed for the project (at most 16 MiB of
each). Measured from source, the worst case being a session that stored
events and showed none of them:

| Earlier session's spool, none of it handed over | `WatchManager.start()` |
|---|---|
| none | 20 ms |
| 1 MiB (2,796 events) | 45 ms |
| 16 MiB (44,739 events) | 207 ms |
| 64 MiB (178,956 events; 16 MiB of it read) | 203 ms |

The first version of this took 1,769 ms at 16 MiB: it checked each event id
against a list that grew as it went. With a set it is the 207 ms above.

The figures below are from 0.4.x.

## What runs, and when

One process, `mod/dist/helper.js` (544 kB, no dependencies to install), started by
the hooks module:

- **With a person at the session** (a terminal, or an app hosting it): at
  session start.
- **In an unattended run** (`claude -p` in a script): only if Claude calls one
  of the mod's tools.
- **With nothing to watch** (no configured server offers events, no saved
  watch): it exits after 20 seconds and is started again when a tool is
  called. A server found without events is remembered for a day, so it is not
  started a second time at every session.

An earlier version of this project was a plugin of the older kind: two
processes for the whole of every session (a stdio MCP server, and a monitor
that looked at a file every 300 ms), and Claude Code waited for the MCP
server, which connected to every configured server before it answered. The
comparison below is against that version.

## Figures

The helper, from the bundle:

| | Node 22.23 | Node 20.18 | Node 24.11 | Bun |
|---|---|---|---|---|
| Start → ready (tools can be called), median of 9 | 141 ms | 80 ms | 75 ms | 86 ms |
| Start → catalog, one local server, median of 9 | 396 ms | 329 ms | 321 ms | 329 ms |
| Memory, nothing to watch (for the 20 s it lives) | 60 MiB | 54 MiB | 69 MiB | 78 MiB |
| Idle, 4 push watches: memory | 55 MiB | 42 MiB | 74 MiB | 84 MiB |
| Idle, 4 push watches: CPU over 30 s | 50 ms (0.17 %) | 80 ms (0.27 %) | 10 ms (0.03 %) | 60 ms (0.20 %) |
| Idle, 4 poll watches every 5 s: memory | 57 MiB | 55 MiB | 75 MiB | 85 MiB |
| Idle, 4 poll watches every 5 s: CPU over 30 s | 60 ms (0.20 %) | 50 ms (0.17 %) | 10 ms (0.03 %) | 100 ms (0.33 %) |
| 1,000 events through one push watch, until all are on disk | 5.6 s (5.6 ms each) | 5.8 s | 5.8 s | 0.5 s (0.5 ms each) |
| Helper CPU per event | 0.87 ms | 0.90 ms | 0.92 ms | 0.43 ms |
| Memory after those 1,000 events | 80 MiB | 79 MiB | 91 MiB | 133 MiB |
| 20 local servers configured, 10 with events: start → catalog | 1.0 s | 0.9 s | 1.0 s | 1.0 s |
| Memory with those 10 connections | 68 MiB | 66 MiB | 79 MiB | 95 MiB |

"Start → catalog" includes the fixture server's own start (a Node process),
which is most of it.

For comparison, the earlier plugin (this mod's first version), on
Node 22.23, measured by `test/perf-baseline.ts`:

| | Before (stdio server + monitor) | Now (one helper) |
|---|---|---|
| Processes for the life of a session | 2, always | 1, and 0 when there is nothing to watch |
| Idle, 4 push watches: memory | 63 + 34 = 97 MiB | 55 MiB |
| Idle, 4 push watches: CPU over 30 s | 90 ms (0.30 %) | 50 ms (0.17 %) |
| What Claude Code waits for at start | the MCP server's answer, after it has connected to every server: 397 ms with one local server | six tool registrations (see below); the helper starts beside them |
| Size of what is installed to run | 836 kB (two bundles) | 533 kB (one) |

In Claude Code itself (2.1.329):

| | |
|---|---|
| The mod's `session.start` hook, which Claude Code awaits before the first prompt | 145 ms in a `-p` run, 350 ms in a terminal session (six tools registered at once; the first version registered them one after another and took 690 ms) |
| One tool call, hooks module → helper → back | 4 ms |
| Taking a batch of events and submitting it as a prompt | 3 ms before the turn starts |
| The catalog's `prompt.compose` hook, per request, with Claude Code's own composition beneath it | 8 to 35 ms |

## What the figures say

- **Cost per event is the disk.** Every event is flushed to disk before it is
  acknowledged to its sender. On macOS, Node's `fsync` asks the drive for a
  full flush (`F_FULLFSYNC`), which is the 5 ms; Bun's evidently does not,
  which is why it reads ten times faster and is not ten times safer. The CPU is under a millisecond an
  event either way. About 170 events a second, sustained, is the ceiling on
  Node on this machine, and Claude is shown a burst as three lines and a
  count, not as 1,000 prompts.
- **A waiting event reaches Claude Code about a second after the server sends
  it**, because the helper waits one second to fold a burst into one prompt
  (`MCP_EVENTS_BATCH_MS`). Without that window it is tens of milliseconds.
- **Idle cost is a Node process.** 40 to 75 MiB depending on the Node version,
  and a few hundredths to a few tenths of a percent of one core for
  heartbeats, poll timers and a liveness check every 5 seconds.
- **Many servers:** connections are made in parallel, so 20 local servers
  take about as long as the slowest. Each server that offers events is a
  second connection for as long as the session runs, and for a local server a
  second process: that is the server's memory, not counted above.

## Why the helper is JavaScript, and what a native helper would change

A native helper (a small binary per platform, in Rust for example) would mean
nothing needs Node or Bun, and a smaller process. The helper stays JavaScript
for now:

- The numbers do not ask for it. The helper is idle almost all of the time,
  and when it is busy the cost is the disk flush, which any language keeps.
- The Events client leans on the MCP TypeScript SDK for its transports and
  for protocol revision negotiation (2026-07-28 and the revisions before it,
  over stdio and Streamable HTTP). A rewrite means reimplementing those and
  proving the conformance clauses and interop tests again with no SDK
  underneath.
- What it would buy is smaller since 0.6.0: a machine with neither Node nor
  Bun can have the mod fetch a copy of Bun for itself (`/mcp-events setup`,
  about 40 MB, on macOS and Linux). A helper binary per platform would need
  no fetch, at a few megabytes each, and would cover Windows too. If Claude Code lets a mod send MCP requests over its own
  connection (see
  [`claude-code-and-mcp-events.md`](claude-code-and-mcp-events.md)), the
  helper goes away altogether and the question with it.
