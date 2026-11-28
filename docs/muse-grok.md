# Muse Code and Grok Bot

This kit adds five features. In Muse, install the plugins you want and open a new trusted session. Muse starts their helpers. Grok Bot uses a different setup for each feature. One discovery helper handles both Server Cards and ARD. Publisher skills can be installed as native Grok skills from a team ZIP. Live reads require an owner-operated connector. Tasks can use that transport or run as a Command connector on the Bot computer. Events uses a watcher on your machine and a webhook-only routine.

| Feature | What you can ask | Muse Code | Grok Bot |
| --- | --- | --- | --- |
| Directory lookup (ARD) | “What services does Buildkite publish?” | The agent reads the directory on the website you name. Verified with Buildkite. | The helper finds the services and prints the connection fields. The operator completes the form. |
| Server Cards | “How do I connect to that service?” | The agent shows the address and a command you can review and run. An earlier Neon test connected and listed five tools. | The helper prepares the name, address and sign-in fields. A signed-in Bot saved a discovered endpoint and returned its publisher receipt. Credential-free services can also produce a reviewed setup draft. |
| Skills over MCP | “Two users sometimes get each other’s output file. What should I change?” | Publisher guides appear by name in the native skill list. Opening one enables a single approved read of its current guide and one optional text reference. | A native team ZIP can contain the actual selected guide and reference, or native entries that request their current files through the owner’s connector. Uploading a catalog is an operator step. |
| Events | “Tell me when a ticket comes in.” | A short wait returns one ticket. A native monitor can interrupt the open terminal once. For repeated notices, confirm a subscription and receive updates with your next messages. | A matching event starts the configured routine with the watch name and ticket or event ID. Try one alert or keep watching. Each wake uses the routine’s permissions and quota. |
| Tasks | “Use the addition service and tell me its result.” | The agent starts an enabled job, checks it by number and returns the answer. Verified with FastMCP. | A private connector exposes the jobs the operator enables to every Bot on the account. A signed-in test Bot started one job and returned its result and receipt. |

### Native publisher skills tested November 28, 2026

* A fresh Muse Code 1.4.25 profile connected to the public Hugging Face endpoint and listed 20 native skills. Repeating the same install kept one connection.
* For the natural-question comparison, the official Muse executable ran local Qwen 3.5 2B with the native-basic preset and 65,536-token context. A disposable publisher served public catalog metadata with synthetic file contents. The fixture supplied the approval decision. The new version read the intended guide and concurrency reference in four of five fresh sessions. The previous version read that pair in two of five. Twice the new version read the relevant reference and correctly advised using a unique output path. Once the model supplied an invalid selection and fetched neither file.
* Two trials asked about a queue setting the reference omitted. In both, the model read the right files and then attributed unsupported settings to them. File verification establishes what was loaded. Check advice that goes beyond the files against the relevant product documentation. [Gradio queue configuration](https://github.com/gradio-app/gradio/blob/main/guides/04_additional-features/01_queuing.md)
* A follow-up about output filenames reused the conversation with zero additional publisher reads. A separate decline produced one request for approval and zero file reads. The model told the user it had continued without the guide.
* In a separate disposable Muse session, a scripted model exercised the native installation path. Muse opened an exported skill and its selected reference after the publisher stopped. The session had zero custom MCP tools.
* The Grok archive, owner-approved read of the guide plus one named file, and connector draft generator passed packaged checks. A signed-in Grok import and use of the new archive, a new draft-based installation receipt, and a recording with the actual owner dialog remain pending.

### What passed on November 27, 2026

- **Discovery.** The installed plugins fetched Buildkite’s live directory and Server Card in Muse Code 1.4.25-R9361.1 on Apple silicon. Both Grok helper modes produced the connector fields locally. The first new Muse run counted several URLs as separate servers. The revised ARD tool puts the server count first. In the fresh recording, the agent reported one Buildkite server and listed its connection options. In a separate Cards run the model retrieved the correct primary address and incorrectly described the direct endpoint as read-only. The guide now tells the model to report permissions only when the publisher explicitly documents them for that address. Review the card and publisher’s sign-in documentation when deciding what access to grant. Tests also cover a listing discoverable only through ARD.
- **Skills in Muse.** We installed the general plugin in a fresh Muse Code 1.4.25 profile and asked which decorator gives a Gradio function GPU time on a Hugging Face ZeroGPU Space. Muse listed the guides and chose ZeroGPU. The Mac prompt named the guide, its publisher and its size. After one approved click, the reader returned the verified text and Muse answered `@spaces.GPU`. When we let the prompt expire in another run, the reader withheld the text and the model still guessed the decorator. A correct chat answer alone cannot prove a read. A second, locally hosted publisher also passed a reader test.
- **Skills in Grok Bot.** In the signed-in `agentpolyfill` chat, the general connector listed 20 Hugging Face guides and Grok chose ZeroGPU. The first read timed out, and Grok reported that it could not answer from the guide. After the temporary connector was reinstalled, Grok reported a connection change and asked us to repeat the question. On that next turn, Grok requested the same guide. At the user's direction, AppleScript clicked **Read once** on the matching Mac dialog. The connector returned 17,357 bytes of verified instructions and Grok answered “Put `@spaces.GPU` on it, after `import spaces`.” Discovery and the approved read were observed on separate turns in the same conversation. We then removed the account-wide connector. Grok's own chat approval form had immediately declined in the earlier test. The working approval is on the connector owner's Mac.
- **Events.** The foreground Muse run received a new ticket titled “Pineapple notebook” from a local test publisher and reported that title. The model tried incorrect event names in some runs and once claimed a ticket after a timeout. The verified run contains a successful wait result with the exact title. A separate scripted run confirmed background wake in the same terminal. The ordinary model has missed the background attachment step. In the earlier signed-in Grok run, a public Hacker News event started one routine that posted a receipt. The packaged watcher’s one-attempt behavior was checked locally.
- **Tasks.** In a disposable Muse profile, the ordinary local Qwen model started a job, kept the handle, checked the independent FastMCP 4.2.6 server and displayed 85. The server returned “37 + 48 = 85”. The packaged Muse and remote Grok interfaces also passed a repeatable test against that server. Cancellation and invalid handles were exercised separately. In Grok Bot 1.3.0 we installed the packaged connector and asked the signed-in test Bot to add 37 and 48 and return the job receipt. It replied **85** and **AP-8C50EC**. The independent publisher generated that receipt and allowed one job. We uninstalled the temporary connector and verified the installed count returned from eleven to ten.

The Muse recordings used local Qwen 3.5 2B, a standing instruction to use the relevant service, disabled shell and writes, and preapproved test tools. The Skills reader separately asked for permission to load the selected guide. The Grok Skills and Tasks tests ran in the signed-in Bot’s ordinary chat. The tests demonstrate the listed flows with those settings. The Cards and ARD conformance reports document their supported rules and omissions. Each other integration covers the subset described below.

## Install in Muse

### Install by name from a checkout

From the repository root, add the catalog once. For example, to add Skills and Events:

```sh
muse plugins marketplace add agent-polyfill "$PWD"
muse plugins install mcp-skill-reference@agent-polyfill
muse plugins approve mcp-skill-reference
muse plugins install mcp-event-monitor@agent-polyfill
muse plugins approve mcp-event-monitor
```

The other three install names are `ard-discovery`, `mcp-server-cards`, and `mcp-task-monitor`. Each entry pins its package digest. The local ZIP kit uses the installer below.

### Install from the ZIP kit

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

On November 28, a fresh install in Muse Code 1.4.25 listed 20 Hugging Face guides, including ZeroGPU, through Muse’s own skill inventory. Packaged reader tests verified that a new session cannot reuse a previous session’s approval and that unlisted or changed files are refused.

In the November 28 local marketplace check, Muse Code 1.4.25 installed all five plugins by name. With a selected Hugging Face connection and the catalog populated before the first turn, local Qwen 3.5 2B used the discovery tool and returned `huggingface-zerogpu` and `skill://huggingface-zerogpu/SKILL.md` on a listing-only question. The listing-only run left the guide closed. When asked how two Gradio listeners should share a queue, the same model used repository search in one run and guessed settings after an unsuccessful read in another. The supporting-file reader passed its integration tests. That earlier run did not establish a reference-grounded answer. The native publisher trials above tested the newer version using synthetic file contents. In a separate official Muse session with a scripted model and a local ticket publisher, two successive messages received distinct recurring notices and the third received none.

### Publishers and skill approval

From the extracted kit, install Skills and connect a publisher in one command.

```sh
node tools/muse-grok/install-muse.mjs skills --approve --publisher https://huggingface.co/mcp
```

Use an existing Muse connection name in place of the URL for an existing private or stdio publisher. The installer reuses a matching HTTP connection, preserves other selected publishers and checks the number of enabled entries through `muse skills list --source user`. Open a fresh trusted conversation after installation. The macOS desktop must be available for **Read once**. Review the plugin before passing `--approve`.

Muse selects a `SKILL.md` entry with its built-in skill reader. The entry lists the publisher URI and available supporting files. A hook recognizes the successful native read and gives that selection a two-minute, single-use receipt. The shared file reader accepts that receipt and one optional reference. It asks before fetching file contents, rechecks the manifest and verifies the bytes. Publisher instructions enter through a tool result. The hook sends only a locally generated selection receipt. A receipt alone grants no access to file contents. A declined request reads zero files. When the user explicitly asks to use already-open material, the prompt hook can close the live reader for that turn. A matching reference filename can suggest which file to request. The dialog names the actual files. Selecting another file later requires another read.

Try “Two users of my Hugging Face ZeroGPU app sometimes get each other’s output image. Both requests write output.png. How should I fix this?” The concurrency reference describes unique output paths. A different question about sharing a Gradio queue requires the same `concurrency_id` on the two listeners. The ZeroGPU concurrency reference omits this setting. A chat answer alone cannot establish which files were used. [Gradio queueing](https://github.com/gradio-app/gradio/blob/main/guides/04_additional-features/01_queuing.md)

A native list entry contains catalog metadata until selected. The helper supports at most 100 entries and refreshes in trusted sessions. The operator chooses any compatible publisher. Selected stdio publishers start a separate instance of their configured command. Unsupported managed OAuth, unresolved environment substitutions and enterprise policy are reported as unavailable. To clear generated entries, run `node tools/muse-grok/select-muse-sources.mjs skills --clear` before removing the plugin. The lower-level selection command replaces the selected names. Separately configured publishers in `sources.json` still apply.

### Native Grok skills

Use the source label and endpoint from the owner connector configuration. For example, save this as `skills.json`:

```json
{"sources":{"huggingface":"https://huggingface.co/mcp"},"askBeforeReading":true}
```

**To distribute the actual skill**, explicitly choose the guide and any one supporting reference. The command fetches and verifies these files and writes a private team ZIP. Review it before uploading. The snapshot contains the guide body with native name and description fields, and at most the one selected text reference. Check that the skill works with those files alone. A guide that depends on additional files, scripts, or its publisher’s services needs those dependencies separately. The included files become available to the people who install the skill. This mode requires the publisher’s permission to redistribute its material. Once installed, Grok uses the native skill without a connector or a Mac. Updating it requires another export and upload. Approval occurs at export.

```sh
python3 tools/muse-grok/package.py zerogpu.zip --grok-skills-config skills.json --source huggingface --snapshot-skill skill://huggingface-zerogpu/SKILL.md --reference references/concurrency.md
```

**Use the same downloaded skill in Muse with no plugin.** Unzip the snapshot into a permanent folder you own. Run `muse skills install /absolute/path/to/unpacked/skills/SKILL_FOLDER --scope user` and start a new session. Muse opens the installed `SKILL.md` itself. The selected supporting file sits alongside it. The authorization decision happens when you choose to download and install the snapshot. Update it by inspecting and installing a fresh export. Use the live publisher plugin if you want approval at read time.

**For current files and approval on each read**, build the native catalog and upload it as a private team plugin. Each publisher guide gets one native skill entry. This ZIP contains only catalog descriptions, file names and instructions for reaching the reader. Add the owner-approved HTTPS connector once as described below. A new publisher guide needs a catalog refresh and re-upload. Existing entries request the current guide and optional named reference together. The owner sees both names on the connector Mac. Each request has its own approval across the account’s Bots. The release tests check the archive contents and wire requests. A signed-in installation of the new catalog and its supporting-file path remains a host check.

```sh
python3 tools/muse-grok/package.py publisher-catalog.zip --grok-skills-config skills.json --source huggingface
```

### Watch an event

**Recurring notices.** Choose a Muse user connection that publishes MCP Events. For example, if yours is called `tickets`, run:

```sh
node tools/muse-grok/select-muse-sources.mjs events tickets
```

Approve the Events plugin, including its prompt hook, then open a new trusted session. Ask “Keep watching tickets for new tickets and tell me when I next message you.” Muse shows the server, event type and filters, then gives you a short phrase such as `watch tickets ticket.created 4821`. Type the phrase shown in your session. One confirmation starts the subscription. Later messages in that session carry a notice with the number of arrivals and handles for reading details. Closing Muse stops the helper. Reopening that session resumes its saved watch. Catch-up depends on the publisher’s event history. Ask Muse to stop the watch and confirm the stop. A watch runs only for a selected compatible connection.

**Immediate alert or short wait.** Events defaults to the public AgentPolyfill feed. Ask “Watch the publicFeed source for the next hn.story and tell me when it arrives.” To use another source, put the same `sources` object in `plugins/data/mcp-event-monitor/sources.json`. Sources must advertise the Events extension and polling. This release supports event types that can be polled with empty arguments.

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

**Read a specific reference in Muse.** Ask a normal question in a fresh trusted session. Muse sees the selected publishers’ native skills. A local hint can point the model to a matching name. When Muse opens that entry, it sees the available filenames. One shared reader accepts the native selection and a file number. Zero requests the main guide alone. Choosing a supporting file requests it together with the guide in a single Mac dialog. Accepting reads and verifies the selected files. Declining reads neither. The same skill can prompt once per turn. On follow-ups the agent can use files already in the conversation. The model decides whether to open a skill and which file to request.

## Set up Grok Bot

**Server Cards and ARD.** From the repository root run the standalone helper. It sends read-only discovery requests and prints the destination, header fields and OAuth information. Use `--server` to choose between multiple entries. Add `--ard` for an ARD lookup. There is no registry search.

```sh
node polyfills/server-cards/grok-bot/skills/server-card-connector/scripts/card-to-connector.mjs buildkite.com --ard
```

For team distribution, build a ZIP with `python3 tools/muse-grok/package.py server-card-connector.zip`. Review the ZIP before uploading it to a private team. It contains the discovery skill, its Node helper, a manifest and the project license. Availability of bundled scripts on the Bot computer depends on the host. The local helper works independently. The account owner enters any secrets directly in Grok’s connector form.

**Skills and Tasks.** The executable bundled with each Muse plugin also serves remote HTTP for a single operator. Point it at an operator-owned sources file. For Skills, Hugging Face is the default catalog. The example below enables the per-guide prompt on the Mac running the connector. For unattended top-level reads, omit `--owner-approval`, set `askBeforeReading` to `false` in the connector’s JSON configuration and include only publishers you trust for all Bots on the account. Nested reads are still refused. For the per-guide prompt, someone must be present at that signed-in Mac. Other chat participants depend on that person to approve the read. A Tasks file must include an allowlist. Use a long random token private to this service. Start the chosen service once on your server. For example, with the token provided through your service manager’s secret store, run

```sh
PORT=8787 node polyfills/skills/muse/plugin/dist/server.mjs --http --owner-approval --config /absolute/path/skills.json
PORT=8788 node polyfills/tasks/muse/plugin/dist/server.mjs --http --config /absolute/path/tasks.json
```

Run each process separately. Both require `AGENTPOLYFILL_TOKEN` in their environment. Put HTTPS in front of their loopback listeners. In Grok choose **Connect apps → Add a custom connector → Remote HTTPS**, enter the published HTTPS URL ending in `/mcp`, and add the `Authorization` header with value `Bearer <your service token>`. Each service is one account-wide connection. A separate token and process per account keeps task handles and access separate. Stop the service and remove the connector to uninstall. This checkout provides the server software. Hosting and TLS are the operator’s responsibility. [Grok connectors](https://docs.x.ai/grok-bot/computer-and-apps)

**Draft a credential-free connector installation.** For a Server Card or ARD discovery, add `--draft-for BOT_UUID` to the discovery command. The helper prints the exact proposed message and a link that opens it in the named Bot. Open a chat with an empty message box, review the endpoint, and choose Send. For Tasks, stage the verified kit on the Bot computer first, then prepare its command with:

```sh
node tools/muse-grok/grok-draft.ts tasks BOT_UUID /usr/local/bin/node /absolute/path/agentpolyfill-hosts/polyfills/tasks/muse/plugin/dist/server.mjs https://publisher.example/mcp add_numbers
```

Sending the draft asks the Bot to install an account-wide connector. It contains only the intended configuration. The owner reviews it before sending. The helper declines draft generation for cards with headers, OAuth or URL secrets. Enter those directly in the connector form. Manual installation produced signed-in receipts in RC1. Draft generation is covered by automated checks; sending a draft and obtaining a new signed-in receipt is a separate host check. [Grok draft links](https://docs.x.ai/grok-bot/deep-links) · [Grok connector setup](https://docs.x.ai/grok-bot/computer-and-apps)

**Run Tasks on the Grok computer.** For a public publisher that requires no credentials, extract the release ZIP once on the Bot’s computer, in a stable folder readable by the connector. Use Node 22.18 or later there. Open **Connect apps → Add a custom connector → Command**. Use the absolute path to Node as the command. Supply these five arguments separately, substituting the real path, publisher URL and tool name.

```text
/absolute/path/agentpolyfill-hosts/polyfills/tasks/muse/plugin/dist/server.mjs
--publisher
https://your-publisher.example/mcp
--allow-tool
your_read_only_tool
```

Choose a tool whose operation you have reviewed. The allowlist limits which job can start. Its publisher still determines what that job does. The connector can check or cancel jobs it started. Each connector is available account-wide. Open a fresh conversation after saving and ask for a job and its receipt. An outstanding handle belongs to the running process and expires if Grok replaces that process. Remove the connector before removing the extracted folder. This setup requires Grok to retain the folder and reuse the process across job calls. The earlier Grok receipt documented above used Remote HTTPS.

**Events.** Set up one webhook-only routine and a private watcher profile from the [Grok Events setup guide](../polyfills/events/grok-bot/README.md). Run the watcher on your machine. Use the same profile for a single alert and for recurring alerts.

```sh
node polyfills/events/grok-bot/dist/watch.mjs once
node polyfills/events/grok-bot/dist/watch.mjs follow
```

Run `once` first, trigger an event, and verify the reply in the Bot. Choose `follow` when you want continued alerts. The Bot receives the watch and ticket identifiers in its webhook. You can opt a watch into sending a short title. Uncertain deliveries stay held for review. On November 28, the signed-in `agentpolyfill` Bot received two separate alerts from the packaged local watcher. It reported `AP-924A2B` and `AP-66B1AB`, each with the expected source and watch. The tickets came from a local MCP test publisher. [Grok webhook routines](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks)

## Security and verification

The ZIP includes the bundled software for five host integrations. Use a dedicated operating-system account for a watcher or hosted connector that handles private publisher data. The approved operator selects the publishers, any local commands and the allowed Tasks tools. Each Grok HTTP connector uses one operator identity across the Bots that can access it. Treat the routine URL and key as credentials. For publisher HTTP connections, these adapters accept HTTPS and local loopback HTTP; inline credentials, queries and fragments are rejected. Publisher guidance and event text remain external content even when their origin or digest has been verified.

Six bounded TLA+ models cover native skill selection and one-use reads, skill-file consent, recurring watch confirmation, routine delivery, task handles and discovery handoffs. The CI runner also requires the expected invariant to fail when each modeled safeguard is removed. See [the model assumptions, implementation checks and reproduction command](../tools/muse-grok/model/README.md).

## Verify the checkout

Bundled executables run without dependency installation. For development, install the pinned dependencies with `npm ci` in `polyfills/skills/codex`, `polyfills/{skills,tasks,events}/core` (each separately), and `polyfills/events/{codex,muse,grok-bot}` (each separately). Rebuild with `node tools/muse-grok/build.mjs` and check with `node tools/muse-grok/build.mjs --check`. Type-check the adapters with `polyfills/skills/codex/node_modules/.bin/tsc -p tools/muse-grok`. Run `node --test tools/muse-grok/integration.test.mjs` for source identity, content integrity, nested-read refusal, Tasks lifecycle, event wake and duplicate delivery. Run `node --test polyfills/events/muse/test/recurring.test.ts` for recurring delivery and watch confirmation. With Muse installed, `node tools/muse-grok/marketplace.mjs` regenerates the catalog after a package change. Add `--check` to verify all five hashes and names in a disposable profile. Run `node tools/muse-grok/codex-ignores-muse.mjs` with Codex installed to check the two shared plugin packages. Discovery has three additional package suites under `polyfills/server-cards/muse`, `polyfills/ard/muse` and `polyfills/server-cards/grok-bot`.


### Build an install kit

From the checkout, run `python3 tools/muse-grok/package.py --kit agentpolyfill-hosts.zip`. Extract the ZIP and open the `agentpolyfill-hosts` folder before following the install instructions. The archive includes the bundled launchers, the test job, the install script and the notices. The packaging command uses an explicit file list and fixed timestamps. Two builds from identical files produce the same bytes.

For a repeatable Tasks interoperability run, start `polyfills/tasks/codex/test/interop/fastmcp_server.py` in the locked environment documented in the Tasks checkout. Set `MUSE_GROK_FASTMCP_URL` to its loopback MCP URL before running the integration tests. The Muse and Grok workflow defines this check for pushes and pull requests. It also runs the shared card, configuration, discovery and formatting rules against both committed Muse discovery bundles.
