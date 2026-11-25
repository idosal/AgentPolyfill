# Conformance: the Server Cards client rules, for Muse Code

The Muse form (0.1.0, on Muse Code 1.4.25) runs the Codex form's code
unchanged, in a bundle of its own: the same card, discovery, cache, formatting and
fetch code, against the same revisions: SEP-2127 Final, ext-server-card
`28db12c9b4`, and the AI Catalog v0.9 release candidate. The shared rule
tests run against the committed bundle, so the
[client rules table](../../claude-code/README.md#client-rules) holds, with
its limits (S-3 remains not met).

These are the rows where Muse differs. M-1 to M-6 are the Muse tests in
[`../test/adapter.test.ts`](../test/adapter.test.ts).

| # | Rule | Status | How, in Muse | Tests |
|---|---|---|---|---|
| P-1 | Never replace a server the person has | met | `muse mcp get <name> --json` before the command is given; a name Muse has, or no answer, is refused. `muse mcp add` refuses an existing name too. | M-4 |
| P-2 | A person approves every addition | met | Nothing is written by the plugin: the person runs the `muse mcp add …` command themselves. Muse's approval judge never stands in for them. | M-2 |
| P-3 | Add only what was shown, as shown | met | The command comes from a card shown in this session, at the URL it gives, which must equal the URL the model names. Every word is quoted for the shell, so what is shown is what runs. | M-2, M-4, M-5 |
| I-2 | Handle `isSecret` values securely | exception | A secret is `--bearer-token-env-var VAR` or a header whose whole value is `${VAR}`. A secret mixed into other text, or in the URL, is refused, because Muse fills a reference only as a whole value. | M-3 |
| I-3 | Choose a remote by its `supportedProtocolVersions` | met | Muse's revisions: 2025-06-18 (what Muse 1.4.25 asks for), 2025-03-26, 2024-11-05; a remote with none of them is refused. | M-7, shared |
| I-4 | Transport `streamable-http` or `sse` | exception | SSE remotes are refused: Muse connects stdio and streamable HTTP servers. | shared C-4 |
| V-3 | No text that displays as something else | met | The shared checks, in Muse: a card whose text shows as something else is refused, and so is one with a header value holding a character that shows as nothing; neither gets a command. | M-6 |
| S-3 | Check the card's claims against the live connection | not met | As in every form: no way to send `server/discover` over Muse's connection. | — |
| H-1 to H-4 | A hand-over's entries, publisher, confirmation, who may hand over | n/a | This form has no hand-over tool. | — |

Manual stand-down: `muse plugins disable mcp-server-cards`. Muse passes no
environment variables, so `MCP_SERVER_CARDS_DISABLED` has no effect there.

Recorded runs: [`live-run.md`](live-run.md).
