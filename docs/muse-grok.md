# Muse Code and Grok Bot

This kit adds five features. In Muse, install the plugins you want and open a new trusted session. Muse starts their helpers. Grok Bot uses a different setup for each feature. One discovery helper on your Mac handles both Server Cards and ARD. Skills and Tasks need a private online connector. Events needs an outside watcher and a routine.

| Feature | What you can ask | Muse Code | Grok Bot |
| --- | --- | --- | --- |
| Directory lookup (ARD) | “What services does Buildkite publish?” | The agent reads the directory on the website you name. Verified with Buildkite. | The helper finds the services and prints the connection fields. The operator completes the form. |
| Server Cards | “How do I connect to that service?” | The agent shows the address and a command you can review and run. An earlier Neon test connected and listed five tools. | The helper prepares the name, address and sign-in fields. Saving and using a discovered service in Grok needs a host check. |
| Skills over MCP | “How do I give my Hugging Face app GPU time?” | Connect the publisher once. The agent can list its guides and read the main file of one guide. The default Mac dialog names it before fetching. | The account-wide connector can list guides. By default it refuses reads because it cannot display that dialog. An operator can enable a named approval dialog on the Mac running the connector or explicitly allow top-level reads from trusted publishers. |
| Events | “Tell me when a ticket comes in.” | A short wait returns the next ticket in this conversation. For an alert later, keep the terminal open and attach the native monitor. | A matching event can start a new routine. The routine receives an empty trigger and uses its own permissions and quota. |
| Tasks | “Use the addition service and tell me its result.” | The agent starts an enabled job, checks it by number and returns the answer. Verified with FastMCP. | A private connector exposes the same operations. The operator chooses which jobs every Bot on the account can start. |

### What passed on November 27, 2026

- **Discovery.** The installed plugins fetched Buildkite’s live directory and Server Card in Muse Code 1.4.25-R9361.1 on Apple silicon. Both Grok helper modes produced the connector fields locally. The first new Muse run counted several URLs as separate servers. The revised ARD tool puts the server count first. In the fresh recording, the agent reported one Buildkite server and listed its connection options. Tests also cover a listing discoverable only through ARD.
- **Skills.** The reader has fetched verified guides from public Hugging Face and a locally hosted, independently written dice publisher. The earlier Hugging Face-only Muse recording includes the named approval, the read and the agent’s answer. The earlier signed-in Grok run approved the read on the owner’s Mac. Grok’s native form immediately declined. In the general Muse build the small local model could answer from memory or skip the guide, even when it produced the correct answer. Treat a successful read as the evidence of using a publisher. A decline or timeout fetches no guide through this adapter. The release candidate has a new optional Mac-owner approval mode for a private Grok connector. Its policy has automated coverage. The signed-in recording was made with the earlier Hugging Face-only version.
- **Events.** The foreground Muse run received a new ticket titled “Pineapple notebook” from a local test publisher and reported that title. The model tried incorrect event names in some runs and once claimed a ticket after a timeout. The verified run contains a successful wait result with the exact title. A separate scripted run confirmed background wake in the same terminal. The ordinary model has missed the background attachment step. In the earlier signed-in Grok run, a public Hacker News event started one routine that posted a receipt. The packaged watcher’s one-attempt behavior was checked locally.
- **Tasks.** In a disposable Muse profile, the ordinary local Qwen model started a job, kept the handle, checked the independent FastMCP 4.2.6 server and displayed 85. The server returned “37 + 48 = 85”. The packaged Muse and remote Grok interfaces also passed a repeatable test against that server. Cancellation and invalid handles were exercised separately. A signed-in Grok run of this Tasks package is a separate release check.

The model runs used local Qwen 3.5 2B. The successful Events and Tasks runs used a standing routing instruction, disabled shell and writes, and preapproved test tools. The tests demonstrate the listed flows with those settings. The Cards and ARD conformance reports document their supported rules and omissions. Each other integration covers the subset described below.

## Install in Muse

Use Node 22.18 or newer and Muse Code. To install and approve all five reviewed local plugins in one command, run

```sh
node tools/muse-grok/install-muse.mjs all --approve
```

Keep the extracted kit in a stable folder. To update, unpack the new kit over that folder and run the installer again. It asks Muse to refresh the existing packages and checks every selected plugin for source conflicts before changing any of them.

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

Add another compatible publisher as another label. Discovery fetches metadata only. Reading selects a source plus an exact URI, checks the current manifest, and verifies the root’s byte count, SHA-256 and frontmatter. The publisher’s text enters the conversation as reference material. Only catalog-listed, fingerprinted roots can be read. Unlisted URIs, supporting files and dynamic skill manifests are outside this adapter. The host’s existing tools keep their normal permissions. Top-level consent is optional in the Skills spec. Set `askBeforeReading` to false to skip the Mac dialog for top-level reads. Identified nested entries require approval. The remote connector declines reads that require a dialog unless the operator runs it on a signed-in Mac with `--owner-approval`. With that flag it requests approval for every top-level read, including when `askBeforeReading` is false. One dialog can be open at a time. The dialog identifies the publisher URL and guide. Nested remote reads are always refused. [Skills specification](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills)

### Watch an event

Events defaults to the public AgentPolyfill feed. Ask “Watch the publicFeed source for the next hn.story and tell me when it arrives.” To use another source, put the same `sources` object in `plugins/data/mcp-event-monitor/sources.json`. Sources must advertise the Events extension and polling. This release supports event types that can be polled with empty arguments.

The plugin prepares a private loopback WebSocket address. The agent opens it with Muse’s native `monitor` tool. A local connection to this address starts polling. A fixed wake message tells the agent to read the inbox. Publisher text is delivered only by the inbox tool. One watch can deliver one event within ten minutes. Stopping the watch or closing the session releases it. For a short wait, ask “Wait here for the next hn.story from publicFeed.” The wait_for_event tool makes one call, waits up to 30 seconds and returns the event, a timeout, or a stop receipt. A timeout ends the watch. Only one wait or background watch can be active. For a background alert use an interactive Muse session with its native monitor available. A preset that omits the monitor can prepare a watch but cannot attach it. [Muse plugin commands and approvals](https://meta-models.github.io/muse-code-sdk/1.4/guides/plugins/concepts/mcp-servers/) · [Events authorization](https://modelcontextprotocol.io/seps/3415-events-extension#authorization)

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

**Skills and Tasks.** The executable bundled with each Muse plugin also serves remote HTTP for a single operator. Point it at an operator-owned sources file. For Skills, Hugging Face is the default catalog. The default requires approval. To permit remote top-level reads, set `askBeforeReading` to `false` in the connector’s JSON configuration and include only publishers you trust for all Bots on the account. Nested reads are still refused. For a human decision on each top-level read, add `--owner-approval` to the Skills command on a signed-in Mac. The person at that Mac makes the decision. A Tasks file must include an allowlist. Use a long random token private to this service. Start the chosen service once on your server. For example, with the token provided through your service manager’s secret store, run

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


### Build an install kit

From the checkout, run `python3 tools/muse-grok/package.py --kit agentpolyfill-hosts.zip`. Extract the ZIP and open the `agentpolyfill-hosts` folder before following the install instructions. The archive includes the bundled launchers, the test job, the install script and the notices. The packaging command uses an explicit file list and fixed timestamps. Two builds from identical files produce the same bytes.

For a repeatable Tasks interoperability run, start `polyfills/tasks/codex/test/interop/fastmcp_server.py` in the locked environment documented in the Tasks checkout. Set `MUSE_GROK_FASTMCP_URL` to its loopback MCP URL before running the integration tests. The Muse and Grok workflow defines this check for pushes and pull requests. It also runs the shared card, configuration, discovery and formatting rules against both committed Muse discovery bundles.
