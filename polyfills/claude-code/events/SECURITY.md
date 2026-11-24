# Security

"The mod" below is this Claude Code plugin: a hooks module that runs inside Claude Code
(`mod/hooks/register.ts`) and a helper process it starts (`mod/dist/helper.js`), which
holds the Events client.

## The model

An event is data from an MCP server you configured. The mod treats it the
way Claude Code treats a tool result from that server, which is what the Events
extension asks for ("the same caution as tool results"). Receiving an event
gives Claude no permission it did not already have: whatever Claude does about
one goes through Claude Code's own permission mode, rules and hooks. The mod
adds no policy of its own on top.

The difference from a tool result is timing. An event arrives without anyone
asking, and wakes an idle session. If that session runs in a mode that approves
actions without asking, an event from a server can lead to actions without a
prompt, as a tool result from the same server could.

## What the mod does

- **Event content is shown as data.** The line that wakes a session carries the
  server's and the event type's names as you configured and watched them, then
  a few top-level fields of the payload: flattened to one line, quoted, cut
  short. `get_event` returns the whole payload, labelled as that server's data.
  The mod's instructions tell Claude to treat both like a tool result and
  that receiving an event is not permission to act.
- **An event is never the person's own words.** The mod hands the line to
  Claude Code with `$.prompt.submit`, without `asUser`. Claude Code shows it as
  "Prompt from the mcp-events plugin" and the model reads it as "The mcp-events
  plugin sent a message: …". It starts a turn only once the session is idle,
  and never joins a turn that is running.
- **Everything else is in the mod's own words.** A server's or the relay's
  error text is never repeated (errors are a code and a fixed name for it).
  Event type and argument names must look like names. A server's description of
  an event type is quoted on one line. Tokens from your config, webhook secrets
  and the relay's keys are removed, where they appear as written, from event
  data, tool results and the log.
- **It connects only where Claude Code does.** Two checks, and both must pass.
  First the mod's own reading of Claude Code's configuration: a server from a
  project's `.mcp.json` is used only in a folder you marked trusted, once
  approved and not rejected; a server switched off stays off; and where an MCP
  allow or deny policy is visible (managed settings, or a list in a settings
  file), the mod connects to nothing. Then Claude Code's own verdict on the
  server in this session (`$.mcp.connect`): the helper is told to leave alone
  any server Claude Code reports as switched off, unapproved, refused by
  policy, not listed, or waiting for a sign-in. The second check is by name:
  the mod cannot ask Claude Code for a server's address, which is why the
  first check stays.
- **A `headersHelper` is run only as Claude Code runs it.** It is a command
  from the server's configuration that prints the headers to send. The mod
  runs it through a shell with a 10 second limit, only for a server that
  passed both checks above, and for a server from the project's `.mcp.json` or
  the local scope only in a trusted folder. A helper that came with the
  repository is not given `ANTHROPIC_*`, `CLAUDE_*` or `MCP_EVENTS_*`
  variables. What it prints is held in memory, never written down, and removed
  from the log and from anything shown. What a failing helper says is not
  repeated.
- **The helper's endpoint is local and closed.** The hooks module reaches the
  helper at `127.0.0.1` on a random port. Every request must carry a 256-bit
  token the helper made at start and said only on its standard output, which
  is a pipe to Claude Code. Without it the answer is `401`. Through it one can
  call the six tools and take this session's event lines, nothing else.
  Variables whose names mark them as credentials an environment carries anyway
  (Claude's, cloud providers', registries' and the like) are never expanded
  into a remote server's address or headers; this goes by name, so it is a
  list, not a guarantee. A local server is started with a small environment,
  not the mod's. A watch saved earlier is not run while its server is one
  this session may not use.
- **It sends `events/*` only to a server that advertised events.** That means
  `io.modelcontextprotocol/events` under `capabilities.extensions` on protocol
  revision 2026-07-28 or later, as the extension defines; or, by default, the
  top-level `events` capability of the design sketch from before the standard
  (the form ChatGPT reads), which the extension does not define.
  `MCP_EVENTS_PRE_STANDARD=off` refuses the second kind. Either way it is
  checked again after every reconnect, and a server that advertised neither is
  sent nothing. A server of the earlier form gets no more trust: its events
  are shown as data like any other's, and its webhooks are verified the same
  way.
- **Webhooks are verified by the mod.** Each subscription has its own
  secret, made by the mod and given only to the MCP server. A delivery is
  taken only if its Standard Webhooks signature verifies, its timestamp is
  within five minutes of when it was received, and it has not been taken
  before. A verification challenge is echoed only if its signature verifies.
- **The relay holds no secret.** It cannot make an event up, and a delivery it
  alters or replays is refused. A mailbox opens only with its key, and a relay
  with an access key set refuses connections without it; a relay with none
  refuses everyone unless opened on purpose (`OPEN_RELAY`).
- **Bounds.** One event or webhook delivery is at most 256 KiB, one answer from
  a remote server 4 MiB (one message of it, for an event stream), one session's
  stored events 64 MiB. Malformed input from a server or the relay is dropped
  without stopping the mod. An event is flushed to disk before it is
  acknowledged. State files that hold secrets are readable only by you.

## What it does not do

- **It is not a sandbox, and it does not judge what Claude does next.** Claude
  Code's permissions are the boundary.
- **A relay's operator can read event payloads.** Webhooks are signed, not
  encrypted. With a relay of your own that operator is you. The public relay
  (`MCP_EVENTS_RELAY=public`) is run by the author of this mod and is never
  used unless you set that by name; with it, your webhook-delivered payloads
  pass through his server and are stored there until collected, for 24 hours
  at most. He could read them. He could not forge or alter one: the signing
  secret stays on your machine and the mod checks every delivery. Push and
  poll never touch any relay.
- **Anyone who learns a webhook address can post junk to it.** The mod drops
  it, but while Claude Code is closed nothing clears the mailbox, so enough
  junk fills it and genuine deliveries are answered `503` until the mod next
  connects. Treat a webhook address as a secret.
- **A challenge is echoed by the mod with the relay in
  [`mod/relay/`](mod/relay/).** A server cannot tell that relay from one that
  echoes challenges itself.
- **Delivery is at least once, with one exception.** A crash between writing
  an event and saving the watch can show it twice after a restart. Two sessions
  on one project can overlap briefly if one is suspended at the wrong moment.
  The exception: a webhook delivery that could not be stored is tried again
  when the mod next connects to the relay, and if deliveries signed more
  than ten minutes later were taken in between, it is refused as too old.
  Where the server keeps history, the watch's cursor recovers it.
- **Policy it cannot see.** A managed policy delivered through the Windows
  registry is invisible to the mod's own reading of the configuration. Claude
  Code's verdict still keeps it from a server such a policy refuses.
- **On Windows it does not check who may read its settings and state files.**
  Elsewhere it refuses a relay settings file that others can read and writes
  its own files for the user alone; on Windows those permission bits do not
  exist, and the files are as private as the user's profile folder.
- **It does not do OAuth, and holds no grant.** A server reached only through
  Claude Code's interactive sign-in is not reachable by the mod. See
  [`docs/sign-in.md`](docs/sign-in.md).
- **A folder you trust can configure it**, as it can configure Claude Code: its
  settings may set this mod's environment variables. The mod refuses a
  servers file (`MCP_EVENTS_CONFIG`) inside the project or its repository as a
  guard against a careless setting, not as a boundary: a trusted folder can
  already run commands through hooks.
- **A watch's note is whatever the session that set the watch wrote.** It is
  shown with each event as "Note saved with this watch".
- **A local (stdio) server's output is not size-limited.** It is a program you
  chose to run.

## How it is tested

- **Automated tests.** From `polyfills/claude-code/events`: `npm test` (the
  mod) and `cd mod/relay && npm test`
  (the relay, in the local Workers runtime over real HTTP and WebSockets)
  cover: forged, altered and replayed deliveries; a relay that sends hostile or
  malformed frames; hostile names, descriptions and schemas; unapproved,
  rejected and untrusted project servers; each of Claude Code's refusals of a
  server; credential variables in server configs; managed policy in each place
  it can live; a child server's environment; a `headersHelper`'s environment
  and its failures; the local endpoint without its token; ownership of a
  project's watches; a full event store; and oversized responses and headers.
- **Conformance.** Every client-side rule of SEP-3415, clause by clause:
  [`docs/conformance.md`](docs/conformance.md).
- **No independent audit.** The Events client, webhook verification and the
  relay were reviewed adversarially during development and the findings fixed
  or listed above. The hooks module, the helper's local endpoint and
  `headersHelper` support are newer and have tests only. Nobody outside the
  project has audited any of it.

This software wakes an agent on outside input, and it is young. The lists
above say what was considered, not that nothing is left.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use **Report a
vulnerability** on this repository's
[Security tab](https://github.com/idosal/MCPolyfill/security/advisories/new)
(GitHub's private reporting), with what you did, what happened, and the
versions of Claude Code and of the mod. If that is not available to you, open
an issue that says only that you have a security report, and you will be
contacted.
