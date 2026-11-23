// Host page for mcp-apps-cli. Runs inside a headless Chrome page that the
// helper drives. It embeds one MCP App view in a sandboxed iframe and wires
// it to an AppBridge; anything that has to leave the page (tool calls,
// messages, links, size changes) goes to the helper through the
// `__cliHost` binding that Playwright exposes.

import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";

type OpenOptions = {
  /** URL the helper serves the view's HTML from, with its CSP header. */
  src: string;
  sandbox: string;
  toolName: string;
  /** Absent while Claude is still writing the call (see __toolArgs). */
  toolInput?: Record<string, unknown>;
  /** What Claude has written of the arguments so far, while toolInput is absent. */
  partialInput?: Record<string, unknown>;
  toolResult: unknown;
  width: number;
  maxHeight: number;
  /** Pictures (image mode): an app a little taller than its room is shrunk to fit. */
  fit: boolean;
  theme: "light" | "dark";
  styles: Record<string, string>;
  /** The tool definition from tools/list (host context `toolInfo`). */
  tool?: Record<string, unknown>;
  locale: string;
  timeZone: string;
  userAgent: string;
  /** The CSP domains the helper applied, from the resource's `_meta.ui.csp`. */
  csp: Record<string, string[]>;
  /** The app asked for clipboardWrite: its copies reach the person's clipboard. */
  clipboard: boolean;
  /** The app asked for a visible border and background (`prefersBorder`). */
  border: boolean;
};

type DisplayMode = "inline" | "fullscreen" | "pip";

declare global {
  interface Window {
    __cliHost(kind: string, payload: unknown): Promise<unknown>;
    __openView(options: OpenOptions): Promise<void>;
    __teardown(): Promise<void>;
    /**
     * The call's arguments: partial while Claude writes them (the view
     * opened early), then whole once, after which no partial is sent.
     */
    __toolArgs(args: Record<string, unknown>, partial: boolean): void;
    /** The tool's result, once it ran (the view opened as it started). */
    __toolResult(result: unknown): void;
    /** The tool didn't run to a result: denied, failed or interrupted. */
    __toolCancelled(reason: string): void;
    /** The view was resized or moved (by the person or the mod): tell the app. */
    __setContainer(mode: DisplayMode, width: number, height: number, fit: boolean): void;
    /** Whether any of the view is on the person's screen (see __setShown). */
    __setShown(shown: boolean): void;
    /** The person changed Claude Code's theme: the app gets it (host-context-changed). */
    __setTheme(theme: "light" | "dark", styles: Record<string, string>, background: string): void;
  }
}

let bridge: AppBridge | undefined;
// What the tool came to, kept until the app has initialized.
let ready = false;
let later: { result?: unknown; cancelled?: string } = {};
// The call's arguments, kept until the app has initialized: all of them, or
// as far as Claude has written them.
let args: { whole?: Record<string, unknown>; partial?: Record<string, unknown> } = {};
let frame: HTMLIFrameElement | undefined;
// setHostContext replaces the whole context, so the current one is kept here.
let context: Record<string, unknown> = {};
// Fullscreen and pane views are a fixed size (the app fills it); inline ones
// are as tall as the app says it is.
let bordered = false;
let fixedHeight = 0;
let contentHeight = 120;
// Whether the app has said how tall it is. One that doesn't (it fills its
// window, as a game's canvas does) gets all its room once it has had
// UNSIZED_MS after initializing to say, as a browser host gives a frame a
// default size; otherwise it stayed at the 120 px start.
let sized = false;
const UNSIZED_MS = 400;
const MAX_PAGE_HEIGHT = 8000;

// An inline picture whose app is taller than its room (many apps fix their
// height and ignore containerDimensions) is drawn smaller, down to this
// scale (13 px text is then about 6 pt on screen in kitty, iTerm2 and
// Ghostty), so all of it shows; taller than that, it scrolls at full size.
// Cells don't shrink: their text is drawn as characters, one per cell.
const MIN_SCALE = 0.6;
let fit = false;
let scale = 1;
// Times the scale grew back for the current room (see place).
let regrowths = 0;
const MAX_REGROWTHS = 3;
let width = 0;
let room = 0;

/**
 * Lays the frame out at the current scale and returns the height it shows.
 * The scale only goes down while the room stays the same: a wider layout
 * can make a page shorter, and growing back would make it taller again.
 */
function place(): number {
  // Inline: the room the view may grow to. Fullscreen or a pane: the fixed
  // box, which an app that ignores containerDimensions may overflow too.
  const box = fixedHeight || room;
  if (fit && contentHeight * scale > box + 0.5) {
    const s = box / contentHeight;
    scale = s >= MIN_SCALE ? Math.min(scale, s) : 1;
  } else if (fit && scale < 1 && regrowths < MAX_REGROWTHS && contentHeight * scale < box * 0.97) {
    // The app got shorter (it was taller while loading): grow back, a few
    // times at most, as a narrower layout can make it taller again.
    regrowths++;
    scale = Math.min(1, box / contentHeight);
  }
  if (frame) {
    // Laid out wider by the same factor, so it fills the view's width.
    frame.style.width = `${width / scale}px`;
    frame.style.height = `${fixedHeight ? fixedHeight / scale : contentHeight}px`;
    frame.style.transformOrigin = "0 0";
    frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
  }
  return fixedHeight || Math.ceil(contentHeight * scale);
}

/** containerDimensions as the app measures them: in its own, scaled, CSS pixels. */
function dimensions() {
  return fixedHeight
    ? { width: width / scale, height: fixedHeight / scale }
    : { width: width / scale, maxHeight: room / scale };
}

window.__openView = async (options) => {
  const iframe = document.createElement("iframe");
  frame = iframe;
  fit = options.fit;
  width = options.width;
  room = options.maxHeight;
  args = options.toolInput ? { whole: options.toolInput } : { partial: options.partialInput };
  iframe.setAttribute("sandbox", options.sandbox);
  iframe.style.width = `${options.width}px`;
  iframe.style.height = "120px";
  bordered = options.border;
  frameLook(options.styles);
  document.body.appendChild(iframe);

  bridge = new AppBridge(
    null,
    { name: "mcp-apps-cli", version: "0.1.0" },
    {
      openLinks: {},
      downloadFile: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {} },
      // What the helper applied: the declared domains, no more.
      sandbox: { csp: options.csp as never, ...(options.clipboard ? { permissions: { clipboardWrite: {} } } : {}) },
    },
    {
      hostContext: (context = {
        ...(options.tool ? { toolInfo: { tool: options.tool } } : {}),
        theme: options.theme,
        platform: "desktop",
        locale: options.locale,
        timeZone: options.timeZone,
        userAgent: options.userAgent,
        // A mouse in a terminal: no touch; hover is reported as the pointer moves.
        deviceCapabilities: { touch: false, hover: true },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        displayMode: "inline",
        // fullscreen: the view fills the terminal; pip: a pane beside the chat.
        availableDisplayModes: ["inline", "fullscreen", "pip"],
        containerDimensions: {
          width: options.width,
          maxHeight: options.maxHeight,
        },
        styles: { variables: options.styles as never },
      }) as never,
    },
  );

  // The mod decides (a pane may not fit); the answer is the mode now in use.
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const current = context.displayMode as DisplayMode;
    const declared = bridge!.getAppCapabilities()?.availableDisplayModes;
    if (declared && !declared.includes(mode)) return { mode: current };
    const answer = (await window.__cliHost("ui/request-display-mode", { mode })) as { mode?: DisplayMode };
    return { mode: answer?.mode ?? current };
  };

  const call = (kind: string) => async (params: unknown) =>
    (await window.__cliHost(kind, params)) as never;

  // Requests the helper answers (through the mod for tools/call).
  bridge.oncalltool = call("tools/call");
  bridge.onreadresource = call("resources/read");
  bridge.onlistresources = call("resources/list");
  bridge.onlistresourcetemplates = call("resources/templates/list");
  // The person is asked; the answer says whether it happened ({ isError }).
  bridge.onmessage = call("ui/message");
  bridge.onopenlink = call("ui/open-link");
  bridge.ondownloadfile = call("ui/download-file");

  // Notifications the host only has to acknowledge.
  bridge.onupdatemodelcontext = async (params) => {
    await window.__cliHost("ui/update-model-context", params);
    return {};
  };
  bridge.onloggingmessage = (params) => {
    void window.__cliHost("log", params);
  };
  // An app that stays within maxHeight fits the view; one that doesn't is
  // given its full height and the helper scrolls a window over it.
  bridge.onsizechange = ({ height }) => {
    if (typeof height === "number" && height > 0) {
      sized = true;
      contentHeight = Math.min(Math.ceil(height), MAX_PAGE_HEIGHT);
      const before = scale;
      const shown = place();
      if (scale !== before) {
        context = { ...context, containerDimensions: dimensions() };
        updateContext();
      }
      // A fixed box keeps its height; the helper still needs a new scale.
      if (fixedHeight && scale === before) return;
      void window.__cliHost("size", { height: shown, scale });
    }
  };

  bridge.oninitialized = () => {
    ready = true;
    // Changes kept back until now (nothing goes to the app before this).
    updateContext();
    if (args.whole) bridge!.sendToolInput({ arguments: args.whole });
    else if (args.partial) bridge!.sendToolInputPartial({ arguments: args.partial });
    const result = options.toolResult ?? later.result;
    if (result) bridge!.sendToolResult(result as never);
    else if (later.cancelled !== undefined) bridge!.sendToolCancelled({ reason: later.cancelled });
    // The display modes the app says it handles: the mod offers only those.
    void window.__cliHost("initialized", { modes: bridge!.getAppCapabilities()?.availableDisplayModes });
    setTimeout(() => {
      if (sized || fixedHeight) return;
      contentHeight = Math.min(room, MAX_PAGE_HEIGHT);
      void window.__cliHost("size", { height: place(), scale });
    }, UNSIZED_MS);
  };

  // Copies from the app's own frame (see the helper's CLIPBOARD_HOOK).
  if (options.clipboard) {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: unknown; text?: unknown } | null;
      if (event.source === iframe.contentWindow && data?.type === "mcp-apps-cli/copy") {
        void window.__cliHost("copy", { text: String(data.text ?? "") });
      }
    });
  }

  // Connect before the view loads so its ui/initialize is not missed.
  const target = iframe.contentWindow!;
  await bridge.connect(new PostMessageTransport(target, target));
  iframe.src = options.src;
};

window.__toolArgs = (next, partial) => {
  // Once the app has all of them, no partial copy (nor a second whole one).
  if (args.whole) return;
  args = partial ? { partial: next } : { whole: next };
  if (!ready) return;
  if (partial) bridge?.sendToolInputPartial({ arguments: next });
  else bridge?.sendToolInput({ arguments: next });
};

window.__toolResult = (result) => {
  if (ready) bridge?.sendToolResult(result as never);
  else later = { result };
};

window.__toolCancelled = (reason) => {
  if (ready) bridge?.sendToolCancelled({ reason });
  else later = { cancelled: reason };
};

window.__setContainer = (mode, newWidth, height, newFit) => {
  fixedHeight = mode === "inline" ? 0 : height;
  width = newWidth;
  if (!fixedHeight) room = height;
  fit = newFit;
  // A new room: the scale is found afresh.
  scale = 1;
  regrowths = 0;
  const shown = place();
  context = { ...context, displayMode: mode, containerDimensions: dimensions() };
  updateContext();
  void window.__cliHost("size", { height: shown, scale });
};

/**
 * A view scrolled out of sight is moved out of the page's viewport, at its
 * size: Chrome then stops drawing the app's frame (no animation frames, no
 * painting), as it does for any cross-origin frame off screen, and starts
 * again when it comes back. Its timers keep running, as in a browser.
 */
window.__setShown = (shown) => {
  if (!frame) return;
  frame.style.position = "relative";
  frame.style.left = shown ? "0px" : "-20000px";
};

/**
 * The frame's own look: a border and the theme's background where the app
 * asked for them (prefersBorder), drawn inside its box so its size holds.
 */
function frameLook(styles: Record<string, string>) {
  if (!frame || !bordered) return;
  frame.style.boxSizing = "border-box";
  frame.style.border = `1px solid ${styles["--color-border-primary"] ?? "#4a4a4a"}`;
  frame.style.borderRadius = "8px";
  frame.style.background = styles["--color-background-secondary"] ?? "transparent";
}

window.__setTheme = (theme, styles, background) => {
  document.documentElement.style.background = background;
  document.body.style.background = background;
  document.documentElement.style.colorScheme = theme;
  frameLook(styles);
  context = { ...context, theme, styles: { variables: styles } };
  updateContext();
};

/**
 * Tells the app the current context, once it has initialized: the host
 * must not send it anything before. AppBridge sends only what changed.
 */
function updateContext() {
  if (ready) bridge?.setHostContext(context as never);
}

window.__teardown = async () => {
  // An app that never initialized has nothing to save, and no answer to give.
  if (!ready) return;
  try {
    await bridge?.teardownResource({});
  } catch {
    // The view may already be gone.
  }
};
