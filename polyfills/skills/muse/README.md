# mcp-skills for Muse Code

Skills your MCP servers serve show up in Muse Code's skill list. A skill loads
after you say yes, and is checked against the server's digests.

Also available for Claude Code: [mcp-skills for Claude Code](../claude-code/README.md),
for Codex: [mcp-skills for Codex](../codex/README.md),
and for Pi: [mcp-skills for Pi](../pi/README.md).

This plugin implements the client side of the MCP Skills extension,
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)
(Final), which Muse doesn't support itself.
- **The folder.** It's the Codex plugin's folder, [`../codex/mod`](../codex/mod),
  with a Muse manifest beside the Codex one
  ([`.muse-plugin/plugin.json`](../codex/mod/.muse-plugin/plugin.json)). Muse runs
  the same bundle, told it is in Muse.
- **The Muse-only code.** It is in [`../codex/src/muse.ts`](../codex/src/muse.ts),
  [`muse-confirm.ts`](../codex/src/muse-confirm.ts) and
  [`muse-prompt-hook.ts`](../codex/src/muse-prompt-hook.ts).
- **All four forms.** [AgentPolyfill in Muse Code](../../../docs/muse.md) covers
  every Muse form.

## Install

You need **Muse Code 1.4.25** (the version tested) and **Node 20 or newer**
on the PATH `muse` runs with:

```bash
muse plugins marketplace add agent-polyfill https://github.com/idosal/AgentPolyfill
muse plugins install mcp-skills@agent-polyfill
muse plugins approve mcp-skills
```

Then start a new `muse` session, in a workspace you trust.
- **What `approve` covers.** Muse holds back the plugin's MCP server and its
  `UserPromptSubmit` hook until you approve them.
- **Updates.** After `muse plugins marketplace update agent-polyfill` and
  `muse plugins update mcp-skills`, approve again.

To remove it:

```bash
muse plugins remove mcp-skills --delete-data
rm -rf ~/.config/muse/skills/mcp-skills-served--*
```

- **`--delete-data`** removes the plugin's store: your approvals, what it learned
  about each server, its log.
- **The stubs** stay in Muse's skill folder until you delete them: that's the
  second line.
- **The marketplace.** If no other plugin of it is installed, drop it too, with
  `muse plugins marketplace remove agent-polyfill`.

## How you say yes

**Muse offers plugins no approval dialog.** In the other hosts, the polyfills
ask you through a prompt the host draws itself, which the model can't answer:

- **Claude Code:** its permission dialog.
- **Codex:** its approval prompt, or an MCP form.
- **Pi:** a dialog.
- **OpenCode:** its permission prompt (the polyfills set their own actions to
  ask).

Muse has nothing like that for a plugin. Its MCP client offers no form, and a
hook's `ask` goes to Muse's approval judge, a model that may approve with
nobody asked. So in Muse, **your yes is a phrase you type, checked by the
plugin's hook**:

- **The question.** The answer to a load is the question, ending with a phrase
  that names what it approves, such as `load github git-workflow 4821`.
- **The check.** The plugin's `UserPromptSubmit` hook reads your next message.
  Only a message that is exactly that phrase approves it, in the same session,
  within 15 minutes, once.
- **Only you.** Muse runs that hook only for messages you type. Nothing a
  model can put into a session runs it: scheduled prompts, monitors,
  subagents, other sessions, goals and workflows were each [checked
  live](../../events/muse/docs/live-run.md#what-can-send-the-phrase).

What a host's prompt gives you that this doesn't: you read the question as the
model relays it in the chat. The phrase names the server and what's on it, so
you type the names of what you approve, but the other details are only in the
question. With Muse's experimental session-protocol gates on, any program you
run can drive the session, and could type the phrase too.

## Try it

Add Hugging Face's public MCP server (no sign-in):

```bash
muse mcp add huggingface --url https://huggingface.co/mcp
```

1. **First session.** Start `muse`; the plugin looks at the server and writes a
   stub for each skill it serves.
2. **Next session.** Muse lists them as `mcp-skills:huggingface:<name>`. Ask
   something one of them covers.
3. **The load.** Muse calls `load_skill`, and the answer is the question for
   you, with a phrase that names the server and the skill, such as
   `load huggingface <skill> 4821`. Send a message that is exactly that
   phrase. Muse calls `load_skill` again, and the skill loads, marked with the
   server it came from.

## How it works

- **The list.** The plugin's server reads `mcpServers` in Muse's user settings,
  connects to each server that declares the Skills extension, and lists its
  skills. For each one it writes a short stub (a SKILL.md of its own words) in
  Muse's own skill folder:
  `~/.config/muse/skills/mcp-skills-served--<server>-<6 hex>--<16 hex>/SKILL.md`.
  - **Why there.** Muse lists a SKILL.md only one folder below a skill folder,
    and the Codex stubs in `~/.agents/skills` are nested deeper.
  - **Codex** doesn't read that folder.
- **Your yes is typed.** Muse gives a plugin no way to ask you:
  - its MCP client offers no elicitation;
  - a tool call that isn't read-only, or a hook's `ask`, goes to Muse's approval
    judge, a model that may approve it with nobody asked.

  So the first `load_skill` answers with the question, as the Codex form asks
  it: the skill, the server, the URI, the files, and the server's description.
  It ends with a phrase, `load <server> <skill> <code>`. The plugin's `UserPromptSubmit` hook
  approves the load only when a message of yours is exactly that phrase, in the
  same session, within 15 minutes. Muse runs that hook for your messages, not
  for a turn Muse or a model starts, so the model can't send it. The next `load_skill`
  loads the skill.
- **After a yes.** An approval is kept as in Codex: the same skill, unchanged,
  loads without the question afterwards. A changed one is asked about again.
- **No preview.** "Show me its SKILL.md first" isn't offered in Muse. Muse has
  no way to show you text the model doesn't see.
- **Which servers.** As for mcp-events in Muse:
  - **Read:** Muse's user settings only.
  - **Left out, each with the reason:** a server with `enabled: false`; a server
    you signed in to with `muse mcp login`; one whose values come from `${VAR}`.
  - **None at all** where your organisation manages Muse.
  - **Never read:** a project's `.mcp.json`.

## Settings

Muse passes the plugin no environment variables. Its settings are the Codex
form's `settings.json` in its store, which in Muse is the plugin's data folder,
`~/.local/share/muse/plugins/data/mcp-skills/`:

```json
{ "servers": ["huggingface"], "skip": ["other"], "off": false }
```

`"off": true` turns it off: no skills offered, and the hook does nothing.

### When Muse supports Skills itself

Disable the plugin (`muse plugins disable mcp-skills`) and delete its stubs.
Muse doesn't tell a plugin what its own MCP client supports, so the plugin
can't notice by itself.

## Limits

The changes Muse would need are in
[What hosts would need to change](../../../docs/host-changes.md#in-muse-code).

- **No preview before a load** (X13b), as above.
- **New skills show up a session late.** Stubs written during a session were
  in Muse's skill list in the sessions after it. Whether Muse lists them in the
  same session wasn't checked. `list_skills` shows them at once.
- **Turning one skill off.** A skill you turn off with `muse skills disable`
  drops out of Muse's list, but a load by its URI still works. `skip` in the
  settings leaves out a whole server.
- **No sign-in through Muse, and no `${VAR}` secrets.**
- **Platforms.** Checked on macOS only.

## Security

A served skill is the server's text, not yours. It loads only after your typed
yes. It's fenced and marked with its server, and checked against the server's
digests. The plugin reads Muse's MCP server list, which can hold header values
you wrote, and never Muse's sign-in store. Details:
[`SECURITY.md`](SECURITY.md).

## Spec and conformance

The rules are met by the same code as the Codex form's, so its
[table](../codex/docs/conformance.md) holds, except for the rows
[`docs/conformance.md`](docs/conformance.md) lists. Muse runs are recorded in
[`docs/live-run.md`](docs/live-run.md). **No run used a real model.**

## Development

Built and tested with the Codex form, from [`../codex`](../codex):

```bash
(cd ../core && npm ci)
cd ../codex && npm ci
npm test              # test/muse-test.ts is the Muse form's
npm run build         # mod/dist/helper.js and mod/muse/hooks/user-prompt-submit.mjs
```

## Licence

Apache-2.0, as the rest of the repository.
