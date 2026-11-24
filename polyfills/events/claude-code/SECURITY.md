# Security

This covers mcp-events for Claude Code. The Codex form has its own:
[SECURITY.md](../codex/SECURITY.md).

"The mod" below means this Claude Code plugin. It has two parts: a hooks
module that runs inside Claude Code (`mod/hooks/register.ts`), and a helper
process it starts (`mod/dist/helper.js`), which holds the Events client.

## The model

An event is data from an MCP server you configured. The Events extension asks
that it be handled with "the same caution as tool results". The mod does that
in two parts:

- What the server sent (the payload) reaches Claude only as a tool result,
  when Claude reads it with `get_event` or `recent_events`.
- The message that wakes the session isn't a tool result. It's a prompt from
  the plugin, which is the only way a mod can start a turn. So it carries no
  event content: it says which watch has new events, how many and their ids,
  names the server and the event type, and repeats the watch's note.

Receiving an event gives Claude no permission it didn't already have.
Whatever Claude does about one goes through Claude Code's own permission mode,
rules and hooks. The mod adds no policy of its own on top.

The other difference from a tool result is timing. An event arrives without
anyone asking, and wakes an idle session. If that session runs in a mode that
approves actions without asking, an event from a server can lead to actions
without a prompt, as a tool result from the same server could. How often that
can happen is bounded (see "Events wake a session only so often" below), not
prevented.

## What the mod does

- **What a server sent is read as a tool result.** The message that wakes a
  session names the server and the event type as you configured and watched
  them. It says how many events are new, gives their ids, and repeats the note
  Claude saved when it set the watch. It carries no payload text.
  - `get_event` returns a payload in full, and `recent_events` a few short
    fields of each event (flattened to one line, quoted, cut short). Both are
    tool results from that server.
  - The mod's instructions tell Claude that receiving an event isn't
    permission to act.
  - `MCP_EVENTS_WAKE_VALUES=1` puts those few short fields back into the wake
    message. That's yours to choose, and it puts text a server wrote into a
    prompt.
- **Events wake a session only so often.** A watch can start a wake at most
  once a minute. Events that come sooner wait and are announced together, in
  one message that may also announce what other watches have waiting. A
  session is woken at most 30 times in an hour. When the next wake would pass
  that, the session is told once that events are waiting. It isn't woken again
  until the person sends a message of their own. Nothing is dropped.
  - `MCP_EVENTS_WAKE_GAP_S` and `MCP_EVENTS_WAKES_PER_HOUR` change the two
    numbers, and 0 turns either off.
  - To know when the person has spoken, the hooks module is told of each
    prompt as it's submitted. It looks only at where the prompt came from,
    never at its text.
- **An event is never the person's own words.** The mod hands the message to
  Claude Code with `$.prompt.submit`, without `asUser`. Claude Code shows it as
  "Prompt from the mcp-events plugin", and the model reads it as "The
  mcp-events plugin sent a message: …". It starts a turn only once the session
  is idle, and never joins a turn that is running.
- **Everything else is in the mod's own words.**
  - A server's or the relay's error text is never repeated. Errors are a code
    and a fixed name for it.
  - Event type and argument names must look like names.
  - A server's description of an event type is quoted on one line.
  - Tokens from your config, webhook secrets and addresses, the mailbox's key
    and the relay's access key are removed, where they appear as written. They
    are removed from every tool result, from the messages that wake a session,
    from the instructions and from the log.
- **It connects only where Claude Code does.** There are two checks, and both
  must pass.
  - First, the mod's own reading of Claude Code's configuration. A server from
    a project's `.mcp.json` is used only in a folder you marked trusted, once
    approved and not rejected. A server switched off stays off. Where an MCP
    allow or deny policy is visible (managed settings, or a list in a settings
    file), the mod connects to nothing.
  - Then, Claude Code's own verdict on the server in this session
    (`$.mcp.connect`). The helper is told to leave alone any server Claude
    Code reports as switched off, unapproved, refused by policy, not listed,
    or waiting for a sign-in.
  - The second check is by name. The mod can't ask Claude Code for a server's
    address, which is why the first check stays.
  - A watch saved earlier isn't run while its server is one this session may
    not use.
- **A `headersHelper` is run only as Claude Code runs it.** A `headersHelper`
  is a command from the server's configuration that prints the headers to
  send.
  - The mod runs it through a shell with a 10 second limit, only for a server
    that passed both checks above. For a server from the project's
    `.mcp.json` or the local scope, it runs only in a trusted folder.
  - A helper that came with the repository isn't given `ANTHROPIC_*`,
    `CLAUDE_*` or `MCP_EVENTS_*` variables.
  - What it prints is held in memory, never written down, and removed from the
    log and from anything shown. What a failing helper says isn't repeated.
- **The helper's endpoint is local and closed.** The hooks module reaches the
  helper at `127.0.0.1` on a random port. Every request must carry a 256-bit
  token that the helper made at start and said only on its standard output,
  which is a pipe to Claude Code. Without it the answer is `401`. Through it
  one can call the six tools and take this session's event lines, nothing
  else.
- **What reaches a server from your environment.** Variables whose names mark
  them as credentials an environment carries anyway (Claude's, cloud
  providers', registries' and the like) are never expanded into a remote
  server's address or headers. This goes by name, so it is a list, not a
  guarantee. A local server is started with a small environment, not the
  mod's.
- **It sends `events/*` only to a server that advertised events.**
  - That means `io.modelcontextprotocol/events` under
    `capabilities.extensions` on protocol revision 2026-07-28 or later, as the
    extension defines.
  - Or, by default, the top-level `events` capability of the design sketch
    from before the standard (the form ChatGPT reads), which the extension
    doesn't define. `MCP_EVENTS_PRE_STANDARD=off` refuses this second kind.
  - Either way it's checked again after every reconnect, and a server that
    advertised neither is sent nothing.
  - A server of the earlier form gets no more trust. Its events are shown as
    data like any other's, and its webhooks are verified the same way.
- **Webhooks are verified by the mod.** Each subscription has its own secret,
  made by the mod and given only to the MCP server. A delivery is taken only
  if its Standard Webhooks signature verifies, its timestamp is within five
  minutes of when it was received, and it hasn't been taken before. A
  verification challenge is echoed only if its signature verifies.
- **The relay holds no signing secret.** It can't make an event up, and a
  delivery it alters or replays is refused.
  - It does receive two bearer keys when the mod connects: the mailbox's key
    (the mailbox's name is that key's hash, so the relay stores none), and the
    relay's access key, if it has one.
  - A mailbox opens only with its key. A relay with an access key set refuses
    connections without it. A relay with none refuses everyone, unless it was
    opened on purpose (`OPEN_RELAY`).
  - A mailbox key is used only with the relay it was made for.
  - There is one mailbox, and one key, per MCP server in a project. Each is a
    connection of its own while Claude Code is open.
  - The relay says when a delivery arrived, and the freshness check takes its
    word. So a delivery from the public relay is refused if it was signed more
    than 25 hours ago (its retention and an hour), whatever the relay says.
    From your own relay, the bound is eight days.
  - A relay that sends a frame larger than any delivery can be loses the
    connection. Node's WebSocket reads that one frame whole first: it has no
    limit on a message's size to set.
- **The one thing it downloads.** Nothing, unless you run `/mcp-events setup`
  on a machine that has no Node and no Bun, and answer Download to the
  question it then puts in Claude Code's own dialog. "Not now" is the first
  answer, so a dialog that closes by itself is a no. Then:
  - It downloads one fixed Bun release from GitHub over HTTPS (`curl`, with
    HTTPS also required of any redirect).
  - It hashes the archive inside the mod (no checksum program on your PATH is
    trusted), and compares the SHA-256 with the value written in
    [`mod/hooks/runtime.ts`](mod/hooks/runtime.ts) for that platform.
  - Only on a match is one named file unpacked, checked to answer with the
    expected version, and moved into the plugin's data folder
    (`~/.claude/plugins/data/mcp-events-mcp-events/runtime`). Otherwise the
    download is deleted and nothing of it is run. A file that can't be deleted
    is left not runnable, and you're told where it is.
  - The command is honoured only from your own input: typed at the prompt, or
    sent from your own Remote Control. Claude can't run it, and neither can a
    script, another session or `claude -p`. Two sessions can't fetch at once.
    No server or event can change what is downloaded or from where.
  - The SHA-256 is checked when the copy is fetched, not each time it runs.
    Only the copy of the pinned version is ever run. A copy of any other
    version put in that folder is never run, not even to ask its version.
  - `/mcp-events setup remove` deletes it. A newer Bun arrives only with a
    newer version of the mod, and only when you run the command again.
- **Bounds.**
  - One event or webhook delivery is at most 256 KiB, measured by the mod
    whether it came directly or through a relay.
  - A cursor is at most 16 KiB.
  - One answer from a remote server is at most 4 MiB (one message of it, for
    an event stream).
  - One session's stored events are at most 64 MiB.
  - Deliveries from a relay waiting to be checked are at most 24 MiB.
  - Malformed input from a server or the relay is dropped without stopping the
    mod.
  - An event is flushed to disk before it's acknowledged.
  - State files that hold secrets are readable only by you.

## What it does not protect against

- **It isn't a sandbox, and it doesn't judge what Claude does next.** Claude
  Code's permissions are the boundary.
- **A relay's operator can read event payloads.** Webhooks are signed, not
  encrypted. With a relay of your own, that operator is you.
  - The public relay (`MCP_EVENTS_RELAY=public`) is run by the author of this
    mod, and is never used unless you set that by name.
  - With it, your webhook-delivered payloads pass through his server and are
    stored there until collected, for about a day at most. An uncollected
    delivery is dropped after 23 hours by a clear-out that runs hourly.
  - He could read them. He couldn't forge or alter one: the signing secret
    stays on your machine, and the mod checks every delivery.
  - Push and poll never touch any relay.
- **Anyone who learns a webhook address can post junk to it.** The mod drops
  it. But:
  - A mailbox holds 500 deliveries or 16 MiB by default on your own relay, and
    100 or 4 MiB on the public one. While Claude Code is closed, nothing
    collects from it.
  - So enough well-formed junk to one address fills its mailbox. Genuine
    deliveries to that mailbox's addresses are then answered `503`, until the
    mod next connects or the junk reaches the end of its retention time.
  - From 0.7.0, each MCP server has a mailbox of its own in each project. So a
    server you watch can do this only to its own watches, not to another
    server's. Until 0.6.0 a project's watches shared one mailbox, so it could.
    A watch made then moves to its server's own mailbox the next time it runs.
    Until it has, it's still in the shared one.
  - Someone else who learns one of your addresses can still fill that
    address's mailbox.
  - On the public relay, each address also has a delivery allowance of its
    own, and junk to an address that doesn't exist uses up nothing.
  - Treat a webhook address as a secret.
- **It doesn't stop a server you watch from waking the session.** Within the
  wake limits above, any server you watch wakes an idle session whenever it
  sends an event. Stopping the watch stops it.
- **The public relay can be abused, and has a cost.**
  - It's rate-limited per sender (an IPv4 address, or an IPv6 /64), it
    refuses what it can't limit, and it opens at most 2,000 new mailboxes in
    an hour, 60 from one sender and 200 from one network (an IPv6 /48). It
    holds at most 20,000 mailboxes at once.
  - Someone with enough networks (ten /48s, or many IPv4 addresses) can spend
    the hourly ceiling and keep new users out until the hour is over.
    Mailboxes that already exist keep working.
  - The same person can also fill the 20,000 and keep it full: about ten
    hours to fill, and one reconnect a week per mailbox to hold it. New users
    are then refused until the operator blocks those mailboxes; existing
    users aren't affected.
  - MCP servers hosted on Cloudflare Workers reach it from one address, so
    their deliveries are counted per mailbox. Junk a Worker sends elsewhere
    can't use up what your mailbox may receive.
  - Anyone can store data in a mailbox of their own on it, as on any open
    relay; the relay can't tell an event from anything else shaped like one.
    Its front page names where to report abuse, and its operator can block a
    mailbox.
  - Its operator pays for it and may switch it off. Requests anyone sends it
    count against its Cloudflare account's quotas and bill, whether or not
    the relay refuses them.
- **A challenge is echoed by the mod with the relay in
  [`mod/relay/`](mod/relay/).** A server can't tell that relay from one that
  echoes challenges itself.
  - Every challenge the mod doesn't confirm gets the same answer (`503`), so
    whoever posts one without the secret learns nothing from the answer
    about whether Claude Code is open. How long the answer takes still
    differs.
- **Delivery is at least once.**
  - If Claude Code closes or crashes just after a batch of events was handed
    to it and before that was saved, the next session in the project is shown
    the batch again.
  - Two sessions on one project can overlap briefly if one is suspended at the
    wrong moment.
  - A webhook delivery that couldn't be stored is tried again when the mod
    next connects to the relay. It's refused only if more than 1,000 later
    deliveries to the same watch were taken in between, or if it was signed
    more than eight days ago. Then its event is lost, unless the server can
    replay it.
- **Policy it can't see.** A managed policy delivered through the Windows
  registry is invisible to the mod's own reading of the configuration. Claude
  Code's verdict still keeps it from a server such a policy refuses.
- **On Windows it doesn't check who may read its settings and state files.**
  Elsewhere it refuses a relay settings file that others can read, and writes
  its own files for the user alone. On Windows those permission bits don't
  exist, and the files are as private as the user's profile folder.
- **It doesn't do OAuth, and holds no grant.** A server reached only through
  Claude Code's interactive sign-in isn't reachable by the mod. See
  [`docs/sign-in.md`](docs/sign-in.md).
- **A folder you trust can configure it**, as it can configure Claude Code. Its
  settings may set this mod's environment variables, `MCP_EVENTS_RUNTIME` (the
  program that runs the helper) among them. The mod refuses a servers file
  (`MCP_EVENTS_CONFIG`) inside the project or its repository. That is a guard
  against a careless setting, not a boundary: a trusted folder can already run
  commands through hooks.
- **A watch's note is whatever the session that set the watch wrote.** It's
  shown with each event as "Note saved with this watch".
- **A local (stdio) server's output isn't size-limited.** It's a program you
  chose to run.

## How it is tested

- **Automated tests.** From `polyfills/events/claude-code`, `npm test` tests
  the mod, and `cd mod/relay && npm test` tests the relay, in the local Workers
  runtime over real HTTP and WebSockets. They cover:
  - forged, altered and replayed deliveries;
  - a relay that sends hostile or malformed frames;
  - hostile names, descriptions and schemas;
  - unapproved, rejected and untrusted project servers;
  - each of Claude Code's refusals of a server;
  - credential variables in server configs;
  - managed policy in each place it can live;
  - a child server's environment;
  - a `headersHelper`'s environment and its failures;
  - the local endpoint without its token;
  - ownership of a project's watches;
  - a full event store;
  - oversized responses and headers.
- **Conformance.** Every client-side rule of SEP-3415, clause by clause:
  [`docs/conformance.md`](docs/conformance.md). The upstream conformance
  suite's Events client scenarios (an unmerged pull request) pass 17 of 17.
- **Property-based tests** (`test/properties-test.ts`) run on generated inputs
  over what a server, a relay or anyone on the wire sends first reaches:
  signatures, delivery judging, the replay memory, routing headers, schemas,
  the wake message, the redactor and the wake budget. They also cover the rule
  for which servers may be sent `events/*`, over all of its cases.
- **A formal model** of delivery and of waking ([`model/`](model/README.md)),
  in Quint and in TLA+. It is simulated, and model-checked with TLC to small,
  stated bounds (webhook with one event, or two with the clock stopped). TLC
  checks the model, not the code, and says nothing past its bounds.
  - On 0.5.0's model it found three cases the simulation had missed.
  - Two were in the code too: the notice that waking stopped was given again
    after a helper restart, and an event was shown again after Claude Code was
    closed and reopened, if the helper stopped at the wrong moment. 0.5.1
    fixes both, each with a test that fails on 0.5.0.
  - The third was in the model only, which now does as the code does.
  - On 0.5.1's model every invariant holds within those bounds. One of them
    allows the case described under "Delivery is at least once".
- **Two reviews from outside the sessions that built it, and no audit by a
  person.** The Events client, webhook verification and the relay were
  reviewed adversarially during development. On 24 November 2026 an AI
  reviewer that hadn't built any of it reviewed the mod and the public relay.
  What it found is fixed in versions 0.4.0 and 0.4.1, each fix with a test, or
  listed above. Later that day another reviewed the relay alone, with
  attacks in [`mod/relay/test/adversarial-test.ts`](mod/relay/test/adversarial-test.ts)
  (two tenants, an outsider, a malicious MCP server, a hostile relay). It
  found no way to read another user's mailbox or to forge an event. What it
  found is fixed in 0.7.2 and in the relay, each fix with a test, or listed
  above. No person has audited any of it.

This software wakes an agent on outside input, and it is young. The lists
above say what was considered, not that nothing is left.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use **Report a
vulnerability** on this repository's
[Security tab](https://github.com/idosal/AgentPolyfill/security/advisories/new)
(GitHub's private reporting). Say what you did, what happened, and the
versions of Claude Code and of the mod. If that isn't available to you, open
an issue that says only that you have a security report, and you'll be
contacted.
