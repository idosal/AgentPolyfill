# mcp-apps-cli: compliance and verification

What `mcp-apps-cli` 0.1.3 implements of MCP Apps, clause by clause, how each
part is checked, and what each check does and does not prove. The spec is
[`specification/2026-01-26/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
(Stable), byte for byte the copy on `main` on 24 November 2026 (SHA-256
`ee452a7d…`), plus `ui/download-file` from the draft.

## Clause by clause

Every line of the spec with MUST, SHOULD, MAY or REQUIRED, 75 in all, one row
each. "Binds" is who the line is about: the host (this plugin), the client
(its MCP connection), a server, a view (the app), or a web host's sandbox proxy
("host (web)"), which this host doesn't have: its views run in a headless
Chrome, not in a web page that holds the conversation.

| State | Rows |
|---|---|
| Met (28 with a test, 4 by reading only, 1 by Claude Code itself) | 33 |
| Met, a MAY taken up (one only in part: R03) | 5 |
| Met with an exception the host causes (R66: Claude Code's own connection doesn't advertise the extension) | 1 |
| Not met, deliberately (R12: the default CSP when an app declares none) | 1 |
| A MAY not taken up | 6 |
| Not applicable: binds a server, a view, or a web host's sandbox proxy | 29 |

R12 is the one MUST that is neither met nor a limit of the host; see the row.

| # | Line | Clause | Binds | State | Where, and the test |
|---|---|---|---|---|---|
| R01 | 64 | MUST use the `ui://` URI scheme to distinguish UI resources | server | n/a | Binds the server. |
| R02 | 95 | SHOULD be `text/html;profile=mcp-app` for HTML-based UIs | server | n/a | Binds the server. |
| R03 | 170 | Hosts MAY honor these by setting appropriate iframe `allow` attributes. | host | met (MAY, in part) | clipboardWrite is honoured (after a click or key, once per click). Camera, microphone and geolocation are not granted: headless Chrome has no devices and no indicator the person could see. |
| R04 | 171 | Apps SHOULD NOT assume permissions are granted | view | n/a | Binds the view (the app). |
| R05 | 206 | Servers MUST consult host-specific documentation | server | n/a | Binds the server. |
| R06 | 240 | // MUST be "text/html;profile=mcp-app" | server | n/a | Binds the server. |
| R07 | 267 | URI MUST start with `ui://` scheme | server | n/a | Binds the server. |
| R08 | 268 | `mimeType` MUST be `text/html;profile=mcp-app` (other types reserved | server | n/a | Binds the server. |
| R09 | 269 | Content MUST be provided via either `text` (string) or `blob` (base64-encoded) | server | n/a | Binds the server. |
| R10 | 270 | Content MUST be valid HTML5 document | server | n/a | Binds the server. |
| R11 | 274 | Host MUST construct CSP headers based on declared domains | host | met | The view's document gets a CSP response header built from the declared domains the helper keeps (policy.rs allowed_csp, build_csp; tests: random_domain_lists_preserve_directive_boundaries and the injection tests). |
| R12 | 275 | Restrictive Default: If `ui.csp` is omitted, Host MUST use: | host | not met (deliberate) | Not met, deliberately: without `ui.csp` the view gets basic-host's default (it adds `'unsafe-eval'` and `blob:` and `connect-src 'self'`, where `'self'` is the view's own origin, answered by the helper inside Chrome), so apps that run generated code, such as the SDK's own three.js example (it declares no CSP and calls `new Function`), work. Not a limit of the host: Ido's decision (see the report). |
| R13 | 286 | No Loosening: Host MAY further restrict but MUST NOT allow undeclared domains | host | met | Further restricted, never loosened: broad sources (`*`, `https:`, a wildcard port, a wildcard over fewer than two labels or over a shared suffix such as `*.workers.dev`, `*.co.uk`) and private addresses other than the server's own are dropped and logged (tests: broad_sources_are_not_applied, wildcards_over_shared_suffixes_are_not_applied, csp_private_ports_and_injection). |
| R14 | 287 | Audit Trail: Host SHOULD log CSP configurations for security review | host | met | Each view's CSP goes to Claude Code's debug log; dropped sources are logged too. |
| R15 | 390 | Resource MUST exist on the server | server | n/a | Binds the server. |
| R16 | 391 | Host MUST use `resources/read` to fetch the referenced resource URI | host | met | Over the helper's own MCP connection (a plugin can't read resources through Claude Code's). |
| R17 | 392 | Host MAY prefetch and cache UI resource content | host | met (MAY, taken up) | Taken up: a second view of an app uses the copy read before, refreshed in the background. |
| R18 | 393 | Servers MAY omit UI-only resources from `resources/list` | server | n/a | Binds the server. |
| R19 | 400 | tools/list behavior: Host MUST NOT include tools in the agent's tool list when their visibility does not include `"model"` | host | met (by Claude Code) | Claude Code does not put app-only tools in the model's tool list; that list is its own, not the plugin's. |
| R20 | 401 | tools/call behavior: Host MUST reject `tools/call` requests from apps for tools that don't include `"app"` in visibility | host | met | The helper refuses a tool whose visibility leaves out `app` before consent is asked (views.rs host_call); the mod refuses a tool its server doesn't list and calls only the view's own server. |
| R21 | 472 | If the Host is a web page, it MUST wrap the View and communicate with it through an intermediate Sandbox proxy. | host (web) | n/a | Not a web host in the spec's sense: the host page in headless Chrome holds no conversation or session, and the view is cross-origin to it (host.<origin> vs <origin>); the binding answers only the host page's frame. |
| R22 | 474 | The Host and the Sandbox MUST have different origins. | host (web) | met | The analogue here: the host page's origin differs from the app's in every case (generated, the Rust helper). |
| R23 | 475 | The Sandbox MUST have the following permissions: `allow-scripts`, `allow-same-origin`. | host | met | The view's iframe: allow-scripts allow-forms allow-same-origin allow-pointer-lock, identical in the Rust helper. |
| R24 | 476 | The Sandbox MUST send a `ui/notifications/sandbox-proxy-ready` notification | host (web) | n/a | No sandbox proxy (R21). |
| R25 | 477 | Once the Sandbox is ready, the Host MUST send the raw HTML resource | host (web) | n/a | No sandbox proxy: the helper serves the HTML at the app's origin with its CSP header. |
| R26 | 478 | The Sandbox MUST load the raw HTML of the View with CSP settings that: | host | met | Declared domains enforced; frame-src 'none' unless declared; base-uri 'none' unless declared (stricter than 'self'); object-src 'none'; restrictive default: see R12. |
| R27 | 484 | If `permissions` is declared, the Sandbox MAY set the inner iframe's `allow` attribute | host | n/a (MAY, not taken up) | See R03. |
| R28 | 485 | The Host MUST NOT send any request or notification to the View before it receives an `initialized` notification. | host | met | Arguments, result, cancel, context changes and the teardown all wait for initialized (host.ts keeps them; __teardown returns when the app never initialized). The line also binds the sandbox proxy's forwarding, which has no counterpart here. |
| R29 | 486 | The Sandbox SHOULD NOT create/send any requests to the Host or to the View | host (web) | n/a |  |
| R30 | 487 | The Host MAY forward any message from the View (coming via the Sandbox) to the MCP Apps server | host | met | Forwarded only with consent (appToolCalls; deny rules first), only to the view's own server, only for the open of the view that asked (0.1.3), and only on Claude Code's yes asked for that request (0.1.2; from 0.1.3 asked again after the person's consent, and a no cancels what is in flight). Model: AppsConsent (ToolCallsConsented, DenyWins, AskedWhereClaudeCodeWouldAsk) and AppsViews (GatedSends, NoSendAfterNo, SendsOnlyWhileUsed, NoAnswerAfterNo, SameInstance, OwnServerOnly). Tests: "an app's calls and reads stop once Claude Code stops using its server", "an app-only tool's yes is asked of Claude Code after the person's yes", "what an earlier open's page asks is refused", `tests/gate.rs` (a revoke cancels a request in flight). |
| R31 | 512 | it MUST include its capabilities in the `appCapabilities` field | view | n/a | Binds the view (the app). |
| R32 | 533 | the Host SHOULD include UI-specific context in the `McpUiInitializeResult`'s `hostContext` field | host | met | theme, styles, displayMode, availableDisplayModes, containerDimensions, locale, timeZone, userAgent, platform, deviceCapabilities, safeAreaInsets, toolInfo. |
| R33 | 718 | hosts MUST listen for `ui/notifications/size-changed` notifications from the View and update the iframe | host | met | Test: in a tall view scrolled down, a click lands on what's under it; resize |
| R34 | 781 | View MUST declare all display modes it supports | view | n/a | Binds the view (the app). |
| R35 | 782 | View MUST check if the requested mode is in `availableDisplayModes` | view | n/a | Binds the view (the app). |
| R36 | 783 | View MUST handle the response mode differing from the requested mode. | view | n/a | Binds the view (the app). |
| R37 | 786 | Host MUST NOT switch the View to a display mode that does not appear in its `appCapabilities.availableDisplayModes`, if set. | host | met (no test) | Checked in host.ts and again in the mod (and the header offers only declared modes). The test covers the modes an app declares, not a refused one. |
| R38 | 787 | Host MUST return the resulting mode (whether updated or not) | host | met | Test: an app can ask to fill the terminal, move to a pane, and come back |
| R39 | 788 | If the requested mode is not available, Host SHOULD return the current display mode | host | met (no test) |  |
| R40 | 789 | Host MAY decline display mode requests from Views that did not declare said modes | host | n/a (MAY, not taken up) |  |
| R41 | 996 | Host SHOULD open the URL in the user's default browser or a new tab. | host | met | After the person says yes (or allowed this app's links for the session); http(s) only. |
| R42 | 1033 | Host SHOULD add the message to the conversation context, preserving the specified role. | host | met | A user turn, framed as the app's words . |
| R43 | 1034 | Host MAY request user consent. | host | met | Taken up: asked by default (appMessages). |
| R44 | 1093 | The View MAY send this request to update the Host's model context. | view | n/a | Binds the view (the app). |
| R45 | 1097 | SHOULD provide the context to the model in future turns | host | met | With the next prompt, out of the person's view, and only from live views of this session: closed views' context is dropped, and all of it is cleared at /clear and when the helper exits. |
| R46 | 1098 | MAY overwrite the previous model context with the new update | host | met (MAY, taken up) | Taken up (latest per app). |
| R47 | 1099 | MAY defer sending the context to the model until the next user message | host | met (MAY, taken up) | Taken up. |
| R48 | 1100 | MAY dedupe identical `ui/update-model-context` calls | host | n/a (MAY, not taken up) |  |
| R49 | 1101 | If multiple updates are received before the next user message, Host SHOULD only send the last update | host | met (no test) | One entry per view, replaced by each update. |
| R50 | 1102 | MAY display context updates to the user | host | n/a (MAY, not taken up) |  |
| R51 | 1106 | Host MUST send this notification with the complete tool arguments after the View's initialize request completes. | host | met | Test: InputBeforeResult; InputBeforeResult; then the whole arguments, once |
| R52 | 1120 | Host MAY send this notification zero or more times while the agent is streaming tool arguments | host | met | Taken up, for calls that run without asking; a call that would ask gets none until allowed (WithheldNoArgs holds). |
| R53 | 1134 | MAY parse the agent's partial JSON output by closing unclosed brackets/braces | host | met (MAY, taken up) | Taken up. |
| R54 | 1135 | MAY send recovered arguments as they become available during streaming | host | n/a (MAY, not taken up) |  |
| R55 | 1136 | MUST stop sending once `ui/notifications/tool-input` is sent with complete arguments | host | met | Test: NoPartialAfterInput; NoPartialAfterInput |
| R56 | 1140 | MAY ignore these notifications entirely | view | n/a | Binds the view (the app). |
| R57 | 1141 | MAY render progressive loading/streaming states | view | n/a | Binds the view (the app). |
| R58 | 1142 | MUST NOT rely on partial arguments for critical operations | view | n/a | Binds the view (the app). |
| R59 | 1143 | SHOULD gracefully handle missing or changing fields between notifications | view | n/a | Binds the view (the app). |
| R60 | 1155 | Host MUST send this notification when tool execution completes (if the View is displayed during tool execution). | host | met | Sent once per call, never after a cancel: tool.run marks the call it takes, and an early view's approval is decided once. |
| R61 | 1169 | Host MUST send this notification if the tool execution was cancelled, for any reason | host | met | Denied, failed to run, or the turn stopped. A view that loaded while its call waited to be allowed, and was denied, is torn down instead (it never had the arguments). |
| R62 | 1201 | Host MUST send this notification before tearing down the UI resource, for any reason | host | met | On eviction, sleep, session end, /clear and a dropped early view (1.5 s at most). A page that crashed has nothing to send it to. |
| R63 | 1202 | Host SHOULD wait for a response before tearing down the resource | host | met | Up to 1.5 s, then closed anyway (the threat model asks for a host deadline). |
| R64 | 1217 | The View SHOULD send this notification when rendered content body size changes | view | n/a | Binds the view (the app). |
| R65 | 1229 | Host MAY send this notification when any context field changes | host | met | Taken up: theme, display mode, size, scale. |
| R66 | 1522 | `mimeTypes`: Array of supported content types (REQUIRED | client | exception (host) | On the helper's own connection. Claude Code's connection, which runs the model's calls, doesn't advertise it, and a plugin can't change that: a limit of the host. |
| R67 | 1531 | Servers SHOULD check client capabilities before registering UI-enabled tools. | server | n/a | Binds the server. |
| R68 | 1558 | Servers SHOULD provide text-only fallback behavior | server | n/a | Binds the server. |
| R69 | 1559 | Tools MUST return meaningful content array even when UI is available | server | n/a | Binds the server. |
| R70 | 1560 | Servers MAY register different tool variants based on host capabilities | server | n/a | Binds the server. |
| R71 | 1698 | All View content MUST be rendered in sandboxed iframes with restricted permissions. | host | met | A sandboxed iframe (`allow-scripts allow-forms allow-same-origin allow-pointer-lock`), served from an origin other than the host page's, in a headless Chrome with its own sandbox on (unless MCP_APPS_CLI_NO_SANDBOX), one browser context per view, WebRTC off, navigation away blocked. |
| R72 | 1725 | Hosts MUST enforce Content Security Policies based on resource metadata. | host | met | Enforced by Chrome on the header; navigation, which connect-src doesn't cover, is blocked separately. |
| R73 | 1756 | Host MUST block connections to undeclared domains | host | met | And dedicated origins only for a server's own hash. |
| R74 | 1757 | Host SHOULD warn users when UI requires external domain access | host | met (no test) | The view's header names the domains its CSP lets it reach. |
| R75 | 1758 | Host MAY implement global domain allowlists/blocklists | host | n/a (MAY, not taken up) | A fixed blocklist of sorts: broad sources and other private addresses are never applied. |

## Features a client can have, and which it has

| Feature (spec section) | Here |
|---|---|
| UI resources from `_meta.ui.resourceUri`, read with `resources/read`, `text` or `blob`, MIME checked | yes, over the helper's own connection |
| Advertising `io.modelcontextprotocol/ui` with `mimeTypes` | on the helper's connection only (host limit: Claude Code's own) |
| Tool visibility (`model`, `app`) | yes: apps call only tools that include `app`; Claude Code keeps app-only tools from the model |
| Lifecycle: `ui/initialize`, `initialized`, `tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `resource-teardown` | yes |
| Host context and `host-context-changed` | yes (theme, styles, display mode and modes, container size, locale, time zone, user agent, platform, device capabilities, safe areas, tool info) |
| View requests: `tools/call`, `resources/read`, `resources/list`, `resources/templates/list`, logging, `ping` | yes |
| `ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode`, `size-changed` | yes |
| `ui/download-file` (draft) | yes, after the person says Save |
| CSP from `_meta.ui.csp`, `prefersBorder`, `domain` | yes (see R11-R14, R26, R72-R75) |
| `permissions` | `clipboardWrite` yes; camera, microphone, geolocation not granted (no devices in headless Chrome, no indicator) |
| Display modes `inline`, `fullscreen`, `pip` | yes, as a terminal allows: fullscreen fills the terminal, pip is a pane |
| Sign-in (OAuth) for servers that need it | no: the helper's own connection can't use Claude Code's sign-in. Host change: `$.mcp.request` over Claude Code's connection ([host-changes](../../../../docs/host-changes.md), change 1) |
| `_meta` and `structuredContent` of Claude Code's own results | restored for tools with an `outputSchema`; host change 4 would give them whole |
| `tools/list_changed`, resource updates | no: Claude Code delivers no server notifications to plugins (host change 3) |

## The conformance suite

`@modelcontextprotocol/conformance` (npm 0.1.16 and 0.2.0-alpha.12;
`main` at `96a6f947`, 10 November 2026) has client scenarios for
initialization, tools, HTTP headers, auth and Skills, and none for MCP Apps
(`io.modelcontextprotocol/ui`). There is nothing of it to run for this
extension.

## Verification

### The formal model

`model/AppsViews.tla` and `model/AppsConsent.tla`, checked with TLC 1.7.4
(`node model/check.mjs`; CI runs it too, `mcp-apps-cli-test.yml`, job
`model`). TLC explores every state reachable within each configuration's
bounds; what it reports for a configuration is exhaustive within them and
says nothing past them.

What is modelled: Claude Code's verdict on each server (which can change at
any time), the mod's verdicts (0.1.2's, kept 5 s, and 0.1.3's, asked for each
request), views opening, closing, sleeping, reopening and evicted past three
live, each open's generation, the helper's pages, its per-id open lock and
the closes it keeps for an open under way, requests between the mod and the
helper delivered in any order, an app's reads and tool calls and their
answers in flight, a no cancelling what is in flight, the mod asking again
while the helper waits on a server, crashes, `/clear`, another program on the
machine without the token; and, in the second module, an app's tool calls under `rules`, `ask`
and `allow` with rules that change at any time and checks that fail, session
grants, one question at a time, views opened while Claude writes the call,
messages under `ask`, `fill` and `allow`, links and downloads.

What is not modelled, and is checked elsewhere or not at all: the config
gate's decision (taken as given here, and checked over every case below);
`${VAR}` expansion (an operator here, property-tested below); Chrome, the
host page and the app's own code; the terminal; timing (the 5 s verdict,
the 0.5 s watch and every deadline are "may happen at any time"). Two
abstractions matter for what SendsOnlyWhileUsed and NoAnswerAfterNo say:
the mod's `$.mcp.connect` and the helper's writing of the request it was
asked for are one step here, though in the code they are one local round
trip apart; and a `/revoke` is applied in the step the mod hears the no,
though in the code it is one local request later. What falls in those gaps
is listed under "What remains" below. The epoch that refuses a yes which
crossed a no on its way exists for the second gap and is checked by
`tests/gate.rs`, not by the model.

The invariants, in plain words:

| Invariant | Says |
|---|---|
| GatedSends | The helper sends a server nothing unless the request behind it came with Claude Code's yes for that server under that name |
| NoSendAfterNo | Once the mod has heard that Claude Code doesn't use a server, a request made after that sends it nothing |
| NoCredentialToRemote | A credential-named variable never reaches a remote server's URL or headers; a server's headers go to its own origin only |
| AtMostLiveMax | At most three views are live (or opening) at once |
| TokenRequired | A request without the token changes nothing and reaches no server |
| OwnServerOnly | A view gets results only from the server its app came from |
| NoOrphanPages | Once nothing is in flight, the helper holds a page only for a view the mod has live or opening |
| NoDeadViews | Once nothing is in flight, every view the mod has live has its page |
| SendsOnlyWhileUsed | Every request the helper writes to a server goes while Claude Code uses that server under that name (0.1.3) |
| NoAnswerAfterNo | Once the mod has heard that Claude Code stopped using a server, nothing more from it reaches a view (an answer, the UI resource of an open under way) until a later yes (0.1.3) |
| SameInstance | What a view's app asked is done only for the open that asked it, never for a later open of the same call (0.1.3) |
| ToolCallsConsented | An app's tool call runs only where the rules allowed it (`rules`, `allow`), the setting allowed it (`allow`, rules not denying), or the person said yes, now or "this session" in this session |
| DenyWins | A deny rule, at the time of the check, is never overridden |
| AskedWhereClaudeCodeWouldAsk | Where the rules would ask, or the check failed, the person is asked, in every mode (unless they allowed the tool this session) |
| LinksAsked, SavesAsked, MessagesAsked | No link opens and no file is saved without a yes; a message goes to Claude only with a yes, the setting `allow`, or from the person's own prompt (`fill`) |
| OnlyApprovedViews | Nothing happens for a view whose call Claude Code didn't let run |
| GrantsEndWithSession | A "this session" yes never carries into the next session |

Results with TLC 1.7.4 on Temurin 21, `-workers auto`; state files under 150 MB, or 400 MB for ConsentRules and
ConsentAsk, whose queue of states yet to visit peaks at about 130 and 160 MB
with CI's four workers (a run past its cap counts as failed), deleted after
each run. The counts are TLC's final distinct-state counts
(0.1.2's table took a progress line for some). With several workers the
reported depth can differ by one from run to run, and for a violated
configuration the states explored up to the first violation found vary too;
the numbers below are one run's.

| Configuration | Bounds | Result |
|---|---|---|
| Live | 4 calls on one server, 3 live at most, each opened once; up to symmetry | all hold; 96,487 states, depth 33 |
| Reopen | 2 calls, 1 live, each opened twice | all hold; 23,773 states, depth 32 |
| Race | 1 call opened, closed and reopened up to 3 times | all hold; 434 states, depth 23 |
| Traffic | 2 calls on 2 servers, 1 live, every kind of app request, Claude Code changing its mind | all hold, SendsOnlyWhileUsed and NoAnswerAfterNo among them; 470,040 states, depth 28 |
| TrafficShared | 2 calls on 1 server, both live, the same | all hold, the same; 199,672 states, depth 27 |
| Instance | 1 call opened twice, its app asking all along | SameInstance, NoOrphanPages, NoDeadViews hold; 1,164 states, depth 20 |
| ReopenTraffic | 1 call opened twice, every kind of app request, Claude Code changing its mind | all hold (generations and cancelling together); 7,552 states, depth 22 |
| Token | another program sending forged requests | all hold; 40,112 states, depth 24 |
| ConsentRules, ConsentAsk, ConsentAllow | 2 tool calls (one app-only), two sessions, each setting | all hold; 947,520, 1,532,480 and 519,488 states, depth 16 |
| ConsentOther | 2 messages, links or downloads, every appMessages setting | all hold; 72,769 states, depth 14 |
| RaceBefore, RaceBeforeDead | Race against 0.1.1 | NoOrphanPages and NoDeadViews violated (the defects fixed in 0.1.2) |
| TrafficBefore, TrafficBeforeNo | Traffic against 0.1.1 | GatedSends and NoSendAfterNo violated (fixed in 0.1.2) |
| WindowBefore | Traffic against 0.1.2 | SendsOnlyWhileUsed violated: the window 0.1.2 documented (a yes kept 5 s for discovery and opening; an open's resource read on the /open's yes) |
| CancelBefore | TrafficShared with every 0.1.3 fix but the cancelling | NoAnswerAfterNo violated: an answer in flight when the mod hears the no still reached the app |
| InstanceBefore | Instance against 0.1.2 | SameInstance violated: requests were matched to a view by id alone |
| RaceGen | Race with generations but not the one-at-a-time order | NoDeadViews violated: a late /open of an earlier generation replaces the newer page, so the order stays |
| Witness* | each outcome (a run, a message, a link, a save) | reachable, so the consent invariants don't hold for want of anything happening |

`node model/check.mjs` runs all 24 configurations; every one gives what it
should. The configurations 0.1.2 had keep their bounds; ReopenTraffic and
RaceGen are new. A larger one (2 calls of one server, each opened twice, with
traffic) passed 150 MB of state files and was dropped.

What the model found, both fixed in 0.1.2 with a test each that fails on
0.1.1:

1. **An app's own traffic was never re-checked.** After a view opened, its
   app's reads and calls of app-only tools went to the server over the
   helper's connection with no further look at Claude Code's verdict, so a
   server switched off in `/mcp` (or that Claude Code stopped using) still got
   them. Each now waits for `$.mcp.connect`, asked afresh.
2. **A view's `/open` and `/close` could cross.** They are separate requests
   the helper matches by view id. Out of order, a close for an earlier open
   could close a reopened view's page (the view then stood live with no page),
   or arrive before its page existed and leave that page running unseen. They
   now go one at a time per id.

The two windows 0.1.2 documented as reachable, closed in 0.1.3, each in
the model first (the invariant that failed with the documented exception
now holds without it), then in the code, each with tests that fail on
0.1.2:

3. **A request reached a server just after Claude Code stopped using it.**
   0.1.2 kept a yes 5 s and reused it to discover and open views, read an
   open's UI resource on the `/open`'s yes, asked Claude Code about an app's
   tool before the person was asked (so the yes could be minutes old), and
   let a request in flight go on. Now no yes is kept: each request the
   helper writes to a server waits for Claude Code's verdict asked for it
   (the helper's `check`, or the mod's answer to the app's own request,
   asked again after the person's consent); a no tells the helper
   (`/revoke`), which fails what is in flight to the server, closes the
   connection and refuses any yes older than the no; and while the helper
   waits on a server the mod asks again every 0.5 s. Model: FixAtSend and
   FixRevoke (WindowBefore, CancelBefore). Tests: the mod's "no yes is
   kept", "the helper's check before each request it writes", "while the
   helper waits on a server", "an app-only tool's yes is asked of Claude
   Code after the person's yes"; `tests/gate.rs`'s
   `a_server_claude_code_says_no_to_is_never_started`,
   `a_revoke_stops_the_server_and_refuses_a_yes_from_before_it`,
   `a_revoke_cancels_a_request_in_flight`.
4. **An earlier open's request could be answered for the reopened view.**
   The mod found a view by its id (the tool call's), so what the page of an
   earlier open of the same call asked (a message to Claude, a link, a tool
   call, its context for the model) could be done for the view opened again
   in its place. Now each open has its own generation, a nonce carried by
   `/open`, every route about the view, every line the helper says of its
   page and every answer; anything of another generation is refused or
   ignored. Model: FixGen (InstanceBefore). Tests: the mod's "what an earlier
   open's page asks is refused" and the reopen test's generations; the Rust
   and Node helpers' generation rules (`views.rs` tests,
   `test/generations.test.mjs`).

What remains of the first, which no change in this plugin can remove:

- Claude Code's yes and the helper's writing of the request are one local
  round trip apart: a `check` line on the helper's stdout, the mod's
  `$.mcp.connect`, its `/reply`. A server switched off within that moment
  still gets the request.
- A request already written isn't unsent: the server may have acted on it.
  Closing the connection is its only notice, and over streamable HTTP rmcp
  closes it with one more request, the session's `DELETE`.
- Within one request, what follows the server's own answers goes on the same
  yes: the second half of the connection's handshake (`initialized`),
  further pages of a tool list, rmcp's upkeep of an HTTP server's event
  stream while the connection stands.
- The mod hears a no only when it asks: at the next request for that server,
  or within 0.5 s while a request to it is in flight. An answer arriving
  before then still reaches the app; a connection with nothing in flight (an
  idle stdio server the helper started) stays open until then, or until the
  helper exits. A `/revoke` reaches the helper one local request after the
  no, and an answer can land in between.
- An app's call of a tool the model also sees goes over Claude Code's own
  connection (`$.mcp.call`), which Claude Code decides about.
- The Node helper, which the plugin doesn't package or run, has the
  generations but none of this (nor 0.1.2's recheck of an app's traffic).

Nothing remains of the second within the model's bounds: a request, answer,
note, picture or close of another generation is refused or ignored by both
the mod and the Rust helper.

### The config gate, over every case

`config::decide` takes a finite input: 11 flags and four settings layers of
12 states each, 42,467,328 cases. `helper-rs/tests/support/gate_exhaustive.rs`
checks every one against the rules written out on their own, asserts each
safety rule separately (no reserved name; nothing under a policy or switched
off; never a lower scope's entry for a refused higher one; local and project
entries only in a trusted folder; under inherited trust, the repository's own
settings change nothing), and checks that every scope is reachable. Three
mutants of `decide` are each caught. This proves `decide` matches those rules.
It does not prove the rules are Claude Code's: they are its documented
behaviour, and the mod asks Claude Code's own verdict first.

### Property-based tests

Seeded, generated inputs (the helper's own generator, no new dependency),
run on every `cargo test`:

| What | Cases | Found |
|---|---|---|
| `config::facts` reads 400 random worlds on disk back as the facts they were written from, and `resolve_in` agrees with `decide` | 400 | nothing |
| `${VAR}` expansion: in a remote entry no credential-named variable is looked up or appears; a local entry gets every variable | 5,000 | nothing |
| Already there: the HTTP request reader (random bytes, short reads, lengths, the head limit, allocation bounds), the token comparison, CSP building against injection, origins, command-line words and `--mcp-config` parsing, expansion fallbacks | 3,000-5,000 each | nothing |

## Measurements

The helper, started alone, five times each, on one machine, over the TCP
transport: ready (its first line) in 4.5-9.8 ms, idle at 4.4-4.7 MB resident
and no measurable CPU over 5 s (the release build; a debug build: 4.6-9.9 ms,
8.2-8.7 MB), a `/ping` round trip in 0.3-0.6 ms, gone 0.6-1.1 ms after
SIGTERM. The mod starts nothing with the session; the helper starts with the
first MCP call. The hooks module is 160 KB of TypeScript. The costs with
views open (Chrome, pictures) aren't measured here. These are 0.1.2's
numbers; 0.1.3 changes nothing at start and adds one local round trip (a
`check`) before each request the helper writes to a server.

## Checked, and not checked

Checked in Claude Code 2.1.329 on macOS, against the hosted arcade server.

Not checked for 0.1.3: macOS on Intel, Linux, Windows; the bench checks that need the
SDK's example servers; the render crate's parity tests; `ui/allow-tool` and
`ui/allow-read` in a Claude Code session (the tests cover them); a session in
which Claude Code stops using a server while a view of it is open.
