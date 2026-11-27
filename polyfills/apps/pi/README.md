# MCP Apps in Pi

After Pi calls an MCP tool, type `/mcp-app` to open its most recent successful
MCP result. Pi first asks to inspect the app on that server. Before the app
opens, a second prompt names the tool whose input and result the app will receive,
the server whose resources it can list and read, and any permitted external
destinations. Declining either prompt leaves you in the conversation.
In Pi’s fullscreen mode, click controls, drag to rotate a 3D model, or scroll
to zoom if the app supports it. Tab moves focus, Enter activates a control,
printable keys enter text and Esc returns to the conversation. Pi draws full-color
graphics when its terminal image renderer is available and colored character
cells otherwise.

The extension is included in the repository's Pi package. From a local clone
run `npm ci` at the repository root and `pi install /absolute/path/to/AgentPolyfill`.
Install Chrome or set `MCP_APPS_CLI_CHROME` to a Chromium executable.
Set `MCP_APPS_OFF=1` before launching Pi to disable the adapter.

### Walkthroughs

Follow a fullscreen Pi session in Kitty from the first tool call through both
approvals. Once the satellite appears, dragging rotates it and scrolling zooms in.

<a href="../../../docs/media/demos/apps-pi-3d.mp4">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="../../../docs/media/demos/apps-pi-3d.jpg">
    <img src="../../../docs/media/demos/apps-pi-3d.gif" alt="Pi shows the inspection and access prompts, opens the satellite, then rotates and zooms it in response to mouse input.">
  </picture>
</a>

[Play the 22-second 3D walkthrough](../../../docs/media/demos/apps-pi-3d.mp4).

The clock walkthrough shows both opening prompts and keyboard navigation.
Refreshing the clock asks for a separate tool approval and displays a new server timestamp.

<a href="../../../docs/media/demos/apps-pi.mp4">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="../../../docs/media/demos/apps-pi.jpg">
    <img src="../../../docs/media/demos/apps-pi.gif" alt="Watch the clock open with its original timestamp, request permission to refresh and display the new time">
  </picture>
</a>

[Watch the 17-second clock walkthrough](../../../docs/media/demos/apps-pi.mp4).

### Play Arcade

Add the hosted Arcade server, then launch Pi in fullscreen mode.

```sh
pi mcp add arcade --url https://mcp-apps-arcade.idosalomon.workers.dev/mcp
pi
```

Ask Pi to load the shareware game `msdos_DOOM_1993` and open its view.
You can also open the most recent result with `/mcp-app`.
Review the server, its embedded page and the listed external destinations.
Click the power button on the cover, choose a sound option, and start a new
game. Use the arrow keys to move and turn, click to fire and press Tab for
the automap. In Kitty, Pi uses graphics by default. To try the same game in
character cells, launch `PI_IMAGE_PROTOCOL=none pi`.

| Kitty graphics | Character cells |
| --- | --- |
| <a href="../../../docs/media/demos/apps-pi-arcade-kitty.mp4"><picture><source media="(prefers-reduced-motion: reduce)" srcset="../../../docs/media/demos/apps-pi-arcade-kitty.jpg"><img src="../../../docs/media/demos/apps-pi-arcade-kitty.gif" alt="Pi in Kitty playing the Hangar level in full color"></picture></a> | <a href="../../../docs/media/demos/apps-pi-arcade-cells.mp4"><picture><source media="(prefers-reduced-motion: reduce)" srcset="../../../docs/media/demos/apps-pi-arcade-cells.jpg"><img src="../../../docs/media/demos/apps-pi-arcade-cells.gif" alt="Pi playing the same level using colored terminal characters"></picture></a> |
| [Play the 18-second Kitty recording](../../../docs/media/demos/apps-pi-arcade-kitty.mp4) | [Play the 18-second cell recording](../../../docs/media/demos/apps-pi-arcade-cells.mp4) |

## Compatibility

This is a partial client for the stable 2026-01-26 MCP Apps specification
(`io.modelcontextprotocol/ui`). The supported Node CLI builds are Pi 1.6.0 and
1.6.1. Both expose the original server and tool in completed MCP tool details
but filter App resources from Pi's own client. The command uses a separate
connection to read the tool definition and app resource. The reviewed document
and its browser policy stay together until you open or decline it. Opening an
app never replays the original tool call. A stdio server starts a second
process. Views requiring Pi's stored OAuth credentials, or a resource held
only in the first process, are unavailable.

**Tool visibility.** The adapter filters the native MCP catalog before Pi
registers tools, including after a server announces a list change. Tools whose
visibility omits `model` stay out of the model's catalog in direct, code-mode
and deferred exposure. Pi currently has no public hook at that point. On
startup the adapter checks the installed build's hash, then applies the
filter in memory. On an unrecognized build or when explicitly disabled, Pi
uses its own MCP behavior and the Apps viewer is unavailable. Restart Pi
after installing the adapter.

**Browser access.** If the app omits its policy, Pi sends the specification's
restrictive default to Chromium. The app can run inline code and display
embedded images. External connections and runtime JavaScript evaluation are
blocked. The opening prompt lists the external destinations that the policy
actually permits. A resource that explicitly includes `blob:` in
`_meta.ui.csp.frameDomains` may embed a page built from its own data. Pi
discloses this separately at review. That permission applies only to frames.
The specification makes the restrictive default mandatory
and recommends warning users about external access. [MCP Apps host behavior](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#host-behavior)
and [security requirements](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#4-content-security-policy-enforcement).

Only Pi's built-in MCP tool results qualify. A disabled server, a changed
configuration or a session switch invalidates the saved result. The view
receives the original input, content and structured content that Pi exposes.
Pi omits the result's private MCP metadata. When the agent opens the viewer
with `open_mcp_app`, the app can request an exposed tool on the same server.
Pi asks you to approve its exact arguments and dispatches the call through Pi.
Views opened via the slash command cannot initiate tool calls. App-only tool
calls, sending chat messages, external links and downloads are unavailable.
Browser storage is scoped to the open view.

## Verification

The first recording shows Pi 1.6.0 in Kitty on macOS rendering a Three.js
fixture with the satellite scene bundled into the app. The upstream Three.js
example builds the scene from JavaScript at runtime and requires evaluation
that the default policy blocks. The recorded fixture omits CSP metadata and
exercises the restrictive default, drag-to-orbit, wheel zoom and Esc.

The second recording uses Pi 1.6.1 and the unmodified upstream vanilla clock
example. Pi displayed the original server timestamp, asked for approval when
the app requested a refresh, then displayed the updated time. Both recordings
used a scripted local model to select tools.

The Arcade recordings used the hosted Arcade Server 1.0.0 and two real
fullscreen Pi 1.6.1 sessions in Kitty 0.50.0 on macOS. A scripted local model
selected the MCP tools. Terminal input started E1M1, walked and turned the
player, fired the pistol and toggled the Hangar automap. One session emitted
Kitty graphics and the other emitted ANSI-colored characters on a 136 × 48
grid. The recorded gameplay uses the game served by Arcade.

Run `npm ci` at the repository root and `npm ci && npm run typecheck && npm test`
in this directory. The regressions cover Pi's model-facing catalog and its live
updates, Chromium's applied policy, accepting and declining access, using the
exact reviewed resource, nested tool approval, and graphical and keyboard input.
