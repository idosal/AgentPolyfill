# SEP-3415 client conformance, in Muse Code

How this client (the Muse form of mcp-events, 0.1.7, on Muse Code 1.4.25)
stands against the **Final** text of SEP-3415, the same revision as the other
forms.

**Every rule the SEP puts on a client is implemented once, in the shared
client ([`../../core`](../../core)), which this form bundles unchanged.** The
clause-by-clause table, with the code and the test for each of the 86
client-side clauses, is the Claude Code form's
[`docs/conformance.md`](../../claude-code/docs/conformance.md), and its result
holds here: **with `MCP_EVENTS_PRE_STANDARD` set to `off` in the settings
file, 80 met and 6 not applicable; by default 78 met, 2 met with a documented
exception (CAP-2 and CAP-4), 6 not applicable, none missing.** The upstream
conformance suite's Events client scenarios were not run through Muse.

What this file adds: what this form's own tests check, and what is different
in Muse. The tests are in [`../../codex/test/muse-test.ts`](../../codex/test/muse-test.ts).
They run the bundled helper as Muse starts it (`--host=muse`, a cleared
environment, `MUSE_SESSION_ID`), and the bundled hook as Muse runs it,
against the hand-written events server of the Claude Code form and a stand-in
`muse`.

## Checked by this form's tests

| Clauses | What | Test |
|---|---|---|
| PUSH-1, STATE-1 | a watch the user typed yes to starts; an event is stored, and reaches the model with the user's next message, once | "a watch starts only after the person types its phrase; …" |
| SEC-1, SEC-2 | what reaches the model carries nothing of what the server sent; `recent_events` returns it as data | same |
| SEC-5 | a watch nobody typed yes to starts nothing and subscribes to nothing; the model calling again doesn't start it | same |
| STATE-1 | a `muse exec` run whose helper ends before any hand-over: the next run's prompt gets the event | same |
| (the SEP leaves it to the client) | waking, where it is on: past the hour's wakes the session is told once, and woken again only after a message of the user's | "waking is capped as in Codex: …" |
| (the SEP leaves it to the client) | a second process for the same session leaves the watches to the first, and takes them over, with the wake count | "a second process for the same session …" |

The form's other tests check what the SEP doesn't cover:
- reading Muse's settings as Muse writes them, and never a project's;
- reaching no server where an organisation manages Muse;
- the hook doing nothing while the plugin's server is turned off;
- the settings file, and the watch question showing every value whole.

## Different in Muse

| Clause | In Muse |
|---|---|
| SEC-3 ("Receipt of an event does NOT constitute authorization to act") | New events reach the model as a context block added to the user's message. Its first line says it's from the plugin, not typed by the user. What Muse does next goes through Muse's approvals. |
| SEC-4 (policy evaluation between receipt and action) | Muse's own. The plugin adds none. |
| SEC-5 (the client owns all subscription state) | Per Muse session, by `MUSE_SESSION_ID`, in the plugin's data folder, private to the user. A watch starts only after the user's typed yes (README, "How it works"). |
| STATE-1 across a restart | A session resumed with `muse resume` (or `muse exec --session-id`) starts its watches again when Muse starts the plugin's server. |
| CAP-1 | The client declares the extension on its own connection to each server (`clientInfo` `mcp-events-muse`). Muse's own connection can't be used: Muse gives a plugin no way to send `events/*` over it, and declares no client capabilities. |
| Delivery | By default with the user's next message. The SEP's wake of an idle session is only behind Muse's two experimental gates (README). |

## Recorded runs

[`live-run.md`](live-run.md): in a real Muse 1.4.25, with no real model.
