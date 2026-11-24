# What Claude Code would need, and what each addition would remove here

This mod is a polyfill: it implements the client side of the MCP Skills
extension (SEP-2640) outside Claude Code, because Claude Code does not support
the extension yet, and it is built to shrink as Claude Code gains the pieces.

Mods that implement an MCP extension keep running into the same four gaps in
what Claude Code offers a mod. This page says, for the Skills extension, which
of the four it needs and what each would take out of this polyfill. Line
counts are of the files at version 0.3.1.

Short version: **Skills needs the first and the second. It has no use for the
third or the fourth.** The numbering is the one in the repository's
[`docs/host-changes.md`](../../../../docs/host-changes.md).

| # | Host change | Used by Skills? | What it would remove |
|---|---|---|---|
| 1 | `$.mcp.request(server, method, params)` over Claude Code's own connection | **Yes. This is the one that matters.** | The second connection, server discovery, the OAuth limit, and probably the helper process |
| 2 | Reading what the server advertised | Yes, unless change 1 can send `server/discover` | The capability tap in `src/wire.ts` (already counted under 1) |
| 3 | Server notifications delivered to the mod | No | Nothing |
| 4 | Raw tool results in hooks; declaring a client extension | No | Nothing |

## 1. `$.mcp.request(server, method, params)`

(`$.mcp.request` is a name for a call that does not exist today. What exists is
`$.mcp.call`, which sends a tool call and nothing else.)

The extension adds three client-to-server methods (`skills/list`, `skills/get`,
`resources/directory/read`) and reads files with the base protocol's
`resources/read`. A mod can send none of the first three today: `$.mcp.call`
sends tool calls only, and the built-in resource tools send `resources/list`
and `resources/read` only. So the mod opens a connection of its own to each
server, which is where most of the limits in the README come from.

With such a call:

- **[`src/wire.ts`](../src/wire.ts) goes (301 lines):** the second connection,
  its transports, running a server's `headersHelper`, the fallback for servers
  from before 2026-07-28, patience with rate limits, its bound on response
  size, and the tap that reads raw capabilities off the handshake.
- **[`src/config.ts`](../src/config.ts) goes (319 lines):** working out which
  servers Claude Code is configured with, whether the folder is trusted, whether
  a project server is approved, how `${VAR}` expands, and whether a managed
  policy is in force. The mod would name a server and Claude Code would decide.
- **The verdict round trip goes** (about 40 lines across
  [`mod/hooks/register.ts`](../mod/hooks/register.ts), [`src/helper.ts`](../src/helper.ts)
  and [`src/app.ts`](../src/app.ts)): asking `$.mcp.connect` about each server
  before the helper may connect to it. So does remembering which servers serve
  skills (so the rest are not connected to at every start): there would be no
  second connection to avoid.
- **The limits go:** servers behind an OAuth sign-in work, because the request
  rides the connection that holds the sign-in, and so do claude.ai connectors
  and servers a plugin brings. A local server is no longer started twice.
  Machines with a managed MCP policy are no longer excluded.
- **The helper process probably goes too** ([`src/helper.ts`](../src/helper.ts),
  287 lines, the bundle in `mod/dist/`, the need for Node or Bun on the user's machine, and
  with it [`mod/hooks/runtime.ts`](../mod/hooks/runtime.ts), which fetches Bun where there is neither).
  The extension's logic, [`src/skills.ts`](../src/skills.ts) (681 lines), is
  written against one small interface, `Wire` (a label, the capabilities, the
  revision, and `request(method, params)`), and uses nothing of Node: hashing is
  WebCrypto, and a test fails if a Node import appears in it. A hooks module on
  Claude Code 2.1.329 has `crypto.subtle`, `TextEncoder` and `atob`. So that file
  should run inside the hooks module with `$.mcp.request` as its `Wire`. **This
  has not been tried**: whether the `yaml` package loads in a hooks module, and
  whether a hook may run long enough to hash a 16 MiB file, are open.

What stays whatever happens: `src/skills.ts` and its tests (the extension's
client rules), `src/format.ts` (what the model reads), the four tools, the
listing hook, the approval of a skill and its store, the preview panel, and
the permission gates in `mod/hooks/register.ts`.

What the call has to do for this to work, exactly:

1. Send any method name, not a fixed set, on the connection Claude Code holds,
   with the request metadata the 2026-07-28 revision requires.
2. Return the result as the server sent it, unknown fields included
   (`skills`, `skill`, `nextCursor`, `ttlMs`, and for `resources/read` the
   `blob` of a binary file, which the built-in read tool replaces with a path).
3. Surface a JSON-RPC error with its code. `-32602` from `skills/get` means "no
   such skill", and the mod answers differently for it.

## 2. Reading what the server advertised

Used. Two client rules depend on what the server declared:
`skills/list` and `skills/get` are sent "only after observing the server's
declaration", and `resources/directory/read` only where the declaration carries
`directoryRead: true`. The mod also checks that the connection is on revision
2026-07-28 or later. Today it reads all three off its own connection.

Over Claude Code's connection a mod can observe none of this. That, more than
the missing request call, is why nothing is offered over Claude Code's
connection today: even a mod that could somehow send `skills/get` would break
the first rule by sending it blind.

If change 1 can send `server/discover` (a normal request on the 2026-07-28
revision, whose result is the server's capabilities), change 1 covers this by
itself, and a server that does not answer it is simply not on a revision the
extension is specified for. A direct read (`$.mcp.capabilities(server)` or the
like, with the negotiated revision) would be cleaner and would save a round
trip per server.

## 3. Server notifications delivered to the mod

Not used. The Skills extension defines no server-to-client message at all: no
`list_changed` of its own, no stream. Freshness is a `ttlMs` hint on each
result, and a changed file is caught when it is read and fails verification.

A server may send the base protocol's `notifications/resources/list_changed`
when its skill set changes (the official TypeScript SDK's server does). The
specification asks nothing of a client about it. A mod that received it could
re-list a little sooner than the `ttlMs` says; that is a nicety, not a
requirement, and the mod does not need it.

## 4. Raw tool results in hooks; declaring a client extension

Not used. A skill is never delivered as a tool result of the server's: it is a
set of resources, listed by `skills/list` and read with `resources/read`.

**Declaring a client extension:** not used either. The specification has the server
declare; it asks nothing of a client's capabilities, and its request examples
carry `"io.modelcontextprotocol/clientCapabilities": {}`. One server in
`ext-skills/docs/implementations.md` (Tachyon) is noted as requiring clients to
advertise the extension, which is outside the specification.

## What the four do not cover

Three things this mod works around are outside the four changes. They are
listed so the count above is not read as "one call and it is native".

- **A way to add a skill to Claude Code's own skill registry.** The mod appends
  its skills to the text of the session's skill listing (`prompt.attachment`,
  type `skill_listing`) and loads them through a tool of its own, because the
  Skill tool cannot be given a skill that has no file. Claude Code's types
  already name `mcp` as a skill source; a mod cannot produce one.
- **Knowing when a loaded skill leaves context.** The specification's acting
  window ends when `SKILL.md` leaves context at the earliest. The mod cannot see
  compaction drop a tool result, so it holds the window until `/clear`, which
  the specification allows and which asks the person more often than it must.
- **Saying, in the permission dialog itself, why a call is asked about.** The
  mod's question for a skill carries a reason (how many files, that the yes is
  remembered, how to read the skill first). Claude Code's dialog for a tool a
  mod registered shows the call and the tool's description, not that reason,
  so the first lines of the tool's description carry the general part of it.

## Standing down

A polyfill should do nothing once the host does the job. There is no documented
way today for a mod to ask Claude Code "do you support extension X". The mod
does two things instead:

- Disabling the plugin, or the environment variable `MCP_SKILLS_OFF=1`, turns
  it off completely.
- It watches `skill.prompt`, which Claude Code raises when it expands a skill.
  The published types say a skill's `source` is `mcp` when it "comes from a
  server". If the mod ever sees one, Claude Code is serving MCP skills itself,
  and the mod turns itself off for the session and says so. This is tested in
  Claude Code's test kit by raising the event; it has not been seen in a real
  build, because no public build serves MCP skills.
