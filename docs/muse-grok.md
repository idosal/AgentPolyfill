# Muse Code and Grok Bot

These experimental adapters are available from this checkout. Each host gets a different user experience.

| Feature | Muse Code | Grok Bot |
| --- | --- | --- |
| Skills over MCP | Ask a question about a connected publisher. The agent can discover its catalog and read the matching verified guidance. The Mac reader names the selected URI and asks before fetching by default. | A remote MCP connector exposes the same catalog and reader. Connect it once. The account’s Bots can use it. There is no verified native Grok approval dialog for a selected skill. |
| Server Cards | Look up a domain and review a command to add the selected server. | Look up a domain and copy the fields into **Add a custom connector**. |
| ARD | Discover the MCP entries in a known domain’s directory and follow a selected Server Card. | Run the discovery helper with `--ard` to prepare the same connector fields. |
| Events | A terminal-session plugin waits for one new event. While the terminal is open, a native monitor can wake the conversation and the agent can read the inbox. | An operator-run watcher starts one webhook routine when a matching event arrives. It sends an empty request. The routine runs as a new job with its own permissions and usage. |
| Tasks | Start an enabled job, keep the handle, check its status, get its result or request cancellation. | The same operations are exposed as regular tools on a private remote connector. The operator chooses the upstream and the exact jobs it can invoke. |

## What was verified on November 27, 2026

- **Discovery.** On the official macOS Muse Code 1.4.25-R9361.1 release, the local Qwen 3.5 2B model used both installed discovery plugins in separate sessions. Buildkite served a live ARD directory and a Server Card for `https://mcp.buildkite.com/mcp`. Both Grok helper modes produced the reviewable remote fields. A fixture publishing an entry only through ARD distinguished the two lookup paths. The Grok checks ended before saving an account-wide connector.
- **Skills.** A normal question in Muse produced two installed-plugin calls followed by an answer using `@spaces.GPU`. Shell and writes were disabled, a standing routing instruction was present, and this run opted out of top-level read prompts. The bundled reader verified Hugging Face’s ZeroGPU root (20 catalog entries). It also read the multi-segment tabletop-dice root from [olaservo’s independent implementation at 6ae5441](https://github.com/olaservo/skills-over-mcp-demo/tree/6ae5441dde2222c93efb8e0955cf8605c75c5450). That publisher ran locally because its public Space returned HTTP 503. The earlier signed-in Grok Bot 1.3.0 run exercised a Hugging Face-only connector. The generic remote service was exercised over authenticated loopback HTTP.
- **Events.** The final Muse plugin passed a real terminal control using a scripted model, a local Events publisher, and a single approval each for preparing the watch and attaching its monitor. The same session received a fixed notice and retrieved the ticket title from the inbox. The small ordinary model could prepare the watch and miss the native WebSocket attachment. The inbox now reports that condition. The earlier Grok Bot run demonstrated one new job and a chat receipt after a public event. The packaged sender’s duplicate and ambiguous-delivery behavior was tested locally.
- **Tasks.** With the native-basic preset and ordinary local Qwen model, Muse asked permission, started the repository’s slow job, checked the returned handle and displayed `done: Blue lantern`. The empty preset was unreliable with this model. A separate scripted control also completed the same lifecycle. Both the stdio and authenticated HTTP packages returned the fixture result, supported cancellation, and refused unknown handles and unlisted jobs. A fresh run of the generic Tasks connector in a signed-in Grok Bot is outstanding.

## Install in Muse

Use Node 22.18 or newer and Muse Code. To install and approve all five reviewed local plugins in one command, run

```sh
node tools/muse-grok/install-muse.mjs all --approve
```

For a smaller install, replace `all` with a space-separated list such as `skills cards`. Omit `--approve` to review them before activation.
 These paths work from the repository root. Install only the features you want. After reviewing each plugin, approve its MCP server and start a new trusted session.

| Feature | Local install | Approval |
| --- | --- | --- |
| Server Cards | `muse plugins install "$PWD/polyfills/server-cards/codex/plugin"` | `muse plugins approve mcp-server-cards` |
| ARD | `muse plugins install "$PWD/polyfills/ard/codex/plugin"` | `muse plugins approve ard-discovery` |
| Skills | `muse plugins install "$PWD/polyfills/skills/muse/plugin"` | `muse plugins approve mcp-skill-reference` |
| Events | `muse plugins install "$PWD/polyfills/events/muse/plugin"` | `muse plugins approve mcp-event-monitor` |
| Tasks | `muse plugins install "$PWD/polyfills/tasks/muse/plugin"` | `muse plugins approve mcp-task-monitor` |

Muse starts the bundled processes with the session. Disable a plugin with `muse plugins disable <id>`, or remove it and its data with `muse plugins remove <id> --delete-data`. A server added separately with `muse mcp add` has its own removal command.

### Publishers and skill approval

Skills defaults to the public Hugging Face publisher. Try “According to Hugging Face’s current guidance, what decorator gives a Gradio function GPU time on a ZeroGPU Space?” The plugin supplies a short routing skill. Tool selection still depends on the model.

To replace the source list, create `sources.json` in the plugin’s data directory, `plugins/data/mcp-skill-reference` under Muse’s data store. Use labels you recognize. The example enables the Mac prompt for each read.

```json
{
  "sources": { "huggingface": "https://huggingface.co/mcp" },
  "askBeforeReading": true
}
```

Add another compatible publisher as another label. Discovery fetches metadata only. Reading selects a source plus an exact URI, checks the current manifest, and verifies the root’s byte count, SHA-256 and frontmatter. The publisher’s text enters the conversation as reference material. Only catalog-listed, fingerprinted roots can be read. Unlisted URIs, supporting files and dynamic skill manifests are outside this adapter. The host’s existing tools keep their normal permissions. Top-level consent is optional in the Skills spec. Set `askBeforeReading` to false to skip the Mac dialog for top-level reads. Identified nested entries require approval. The remote transport declines reads that require a dialog. [Skills specification](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills)

### Watch an event

Events defaults to the public AgentPolyfill feed. Ask “Watch the publicFeed source for the next hn.story and tell me when it arrives.” To use another source, put the same `sources` object in `plugins/data/mcp-event-monitor/sources.json`. Sources must advertise the Events extension and polling. This release supports event types that can be polled with empty arguments.

The plugin prepares a private loopback WebSocket address. The agent opens it with Muse’s native `monitor` tool. A local connection to this address starts polling. A fixed wake message tells the agent to read the inbox. Publisher text is delivered only by the inbox tool. One watch can deliver one event within ten minutes. Stopping the watch or closing the session releases it. Use an interactive Muse session with its native monitor available. A preset that omits the monitor can prepare a watch but cannot attach it. [Muse plugin commands and approvals](https://meta-models.github.io/muse-code-sdk/1.4/guides/plugins/concepts/mcp-servers/) · [Events authorization](https://modelcontextprotocol.io/seps/3415-events-extension#authorization)

### Run a task

Tasks starts with an empty allowlist. Put your configuration in `plugins/data/mcp-task-monitor/sources.json`. For a disposable example, start the repository’s read-only fixture and use its printed port in the configuration.

```sh
portfile="$(mktemp)"
node polyfills/tasks/codex/test/fixture-tasks-server.mjs --http "$portfile" &
fixture_pid=$!
while [ ! -s "$portfile" ] && kill -0 "$fixture_pid" 2>/dev/null; do sleep 0.1; done
cat "$portfile"
```

```json
{
  "sources": { "demo": "http://127.0.0.1:PORT/mcp" },
  "tools": { "demo": ["slow", "echo", "long"] }
}
```

A fresh session exposes each enabled job with its publisher’s input schema when startup discovery succeeds. Generic start and status tools remain available. Ask it to run the demo’s `slow` job with text `Blue lantern` and check the result. Stop the fixture afterward with `kill "$fixture_pid"`. The connector verifies the upstream Tasks extension on protocol revision 2026-07-28 or later. An allowlist grants access to the chosen tool’s argument surface. Choose public or genuinely read-only jobs appropriate for everyone with access to the connector.

Handles last for this process, subject to the publisher’s TTL, a one-hour local limit, and at most ten minutes of terminal-result retention. Polling honors the publisher’s suggested interval. A publisher can return an immediate result or require input. The adapter reports the latter and offers cancellation. It does not answer embedded input requests, resume after a restart, or wake the conversation when a task finishes. [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/seps/2663-tasks-extension)

## Set up Grok Bot

**Server Cards and ARD.** From the repository root run the standalone helper. It sends read-only discovery requests and prints the destination, header fields and OAuth information. Use `--server` to choose between multiple entries. Add `--ard` for an ARD lookup. There is no registry search.

```sh
node polyfills/server-cards/grok-bot/skills/server-card-connector/scripts/card-to-connector.mjs buildkite.com --ard
```

For team distribution, build a ZIP with `python3 tools/muse-grok/package.py server-card-connector.zip`. Review the ZIP before uploading it to a private team. It contains the discovery skill, its Node helper, a manifest and the project license. Availability of bundled scripts on the Bot computer depends on the host. The local helper works independently. The account owner enters any secrets directly in Grok’s connector form.

**Skills and Tasks.** The executable bundled with each Muse plugin also serves remote HTTP for a single operator. Point it at an operator-owned sources file. For Skills, the file is optional and Hugging Face is the default. A Tasks file must include an allowlist. Use a long random token private to this service. Start the chosen service once on your server. For example, with the token provided through your service manager’s secret store, run

```sh
PORT=8787 node polyfills/skills/muse/plugin/dist/server.mjs --http --config /absolute/path/skills.json
PORT=8788 node polyfills/tasks/muse/plugin/dist/server.mjs --http --config /absolute/path/tasks.json
```

Run each process separately. Both require `AGENTPOLYFILL_TOKEN` in their environment. Put HTTPS in front of their loopback listeners. In Grok choose **Connect apps → Add a custom connector → Remote HTTPS**, enter the published HTTPS URL ending in `/mcp`, and add the `Authorization` header with value `Bearer <your service token>`. Each service is one account-wide connection. A separate token and process per account keeps task handles and access separate. Stop the service and remove the connector to uninstall. This checkout provides the server software. Hosting and TLS are the operator’s responsibility. [Grok connectors](https://docs.x.ai/grok-bot/computer-and-apps)

**Events.** Create a disposable webhook-only routine in the intended Bot. Give it a fixed reply and choose its tools deliberately. In its settings copy the webhook URL and key into an owner-readable file (`chmod 600`) containing `{"url":"…","key":"…"}`. Keep this file off the Bot and out of any team ZIP. The watcher accepts the HTTPS webhook URL format observed in Grok Bot 1.3.0. Set an absolute private receipt directory on persistent storage and run

```sh
GROK_ROUTINE_FILE=/absolute/path/routine.json GROK_RECEIPT_DIR=/absolute/path/receipts \
  node polyfills/events/grok-bot/dist/watch.mjs publicFeed hn.story --arm-once
```

To watch another operator-configured publisher, supply `--config /absolute/path/events.json` with a `sources` object. The process exits after the first matching occurrence or ten minutes. Before contacting Grok it reserves that routine’s attempt on disk and flushes the receipt. Concurrent watchers, process restarts, HTTP errors and ambiguous failures all preserve the reservation. An operator must check the Bot’s run history before deliberately rearming. Separate machines require shared storage with exclusive-create semantics to share this guarantee. Events never grant the routine additional permissions. [Grok webhook routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)

## Verify the checkout

Bundled executables run without dependency installation. For development, install the pinned dependencies with `npm ci` in `polyfills/skills/codex`, `polyfills/{skills,tasks,events}/core` (each separately), and `polyfills/events/muse`. Rebuild with `node tools/muse-grok/build.mjs` and check with `node tools/muse-grok/build.mjs --check`. Type-check the adapters with `polyfills/skills/codex/node_modules/.bin/tsc -p tools/muse-grok`. Run `node --test tools/muse-grok/integration.test.mjs` for source identity, content integrity, nested-read refusal, Tasks lifecycle, event wake and duplicate delivery. Discovery has three additional package suites under `polyfills/server-cards/muse`, `polyfills/ard/muse` and `polyfills/server-cards/grok-bot`.
