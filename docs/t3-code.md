# T3 Code

T3 Code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) is an
app that runs coding agents on your machine and gives them one interface on
desktop, web and phone. This page says what the polyfills can do there, and
why they take the shape they do.

Checked against T3 Code 0.1.11 (the `t3` npm package, released 20 November
2026) and its source at commit `5a156a2a` (24 November 2026), with Codex CLI
0.172.0 and Claude Code 2.1.331 underneath.

## What T3 Code is

T3 Tools makes one agent product that runs on your machine: T3 Code. T3 Chat,
the company's chat app, is a hosted web product. Neither pingdotgg nor
t3dotgg publishes its source (the repositories named after it on GitHub are
other people's clones), and T3 Code's docs mention it only as a plan that lets
T3 Connect link more machines. It has nothing local for a polyfill to plug
into, so nothing here applies to it.

T3 Code doesn't have an agent loop of its own. It drives the agents you
already have and are signed in to: Claude Code, Codex, Cursor, OpenCode, Grok
Build, Antigravity, Kiro, Pi, Muse Code, fx, and any ACP agent. Each is a
"provider". For the two this repository has forms for:

- **Codex** runs as `codex app-server -c thread_unload_delay_secs=0`, a child
  of the T3 Code server over stdio, with your normal `CODEX_HOME`. One app
  server serves all of a provider instance's threads.
  (`apps/server/src/provider/codexLaunchArgs.ts`)
- **Claude Code** runs through the Claude Agent SDK (0.3.321), which starts
  the `claude` CLI with streaming input and your normal configuration
  directory. Your plugins, including mods, load.
  (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`)

So T3 Code has no MCP client for your servers. MCP is the agent's: the servers
in Codex's `config.toml` or Claude Code's configuration are started and
connected by the agent, as they are in a terminal. T3 Code adds one MCP
server of its own to every thread (`t3-code`: threads, projects, worktrees,
previews).

T3 Code has no plugin layer. Its providers are packages built into the app.
What it offers outside code is:

- **`t3 thread send / start / show / list`**, a command for messaging a thread
  from the machine that runs it, with no sign-in there. A send never
  interrupts: an idle thread starts a turn, a busy one gets the message as its
  next turn. (`docs/user/outside-agents.md`, "Scripts on the host")
- **Its MCP server over HTTP with OAuth**, for agents T3 Code didn't start.
  That server is an MCP Events *server* (`io.modelcontextprotocol/events`):
  turns ending, runs waiting on a person.
- **Scheduled tasks** (a prompt on a timer or webhook) and **workflows**
  (TypeScript scripts, a Labs feature off by default). Both run T3 Code's own
  work; neither is a way to add tools or hooks.
- **`T3CODE_THREAD_ID`**: every stdio MCP server Codex starts for a T3 Code
  thread has the thread's id in its environment. T3 Code sets it so it can
  tell which thread a process belongs to (`CodexAdapterV2.ts`,
  `codexThreadRuntimeParams`). It isn't in the user docs yet. Claude Code's
  servers don't get it.

## What a polyfill needs, in T3 Code

The rows are the ones in [What hosts would need to change](host-changes.md).
"Via Codex" or "via Claude Code" means T3 Code passes the agent's own
mechanism through; the Codex and Claude Code columns of that page then apply.

| What a polyfill needs | T3 Code with Codex | T3 Code with Claude Code |
|---|---|---|
| Add tools the model can call | Yes, via Codex: an MCP server in `config.toml` or a plugin | Yes, via Claude Code: a mod's `$.tool.register`, or an MCP server |
| Draw its own UI | No. A Claude Code mod pane is not shown; T3 Code shows an MCP App that a server returns | No. When a mod asks for a terminal pane's focus, T3 Code ends the turn with `claude_mod_ui_unsupported` |
| Start a turn in an idle session | Yes: `t3 thread send <thread> -` (T3 Code's own command; checked). Not `codex queue`: T3 Code's app server runs the queued turn, but the thread doesn't show it (checked) | Yes: `t3 thread send`. A mod's `$.prompt.submit` works only while T3 Code keeps the `claude` process open |
| Know which session called | Yes: `T3CODE_THREAD_ID` in a stdio server's environment (not documented yet); `_meta.threadId` is Codex's own id for the thread | Partly: a mod runs in its session, but nothing tells an MCP server which T3 Code thread it serves |
| Ask the user through the host's own approval or dialog | Partly: Codex's own approvals are shown in the thread; an MCP elicitation is shown only if T3 Code can answer it with Approve or Decline, and any other form is cancelled unseen (`CodexMcpElicitation.ts`; checked) | Partly: tool permission prompts and `AskUserQuestion` are shown; MCP elicitations go through the same Approve-or-Decline check; a mod's other dialogs are cancelled (`onUserDialog` takes only `resume_return`) |
| Call a server's tool, read resources, over the host's connection with its sign-in | Via Codex: only for an app-server client, and T3 Code is that client | Via Claude Code: `$.mcp.call` in a mod |
| Send any other MCP method | No | No |
| See what a server advertised | No | No |
| Receive a server's notifications | No | No |
| See raw tool results and `_meta` | No (T3 Code reads `_meta.ui` itself, to show MCP Apps) | No (likewise) |
| Declare a client extension | No | No |
| Add skills | Yes, via Codex: skills in a plugin or in `~/.agents/skills` are listed in the composer | Yes, via Claude Code: plugin and project skills are listed in the composer (`$`) |
| Add an MCP server to the host's configuration | Via Codex: `codex mcp add`. T3 Code needs **Restart agent session** to pick it up in a thread | Via Claude Code: `claude mcp add`, then **Restart agent session** |

### What T3 Code supports itself

- **MCP Apps: yes.** When Codex or Claude Code (2.1.301 or newer) calls a tool
  whose server returns an MCP App, T3 Code shows the app in the thread, on
  desktop, web and phone, sandboxed, asking before the app calls a tool that
  isn't read-only and before every message (`docs/user/html-renders.md`,
  `apps/server/src/mcpApps`). The Apps polyfill must not run in T3 Code.
- **Events: as a server only.** T3 Code's own MCP server offers events to
  outside agents. It has no Events client for your servers.
- **Skills (SEP-2640), Server Cards, ARD: no.** T3 Code lists the agent's own
  skills; it doesn't read skills from MCP servers.

## The shape: which case applies

There are three possible cases. Here is what each turned out to be.

**(a) T3 Code has its own plugin layer: no.** There is nothing to load a
`polyfills/<ext>/t3` plugin into, as there is in OpenCode or Pi.

**(b) T3 Code drives Codex or Claude Code, so the existing forms run inside
it: partly.** (It drives OpenCode too, the fourth host here; the OpenCode
forms were not checked in T3 Code.) Skills, Server Cards and ARD are tools, skills and (for Server
Cards) writing the agent's configuration. The Codex plugins and the Claude
Code mods load in T3 Code's threads as they do in a terminal, and their tools
work there. Checked with Codex: `list_skills` in a T3 Code thread lists the
demo server's skills. What doesn't carry over:

- **The questions the Codex forms ask through MCP elicitation.** Before it
  loads a skill, adds a server from a card, or sends a registry search, each
  Codex form asks you with a form whose one field is a choice ("Load it",
  "Add it", "Send the search"). T3 Code shows an MCP elicitation only when it
  can answer it with Approve or Decline: it fills in a choice only if the
  choice is named like `accept`, `approve`, `allow` or `once`, and cancels any
  other form without showing it (`CodexMcpElicitation.ts`,
  `toMcpElicitationResponse`; its log says "Cancelled an unsupported MCP
  elicitation"). So in T3 Code with Codex, loading a server's skill, adding a
  server from its card, and an ARD registry search are each refused as if you
  had said no. Nothing is approved for you; you're just never asked. Checked
  with Skills; Server Cards and ARD use the same kind of form. Claude
  Code's elicitations go through the same function in T3 Code.
- A Claude Code mod's terminal pane. T3 Code fails a turn in which a mod asks
  for its pane's focus. (The Skills mod for Claude Code, since removed from
  this repository, opened a skill in a pane this way.)
- A mod's own dialogs, other than permission prompts and `AskUserQuestion`.
  The mcp-events mod asks through `$.ui.ask` only before downloading a
  runtime (`/mcp-events setup`); T3 Code cancels that question,
  which means "Not now".

The Claude Code half of this is from T3 Code's source. It was not checked in
T3 Code with Claude Code as the agent.

**Events is where (b) is not enough.** Both existing forms wake a session by a
route T3 Code doesn't take:

- The Codex form wakes with `codex queue --resume`, meant for Codex's
  app-server daemon. T3 Code doesn't use the daemon: it runs an app server of
  its own. Checked: with no daemon running, `codex queue` can't resume
  the session, but leaves the message in Codex's queue, and T3 Code's app server
  then runs a turn with it. That turn reads the event and answers, and none of
  it appears in the T3 Code thread. A wake that runs work you can't see in the
  app is worse than none.
- The Claude Code form wakes with `$.prompt.submit`, which needs the `claude`
  process to be running, and the mod's helper is that process's child. T3
  Code closes an idle provider session after a timeout
  (`ProviderSessionManager.ts`: two minutes for a provider that can resume,
  unless background work pins it), and a restart of T3 Code ends every
  session. Events that arrive meanwhile are stored and shown at your next
  message, not when they arrive. Whether T3 Code shows a turn a mod starts in
  an idle session at all wasn't checked.

A Codex thread's MCP servers can still be running 20 minutes after
its last turn, so the timeout isn't the only thing that decides when a
session closes. A restart always ends them.

**(c) A server of our own, with T3 Code's own primitives: yes, for Events.**
`polyfills/events/t3` is an MCP server you add to Codex's configuration.
Codex starts it for each T3 Code thread, and T3 Code tells it which thread
(`T3CODE_THREAD_ID`). It passes its tools' calls to one watcher process,
which it starts and which outlives the agent's sessions. The watcher runs the
shared Events client (`polyfills/events/core`), and when an event arrives it
runs `t3 thread send <thread> -` with the message on standard input. T3 Code
then starts a turn in that thread, in the thread's own permission mode,
reopening the agent session if it had closed it.

T3 Code puts its own first line on what it hands the agent ("[T3 Code: this
message came through T3 Code's tools, not from the user typing in this
chat.]"), so the agent is told twice that the wake isn't from you. The app
shows it as a message in the thread.

This needs nothing undocumented except `T3CODE_THREAD_ID`, which is what T3
Code sets for exactly this question (which thread a process belongs to), and
which we ask T3 Code to document. It needs no sign-in, reads no credentials,
and approves nothing: `watch_event` and `unwatch_event` go through Codex's
approval in T3 Code like any tool that changes something.

### Most for the least

1. **The existing Skills, Server Cards and ARD forms**: no new code. Their
   tools work in T3 Code, but with Codex the one question each asks before
   acting is cancelled unseen, so the step that needs your yes doesn't happen
   until T3 Code shows general elicitation forms (the first ask below).
   Changing the forms to name their choices `accept` would get them through,
   and would be a quirk of one host dressed as a choice, so they don't.
2. **Events: `mcp-events-t3`, for Codex threads.** New, small (a server, a
   watcher, a wake), built on the shared core. Claude Code threads keep the
   mcp-events mod, with the limit above, until T3 Code passes
   `T3CODE_THREAD_ID` to Claude Code's MCP servers too; then the same server
   serves them, unchanged.
3. **Apps: nothing.** T3 Code already does it.

Turning this into T3 Code features would serve users better still. The asks
are below.

## What T3 Code would need to change

The same asks are in [host-changes.md](host-changes.md#in-t3-code), with T3
Code's column in its table.

- **Show an MCP elicitation form as the server wrote it.** T3 Code shows a
  form only when it can answer it with Approve or Decline, and cancels the
  rest without showing them. Showing a form's fields (MCP's form mode allows
  strings, numbers, booleans and single choices) and returning what the
  person picks would let any server, the Skills, Server Cards and ARD
  polyfills among them, ask its question. At the least, a form T3 Code can't
  show should be declined with a notice in the thread, not cancelled
  silently.
- **Document `T3CODE_THREAD_ID`, and set it for every provider's MCP
  servers.** Codex's stdio servers get it today; Claude Code's don't. With it
  documented, a server can rely on it; with it set for Claude Code, the Events
  server serves Claude Code threads too.
- **Show a turn the agent starts by itself.** When a Claude Code mod submits a
  prompt into an idle session (`$.prompt.submit`), and while T3 Code keeps the
  session open, show that turn in the thread as it does for scheduled wakeups.
  (Not checked.)
- **Let a mod's pane fail softly.** A mod asking for its pane's focus ends the
  turn today. Answering the held call with "no pane here" would let a mod say
  so and carry on.
- **An Events client of T3 Code's own.** T3 Code already speaks Events as a
  server. As a client, it would hold the subscriptions itself, outlive the
  agent sessions by design, and wake threads without a second process. It
  would still need the agent's MCP connection (or its own) to the server,
  which is the "send any MCP method" change in host-changes.md, asked of the
  agents.
