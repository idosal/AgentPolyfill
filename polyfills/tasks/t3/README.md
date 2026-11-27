# MCP Tasks in T3 Code with Pi

## Setup

1. Install the [Pi Tasks extension](../pi/README.md) on the machine running T3. Use the same Pi executable and agent directory configured in T3’s provider settings. From the checkout, run `pi install ./polyfills/tasks/pi/extension`.
2. Enable your Tasks-capable server in Pi’s MCP configuration. Pi reads `mcp.json` in its agent directory (normally `~/.pi/agent`) and can also read a trusted project’s `.pi/mcp.json`. Keep Pi’s built-in MCP support and the Tasks extension enabled.
3. Select Pi as the provider for a T3 thread. Ask it which servers support Tasks, then ask it to start the tool. Review the server, tool and arguments and choose **Start it**.
4. Keep the thread’s Pi session running. When the job needs input, choose **Enter answer**, type the requested JSON in the composer and submit. The extension validates the answer and sends it to the server. The thread wakes again when the job finishes, subject to Pi’s wake rate limit.

T3 loads Pi’s user extensions and translates Pi’s blocking selection and text dialogs into composer questions. The Pi adapter owns polling, consent, validation and delivery. Use the disable switch and compatibility limits in the [Pi README](../pi/README.md). [T3’s Pi provider documentation](https://github.com/pingdotgg/t3code/blob/v0.1.12/docs/user/providers-pi.md).

## Verification

A local T3 Code 0.1.12 server and browser ran Pi 1.6.0 with the packaged Tasks extension, a scripted model and the repository’s [Tasks server fixture](../codex/test/fixture-tasks-server.mjs). The initial turn ended after approval. An idle wake prompted for a name, the composer submitted `{"name":"Luca"}`, and the fixture received one accepted answer for that task. After the completion wake, the same thread retrieved `Hello, Luca!`. The local model required no account.

For a manual check, configure the fixture as a Pi stdio server called `jobs` with `node` as the command and the absolute fixture path as its sole argument. Ask Pi to start the `ask` tool with empty arguments, collect your answer when requested, and read the result when it finishes. To inspect requests, set `FIXTURE_LOG` in the fixture server’s environment.

## Other T3 providers

A separate scripted ACP provider forwarded `elicitation/create` in an active turn. T3 rendered the required name field, the typed answer reached `tasks/update` once, and the result appeared in the thread. A deployable ACP integration also needs a way to wake the correct idle thread. The Codex and Claude providers in this release cancel the required-string MCP form used here. [T3 ACP form handling](https://github.com/pingdotgg/t3code/blob/v0.1.12/packages/provider-acp/src/server/elicitationForm.ts) · [Codex MCP form handling](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/provider/CodexMcpElicitation.ts).
