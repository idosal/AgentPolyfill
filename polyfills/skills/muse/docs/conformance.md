# Conformance: the Skills extension's client rules, for Muse Code

The Muse form of mcp-skills (0.1.0, on Muse Code 1.4.25) runs the Codex form's
code unchanged, in a bundle of its own. So the Codex form's
[table](../../codex/docs/conformance.md) holds row by row, with its tests,
except for the rows below. The source is the same: SEP-2640, Final, at commit
`2eb3a8e`.

Its own tests are in [`../test/muse-test.ts`](../test/muse-test.ts),
with the Codex form's tests run against the same `App`.

## Different in Muse

| Rule | Status in Muse | How |
|---|---|---|
| X8 | met | Gate any cross-origin read behind per-call approval naming both servers. Muse gives the model no tool that reads an MCP resource (none of its 32 built-in tools does), and `read_skill_file` reads only the skill's own server. So no cross-origin read can happen. In Codex this row is "not met", because Codex has its own `read_mcp_resource`. |
| X2, X13c (the user's yes before anything of a skill is fetched; a gate per skill) | met | The question is the Codex form's, put through a typed yes: `load_skill` answers with it and the phrase `load <server> <skill> <code>`, and the plugin's `UserPromptSubmit` hook approves only a message of the user's that is exactly that phrase, in the same session, within 15 minutes. None of the ways a model can put text into a session (scheduled prompts, monitors, subagents, other sessions, goals, workflows) ran that hook when each was checked ([live runs](../../../events/muse/docs/live-run.md#what-can-send-the-phrase)). `muse-test.ts` "a served skill gets a stub …", "the bundled hook approves only the waiting question …" |
| X13b | **not met** | Let users inspect a skill before it is loaded. Muse has no way to show the person text the model doesn't see, so "Show me its SKILL.md first" isn't offered, and no phrase takes it. `muse-test.ts` "Muse never offers …". It needs a change in Muse: a way for a plugin to ask the person, or to show them text ([host changes](../../../../docs/host-changes.md#in-muse-code)). |
| X9 (collisions surfaced) | exception | As in Codex. A stub's name in Muse's list is `mcp-skills:<server>:<name>`, so a served skill never takes a local skill's name. |
| F1 | n/a | As in Codex. |
| The stubs | — | In Muse's own skill folder, flat (`mcp-skills-served--<server>-<6 hex>--<16 hex>`), because Muse lists a SKILL.md only one folder down. `muse-test.ts` "one folder each, directly in Muse's skill folder …" |
| X11, H1 (the user's per-skill switch) | exception | Codex's `[[skills.config]]` rules have no Muse equivalent the plugin can read. A skill turned off with `muse skills disable` drops out of Muse's list, but a load by URI still works. `skip` in the settings leaves out a server. |

The media-type check of the shared core holds in Muse: `muse-test.ts` "a
binary file's media type from the server reaches the model as a media type or
not at all, after a load the person typed yes to".

**Summary for Muse:** as the Codex table, with X8 met instead of not met, and
X13b not met instead of met.

## Recorded runs

[`live-run.md`](live-run.md): in a real Muse 1.4.25, with no real model.
