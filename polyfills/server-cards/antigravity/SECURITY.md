# Security

This covers `mcp-server-cards` for Google Antigravity. The
[Claude Code](../claude-code/SECURITY.md), [Codex](../codex/SECURITY.md) and
[Pi](../pi/SECURITY.md) forms use the same discovery and card rules, with
their own host adapters.

The plugin reads documents strangers publish and turns a card the person
approves into an Antigravity MCP entry. Catalogs and cards are untrusted data,
including their descriptions. A card is advisory, never authority for a
security decision.

## What is trusted

- **You:** your answer in Antigravity's own approval card.
- **Antigravity:** its approval card, its hooks, its MCP connection and its
  sign-in.
- **The plugin's state folder**, `~/.gemini/agentpolyfill/mcp-server-cards/`.
  Anything that can write it, or run the plugin's hook as you, can make a
  ticket (seen live with the Events form's hook: a ticket made by running the
  hook command by hand was accepted once). It could also edit
  `mcp_config.json` directly. Antigravity's terminal sandbox, on by default,
  keeps the agent's commands to the workspace and temporary folders; a
  command run outside it (you approved it, Auto mode judged it safe, or the
  sandbox is off, as in Turbo) can reach both.
- **Not the publisher or the model:** neither can supply a URL to add. The
  card must have been shown by `discover_mcp_servers` within the hour, and the
  URL it yields must equal the URL in the call.

## The boundary: Antigravity's approval card

Antigravity's MCP client declares elicitation but cancels every request
without showing it (seen live, App 2.35.1 and CLI 1.5.16). So an addition is
put to you through the plugin's `PreToolUse` hook:

- **Which calls the hook sees.** `add_mcp_server` is eager
  (`plugin/mcp_config.json`), and the matcher takes its eager name,
  `mcp_mcp-server-cards_cards_add_mcp_server`, and nothing else. The hook is
  never handed another server's call. Called through `call_mcp_tool` instead,
  it doesn't reach the hook, carries no ticket, and is refused.
- **The question.** The hook works out exactly what would be written and
  answers `force_ask`. Antigravity then shows its approval card with the
  plugin's question: the host and the name first, then the URL, the header
  names and the file, then the header values, where the card came from and
  how to undo it. The CLI's card shows the first two lines and hides the rest
  (seen live); the App's shows it all. `force_ask` ignores any "always allow"
  you set; the App greys those choices out, the CLI still lists them.
- **What the arguments say.** The call must name the entry's name, URL,
  header names and file in its own arguments, and both the hook and the
  server refuse a call whose arguments say anything else. An editor connected
  to `agy acp` shows the person only a tool's name and arguments, so that is
  what they approve there; the provenance and the undo aren't shown in an
  editor.
- **The ticket.** The hook leaves a one-use ticket for that exact entry and
  adds it to the call. Its file is named by the nonce's SHA-256; it is good
  for an hour at most, and the plugin's `Stop` hook removes a conversation's
  unused tickets when its turn ends. A question declined or never answered
  leaves its ticket until that conversation's next turn ends normally (a
  decline in the CLI interrupts the turn, and closing the CLI runs no `Stop`),
  or the hour. The MCP server writes only with that ticket, unused, for the
  same entry. While the hook runs, it replaces any ticket a call carries.
- **Nothing is auto-approved:** the hook never answers `auto_approve` and sets
  no permission overrides. `discover_mcp_servers`, which only reads, isn't
  gated and goes through Antigravity's usual approval for MCP tools.
- **When the hook can't run.** In CLI 1.5.17 a `PreToolUse` hook that exits
  non-zero, times out or prints something that isn't JSON makes Antigravity
  fail the call (seen live). The hook always exits 0 with JSON: `allow` for a
  call that isn't the plugin's or that it can't read (whose call it is can't
  be told; an addition then carries no ticket and is refused), `deny` for the
  plugin's own call when it can't open its state or anything else goes wrong.
- **The IDE.** Antigravity documents no plugin hooks for the IDE, so an
  addition there gets no ticket and is refused; the hook also refuses a call
  whose transcript is the IDE's.

Antigravity's defaults ask before an MCP tool (the App's card; the
interactive CLI, which starts in auto mode; headless `agy -p` denies a call
nobody answers; all seen live). `force_ask` asks even where you have allowed
MCP tools. Whether `--dangerously-skip-permissions` also skips `force_ask`
hasn't been checked.

## What the plugin does

### What it fetches

Plain GET requests to the named domain's AI Catalog and home page, then
catalog links, nested catalogs and cards. No conversation, cookie, stored
credential or header from your configuration goes with discovery. Headers
are Accept, If-None-Match where cached, and a User-Agent naming the plugin.

The shared code caps response bodies at 512 KiB and cards at 64 KiB, with 20
cards, three page links and catalogs four deep. Public sources can't point at
literal private or loopback addresses, private host spellings such as
`.local`, or single-label names. Plain HTTP is allowed only for loopback
development. Every redirect is checked under the same rules, at most five
hops. A public name that resolves to a private address is a known gap (Node's
fetch resolves names itself).

### What it reads

- `~/.gemini/config/mcp_config.json`, to refuse a name you already have. That
  file can hold header values (API keys). The plugin keeps the rest of the
  file as it is when it writes, and never logs or shows any value from it. A
  file it can't read as JSON is refused without quoting it: Node's parser
  error can quote a piece of the file.
- Its own folder, `~/.gemini/agentpolyfill/mcp-server-cards/` (0700): the
  cards shown in the last hour, and the tickets.

It never opens `~/.gemini/antigravity/mcp_oauth_tokens.json` or any other
sign-in store, Antigravity's or anyone's.

### What it writes

Only an entry you approved, under `mcpServers` in
`~/.gemini/config/mcp_config.json`: `{"serverUrl": ..., "headers": {...}}`.
It writes the whole file in one step (a temporary file, then a rename),
reading it again just before, and keeps its permissions. It refuses a name you
have, in any case, before the question and again before writing. It never
writes a secret: a card that needs one (an API key in a header or the URL) is
refused, because Antigravity's personal file reads no `${VAR}`. You add such a
server by hand. Uninstalling leaves the entries you added and the plugin's own
folder.

### Text

Shared validation refuses control characters, direction marks, userinfo and
markup in URLs, and unsafe variable substitutions. Other characters that show
as nothing (a soft hyphen, variation selectors, tag characters) don't get a
card refused, but they're taken out of everything shown, and a header value
that would be written holding one is refused, so the value written is the
one you were asked about.

## What it does not protect against

- A server misbehaving after it's added. Antigravity's own handling of that
  server and its tools governs from then on.
- An approval given without reading the card, or answered by an editor on the
  person's behalf.
- Another program writing `mcp_config.json` at the very same moment: one of
  the two writes could be lost. (A write by Antigravity's `agy mcp add` while
  the question was open was kept, seen live.)
- Disagreement between a card and the live server: the plugin can't send
  `server/discover` over Antigravity's connection.
- Anything that can write the plugin's state folder, as above.

## Reporting

Report privately through this repository's **Security → Report a
vulnerability** form on GitHub. Name `mcp-server-cards`, the Antigravity
form, the Antigravity surface and version, and the domain or card. Don't
include credentials.
