# Host kit safety models

TLC exhaustively explores the reachable states of five finite TLA+ specifications. Each specification has a normal configuration and separate negative controls. A control passes only if TLC reports the expected invariant violation. The model checker and the packaged adapter tests run in the host kit workflow.

| Model | Property | Bounds and corresponding implementation checks |
| --- | --- | --- |
| RoutineDelivery | A crash or restart cannot authorize a second POST. A deliberate retry preserves the original body. A local read requires an exact accepted batch. Expiry retains unsent events. | Two events, one explicit retry per batch, two title settings, one routine. The Grok bridge, SQLite inbox and packaged CLI tests cover persistence, retention pressure, migration, redirects, timeout, concurrent ownership and operator confirmation. An operator-authorized retry after an ambiguous response can create a second hosted run. |
| SkillApproval | A supporting file can be returned only for its own session, publisher and manifest, after exact membership and content verification. A new read request clears the old grant. | Two sessions, two source identities, two manifest digests, listed and unlisted files, matching and mismatched bytes. The packaged Skills tests exercise publisher replacement, changed content and cross-session refusal. The default local approval prompt and the optional remote owner dialog are macOS features. |
| WatchConfirmation | The same request can consume a typed confirmation once, in its session and for its endpoint. | Two sessions, two requests per session, two endpoints, two phrase codes, and expiry. A generation distinguishes consecutive requests even if a phrase code is reused. The recurring Events tests cover the prompt hook, replacement, expiry, and endpoint changes. |
| TaskHandles | Each job starts through its source-specific allowlist. Poll and cancel resolve a live handle through the issuing publisher connection. | Two sources, two tools and two handles, including expiry. Stdio and HTTP tests exercise the real packaged adapter with a separate FastMCP publisher. Grok's HTTP bearer represents one operator. Anyone holding the bearer and a valid handle shares its authority. |
| DiscoveryHandoff | Directory and Server Card discovery can prepare a connection to a shown endpoint. Preparing a plan leaves the host configuration untouched. | Two cards and two endpoint identities. Muse caches discoveries per session. The Grok helper fetches its card during the command. The host-specific discovery suites check actual URLs, plan quoting, existing connector names and recorded host interactions. |

The models cover these protocol decisions under the stated bounds. They assume working cryptographic primitives, a private operating-system account, correctly identified sessions and atomic database commits. Model checking does not establish filesystem durability on every platform, remote service availability, parser correctness or model behavior on a natural-language question. The real-host evidence and remaining limitations are in the [setup guide](../../../docs/muse-grok.md).

Run the checks with Java and the official TLC 1.7.4 JAR. The runner verifies the pinned SHA-256 before invoking Java.

```sh
TLA2TOOLS=/absolute/path/to/tla2tools.jar node tools/muse-grok/model/check.mjs
```

The runner exits unsuccessfully on a parsing error, timeout, unexpected violation, missing counterexample or incorrect tool version.

The lost-acknowledgment trace in `lost-ack.json` is shared with the packaged watcher test. TLC checks that this sequence can reach an accepted second batch with the first batch readable. The CLI test runs the real watcher process, accepts a request on a loopback receiver, withholds its response, kills the sender, and compares the observable ownership, held batch, queue, reads and POSTs through restart and operator confirmation. It covers that concrete schedule.
