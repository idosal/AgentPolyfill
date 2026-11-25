# Security

This covers `mcp-server-cards` for Codex. The other forms have their own:
[Claude Code](../claude-code/SECURITY.md), [Pi](../pi/SECURITY.md), [OpenCode](../opencode/SECURITY.md). Where this file says nothing
different, the Claude Code form's SECURITY.md applies.

This plugin reads documents that strangers publish on the web: catalogs and
Server Cards. It turns one of those cards into an entry in your Codex MCP
configuration. Every rule below follows from that. What a catalog or card says
is someone else's claim, read before any connection. Codex's own permissions
and sign-in are the boundary, and the plugin adds no policy of its own beyond
asking you.

Both forms run the same card, discovery and configuration code. This file
describes the Codex form, and says where it differs from the Claude Code
form. The client rules and their tests are in the
[README](README.md#client-rules).

## What is trusted

- **You.** The servers you accept in Codex's form.
- **Codex:** its form, its approval settings, its sign-in, and the `codex`
  command.
- **Not the publishers.** A catalog can list anything, and a card can claim
  anything. The SEP says a card is advisory and never authoritative for
  security decisions.
- **Not Codex's model.** It decides when to call the tools and what to pass.
  Nothing it passes is written without your accept, and a URL is never taken
  from it: only from a card a tool showed in this session.

## What the plugin does

### What it fetches

It makes plain `GET`s with Node's `fetch`, with only `Accept`, `If-None-Match`
and a `User-Agent` naming the plugin: no cookies, no credentials. For a domain
Codex names, it reads `/.well-known/ai-catalog.json`, that domain's home page
for `rel="ai-catalog"` links, and the cards and nested catalogs those name. It
sends nothing to a third party.

Every answer is read up to 512 KiB and no further, a card up to 64 KiB. It
reads at most 20 cards and 3 page links, and catalogs 4 deep.

### Where it won't go

- A public catalog or card can't send it to a local or private address:
  `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local,
  unique-local, `.local` and `.internal` names, and single-label names. That
  holds whatever the spelling (`0x7f.1`, a trailing dot).
- **Neither can a redirect.** The plugin follows redirects itself
  (`redirect: 'manual'`), at most five, and holds each hop to the same rule:
  HTTPS, plain HTTP only from loopback to loopback, and no step from a public
  origin to a private one. The Claude Code form can't do this, because Claude
  Code's fetch follows redirects without saying where.
- Plain HTTP is used only for a loopback address you name yourself, for local
  development.

### Text that displays as something else

The rules are the same in both forms:

- A card holding a control character or an invisible formatting or direction
  mark is refused.
- Other characters that show as nothing don't get a card refused (an emoji's
  variation selector is one), but they're taken out of everything shown, to
  you and to the model: a soft hyphen, variation selectors, and tag
  characters, which can carry text nobody sees. A line separator is shown as a
  space.
- A remote URL must be printable ASCII, with no `` ` ``, `<`, `>` or square
  brackets outside an IPv6 host. So must every other URL from a card or a
  finder that is shown (security review C1). So a host that renders the form
  as Markdown or HTML can't show a link text in place of the URL.
- No URL may name a user before its host or hold a backslash. Either one shows
  one host and connects to another (C3). The form names the host first, since
  some clients join its lines, and again on a line of its own.
- A card's fixed header values hold no markup (C4).
- A header value that would be written, from the card or given, is refused if
  it holds a character that shows as nothing, so the value written is the one
  you were asked about.
- Everything shown passes a plain-text filter, line by line.

### What it writes

Only Codex's MCP configuration, `$CODEX_HOME/config.toml`
(`~/.codex/config.toml`), one server at a time, and only after your accept.

- **Who decides:** you, in the form Codex shows (MCP elicitation). It names
  the server, the URL, the headers, the file and the undo command.
  - The form is one required choice, **Don't add it** or **Add it**, and only
    **Add it** adds.
  - Nothing is written if Codex's client offers no form, or if you decline or
    close it, choose **Don't add it**, or send it back without a choice.
  - Under `--ask-for-approval never`, in `codex exec`, and with granular
    `mcp_elicitations = false`, Codex declines the form itself, so nothing is
    written.
  - Codex 0.172 shows a form with a required choice to the person even under
    `--dangerously-bypass-approvals-and-sandbox`. It auto-accepts only forms
    with no fields (`can_auto_accept_elicitation` in
    `codex-mcp/src/elicitation.rs` at `rust-v0.172.0`). More exactly, in that
    mode it shows the form where the Codex client takes form input (it
    declares `openai/standard-form-input`, for a thread the person started).
    Otherwise it declines the form, so nothing is added. This is Codex 0.172's
    behaviour, not something the MCP spec promises, and a later Codex may
    change it.
  - Auto-review doesn't answer the form: it still comes to you.
  - The [README](README.md#which-codex-modes-ask-you) has the table of modes.
- **Never over a server you have.** A name `codex mcp get` knows, or can't
  rule out, is refused, before you are asked and again after.
- **Which server and URL:** only a card a tool showed in this session, and
  only if the URL in the call is the one that card gives.
- **How:** `codex mcp add NAME --url URL [--bearer-token-env-var VAR]`. Other
  headers, which that command can't set, go through `codex app-server`'s
  `config/value/write`, which edits the same file. The arguments are the
  plugin's own: nothing from a card is run, and no shell is involved.
- **Remotes:** a card from a public source may not name a private address.
- **Values:** a value put into a URL holds only letters, digits and
  `. _ ~ -`. No text from a card or from the model may contain `$`.
- **Sign-in:** `codex mcp add` starts a browser sign-in by itself for a server
  that offers OAuth. The plugin stops the command at that point, before any
  registration request, so no browser opens from a tool call. The entry is
  written by then (checked live). You sign in with `codex mcp login NAME`,
  which is Codex's own.

### Secrets

A secret the card asks for never passes through Codex's model, the command
line or the plugin.

- The configuration holds the *name* of an environment variable,
  `MCP_<SERVER>__<INPUT>_<TAG>`, as `bearer_token_env_var` or in
  `env_http_headers`. You set its value. The tag is 80 bits of SHA-256 over the
  card's name and endpoint, so no other card can be given a reference to it.
- A card that needs a secret inside its URL, or mixed into a header with other
  text, is refused. Codex can read a secret only as a whole header value or a
  bearer token.
- A card that sets a secret's value itself is refused: cards MUST NOT carry
  credentials.

### What it stores

The catalogs and cards it fetched, with their `ETag` and expiry, in memory,
for the life of the server (one Codex session). Nothing goes on disk. With
`MCP_SERVER_CARDS_LOG` set (for development), it appends its log there. The
plugin's `.mcp.json` doesn't pass that variable through.

### What it never does

It never reads Codex's credentials (`auth.json`, the sign-ins
`codex mcp login` keeps), runs no sign-in of its own, and holds no token. The
only commands it runs are `codex mcp get`, `codex mcp add` and
`codex app-server`, with arguments it builds itself.

## What it does not protect against

- **A public name that resolves to a private address.** Node's `fetch`
  resolves names itself, so only addresses named directly, and redirects, are
  checked.
- **A form you accept without reading it.** The form says exactly what is
  written. The plugin can't tell how carefully it was read.
- **A later Codex that answers forms differently.** The plugin can't tell
  Codex's answer from yours, so it relies on Codex 0.172's rule that a form
  with a field is never accepted by itself. An earlier version of this plugin
  sent a form with no fields, which Codex accepted by itself under
  `--dangerously-bypass-approvals-and-sandbox`. Codex putting the approval
  mode in a tool call's metadata is the proper fix.
- **A publisher's own bad server.** A valid card from the real publisher can
  still point at a server that misbehaves once connected. What that server can
  then do is up to Codex's permissions for MCP tools, as for any server you
  add.
- **Another plugin or a hook.** A Codex hook of type `mcp_tool` can call this
  plugin's tools, as the model can. The form still goes to you. A plugin can
  also run `codex mcp add` itself, with the rights Codex gives it.
- **The card's claims about the live server.** They aren't checked against the
  connection (SEP-2127's SHOULD), because the plugin has no access to Codex's
  connection.
- **A clash with a server in a project's own `.codex/config.toml`.** The
  plugin's server runs in the plugin's folder, so `codex mcp get` there
  doesn't see a project's configuration.

## In Muse Code

The plugin folder also holds the Muse Code form, which runs its own bundle
and reuses this form's code unchanged. What differs there is in
[its Muse security notes](../muse/SECURITY.md).

## Undoing an addition

Run `codex mcp remove <name>`. Every addition's result gives the exact line.

## Reporting

Report a security issue privately, through this repository's
**Security → Report a vulnerability** form on GitHub, not in a public issue.
Name the polyfill (`mcp-server-cards`, Codex form), the Codex version, and the
domain, catalog or card involved.
