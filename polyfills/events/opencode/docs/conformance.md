# SEP-3415 client conformance, in OpenCode

How this client (the OpenCode form of mcp-events, 0.1.2) stands against the
**Final** text of SEP-3415 (`seps/3415-events-extension.md` in
`modelcontextprotocol/modelcontextprotocol`, as fetched on 24 November 2026),
the same revision as the Claude Code and Codex forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md). Its tests and
its result in the upstream conformance suite (17 of 17 Events client
scenarios) are for that same client. The result there holds here: **with
`MCP_EVENTS_PRE_STANDARD=off`, 80 met and 6 not applicable; by default 78
met, 2 met with a documented exception (CAP-2 and CAP-4), 6 not applicable,
none missing.**

What this file adds: which rules this form's own tests check end to end, in a
real OpenCode, and what is different in OpenCode.

## Checked end to end in this form

[`test/e2e.test.ts`](../test/e2e.test.ts) runs the bundled plugin in OpenCode
2.4.1, against the Claude Code form's fixture events server (written from the
SEP, sharing no code with the client).

| Clauses | What | Test |
|---|---|---|
| LIST-1, DM-1 | events/list read; delivery modes as listed | "lists the fixture server's event types" |
| POLL-1, POLL-2 | polled, with the cursor passed back; an event wakes the session | "approved, it watches; an event then wakes the idle session" |
| PUSH-1 | one `events/stream` per watch, by push where the type offers it | "a push event type is watched by push" |
| WH-1, RX-1, RX-7 | a webhook subscription with its own secret; only signed deliveries taken, by the plugin's receiver inside OpenCode's server; http only on loopback for tests | "a webhook-only event type is watched by webhook" |
| STATE-1, PUSH-11 | after OpenCode restarts, resumed from the saved cursor; what came meanwhile arrives once | "a watch resumes from its cursor" |
| SEC-1, SEC-2 | payloads reach the model only as tool results (`get_event`); the wake message carries no server text | "approved, it watches…" (the wake holds no payload) |
| SEC-3 | receipt is not authorization: watches are put to OpenCode's permission rules, and ask by default | "a watch is put to OpenCode's permission rules", "asks by default" |
| (sign-in) | a server that needs a sign-in this client can't do is named, and its configured header never shows | "a server that needs a sign-in" |

Also checked in OpenCode 2.4.1: AgentPolyfill's public event-feeds server by
poll, and a webhook through the public relay, each waking an idle session;
and, against the fixture server, an event waking a session in OpenCode's TUI
and in OpenCode Desktop.

## Different in OpenCode

| Clause | In OpenCode |
|---|---|
| SEC-3 ("Receipt of an event does NOT constitute authorization to act") | The wake is a synthetic message (`ctx.session.synthetic`), and what OpenCode does next goes through its permission rules as for any turn. Starting or stopping a watch is put to those rules (`mcp_events_watch`, `mcp_events_unwatch`) and asks by default: OpenCode's shipped rules allow every action, so the plugin turns `allow` into `ask` for these two actions unless the person chose "Allow always" for that server and event type, or set `askByDefault: false`. |
| SEC-4 (policy evaluation between receipt and action) | OpenCode's own permission rules. The plugin adds none beyond its own two actions. |
| SEC-5 (the client owns all subscription state) | Per OpenCode session, in `$XDG_DATA_HOME/opencode/mcp-events/threads/<session id>/` (watches, cursors, the project folder) and `sessions/<session id>/` (events), private to the user. |
| STATE-1 across a restart | A session's watches resume when OpenCode next loads that project's plugins, which it does when something uses the project. The README says so under Limits. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-opencode`). OpenCode's own connection declares it too, for its automations. |

## Departures from the polyfill contract

**Rule 4 (stand down where the host is native).** OpenCode 2.4.1 has part of
Events itself: its client takes push events for its automations, which can
start a prompt in a session. It doesn't poll, take webhooks, or watch for a
session, and it skips an event type whose schemas it can't turn into a checker
(it skips both of the fixture server's types, valid under the SEP). A plugin
can't ask which types OpenCode accepts. So this plugin keeps its own client for
every event type, push included, and when it lists event types or watches one
by push it tells the model that an automation is the other way, and to use one
or the other. Nothing stops both being set up for one event type; the plugin
only says so. `MCP_EVENTS_OFF=1` turns the plugin off.

OpenCode Console, for a signed-in workspace, has `console_watch` tools that can
also wake a session on events of the workspace's MCP servers on Console. They
aren't checked here; the plugin doesn't look for them.

## The upstream conformance suite

Run against the shared client in the Claude Code and Codex forms
(`npm run conformance` there); this form bundles that client unchanged and
adds no Events protocol code of its own.
