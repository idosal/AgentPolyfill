#!/usr/bin/env node
// mcp-apps-cli helper: a headless MCP Apps host for the Claude Code CLI.
//
// The mod starts this process and talks to it over a Unix socket (HTTP+JSON).
// The helper answers back on stdout, one JSON object per line:
//   {type:"ready", socket}                     once listening
//   {type:"frame", viewId, v, frame}           a new text frame for a view
//   {type:"request", id, viewId, method, params}  the mod must answer (tools/call)
//   {type:"notify", viewId, method, params}    ui/message, ui/open-link, ...
//   {type:"log", level, text}                  diagnostics
// Nothing else is ever written to stdout; logs go to stderr.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright-core";

import { decodePng } from "./png.mjs";
import { kindOf, parentCommandWords, placesHere, resolveServer } from "./servers.mjs";
import { tooBroad } from "./csp.mjs";
import { markDownloaded, privateFolder as checkedFolder } from "./platform.mjs";
import { altFromTree, plainText } from "./alt.mjs";
import { SNAP_ON, applySnap, planSnap } from "./snap.mjs";
import { crc32, encodeStrips } from "./strips.mjs";
import { genOf, pageHeld, sameOpen } from "./generations.mjs";
import { composeFrame } from "./render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
// A picture is fitted into its box of cells keeping its shape, so it must
// have the cells' shape, or the pointer drifts down the view. The terminal's
// cells are measured from its window size in pixels (ioctl TIOCGWINSZ on
// the session's terminal, through perl, which macOS and Linux ship).
let lastAspect = 0;
function cellAspect() {
  const forced = Number(process.env.MCP_APPS_CLI_CELL_ASPECT);
  if (forced > 0) return forced;
  try {
    const out = execFileSync(
      "perl",
      [
        "-e",
        'open(my $t,"<","/dev/tty") or exit 1; my $w=" "x8; ' +
          'ioctl($t, $^O eq "darwin" ? 0x40087468 : 0x5413, $w) or exit 1; print join(" ", unpack("S4", $w))',
      ],
      { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const [rows, cols, width, height] = out.trim().split(/\s+/).map(Number);
    if (rows > 0 && cols > 0 && width > 0 && height > 0) {
      // Not clamp(): that rounds to whole numbers.
      const aspect = Math.max(1.2, Math.min(3.5, height / rows / (width / cols)));
      if (aspect !== lastAspect) log(`cells are ${width / cols}x${height / rows} px`);
      lastAspect = aspect;
      return aspect;
    }
    log(`cell size: the terminal reported ${out.trim() || "nothing"}`);
  } catch (error) {
    // No terminal, or no perl: the usual shape.
    log(`cell size unknown (${error.status ?? ""} ${String(error.stderr ?? error.message).trim()})`);
  }
  return CELL_HEIGHT / CELL_WIDTH;
}

/**
 * CSS pixels per row, from the cells' shape so the view isn't stretched:
 * halves for pictures (whole device pixels at 2x), whole pixels for cell
 * frames, which are fitted at 1x.
 */
function rowHeight(mode) {
  if (mode !== "image") return Math.round(CELL_WIDTH * cellAspect());
  return Math.round(CELL_WIDTH * cellAspect() * 2) / 2;
}

const VIEW_ORIGIN = "http://mcp-app.localhost";
// The host page is served from another origin of the same site: the app's
// frame is then first party, so it has storage (Chrome refuses it to a
// frame under an opaque, setContent page), and still can't reach the page.
const HOST_ORIGIN = "http://host.mcp-app.localhost";
// `allow-same-origin` gives the app its own origin (VIEW_ORIGIN), so it has
// storage (see the view stores below). `allow-pointer-lock`: a game takes the
// pointer for aiming (DOOM fires on a click only once it has it); in this
// headless Chrome that captures nothing of the person's own mouse.
const SANDBOX = "allow-scripts allow-forms allow-same-origin allow-pointer-lock";

/**
 * The origins a view's app and its host page are served from. An app may
 * ask for a dedicated origin (`_meta.ui.domain`, for an API that allowlists
 * origins, or an OAuth callback); the format is the host's, and Claude's is
 * the first 32 hex characters of the SHA-256 of the server's URL, under
 * claudemcpcontent.com. Only that one is given (a server can't take
 * another's), over https, with the host page on a subdomain of it, so the
 * app's storage is still first party. Nothing at either origin reaches the
 * network: the helper serves both.
 */
function viewOrigins(server, domain) {
  const local = { view: VIEW_ORIGIN, host: HOST_ORIGIN };
  if (typeof domain !== "string" || !domain) return local;
  const url = serverUrl(server);
  const expected = url ? `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.claudemcpcontent.com` : undefined;
  if (domain.toLowerCase() !== expected) {
    log(`${server}: domain ${domain.slice(0, 100)} not given (${expected ? `this server's is ${expected}` : "a server without a URL has none"})`);
    return local;
  }
  return { view: `https://${expected}`, host: `https://host.${expected}`, domain: expected };
}
// The page tells the helper when it changes (CHANGE_HOOK: DOM mutations,
// canvas draw calls, fonts, running animations; through its binding,
// __cliChanged) and when its store is written. What the hook can't see (an
// animated GIF, a caret blinking) the backstop catches: a full capture every
// FULL_CAPTURE_MS, or BOOST_CAPTURE_MS for BOOST_MS after one found a change
// nothing announced. The poll also checks the page still answers: one that
// misses MAX_MISSES checks in a row (a busy loop, a promise that never
// settles) is closed, rather than hold a core and the view.
const POLL_MS = 500;
const BOOST_CAPTURE_MS = 500;
const BOOST_MS = 5000;
const LIVENESS_MS = 2000;
const LIVENESS_TIMEOUT_MS = 3000;
const MAX_MISSES = 3;
// While a view keeps changing (animation, live data), capture again soon
// after each new frame; a view that stops changing falls back to POLL_MS.
const ANIMATION_MS = 25;
// The pause after a changed picture before the next capture. Pictures sent
// as files cost the terminal almost nothing; inline ones take its bandwidth.
const IMAGE_ANIMATION_MS = 60;
const IMAGE_FILE_PACE_MS = 30;
// A still picture is not sent while the pointer moves over it: each one
// replaces the whole image, a flash in kitty, and a hover crossing a chart
// changed it every few pixels. It is sent once the pointer has rested this
// long, and a few times a second through a long sweep.
const HOVER_REST_MS = 90;
const HOVER_SWEEP_MS = 300;

// In the app's own frame: a count of what can change its picture (DOM
// changes, animation frames, scrolls, loads), with running CSS animations
// and playing media counted as always changing. The poll reads it and skips
// the screenshot when nothing moved.
// Counts the app's storage writes (localStorage, sessionStorage, IndexedDB),
// so its view's store is saved a moment after them (see poll), not only
// every STORE_SAVE_MS: a helper ended outright lost what came since.
const STORE_HOOK = `(() => {
  let writes = 0;
  // Each write is counted, and the helper hears of it (its binding), so it
  // saves the store about a second later, before a helper ended outright
  // loses it.
  let soon = 0;
  const count = (proto, names) => {
    for (const name of names) {
      const real = proto && proto[name];
      if (typeof real !== "function") continue;
      proto[name] = function () {
        writes++;
        if (!soon) soon = setTimeout(() => { soon = 0; try { window.__cliChanged?.("store"); } catch {} }, 50);
        return real.apply(this, arguments);
      };
    }
  };
  count(window.Storage && Storage.prototype, ["setItem", "removeItem", "clear"]);
  count(window.IDBObjectStore && IDBObjectStore.prototype, ["put", "add", "delete", "clear"]);
  Object.defineProperty(window, "__cliStoreWrites", { get: () => writes });
})()`;

const CHANGE_HOOK = `(() => {
  // The app's frame counts what changes; frames it embeds (another site's
  // too) only say that something did. The host page itself runs neither.
  if (window.parent === window) return;
  const app = window.parent === window.top;
  // The helper hears of a change at once, through its binding, at most once
  // a frame's worth of time (it paces captures itself). An untrusted hint:
  // it only brings a capture sooner.
  let soon = 0;
  const notify = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = 0;
      try { window.__cliChanged?.(""); } catch {}
    }, 16);
  };
  let n = 0;
  const bump = () => { n++; notify(); };
  // What moves the page's text (the DOM, layout, fonts, animations), apart
  // from canvas draws: while it stands still a cells frame keeps the text it
  // read last (the helper asks __cliDom; -1 while something animates).
  let dom = 0;
  const bumpDom = () => { dom++; bump(); };
  const moving = () =>
    (document.getAnimations?.() ?? []).some((a) => a.playState === "running") ||
    [...document.querySelectorAll("video, audio")].some((m) => !m.paused);
  if (app) window.__cliChanges = () => (moving() ? -1 : n);
  if (app) window.__cliDom = () => (moving() ? -1 : dom);
  const watch = () => new MutationObserver(bumpDom).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  watch();
  for (const type of ["scroll", "load", "resize", "input", "change"]) addEventListener(type, bumpDom, true);
  document.fonts?.addEventListener?.("loadingdone", bumpDom);
  // CSS animations and playing media change with no event of their own:
  // from when one starts, a notice every 100 ms while anything still runs.
  let ticking = 0;
  const tick = () => {
    if (ticking) return;
    ticking = setInterval(() => {
      if (moving()) notify();
      else { clearInterval(ticking); ticking = 0; }
    }, 100);
  };
  for (const type of ["animationstart", "transitionrun", "play", "playing"]) addEventListener(type, () => { bumpDom(); tick(); }, true);
  const animate = window.Element?.prototype.animate;
  if (animate) Element.prototype.animate = function (...args) { const running = animate.apply(this, args); tick(); return running; };
  // Drawing on a canvas moves neither the DOM nor, from a timer, animation
  // frames: each draw call counts too. (Asking for an animation frame
  // doesn't: an idle loop of them drew nothing, and looked like constant change.)
  const counted = (proto, names) => {
    if (!proto) return;
    for (const name of names) {
      const draw = proto[name];
      if (typeof draw !== "function") continue;
      proto[name] = function (...args) { bump(); return draw.apply(this, args); };
    }
  };
  const flat = ["fillRect", "strokeRect", "clearRect", "fill", "stroke", "fillText", "strokeText", "drawImage", "putImageData"];
  counted(window.CanvasRenderingContext2D?.prototype, flat);
  counted(window.OffscreenCanvasRenderingContext2D?.prototype, flat);
  const gl = ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "blitFramebuffer"];
  counted(window.WebGLRenderingContext?.prototype, gl);
  counted(window.WebGL2RenderingContext?.prototype, gl);
  counted(window.ImageBitmapRenderingContext?.prototype, ["transferFromImageBitmap"]);
  counted(window.GPUQueue?.prototype, ["submit"]);
})();`;

// For apps that ask for `clipboardWrite`: in the app's own frame (not the
// frames it embeds), navigator.clipboard.writeText goes to the host page,
// which hands it to the helper; headless Chrome's clipboard is nobody's.
const CLIPBOARD_HOOK = `(() => {
  if (window.parent === window || window.parent !== window.top) return;
  const write = async (text) => {
    window.parent.postMessage({ type: "mcp-apps-cli/copy", text: String(text) }, "*");
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write, write: async () => {} } });
  } catch {}
})();`;

// Pictures (image mode) are captured a few times a second, so a CSS
// transition only showed as a late, stepped change: a hover's took two or
// three pictures to land. They finish at once here instead (1 ms, so
// transitionend still fires); keyframe animations are left as they are.
const INSTANT_TRANSITIONS = `(() => {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("*, *::before, *::after { transition-duration: 1ms !important; transition-delay: 0s !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
})();`;
// WebRTC reaches any address its STUN and TURN servers name, past the CSP's
// connect-src: an app could send what it holds anywhere. Not offered (a view
// in a terminal makes no calls); in every frame, before the app's scripts.
const NO_WEBRTC = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
    try { delete window[name]; } catch {}
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})();`;
// Chrome's own sandbox for the renderers that run the apps (Playwright turns
// it off by default). Where the system can't give it (some Linux
// containers), MCP_APPS_CLI_NO_SANDBOX=1 runs without, knowingly.
const SANDBOXED = process.env.MCP_APPS_CLI_NO_SANDBOX !== "1";
const MAX_IMAGE_BYTES = 1_500_000;
// Claude Code draws no tree with more than 2 MiB of Image source (base64): a
// view's strips together stay under this, else it's taken again smaller,
// down to MIN_SCALE.
const MAX_STRIP_CHARS = 1_900_000;
const MIN_SCALE = 0.5;

/**
 * Whether the terminal claude runs in can show Claude Code's Image element:
 * iTerm2 3.5+, kitty or Ghostty, outside tmux. MCP_APPS_CLI_MODE=cells|image
 * overrides. Claude Code itself has the last word: a blit it refuses because
 * it drew the alt text sends the mod back to cells.
 */
function imageCapable() {
  const mode = process.env.MCP_APPS_CLI_MODE;
  if (mode === "image") return true;
  if (mode === "cells") return false;
  if (process.env.TMUX) return false;
  const program = process.env.TERM_PROGRAM ?? "";
  const version = (process.env.TERM_PROGRAM_VERSION ?? "0").split(".").map(Number);
  if (program === "iTerm.app") return version[0] > 3 || (version[0] === 3 && version[1] >= 5);
  if (program === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) return true;
  if (process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") return true;
  return false;
}

/**
 * Whether a picture needs a fresh copy swapped in each time Claude Code draws
 * it anew. iTerm2 does: it shows a picture only once new bytes arrive. kitty
 * and Ghostty show it at once, so one swap per view is enough there (it
 * finds out a terminal that drew the alt text instead).
 */
function swapEveryDraw() {
  if (process.env.TERM_PROGRAM === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) return false;
  if (process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") return false;
  return true;
}

/**
 * Whether cells may use the sextant shapes (U+1FB00, 2 x 3 blocks) for 3D
 * scenes, images and video. Only terminals that draw them themselves:
 * elsewhere they come from a font, if one has them, or show as boxes.
 * MCP_APPS_CLI_SEXTANTS=1|0 overrides.
 */
function sextantsDrawn() {
  const forced = process.env.MCP_APPS_CLI_SEXTANTS;
  if (forced === "1") return true;
  if (forced === "0") return false;
  const program = process.env.TERM_PROGRAM ?? "";
  if (program === "WezTerm" || program === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR) return true;
  return Boolean(process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty");
}
const SEXTANTS = sextantsDrawn();

/**
 * Whether cell views are drawn in full colour: as styled text, whose colours
 * Claude Code passes on whole, instead of a Raster (16 levels a channel, a
 * colour-pair budget). On by default in terminals that report 24-bit colour
 * (COLORTERM=truecolor|24bit), the best-looking choice there, at about four
 * times Claude Code's CPU; MCP_APPS_CLI_TRUECOLOR=0 turns it off.
 */
const TRUECOLOR =
  process.env.MCP_APPS_CLI_TRUECOLOR !== "0" && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const REQUEST_TIMEOUT_MS = 120_000;
// A person deciding whether an app may run a tool may take a while.
const CONSENT_TIMEOUT_MS = 600_000;

const args = parseArgs(process.argv.slice(2));
const socketPath =
  args.socket ?? path.join(os.tmpdir(), `mcp-apps-cli-${process.pid}.sock`);
// The mod reaches the helper over a Unix socket only the person can open.
// Windows has none Claude Code's fetch can use, so there (or with
// MCP_APPS_CLI_TRANSPORT=tcp) it's loopback TCP. Either way every request
// carries a token only the mod was given, on the helper's stdout: another
// program on the machine, even the person's own, could reach the socket or
// the port, but not drive the helper or answer for the person.
const TCP = process.platform === "win32" || process.env.MCP_APPS_CLI_TRANSPORT === "tcp";
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-mcp-apps-cli-token";

/** Whether a request carries the helper's token. */
function authorized(req) {
  const given = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ""));
  const wanted = Buffer.from(TOKEN);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
const cwd = args.cwd ?? process.cwd();

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// ---------------------------------------------------------------- png stamps

// Claude Code sends an Image's picture to the terminal when the source it is
// given changes. In iTerm2 the first drawing of an Image only clears its cells,
// and a picture shows once a swap brings new bytes. So every PNG carries a
// counter in a text chunk: the same pixels sent again are new bytes.
/** The PNG with a tEXt chunk holding `n` after its header chunk. */
function stampPng(png, n) {
  const body = Buffer.concat([Buffer.from("tEXt"), Buffer.from(`mcp-apps-cli\0${n}`, "latin1")]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  const afterHeader = 8 + 25; // signature, then IHDR: length, type, 13 bytes, CRC
  return Buffer.concat([png.subarray(0, afterHeader), chunk, png.subarray(afterHeader)]);
}
const log = (...parts) => process.stderr.write(`[mcp-apps-cli] ${parts.join(" ")}\n`);

// ---------------------------------------------------------------- browser

let browserPromise;
// The helper's own shutdown closes Chrome, which then removes its temporary
// profile; Playwright's signal handlers exited first and left the profile
// behind (tens of MB each time).
const OWN_SIGNALS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

// Chrome keeps only the last --disable-features it is given, and Playwright
// passes its own, so ours carries Playwright's list too (as of
// playwright-core 1.65) or that list would be dropped.
const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "HttpsUpgrades",
  "HttpsFirstBalancedModeAutoEnable", "LensOverlay", "MediaRouter", "PaintHolding",
  "ThirdPartyStoragePartitioning", "AvoidCorsURLLoaderRestartOnRedirect", "TcpPortRandomizationWin",
  "OptimizationHints", "NetworkTimeServiceQuerying", "AimEnabled", "PreconnectToSearch",
  "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion",
];
const DISABLED_FEATURES = [
  ...PLAYWRIGHT_DISABLED_FEATURES,
  "WebUIOmniboxPopup",
];

// Chrome's temporary profile (Playwright makes one per launch, 30-80 MB) goes
// in a folder of this helper's own. Claude Code ends its helper outright when
// it quits, before it can close Chrome, which left the profile behind once a
// session; the next helper removes folders of helpers no longer running, and
// their sockets, which the same outright end leaves behind.
const OWN_TMP = path.join(os.tmpdir(), `mcp-apps-cli-${process.pid}.tmp`);
function sweepOldTmp() {
  const root = path.dirname(OWN_TMP);
  for (const name of fs.readdirSync(root)) {
    const pid = Number(/^mcp-apps-cli-(\d+)\.(?:tmp|sock)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // still running
    } catch (error) {
      if (error.code === "EPERM") continue; // running, someone else's
    }
    // A Chrome still running on its profile (its helper was ended outright
    // with a view open) is stopped first: each held hundreds of MB, for hours.
    if (name.endsWith(".tmp")) stopChromesIn(path.join(root, name));
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

/** Stops Chrome processes running on a profile inside `folder` (a dead helper's own). */
function stopChromesIn(folder) {
  if (process.platform === "win32") return;
  let listing = "";
  try {
    listing = execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes(`--user-data-dir=${folder}`)) {
      try {
        process.kill(Number(m[1]), "SIGTERM");
      } catch {}
    }
  }
}

function browser() {
  browserPromise ??= (async () => {
    try {
      sweepOldTmp();
    } catch (error) {
      log("temporary folder:", error.message);
    }
    // Checked, not taken as found: its name can be guessed (A6). Chrome
    // doesn't start in one that fails.
    checkedFolder(OWN_TMP, fs);
    const executablePath = process.env.MCP_APPS_CLI_CHROME;
    let extra = [];
    try {
      // Chrome's process isolation is on: each site in a process of its
      // own. The app's frame is the same site as its host page (see
      // viewOrigins), so it stays in the page's process, and a frame it
      // embeds from another site gets one of its own. (It was off while the
      // host page was opaque, which put the app out of process, where input
      // into a scrolled page went astray; clicks in a scrolled view, and in a
      // frame from another site, land where aimed: bench/host-check.mjs.)
      // GPU rasterization draws anti-aliased edges (rounded corners) a little
      // differently from one screenshot to the next, so an idle page looked
      // changed and its picture was sent again, 200 KB at a time. CPU
      // rasterization is repeatable; WebGL canvases still use the GPU.
      // Chrome also preloads its address bar's popup (a WebUI page) for each
      // new page, in a renderer of its own: about 100 MB a view, never shown.
      extra = [
        `--disable-features=${DISABLED_FEATURES.join(",")}`,
        "--disable-gpu-rasterization",
        // WebRTC is taken from every frame (NO_WEBRTC); should that ever
        // miss one, it has no UDP of its own to reach past the CSP with either.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(process.env.MCP_APPS_CLI_CHROME_ARGS?.split(" ").filter(Boolean) ?? []),
      ];
      return await inOwnTmp(() =>
        chromium.launch(
          executablePath
            ? { executablePath, args: extra, chromiumSandbox: SANDBOXED, ...OWN_SIGNALS }
            : { channel: "chrome", headless: true, args: extra, chromiumSandbox: SANDBOXED, ...OWN_SIGNALS },
        ),
      );
    } catch (error) {
      log("installed Chrome did not start, trying Playwright's Chromium:", error.message);
      try {
        return await inOwnTmp(() => chromium.launch({ headless: true, args: extra, chromiumSandbox: SANDBOXED, ...OWN_SIGNALS }));
      } catch (fallback) {
        log("no Chromium either:", fallback.message);
        throw new Error(
          executablePath
            ? `the browser at MCP_APPS_CLI_CHROME (${executablePath}) did not start`
            : "app views need Google Chrome (or MCP_APPS_CLI_CHROME set to a Chromium-based browser), and none started" +
              (SANDBOXED ? " (where the system has no sandbox for Chrome, MCP_APPS_CLI_NO_SANDBOX=1)" : ""),
        );
      }
    }
  })().then(watchBrowser);
  // Not kept when it failed: a browser installed later is found by the next view.
  browserPromise.catch(() => {
    browserPromise = undefined;
  });
  return browserPromise;
}

/**
 * Chrome went away: it crashed, ran out of memory, was killed, or was closed
 * while idle. The next view starts it again. The views open in it are gone,
 * and the mod is told, so the person can open each again (reopen).
 */
// Chrome outlives a helper ended outright (Claude Code ends it so when it
// quits, before it can close Chrome): a watcher beside it, a process of its
// own with no stdio, waits for the helper to be gone, then stops every Chrome
// process on a profile in the helper's folder (Chrome's profile is made
// there, see inOwnTmp) and removes the folder. A shell loop on Unix, and
// PowerShell's Wait-Process on Windows, so it costs next to nothing; the
// helper ends it itself when Chrome closes. (The Rust helper has --reap,
// and on Windows a job object.)
let chromeWatcher;
function watchChrome() {
  chromeWatcher?.kill();
  const [command, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
              `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir=${OWN_TMP.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
              `Remove-Item -Recurse -Force -LiteralPath '${OWN_TMP.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
          ],
        ]
      : [
          "/bin/sh",
          [
            "-c",
            'while kill -0 "$1" 2>/dev/null; do sleep 1; done; pkill -TERM -f -- "--user-data-dir=$2"; sleep 2; pkill -KILL -f -- "--user-data-dir=$2"; rm -rf "$2"',
            "mcp-apps-cli-watcher",
            String(process.pid),
            OWN_TMP,
          ],
        ];
  try {
    chromeWatcher = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    chromeWatcher.on("error", (error) => log("no watcher for Chrome:", error.message));
    chromeWatcher.unref();
  } catch (error) {
    log("no watcher for Chrome:", error.message);
  }
}

function watchBrowser(b) {
  watchChrome();
  b.on("disconnected", () => {
    // Chrome closed (idle, or it stopped): nothing left to watch for.
    chromeWatcher?.kill();
    chromeWatcher = undefined;
    if (browserPromise && browserNow === b) browserPromise = undefined;
    for (const view of [...views.values()]) dropView(view, "Chrome stopped");
    log("Chrome disconnected");
  });
  browserNow = b;
  noteViews();
  return b;
}
let browserNow;

// Chrome (about 260 MB, and more per view) is closed when no view has been
// open for CHROME_IDLE_MS, and started again by the next one, which takes a
// quarter of a second, while Claude is still writing the call.
// MCP_APPS_CLI_CHROME_IDLE_S sets the wait in seconds; 0 keeps it running.
const CHROME_IDLE_MS = Number(process.env.MCP_APPS_CLI_CHROME_IDLE_S ?? 300) * 1000;
let idleTimer;
/** Views being opened right now: Chrome isn't idle while one is. */
let opening = 0;

function noteViews() {
  clearTimeout(idleTimer);
  if (views.size || opening || !browserPromise || !(CHROME_IDLE_MS > 0)) return;
  idleTimer = setTimeout(() => void closeIdleBrowser(), CHROME_IDLE_MS);
  idleTimer.unref?.();
}

async function closeIdleBrowser() {
  if (views.size || opening || !browserPromise) return;
  const b = await browserPromise.catch(() => undefined);
  if (views.size || opening) return;
  browserPromise = undefined;
  log("no views for a while: Chrome closed");
  await b?.close().catch(() => {});
}

const hostScript = fs.readFileSync(path.join(HERE, "host", "host.js"), "utf8");
/** A view's title at most this long. */
const MAX_TITLE_CHARS = 80;

function hostPage(background, scheme) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${background};overflow:hidden;color-scheme:${scheme}}
iframe{display:block;border:0;background:transparent}
</style></head><body><script>${hostScript}</script></body></html>`;
}

// ---------------------------------------------------------------- servers

/**
 * The entry Claude Code would use for `server` ({ config, scope }), or an
 * Error saying why the helper won't use one (see servers.mjs): nothing is
 * started, sent or expanded before this.
 */
function serverEntry(server) {
  return resolveServer(server, {
    places: placesHere(cwd),
    own: args.mcpConfig ?? [],
    parent: parentCommandWords(),
    log: (text) => log(text),
  });
}

/** A server's url, if the helper may use it and it has one. */
function serverUrl(server) {
  try {
    return serverEntry(server).config.url;
  } catch {
    return undefined;
  }
}

const sideClients = new Map(); // server name -> Promise<Client>
const serverScopes = new Map(); // server name -> the scope its config came from

/** A read-only connection of our own, for tools/list and resources/read. */
function sideClient(name) {
  if (!sideClients.has(name)) {
    const promise = (async () => {
      const { config, scope } = serverEntry(name);
      serverScopes.set(name, scope);
      const type = kindOf(config);
      const requestInit = { headers: config.headers ?? {} };
      // A redirect is followed only within the server's own origin (and only
      // one that keeps the request as it is): one to another host would carry
      // the server's headers there, outside the browser's protections
      // (security review, A3). The default of the SDK in package-lock.json
      // (1.32.2); said here so another version can't quietly change it.
      const redirectPolicy = "same-origin";
      const transport =
        type === "http"
          ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit, redirectPolicy })
          : type === "sse"
            ? new SSEClientTransport(new URL(config.url), { requestInit, redirectPolicy })
            : new StdioClientTransport({
                command: config.command,
                args: config.args ?? [],
                env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
                cwd: config.cwd ?? cwd,
                stderr: "ignore",
              });
      // Says it renders MCP Apps, so servers that check it offer their UIs.
      const client = new Client(
        { name: "mcp-apps-cli", version: "0.1.0" },
        { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
      );
      await client.connect(transport);
      return client;
    })();
    promise.catch(() => sideClients.delete(name));
    sideClients.set(name, promise);
  }
  return sideClients.get(name);
}

const discovered = new Map(); // server -> { tools }

async function discover(server, refresh = false) {
  if (!refresh && discovered.has(server)) return discovered.get(server);
  const client = await sideClient(server);
  const tools = {};
  const structured = [];
  const appOnly = [];
  // Every tool's `_meta.ui.visibility`, UI or not: an app may call only tools
  // that include "app" (absent means model and app).
  const visibility = {};
  // Each tool's definition, for the host context's toolInfo.
  const definitions = {};
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools) {
      const ui = tool._meta?.ui ?? {};
      const resourceUri = ui.resourceUri ?? tool._meta?.["ui/resourceUri"];
      if (resourceUri) tools[tool.name] = { resourceUri, visibility: ui.visibility };
      if (Array.isArray(ui.visibility)) visibility[tool.name] = ui.visibility;
      definitions[tool.name] = tool;
      if (tool.outputSchema) structured.push(tool.name);
      if (Array.isArray(ui.visibility) && !ui.visibility.includes("model")) appOnly.push(tool.name);
    }
    cursor = page.nextCursor;
  } while (cursor);
  // `scope`: where its config came from (command line, local, project or user).
  const result = { tools, structured, appOnly, visibility, definitions, scope: serverScopes.get(server) };
  discovered.set(server, result);
  return result;
}

function sanitizeDomains(domains) {
  return (domains ?? []).filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

/** Sources that name no domain: everything, or every host of a scheme. */

/** A CSP source's host (no "*." in front) and port, if it names one. */
function sourceHost(source) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^:/]+)(?::(\d+|\*))?/i.exec(source);
  return m ? { host: m[1].toLowerCase().replace(/^\*\./, ""), port: m[2] } : undefined;
}

/**
 * This machine or its local network: `localhost` and `.local` names, and
 * addresses that are loopback, private, link-local or unspecified (an
 * address, parsed: a name like `127.0.0.1.example` is a name).
 */
function privateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return true;
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (net.isIPv4(bare)) {
    const [a, b] = bare.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || bare === "0.0.0.0";
  }
  if (net.isIPv6(bare)) {
    if (bare === "::1" || bare === "::" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    return Boolean(mapped && privateHost(mapped[1]));
  }
  return false;
}

/**
 * A server on this machine or its local network (its URL's host), or a stdio
 * server (no URL; it runs here): its views may reach that network. Chrome's
 * local-network checks are on: a view of any other server may not reach this
 * machine or its network, even by a public name that resolves there (the CSP
 * judges names, not addresses).
 */
function localServer(server) {
  try {
    const { config } = serverEntry(server);
    return config.url === undefined ? kindOf(config) === "stdio" : privateHost(new URL(config.url).hostname.toLowerCase());
  } catch {
    // One the helper may not use: no access.
    return false;
  }
}

/**
 * The domains of a resource's `_meta.ui.csp` the view gets. A server may
 * name an address on the person's machine or network only where it runs
 * itself: its own host and port (Chrome's local-network checks back this up,
 * see localServer). Sources that name no domain (`*`, `https:`) aren't
 * applied either. What's left out is logged.
 */
function allowedCsp(csp, server) {
  let own;
  try {
    const url = serverUrl(server);
    if (url) {
      const u = new URL(url);
      own = `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    }
  } catch {}
  const out = {};
  const dropped = [];
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
    const kept = [];
    for (const source of sanitizeDomains(csp?.[key])) {
      const at = sourceHost(source);
      const port = at?.port ?? (/^(https|wss):/i.test(source) ? "443" : "80");
      if (tooBroad(source) || (at && privateHost(at.host) && `${at.host}:${port}` !== own)) dropped.push(source);
      else kept.push(source);
    }
    if (kept.length) out[key] = kept;
  }
  if (dropped.length) log(`${server}: declared CSP sources not applied: ${[...new Set(dropped)].join(" ")}`);
  return out;
}

/** The domains a resource's `_meta.ui.csp` declares, as applied (hostCapabilities.sandbox.csp). */
function cspDomains(csp) {
  const out = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
    const list = sanitizeDomains(csp?.[key]);
    if (list.length) out[key] = list;
  }
  return out;
}

/**
 * The CSP basic-host sends, as a response header for the view's document.
 * Without a declared `ui.csp` the spec asks for a stricter default (no eval,
 * no blob:, no connections); basic-host's allows eval and blob:, which apps
 * that run generated code (threejs-server) need, and opens no other domain.
 */
function buildCsp(csp) {
  const resources = sanitizeDomains(csp?.resourceDomains).join(" ");
  const connect = sanitizeDomains(csp?.connectDomains).join(" ");
  const frames = sanitizeDomains(csp?.frameDomains).join(" ");
  const baseUri = sanitizeDomains(csp?.baseUriDomains).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resources}`.trim(),
    `img-src 'self' data: blob: ${resources}`.trim(),
    `font-src 'self' data: blob: ${resources}`.trim(),
    `media-src 'self' data: blob: ${resources}`.trim(),
    `connect-src 'self' ${connect}`.trim(),
    `worker-src 'self' blob: ${resources}`.trim(),
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    "object-src 'none'",
    baseUri ? `base-uri ${baseUri}` : "base-uri 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------- views

const views = new Map();
let nextRequestId = 1;
const pending = new Map();

// The spec's standard style variables (host context styles.variables), for
// apps that theme themselves from the host: colours near a terminal's, the
// system's fonts. The primary background is transparent, so a view shows
// the terminal's own (the page behind is the theme's background).
const SHARED_STYLES = {
  "--font-sans": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--border-radius-xs": "2px",
  "--border-radius-sm": "4px",
  "--border-radius-md": "6px",
  "--border-radius-lg": "8px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
};
const colours = (c) => ({
  "--color-background-primary": "transparent",
  "--color-background-secondary": c.bg2,
  "--color-background-tertiary": c.bg3,
  "--color-background-inverse": c.text,
  "--color-background-ghost": "transparent",
  "--color-background-disabled": c.bg2,
  "--color-background-info": c.infoBg,
  "--color-background-danger": c.dangerBg,
  "--color-background-success": c.successBg,
  "--color-background-warning": c.warningBg,
  "--color-text-primary": c.text,
  "--color-text-secondary": c.text2,
  "--color-text-tertiary": c.text3,
  "--color-text-inverse": c.bg,
  "--color-text-ghost": c.text3,
  "--color-text-disabled": c.text3,
  "--color-text-info": c.info,
  "--color-text-danger": c.danger,
  "--color-text-success": c.success,
  "--color-text-warning": c.warning,
  "--color-border-primary": c.border,
  "--color-border-secondary": c.border2,
  "--color-border-tertiary": c.bg3,
  "--color-border-inverse": c.text,
  "--color-border-ghost": "transparent",
  "--color-border-disabled": c.border2,
  "--color-border-info": c.info,
  "--color-border-danger": c.danger,
  "--color-border-success": c.success,
  "--color-border-warning": c.warning,
  "--color-ring-primary": c.info,
  "--color-ring-secondary": c.text3,
  "--color-ring-inverse": c.bg,
  "--color-ring-info": c.info,
  "--color-ring-danger": c.danger,
  "--color-ring-success": c.success,
  "--color-ring-warning": c.warning,
  ...SHARED_STYLES,
});
const THEMES = {
  dark: {
    background: "#202020",
    styles: colours({
      bg: "#202020", bg2: "#2a2a2a", bg3: "#333333", text: "#e8e8e8", text2: "#b4b4b4", text3: "#8a8a8a",
      border: "#4a4a4a", border2: "#3a3a3a", info: "#6cb6ff", danger: "#ff7b72", success: "#56d364", warning: "#e3b341",
      infoBg: "#1d3557", dangerBg: "#4a1f1f", successBg: "#1f3d2a", warningBg: "#4a3a14",
    }),
  },
  light: {
    background: "#ffffff",
    styles: colours({
      bg: "#ffffff", bg2: "#f4f4f5", bg3: "#e9e9eb", text: "#1f1f1f", text2: "#4a4a4a", text3: "#737373",
      border: "#d0d0d0", border2: "#e0e0e0", info: "#0969da", danger: "#cf222e", success: "#1a7f37", warning: "#9a6700",
      infoBg: "#ddf4ff", dangerBg: "#ffebe9", successBg: "#dafbe1", warningBg: "#fff8c5",
    }),
  },
};

/**
 * light or dark, from Claude Code's theme. Its "auto" follows the terminal:
 * where the terminal says its colours (COLORFGBG, "foreground;background",
 * set by iTerm2, Konsole, rxvt and others), a ground of 7 or 15 is light;
 * otherwise dark.
 */
function themeName(theme) {
  if (theme === "light" || theme === "dark") return theme;
  const ground = Number(String(process.env.COLORFGBG ?? "").split(";").pop());
  return ground === 7 || ground === 15 ? "light" : "dark";
}

/** The person changed Claude Code's theme: an open view follows it (host-context-changed). */
async function setTheme(view, wanted) {
  const scheme = themeName(wanted);
  const theme = THEMES[scheme];
  if (process.env.MCP_APPS_CLI_DEBUG) log(`view ${view.id}: theme ${scheme}`);
  view.background = parseInt(theme.background.slice(1), 16);
  // The app's prefers-color-scheme, and the host page under it.
  await view.page.emulateMedia({ colorScheme: scheme });
  await view.page.evaluate(([s, styles, ground]) => window.__setTheme(s, styles, ground), [scheme, theme.styles, theme.background]);
  // A theme can recolour text with no DOM change (CSS media queries).
  view.textCache = undefined;
  setTimeout(() => void capture(view), 60);
  return { ok: true, theme: scheme };
}

// UI resources read this session, by server and URI (the spec lets a host
// prefetch and cache them). A view of an app opened before uses the copy it
// has and reads it again in the background, for the next view: the three.js
// example's is 10 MB, a second or more to read. MCP_APPS_CLI_RESOURCE_CACHE=0
// reads each time.
const uiResources = new Map();
const RESOURCE_CACHE = process.env.MCP_APPS_CLI_RESOURCE_CACHE !== "0";

async function readUiResource(server, uri) {
  const key = `${server}\n${uri}`;
  const fresh = (async () => (await sideClient(server)).readResource({ uri }))();
  const cached = RESOURCE_CACHE ? uiResources.get(key) : undefined;
  fresh.then((read) => RESOURCE_CACHE && uiResources.set(key, read), () => {});
  return cached ?? fresh;
}

/** A browser context and page for a view, with the scripts every view has. */
// ---------------------------------------------------------------- view stores

// Each view has a store of its own: the cookies, localStorage and IndexedDB
// its app keeps, in a browser context no other view shares. It's saved to a
// file of the view's own (by server and view: a tool call) while the view is
// open and when it closes, and given back when the same view opens again
// (reopened in the transcript, or after the helper restarted), as a browser
// keeps a page's storage across reloads. Two views, even of one app, never
// see each other's. Kept in the plugin's data folder, files only the person
// can read; ones untouched for STORE_DAYS are removed.
// MCP_APPS_CLI_STORAGE_DIR puts them elsewhere; =off keeps none.
const STORE_DAYS = 30;
/** How long an app has to answer its teardown before its view is closed anyway. */
const TEARDOWN_MS = 1_500;
const STORE_SAVE_MS = 20_000;
/** How soon after the app writes to storage its store is saved. */
const STORE_SOON_MS = 1_000;
const storeRoot = (() => {
  const wanted = process.env.MCP_APPS_CLI_STORAGE_DIR;
  if (wanted === "off") return undefined;
  // Outside the plugin (no data folder): under the person's home, never a
  // shared temporary folder another user could have made first.
  const root = wanted || (process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, "views") : path.join(os.homedir(), ".cache", "mcp-apps-cli", "views"));
  return privateFolder(root) ? root : undefined;
})();

/**
 * Whether `folder` is the person's alone, made so if it is new: a real
 * folder (not a link), theirs, that no one else can read or write. Stores
 * aren't kept anywhere else.
 */
function privateFolder(folder) {
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a folder");
    if (process.platform !== "win32") {
      if (stat.uid !== process.getuid()) throw new Error("owned by someone else");
      if (stat.mode & 0o077) fs.chmodSync(folder, 0o700);
    }
    return true;
  } catch (error) {
    log(`view stores off: ${folder}: ${error.message}`);
    return false;
  }
}

/** The file a view's store is kept in, or undefined when stores are off. */
function storeFile(server, viewId) {
  if (!storeRoot) return undefined;
  const name = createHash("sha256").update(`${server}\n${viewId}`).digest("hex").slice(0, 32);
  return path.join(storeRoot, `${name}.json`);
}

function pruneStores() {
  if (!storeRoot) return;
  try {
    const oldest = Date.now() - STORE_DAYS * 86_400_000;
    for (const name of fs.readdirSync(storeRoot)) {
      const file = path.join(storeRoot, name);
      if (name.endsWith(".json") && fs.statSync(file).mtimeMs < oldest) fs.rmSync(file, { force: true });
    }
  } catch {}
}

setTimeout(pruneStores, 5_000).unref();

/** Saves a view's store (nothing kept: no file). `last`: after any save under way. */
async function saveStore(view, last = false) {
  // A paused page changes nothing, and reading it would wait until it's back.
  if (!view.storeFile || (view.paused && !last)) return;
  if (last) await view.storeSaving;
  else if (view.storeSaving) return;
  let done;
  view.storeSaving = new Promise((resolve) => (done = resolve));
  try {
    const state = await view.context.storageState({ indexedDB: true });
    const empty = !state.cookies.length && state.origins.every((o) => !o.localStorage?.length && !o.indexedDB?.length);
    if (empty) {
      fs.rmSync(view.storeFile, { force: true });
      return;
    }
    // A new file of an unguessable name ("wx": never one that's there, or a
    // link), then moved over the store.
    const temp = `${view.storeFile}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, view.storeFile);
  } catch (error) {
    if (views.has(view.id)) log(`store ${view.id}:`, error.message);
  } finally {
    view.storeSaving = undefined;
    done();
  }
}

async function newViewPage(mode, cols, maxRows, cellH, theme, store, localNetwork) {
  let storageState;
  try {
    if (store && fs.existsSync(store)) storageState = JSON.parse(fs.readFileSync(store, "utf8"));
  } catch {
    storageState = undefined; // unreadable: a fresh store
  }
  const context = await (await browser()).newContext({
    ...(storageState ? { storageState } : {}),
    viewport: { width: cols * CELL_WIDTH, height: Math.ceil(maxRows * cellH) },
    // Images get twice the pixels per cell, so text and edges stay sharp.
    deviceScaleFactor: mode === "image" ? 2 : 1,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  // A local server's view reaches that server (see localServer).
  if (localNetwork) await context.grantPermissions(["local-network-access"]);
  // Runs in every frame before the app's own scripts: records the text
  // canvases draw, so chart labels become characters too.
  await context.addInitScript(CANVAS_TEXT_HOOK);
  await context.addInitScript(CHANGE_HOOK);
  await context.addInitScript(STORE_HOOK);
  await context.addInitScript(NO_WEBRTC);
  if (mode === "image") await context.addInitScript(INSTANT_TRANSITIONS);
  return { context, page: await context.newPage() };
}

async function openView(options) {
  const held = views.get(options.viewId);
  // The same open asked again gets its page; a page of another open is
  // closed, and this open makes its own.
  if (held && pageHeld(held.gen, genOf(options)) === "same") return { ok: true, existing: true };
  if (held) await closeView(options.viewId);
  opening++;
  clearTimeout(idleTimer);
  try {
    return await openViewNow(options);
  } finally {
    opening--;
    noteViews();
  }
}

async function openViewNow(options) {
  const { viewId, server, toolName } = options;

  const cols = clamp(options.cols ?? 100, 20, 240);
  const maxRows = clamp(options.maxRows ?? 30, 4, 80);
  const mode = options.mode === "image" ? "image" : "cells";
  const cellH = rowHeight(mode);
  // The page is made while the app's HTML is read: each takes a few hundred ms.
  const store = storeFile(server, viewId);
  const scheme = themeName(options.theme);
  const made = newViewPage(mode, cols, maxRows, cellH, scheme, store, localServer(server));
  const unmade = () => made.then(({ context }) => context.close(), () => {}).catch(() => {});
  let content, entry;
  try {
    const tools = (await discover(server)).tools;
    entry = tools[toolName];
    if (!entry) {
      unmade();
      return { ok: false, error: `${server}/${toolName} has no UI resource` };
    }
    content = (await readUiResource(server, entry.resourceUri)).contents?.[0];
  } catch (error) {
    unmade();
    throw error;
  }
  // The app's HTML, as text or base64 (`blob`), of the MCP Apps type.
  const html = typeof content?.text === "string"
    ? content.text
    : typeof content?.blob === "string" ? Buffer.from(content.blob, "base64").toString("utf8") : undefined;
  if (html === undefined) {
    unmade();
    return { ok: false, error: `resource ${entry.resourceUri} has no content` };
  }
  if (content.mimeType && !/^text\/html;\s*profile=mcp-app/i.test(content.mimeType)) {
    unmade();
    return { ok: false, error: `resource ${entry.resourceUri} is ${content.mimeType}, not text/html;profile=mcp-app` };
  }
  const meta = content._meta?.ui ?? {};
  // Logged for review; the mod tells the person about domains beyond the view.
  const declared = allowedCsp(meta.csp, server);
  const csp = cspDomains(declared);
  const external = [...new Set(Object.values(csp).flat())];
  log(`view ${viewId}: CSP ${buildCsp(declared)}`);

  const theme = THEMES[scheme];
  const { context, page } = await made;
  // Before the host page and the app load, so it runs in the app's frame.
  const clipboard = Boolean(meta.permissions?.clipboardWrite);
  if (clipboard) await context.addInitScript(CLIPBOARD_HOOK);
  const origins = viewOrigins(server, meta.domain);
  const view = {
    fileStem: createHash("sha1").update(viewId).digest("hex").slice(0, 12),
    origins,
    id: viewId,
    server,
    toolName,
    gen: genOf(options),
    mode,
    visibility: entry.visibility,
    context,
    page,
    frame: undefined,
    cols,
    maxRows,
    cellH,
    heightPx: 0,
    scrollY: 0,
    rows: 0,
    hash: "",
    version: 0,
    busy: false,
    again: false,
    inputs: Promise.resolve(),
    background: parseInt(theme.background.slice(1), 16),
    timer: undefined,
  };
  views.set(viewId, view);
  noteViews();
  // Its renderer crashed (out of memory, a GPU fault): the view is gone,
  // and the person can open it again.
  page.on("crash", () => {
    if (views.get(viewId) !== view) return;
    log(`view ${viewId}: its page crashed`);
    dropView(view, "the app's page crashed");
    void context.close().catch(() => {});
  });

  // The view's document stays its own: it may not navigate itself (a link,
  // a form, location) anywhere but its own origin, which would send what it
  // holds in the URL or the form past its CSP (connect-src doesn't cover a
  // navigation, and a document from elsewhere brings no CSP of ours). Frames
  // it embeds (frameDomains) load and move as their CSP lets them.
  await page.route(
    (url) => url.origin !== origins.view && url.origin !== origins.host,
    (route, request) => {
      let frame;
      try {
        frame = request.frame();
      } catch {}
      const ours = frame && (frame === page.mainFrame() || frame.parentFrame() === page.mainFrame());
      if (request.isNavigationRequest() && ours) {
        log(`view ${viewId}: navigation away refused (${request.url().slice(0, 120)})`);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    },
  );
  await page.route(`${origins.view}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "Content-Security-Policy": buildCsp(declared) },
      body: html,
    }),
  );
  // Playwright puts the binding in every frame of the page, the app's
  // sandboxed iframe and anything it embeds included: only the host page's
  // own frame may use it. The app reaches the host through AppBridge's
  // postMessage, which validates what it sends.
  await page.exposeBinding("__cliHost", (source, kind, payload) => {
    if (source.frame !== page.mainFrame()) throw new Error("not available to the view");
    return onHostCall(view, kind, payload);
  });
  // A hint from any frame of the page (CHANGE_HOOK, STORE_HOOK): it only
  // brings a capture, or a store save, sooner.
  await page.exposeBinding("__cliChanged", (source, payload) => changed(view, payload === "store"));
  page.on("console", (message) => {
    if (message.type() === "error") log(`[view ${viewId}]`, plainText(message.text()).slice(0, 500));
  });
  const host = hostPage(theme.background, scheme);
  await page.route(`${origins.host}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: host }),
  );
  await page.goto(`${origins.host}/`);
  await page.evaluate((o) => window.__openView(o), {
    src: `${origins.view}/view/${encodeURIComponent(viewId)}`,
    sandbox: SANDBOX,
    toolName,
    // While Claude is still writing the call (`streaming`), none yet: what
    // it has written so far, if anything, and the rest later (/args).
    toolInput: options.streaming ? undefined : options.toolInput ?? {},
    partialInput: options.streaming ? options.partialInput : undefined,
    toolResult: normalizeResult(options.toolResult),
    // The view's size now: a /resize may have come while the page loaded.
    width: view.cols * CELL_WIDTH,
    maxHeight: view.maxRows * view.cellH,
    fit: view.mode === "image",
    theme: scheme,
    styles: theme.styles,
    tool: (await discover(server)).definitions[toolName],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: options.userAgent ?? "Claude Code (mcp-apps-cli)",
    csp,
    clipboard,
    // A border and background drawn by the host (`prefersBorder`); the
    // spec leaves an omitted one to the host, and here that's none.
    border: meta.prefersBorder === true,
  });

  for (let i = 0; i < 100 && !view.frame; i++) {
    view.frame = page.frames().find((f) => f.url().startsWith(origins.view));
    if (!view.frame) await sleep(50);
  }
  if (!view.frame) return { ok: false, error: "the view's frame never loaded" };
  await view.frame.waitForLoadState("load").catch(() => {});

  // And once more now the frame exists: a /resize that came while the page
  // was loading sized the window but found no frame to widen, which left the
  // app at its opening width inside a wider window.
  await resize(view, view.cols, view.maxRows, view.display);
  // The helper's own session for looks at the app (appEval), set up while
  // the page answers.
  await appEval(view, "1").catch(() => {});
  view.timer = setInterval(() => void poll(view), POLL_MS);
  if (process.env.MCP_APPS_CLI_PAINTS !== "0") void watchPaints(view);
  describeSoon(view, ALT_SETTLE_MS);
  view.storeFile = store;
  if (store) view.storeTimer = setInterval(() => void saveStore(view), STORE_SAVE_MS);
  setTimeout(() => void capture(view), 150);
  return { ok: true, cols, maxRows, mode, domains: external };
}

/**
 * A tool's result as a view gets it: a CallToolResult made only of what came.
 *
 * Claude Code hands a plugin an MCP tool's result as the model reads it: a
 * result with `structuredContent` comes as one text block of that object's
 * JSON, its `content` and `_meta` left out. `$.mcp.call` answers with
 * `content`, `isError` and `structuredContent`, no `_meta`. A CallToolResult
 * (it has `content`) is passed on as it is; anything else becomes its text.
 * Up to 0.1.4 a text block that parsed to a JSON object was taken back as
 * `structuredContent`, a guess from what the model reads (issue #6); the Rust
 * helper (`helper-rs/src/policy.rs`) does the same as this. The setting that
 * takes it back for a server the person lists ("Structured results from
 * text") is the Rust helper's alone: this one is not run by the plugin.
 */
function normalizeResult(result) {
  if (!result) return undefined;
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (Array.isArray(result)) return { content: result };
  if (Array.isArray(result.content)) return { ...result };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function onHostCall(view, kind, payload) {
  if (process.env.MCP_APPS_CLI_DEBUG && kind !== "log") {
    log(`host call ${kind} ${JSON.stringify(payload ?? {}).slice(0, 100)}`);
  }
  switch (kind) {
    case "size":
      await inLayout(view, async () => {
        view.heightPx = payload?.height ?? view.heightPx;
        // A picture shrunk to fit its room: the app's pixels are this much smaller.
        view.scale = payload?.scale ?? 1;
        await fitViewport(view);
        await clampScroll(view);
      });
      setTimeout(() => void capture(view), 30);
      return {};
    case "initialized":
      setTimeout(() => void capture(view), 60);
      emit({ type: "notify", viewId: view.id, gen: view.gen, method: "ui/app-modes", params: { modes: payload?.modes ?? null } });
      return {};
    case "ui/request-display-mode": {
      // The mod answers with the mode now in use, and resizes the view to it.
      const answer = await requestFromMod(view, kind, payload).catch(() => null);
      return { mode: answer?.mode ?? view.display ?? "inline" };
    }
    case "tools/call": {
      const name = payload?.name;
      const discoveredTools = await discover(view.server);
      if (discoveredTools.visibility[name] && !discoveredTools.visibility[name].includes("app")) {
        throw new Error(`tool ${name} is not available to apps`);
      }
      // Before either way below: the person's permission rules decide, or
      // the person is asked (the mod answers; see allowTool there).
      const consent = await requestFromMod(
        view,
        "ui/allow-tool",
        // App-only tools aren't Claude's: Claude Code has no rules for them.
        { name, arguments: payload?.arguments ?? {}, appOnly: discoveredTools.appOnly.includes(name) },
        CONSENT_TIMEOUT_MS,
      ).catch((error) => ({ allow: false, reason: error.message }));
      if (!consent?.allow) throw new Error(consent?.reason ?? `the user declined ${name}`);
      if (!views.has(view.id)) throw new Error("the view closed");
      // Claude Code doesn't register app-only tools, so `$.mcp.call` can't
      // reach them: those go over the helper's own connection, which also
      // returns the server's result exactly as sent.
      if (discoveredTools.appOnly.includes(name)) {
        log(`app-only tool ${name} → helper connection`);
        return (await sideClient(view.server)).callTool(payload);
      }
      return normalizeResult(await requestFromMod(view, kind, payload));
    }
    case "resources/read":
      return (await sideClient(view.server)).readResource(payload);
    case "resources/list":
      return (await sideClient(view.server)).listResources(payload ?? {});
    // The app copied text: to the person's clipboard, if they just clicked or
    // typed in the view (a copy button), as a browser requires; once per click.
    case "copy": {
      const text = String(payload?.text ?? "");
      if (!text || text.length > 100_000 || Date.now() - (view.activatedAt ?? 0) > 2000) return {};
      view.activatedAt = 0;
      emit({ type: "notify", viewId: view.id, gen: view.gen, method: "ui/copy", params: { text } });
      return {};
    }
    case "resources/templates/list":
      return (await sideClient(view.server)).listResourceTemplates(payload ?? {});
    // The mod answers these, asking the person where it should: { isError }
    // when it didn't happen.
    case "ui/message":
      return requestFromMod(view, kind, payload);
    case "ui/open-link":
      return requestFromMod(view, kind, payload, CONSENT_TIMEOUT_MS);
    case "ui/download-file":
      return downloadFiles(view, payload?.contents ?? []);
    case "ui/update-model-context":
    case "log":
      emit({ type: "notify", viewId: view.id, gen: view.gen, method: kind, params: payload });
      return {};
    default:
      throw new Error(`unsupported host call ${kind}`);
  }
}

/**
 * ui/download-file: each item is embedded (text or base64 blob) or a link
 * the helper reads over its connection. The person is asked first; the files
 * go to their Downloads folder under names made safe, never overwriting.
 */
async function downloadFiles(view, contents) {
  // One at a time per view, a few files, and so many bytes in all: an app
  // can't fill the helper's memory with files waiting for the person.
  if (view.downloading || !Array.isArray(contents) || contents.length > MAX_DOWNLOAD_FILES) return { isError: true };
  view.downloading = true;
  try {
    return await downloadBounded(view, contents);
  } finally {
    view.downloading = false;
  }
}

const MAX_DOWNLOAD_FILES = 20;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

async function downloadBounded(view, contents) {
  const files = [];
  let total = 0;
  for (const item of contents) {
    let resource = item?.type === "resource" ? item.resource : undefined;
    if (item?.type === "resource_link") {
      resource = (await (await sideClient(view.server)).readResource({ uri: item.uri })).contents?.[0];
    }
    if (!resource) continue;
    // The size before decoding: base64 is 4 characters for 3 bytes.
    total += typeof resource.blob === "string" ? Math.floor((resource.blob.length * 3) / 4) : Buffer.byteLength(String(resource.text ?? ""));
    if (total > MAX_DOWNLOAD_BYTES) return { isError: true };
    const bytes = typeof resource.blob === "string"
      ? Buffer.from(resource.blob, "base64")
      : Buffer.from(String(resource.text ?? ""), "utf8");
    const base = String(item.name ?? resource.uri ?? "download").split(/[\\/]/).pop() || "download";
    files.push({ name: base.replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download", bytes });
  }
  if (!files.length) return { isError: true };
  const answer = await requestFromMod(
    view,
    "ui/allow-download",
    { files: files.map((f) => ({ name: f.name, size: f.bytes.length })) },
    CONSENT_TIMEOUT_MS,
  ).catch(() => null);
  if (!answer?.allow || !views.has(view.id)) return { isError: true };
  const folder = path.join(os.homedir(), "Downloads");
  fs.mkdirSync(folder, { recursive: true });
  const saved = [];
  for (const file of files) {
    const ext = path.extname(file.name);
    let target = path.join(folder, file.name);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(folder, `${path.basename(file.name, ext)} (${n})${ext}`);
    fs.writeFileSync(target, file.bytes, { flag: "wx" });
    try {
      markDownloaded(target, { fs, execFileSync });
    } catch (error) {
      log(`${target}: not marked as downloaded: ${error.message}`);
    }
    saved.push(target);
  }
  emit({ type: "notify", viewId: view.id, gen: view.gen, method: "ui/downloaded", params: { files: saved } });
  return {};
}

function requestFromMod(view, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = nextRequestId++;
  emit({ type: "request", id, viewId: view.id, gen: view.gen, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, viewId: view.id, gen: view.gen });
  });
}

function reply(body) {
  const { id, result, error } = body;
  const waiting = pending.get(id);
  if (!waiting) return { ok: false, error: "unknown request" };
  pending.delete(id);
  clearTimeout(waiting.timer);
  // An answer meant for another open of the view than the page that asked.
  if (!sameOpen(waiting.gen, body)) waiting.reject(new Error("the answer was for another open of this view"));
  else if (error) waiting.reject(new Error(String(error)));
  else waiting.resolve(result);
  return { ok: true };
}

// The page reports each laid-out line of text, so the frame can draw real
// characters instead of guessing them from pixels. Runs inside the view.
/**
 * The text a canvas drew (see the canvas text hook) as EXTRACT_TEXT adds it,
 * with the app's DOM counter (see the change hook): what a cells frame reads
 * when only a canvas changed.
 */
/** Text read anew for this long after input (see view.textCache). */
const TEXT_AFTER_INPUT_MS = 300;

const CANVAS_TEXT = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  if (typeof window.__cliCanvasTexts === "function") {
    for (const t of window.__cliCanvasTexts()) {
      if (t.bottom < 0 || t.top > vh || t.right < 0 || t.x > vw) continue;
      out.push({ ...t, source: "canvas" });
    }
  }
  return [window.__cliDom ? window.__cliDom() : -1, out];
})()`;

const EXTRACT_TEXT = () => {
  const lines = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_TEXT);
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION", "TITLE"]);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || skip.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const bold = Number(cs.fontWeight) >= 600;
    // SVG text is painted with fill, not color.
    const color =
      el instanceof SVGElement && cs.fill && cs.fill !== "none" && !cs.fill.startsWith("url(")
        ? cs.fill
        : cs.color;
    const text = node.data;
    // As drawn: CSS text-transform changes case, not layout (one character
    // stays one character for these).
    const transform = cs.textTransform;
    const shown = (i) =>
      transform === "uppercase"
        ? text[i].toUpperCase()
        : transform === "lowercase"
          ? text[i].toLowerCase()
          : transform === "capitalize" && (i === 0 || /\s/.test(text[i - 1]))
            ? text[i].toUpperCase()
            : text[i];
    let line = null;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      const shownChar = shown(i);
      const ch = /\s/.test(text[i]) ? " " : shownChar.length === 1 ? shownChar : text[i];
      const cy = rect.top + rect.height / 2;
      if (line && Math.abs(cy - line.cy) < rect.height / 2 && rect.left >= line.right - 1) {
        line.t += ch;
        line.right = rect.right;
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        if (line) lines.push(line);
        line = {
          x: rect.left,
          cy,
          t: ch,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          color,
          bold,
        };
      }
    }
    if (line) lines.push(line);
  }
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const padLeft = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const padTop = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
    const focused = document.activeElement === el;
    if (type === "checkbox" || type === "radio") {
      const mark = type === "checkbox" ? (el.checked ? "[x]" : "[ ]") : el.checked ? "(•)" : "( )";
      lines.push({ x: rect.left, cy: rect.top + rect.height / 2, t: mark, color: cs.color });
      continue;
    }
    if (["hidden", "range", "color", "file", "button", "submit", "reset", "image"].includes(type)) continue;
    let value = el.tagName === "SELECT" ? (el.selectedOptions[0]?.text ?? "") : el.value;
    let dim = false;
    if (!value && el.placeholder) {
      value = el.placeholder;
      dim = true;
    }
    if (type === "password") value = "•".repeat(value.length);
    const caret = focused && !dim && typeof el.selectionStart === "number" ? el.selectionStart : null;
    const rowsOfText = el.tagName === "TEXTAREA" ? value.split("\n") : [value];
    let offset = 0;
    const isSelect = el.tagName === "SELECT";
    // A dropdown's arrow is drawn by the browser or a background image, a few
    // pixels that would come out as a dash: draw it as a character instead.
    // The arrow goes in the last cell inside the border, and the label may run
    // up to it: a terminal font is wider than the page's, so every cell counts.
    const arrowWidth = 10;
    const arrowed =
      isSelect && !el.multiple && el.size <= 1 && (cs.appearance !== "none" || cs.backgroundImage !== "none");
    rowsOfText.forEach((t, i) => {
      const lineCaret =
        caret != null && caret >= offset && caret <= offset + t.length ? caret - offset : null;
      lines.push({
        x: rect.left + padLeft,
        cy: isSelect ? rect.top + rect.height / 2 : rect.top + padTop + lineHeight * (i + 0.5),
        t,
        color: cs.color,
        dim,
        maxX: arrowed ? rect.right - (parseFloat(cs.borderRightWidth) || 0) - arrowWidth : rect.right - padLeft,
        caret: isSelect ? null : focused && dim && i === 0 ? 0 : lineCaret,
        inverse: isSelect && focused,
      });
      offset += t.length + 1;
    });
    if (arrowed) {
      const right = rect.right - (parseFloat(cs.borderRightWidth) || 0);
      lines.push({
        x: right - arrowWidth,
        cy: rect.top + rect.height / 2,
        t: "▾",
        color: cs.color,
        top: rect.top + rect.height * 0.2,
        bottom: rect.bottom - rect.height * 0.2,
        right: right - 1,
        inverse: focused,
      });
    }
  }
  if (typeof window.__cliCanvasTexts === "function") {
    for (const t of window.__cliCanvasTexts()) {
      if (t.bottom < 0 || t.top > vh || t.right < 0 || t.x > vw) continue;
      lines.push({ ...t, source: "canvas" });
    }
  }
  return lines;
};

/**
 * Wraps CanvasRenderingContext2D.fillText/strokeText to remember what each
 * canvas drew and where (its box in canvas pixels, through the current
 * transform). A full clearRect forgets it, as charts clear before redrawing.
 * `__cliCanvasTexts()` maps the boxes to page coordinates. Rotated text is
 * skipped: it can't be laid out as a row of characters.
 */
const CANVAS_TEXT_HOOK = `(() => {
  if (window.__cliCanvasTexts) return;
  const P = CanvasRenderingContext2D.prototype;
  const drawn = new Map();
  const list = (canvas) => {
    let a = drawn.get(canvas);
    if (!a) drawn.set(canvas, (a = []));
    return a;
  };
  const clearRect = P.clearRect;
  P.clearRect = function (x, y, w, h) {
    try {
      const m = this.getTransform();
      if (Math.abs(w * m.a) >= this.canvas.width * 0.9 && Math.abs(h * m.d) >= this.canvas.height * 0.9) {
        drawn.set(this.canvas, []);
      }
    } catch {}
    return clearRect.apply(this, arguments);
  };
  for (const name of ["fillText", "strokeText"]) {
    const original = P[name];
    P[name] = function (text, x, y) {
      try {
        const m = this.getTransform();
        if (Math.abs(m.b) < 1e-3 && Math.abs(m.c) < 1e-3 && String(text).trim()) {
          const metrics = this.measureText(text);
          const width = metrics.width;
          const align = this.textAlign;
          const rtl = this.direction === "rtl";
          let left = x;
          if (align === "center") left = x - width / 2;
          else if (align === "right" || (align === "end" && !rtl) || (align === "start" && rtl)) left = x - width;
          const ascent = metrics.actualBoundingBoxAscent || 0;
          const descent = metrics.actualBoundingBoxDescent || 0;
          const x0 = m.a * left + m.e;
          const x1 = m.a * (left + width) + m.e;
          const y0 = m.d * (y - ascent) + m.f;
          const y1 = m.d * (y + descent) + m.f;
          const style = name === "fillText" ? this.fillStyle : this.strokeStyle;
          list(this.canvas).push({
            text: String(text),
            x0: Math.min(x0, x1), x1: Math.max(x0, x1),
            y0: Math.min(y0, y1), y1: Math.max(y0, y1),
            color: typeof style === "string" ? style : null,
            alpha: this.globalAlpha,
            bold: /bold|[6-9]00/.test(this.font),
          });
        }
      } catch {}
      return original.apply(this, arguments);
    };
  }
  window.__cliCanvasTexts = () => {
    const out = [];
    for (const [canvas, texts] of drawn) {
      if (!canvas.isConnected || !texts.length) continue;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height || !canvas.width || !canvas.height) continue;
      const sx = r.width / canvas.width;
      const sy = r.height / canvas.height;
      for (const t of texts) {
        if (t.alpha < 0.2) continue;
        out.push({
          x: r.left + t.x0 * sx,
          right: r.left + t.x1 * sx,
          top: r.top + t.y0 * sy,
          bottom: r.top + t.y1 * sy,
          cy: r.top + ((t.y0 + t.y1) / 2) * sy,
          t: t.text,
          color: t.color || "rgb(220, 220, 220)",
          bold: t.bold,
        });
      }
    }
    return out;
  };
  // Canvases drawn by WebGL/WebGPU, plus images and videos: photo regions,
  // which the cell renderer fits for shading rather than for flat UI. 2D
  // canvases are reported too, flagged: the renderer fits one as a photo only
  // when it's densely filled (an area chart), not a sparse line chart.
  const photoCanvases = new Set();
  const flatCanvases = new Set();
  const getContext = HTMLCanvasElement.prototype.getContext;
  // A 3D scene that sizes its drawing by devicePixelRatio (three.js's
  // setPixelRatio) rendered four times the pixels on picture mode's 2x page and
  // stuttered: a bloom-lit torus knot ran at about 2 pictures a second. Once
  // the page has a WebGL/WebGPU canvas, devicePixelRatio reads 1, the scale
  // its frames are captured at while they move; DOM text, 2D canvases and
  // images keep the page's real scale (1 in cells mode anyway).
  let webgl = false;
  const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio") ??
    Object.getOwnPropertyDescriptor(Window.prototype, "devicePixelRatio");
  const realRatio = () => (ratio && ratio.get ? ratio.get.call(window) : 1);
  try {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => (webgl ? 1 : realRatio()) });
  } catch {}
  HTMLCanvasElement.prototype.getContext = function (type) {
    const context = getContext.apply(this, arguments);
    if (context && /webgl|webgpu/i.test(String(type))) webgl = true;
    if (context && /webgl|webgpu|bitmaprenderer/i.test(String(type))) photoCanvases.add(this);
    else if (context && /^2d$/i.test(String(type))) flatCanvases.add(this);
    return context;
  };
  window.__cliPhotoRects = () => {
    const out = [];
    const box = (el, extra) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) out.push({ x: r.left, y: r.top, w: r.width, h: r.height, ...extra });
    };
    for (const el of [...photoCanvases, ...document.querySelectorAll("img, video")]) box(el);
    for (const el of flatCanvases) if (!photoCanvases.has(el)) box(el, { canvas2d: true });
    return out;
  };
})();`;

/** The latest picture again, as new bytes (see `stampPng`). */
function sendImage(view, all = false) {
  const image = view.lastImage;
  if (!image) return false;
  view.stamps = (view.stamps ?? 0) + 1;
  const { png, ...placed } = image;
  if (IMAGE_FILES && view.files !== false) {
    // The terminal reads the picture from a file: a short command instead of
    // the whole PNG through the terminal, which took a third of a second.
    // Three files in turn, so one is never rewritten while it is being read.
    const file = path.join(imageDir(), `${view.fileStem}-${view.stamps % 3}-tty-graphics-protocol.png`);
    // Written whole under another name, then renamed over the file: a
    // terminal reading it then gets the old picture or the new one, never
    // half of the new one.
    const temporary = path.join(imageDir(), `.${view.fileStem}-${randomBytes(6).toString("hex")}.part`);
    try {
      fs.writeFileSync(temporary, png, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    emit({ type: "frame", viewId: view.id, gen: view.gen, v: view.version, image: { ...placed, file, generation: view.stamps } });
    return true;
  }
  if (inlineStrips(view)) {
    queueStrips(view, all);
    return true;
  }
  emit({
    type: "frame",
    viewId: view.id,
    gen: view.gen,
    v: view.version,
    image: { ...placed, png: stampPng(png, view.stamps).toString("base64") },
  });
  return true;
}


/** Stops (or starts again) drawing a view nobody can see; on return, a fresh look. */
async function setShown(view, shown) {
  if (view.offscreen === !shown) return;
  view.offscreen = !shown;
  await settleShown(view);
  log(`view ${view.id} ${shown ? "back in sight" : "out of sight: paused"}`);
  if (shown) void poll(view);
}

/**
 * Out of sight, the page's scripts are paused too, with the debugger's
 * pause. With its frame moved off screen an app stops painting, but its
 * timers ran on: a game or an emulator scrolled away took a core from the
 * views still in sight. Headless Chrome has no background tab to freeze
 * (Page.setWebLifecycleState and window states change nothing there).
 * A paused page answers nothing, the helper included, so every request for
 * the view wakes it first (whileAwake). An idle page pauses at its next
 * script; Debugger.disable resumes it and drops a pause still waiting.
 *
 * Changes go one at a time, and each brings the page to the view's state
 * as it is then: a quick scroll away and back (or a request meanwhile)
 * can't leave a pause landing after the resume.
 */
function settleShown(view) {
  view.shownTurn = (view.shownTurn ?? Promise.resolve()).then(async () => {
    const hidden = Boolean(view.offscreen) && !view.awake && views.has(view.id);
    if (!hidden) await setPaused(view, false);
    if (Boolean(view.framedOff) !== Boolean(view.offscreen) && views.has(view.id)) {
      view.framedOff = Boolean(view.offscreen);
      await view.page.evaluate((s) => window.__setShown?.(s), !view.offscreen).catch(() => {});
    }
    if (hidden) await setPaused(view, true);
  });
  return view.shownTurn;
}

/** Pauses (or resumes) every renderer the view's page runs in. */
async function setPaused(view, paused) {
  if (Boolean(view.paused) === paused) return;
  try {
    if (paused) {
      view.paused = true;
      // The page's renderer, and each frame's in a process of its own (site
      // isolation; Playwright opens a session only for those).
      view.pauseSessions = [await view.context.newCDPSession(view.page)];
      for (const frame of view.page.frames().slice(1)) {
        const session = await view.context.newCDPSession(frame).catch(() => null);
        if (session) view.pauseSessions.push(session);
      }
      for (const session of view.pauseSessions) {
        await session.send("Debugger.enable");
        await session.send("Debugger.pause");
      }
      // Its workers too: a worker runs on while its page is paused (a
      // spinning one kept a core busy out of sight).
      await workersDebugger(view, ["Debugger.enable", "Debugger.pause"]);
    } else {
      await workersDebugger(view, ["Debugger.disable"]).catch(() => {});
      await unpause(view);
      view.paused = false;
    }
  } catch (error) {
    await unpause(view);
    view.paused = false;
    if (views.has(view.id)) log(`view ${view.id}: could not ${paused ? "pause" : "resume"} its page:`, error.message);
  }
}

/**
 * Sends debugger commands to the view's dedicated workers. Playwright gives
 * no CDP session for a worker, so the helper's own page session attaches to
 * them (Target.setAutoAttach, not flattened) and speaks to each through
 * Target.sendMessageToTarget.
 */
async function workersDebugger(view, methods) {
  view.cdp ??= await view.page.context().newCDPSession(view.page);
  if (!view.workers) {
    view.workers = new Set();
    view.cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
      if (targetInfo.type !== "worker") return;
      view.workers.add(sessionId);
      // A worker started while the page is paused is paused too.
      if (view.paused) for (const method of ["Debugger.enable", "Debugger.pause"]) void sendToTarget(view, sessionId, method);
    });
    view.cdp.on("Target.detachedFromTarget", ({ sessionId }) => view.workers.delete(sessionId));
    await view.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  }
  for (const sessionId of view.workers) for (const method of methods) await sendToTarget(view, sessionId, method);
}

let targetMessages = 0;
function sendToTarget(view, sessionId, method) {
  return view.cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: ++targetMessages, method, params: {} }) }).catch(() => {});
}

/** Resumes the view's renderers (Debugger.disable) and lets their sessions go. */
async function unpause(view) {
  const sessions = view.pauseSessions ?? [];
  view.pauseSessions = [];
  for (const session of sessions) {
    await session.send("Debugger.disable").catch(() => {});
    await session.detach().catch(() => {});
  }
}

/** Runs `fn` with the view's page awake; paused again after if it's still out of sight. */
async function whileAwake(view, fn) {
  if (!view || (!view.offscreen && !view.paused && !view.awake)) return fn();
  view.awake = (view.awake ?? 0) + 1;
  try {
    await settleShown(view);
    return await fn();
  } finally {
    view.awake -= 1;
    if (!view.awake) await settleShown(view);
  }
}

// ---------------------------------------------------------------- strips

let worker;
let workerFailed = false;
let jobs = 0;
const stripJobs = new Map();

/** The strips worker, started on first use; undefined once it has failed. */
function stripsWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./strips-worker.mjs", import.meta.url));
    worker.unref();
    worker.on("message", ({ id, result, error }) => {
      const job = stripJobs.get(id);
      stripJobs.delete(id);
      if (error) job?.reject(new Error(error));
      else job?.resolve(result);
    });
    const fail = (error) => {
      log("strips worker stopped; encoding on the main thread:", String(error?.message ?? error));
      workerFailed = true;
      worker = undefined;
      for (const job of stripJobs.values()) job.reject(new Error("strips worker stopped"));
      stripJobs.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => code !== 0 && fail(`exit ${code}`));
  } catch (error) {
    workerFailed = true;
    log("no strips worker:", error.message);
  }
  return worker;
}

/** One view's strips job, in the worker if there is one, else here. */
function encodeOff(view, job) {
  const w = stripsWorker();
  if (!w) return encodeStrips((view.stripState ??= {}), job);
  return new Promise((resolve, reject) => {
    const id = ++jobs;
    stripJobs.set(id, { resolve, reject });
    w.postMessage({ id, viewId: view.id, job });
  }).catch((error) => {
    // Its state is gone with it: everything again, here.
    view.stripState = {};
    return encodeStrips(view.stripState, { ...job, all: true });
  });
}

/**
 * Sends the view's latest picture as strips. One job per view at a time, in
 * order; a picture that comes while one is being encoded waits, and only the
 * latest waiting one is encoded (its bands are compared with the last ones
 * sent, so nothing is missed). A fresh copy asked for on the way is kept.
 */
function queueStrips(view, all) {
  view.stripAll = Boolean(view.stripAll || all);
  if (view.stripBusy) {
    view.stripAgain = true;
    return;
  }
  view.stripBusy = true;
  void (async () => {
    try {
      do {
        view.stripAgain = false;
        const image = view.lastImage;
        if (!image || !views.has(view.id)) break;
        const job = {
          png: image.png,
          rows: image.rows,
          top: image.scroll?.top ?? 0,
          all: view.stripAll,
          stamp: view.stamps,
          version: view.version,
        };
        view.stripAll = false;
        const scale = view.lastScale ?? 1;
        const { png, ...placed } = image;
        const result = await encodeOff(view, job);
        if (!views.has(view.id) || view.mode !== "image" || !inlineStrips(view)) break;
        // The bands the mod would hold, the unchanged ones with the new.
        const chars = (view.stripChars ?? []).slice(0, result.stripCount);
        for (const strip of result.strips) chars[strip.i] = strip.png.length;
        const total = chars.reduce((sum, n) => sum + (n ?? 0), 0);
        if (total > MAX_STRIP_CHARS && scale <= MIN_SCALE) {
          // Too big even at the smallest scale: not sent (Claude Code would
          // refuse it, and the rows drawn with it); the last one stays.
          view.stripState = {};
          worker?.postMessage({ drop: view.id });
          log(`strips ${view.id}: ${total} characters even at ${scale}x, not sent`);
          continue;
        }
        if (total > MAX_STRIP_CHARS) {
          // More than Claude Code draws: not sent, and taken again smaller now
          // (a new width, so every band of it).
          view.maxScale = Math.max(MIN_SCALE, scale / 2);
          view.cappedAt = Date.now();
          log(`strips ${view.id}: ${total} characters at ${scale}x, taken again at ${view.maxScale}x`);
          setTimeout(() => void capture(view), 0);
          continue;
        }
        view.stripChars = chars;
        // Taken smaller since: back to 2x once a 2x picture would fit, as this
        // one's size says (4x the pixels at 2x from 1x, and no more than 4x the
        // characters), not sooner than 10 s on.
        if ((view.maxScale ?? 2) < 2 && scale >= view.maxScale) {
          const grown = total * (2 / scale) ** 2;
          if (grown < MAX_STRIP_CHARS * 0.8 && Date.now() - (view.cappedAt ?? 0) > 10_000) {
            view.maxScale = 2;
            setTimeout(() => void capture(view), 300);
          }
        }
        emit({ type: "frame", viewId: view.id, gen: view.gen, v: job.version, image: { ...placed, ...result } });
      } while (view.stripAgain);
    } catch (error) {
      log(`strips ${view.id}:`, error.message);
    } finally {
      view.stripBusy = false;
    }
  })();
}

/**
 * Whether pictures go to the terminal as files it reads itself (kitty and
 * Ghostty on this machine). Not over SSH, where the terminal is elsewhere;
 * a terminal that can't read one sends the view back to inline PNGs.
 * MCP_APPS_CLI_IMAGE_FILES=0 turns it off.
 */
// Inline pictures go in bands (see strips.mjs). MCP_APPS_CLI_STRIPS=0
// sends them whole.
const STRIPS_ON = process.env.MCP_APPS_CLI_STRIPS !== "0";
/** Whether this view's pictures go inline in strips (not as files the terminal reads). */
function inlineStrips(view) {
  return STRIPS_ON && !(IMAGE_FILES && view.files !== false);
}

const IMAGE_FILES =
  !swapEveryDraw() &&
  !process.env.SSH_CONNECTION &&
  !process.env.SSH_TTY &&
  process.env.MCP_APPS_CLI_IMAGE_FILES !== "0";
let imageFolder;
/** A folder only this user can read, removed when the helper exits. */
function imageDir() {
  if (!imageFolder) {
    imageFolder = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-cli-"));
    process.on("exit", () => fs.rmSync(imageFolder, { recursive: true, force: true }));
  }
  return imageFolder;
}

/**
 * A picture of the view's area, `scale` image pixels per CSS pixel, through
 * Chrome's own screenshot call (Playwright's adds work of its own, about a
 * third of the time). Fast, larger PNGs where the terminal reads a file;
 * smaller ones where the bytes go through the terminal.
 */
function shoot(view, clip, scale) {
  return inTurn(view, () => shootNow(view, clip, scale));
}
async function shootNow(view, clip, scale) {
  // A view bigger than its own box (shrunk, or taller than its window) is
  // drawn only within the viewport: make sure Chrome hasn't shortened it.
  const wanted = wantedViewport(view);
  const bigger = wanted.width > view.cols * CELL_WIDTH || wanted.height > Math.ceil(view.maxRows * view.cellH);
  if (bigger) await fitViewport(view, true);
  view.cdp ??= await view.page.context().newCDPSession(view.page);
  const { data } = await view.cdp.send("Page.captureScreenshot", {
    format: "png",
    // The page is scrolled to the view's window: clips are in page pixels.
    clip: { x: clip.x, y: clip.y + view.scrollY, width: clip.width, height: clip.height, scale },
    // Chrome's fast PNG encoding: the shot is decoded here (cells, bands) or
    // read from a file, and its encoding was most of a capture's time.
    optimizeForSpeed: true,
    // Chrome's own window is the viewport less its 87 px toolbar, and a shot
    // shows only what's in the window unless told otherwise: the bottom of a
    // shrunk app was grey, and of any view as tall as its box (DOOM's status bar).
    captureBeyondViewport: true,
  });
  return Buffer.from(data, "base64");
}

// The longest a view goes without a capture (see POLL_MS).
const FULL_CAPTURE_MS = 3000;
// The backstop once Chrome says when it paints (see watchPaints): a frame no
// hook announced brings a capture within BOOST_CAPTURE_MS instead.
const PAINTED_BACKSTOP_MS = 10_000;
// Frames Chrome draws this soon after a capture are the capture's own (the
// viewport fitted for it), not the app's.
const OWN_PAINT_MS = 150;
// After three paint-led captures in a row found nothing new, paints rest this long.
const PAINT_REST_MS = 5000;

/**
 * Chrome says when it draws a new frame of the view's page (its screencast,
 * tiny frames, only a signal): what changed may be something no hook saw (an
 * animated image, a worker's canvas). A Chrome without it keeps the timed
 * backstop.
 */
async function watchPaints(view) {
  try {
    view.cdp ??= await view.page.context().newCDPSession(view.page);
    view.cdp.on("Page.screencastFrame", ({ sessionId }) => {
      void view.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      view.painting = true;
      view.paints = (view.paints ?? 0) + 1;
      if (view.busy || Date.now() < (view.ownPaintUntil ?? 0)) return;
      view.painted = true;
    });
    await view.cdp.send("Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 });
  } catch {}
}

/**
 * The regular check: the backstop's capture when it's due, and whether the
 * page still answers (see POLL_MS).
 */
async function poll(view) {
  // Out of sight (see /shown): nothing to draw, and the app's frame is still.
  if (!views.has(view.id) || !view.frame || view.offscreen || view.paused) return;
  const now = Date.now();
  const every =
    (view.boostUntil ?? 0) > now || view.painted ? BOOST_CAPTURE_MS : view.painting ? PAINTED_BACKSTOP_MS : FULL_CAPTURE_MS;
  if (!view.busy && now - (view.capturedAt ?? 0) >= every) {
    view.backstop = true;
    void capture(view);
  }
  if (view.checking || now < (view.aliveCheckAt ?? 0)) return;
  view.checking = true;
  view.aliveCheckAt = now + LIVENESS_MS;
  const answered = await appEval(view, "1", LIVENESS_TIMEOUT_MS).then(() => true, () => false);
  view.checking = false;
  // Out of sight meanwhile: its page was paused, not hung.
  view.misses = answered || view.paused || view.offscreen ? 0 : (view.misses ?? 0) + 1;
  if (view.misses >= MAX_MISSES && views.get(view.id) === view) {
    log(`view ${view.id}: its app stopped responding`);
    dropView(view, "the app stopped responding");
    void view.context.close().catch(() => {});
  }
}

/** The page said it changed: captured now, unless a capture runs (it goes again) or one is paced. */
function changed(view, store) {
  if (!views.has(view.id)) return;
  if (store) {
    if (!view.storeSoon) view.storeSoon = setTimeout(() => {
      view.storeSoon = undefined;
      void saveStore(view);
    }, STORE_SOON_MS);
    return;
  }
  view.hinted = true;
  if (view.paused || view.offscreen) return;
  if (view.busy) {
    view.again = true;
    return;
  }
  if (view.paced) return;
  void capture(view);
}

/**
 * Evaluates in the app's frame, as the helper's own look (its text, whether
 * it answers): over the page's CDP session, never as if the person had just
 * acted. Playwright's evaluations always grant user activation, which gates
 * clipboard writes, popups and fullscreen; an app polled through them held
 * it all along. Input (a select, a key) still goes through Playwright.
 */
async function appEval(view, expression, timeout = 10_000) {
  // The whole call within `timeout`: on a hung page the session's setup
  // waits as long as the evaluation would.
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("no answer")), timeout)));
  return Promise.race([appEvalNow(view, expression), late]).finally(() => clearTimeout(timer));
}

async function appEvalNow(view, expression) {
  view.cdp ??= await view.page.context().newCDPSession(view.page);
  if (!view.contexts) {
    view.contexts = new Map(); // frame id -> its main world's context id
    view.cdp.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.auxData?.isDefault) view.contexts.set(context.auxData.frameId, context.id);
    });
    view.cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      for (const [frame, id] of view.contexts) if (id === executionContextId) view.contexts.delete(frame);
    });
    view.cdp.on("Runtime.executionContextsCleared", () => view.contexts.clear());
    await view.cdp.send("Runtime.enable");
  }
  const { frameTree } = await view.cdp.send("Page.getFrameTree");
  const app = (frameTree.childFrames ?? []).find((child) => child.frame.url.startsWith(`${view.origins.view}/view/`));
  const contextId = app && view.contexts.get(app.frame.id);
  if (!contextId) throw new Error("the view's frame has no context yet");
  const result = await view.cdp.send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
  return result.result.value;
}

async function capture(view) {
  // A paused page (out of sight) would hold the screenshot; it's taken on return.
  if (!views.has(view.id) || !view.frame || view.paused) return;
  // The pointer is moving over a still picture: wait until it rests.
  if (view.mode === "image" && view.holdForRest && view.restUntil > Date.now() && !view.sweep) return;
  view.sweep = false;
  view.capturedAt = Date.now();
  if (view.busy) {
    view.again = true;
    return;
  }
  view.busy = true;
  const paintLed = Boolean(view.painted);
  const paints = view.paints ?? 0;
  view.painted = false;
  view.paints = 0;
  view.captureStarted = Date.now();
  const backstop = view.backstop;
  const hinted = view.hinted;
  view.backstop = false;
  view.hinted = false;
  let changed = false;
  try {
    // Wait for a layout change under way; then one made before the
    // screenshot's turn makes it stale (old pixels, new size): taken again.
    await view.turn;
    const gen = view.layoutGen;
    const stale = () => view.layoutGen !== gen;
    const cols = view.cols;
    const heightPx = view.heightPx || 120;
    const rows = clamp(Math.ceil(heightPx / view.cellH), 1, view.maxRows);
    const top = view.scrollY;
    const clip = { x: 0, y: 0, width: cols * CELL_WIDTH, height: rows * view.cellH };
    if (view.mode === "image") {
      // Viewport coordinates: the page is scrolled to `top` already.
      // Inline pictures (iTerm2) are bytes through the terminal, about
      // 1 MB/s: while the page moves (it animates, or the pointer sweeps)
      // they have half the pixels each way, and full detail at rest.
      const now = Date.now();
      const animating = (view.motion ?? []).filter((t) => now - t < 1000).length >= 3;
      // With strips a hover sends only the bands it changed, at full detail:
      // a change of scale would change them all.
      const sweeping = now - (view.hoverAt ?? 0) < HOVER_REST_MS + 20 && !inlineStrips(view);
      // A drag (a button held) moves the page too. Its changes follow input,
      // so `animating` doesn't count them: without this a drag went at 2x,
      // four times the pixels, and only 1-2 pictures a second got through.
      const moving = !IMAGE_FILES && (animating || sweeping || view.pointerHeld);
      // Strips (below) need each row to be whole pixels: just over 1x then.
      // At most the view's own cap: lowered when its strips grew too big.
      let scale = Math.min(moving ? (inlineStrips(view) ? Math.ceil(view.cellH) / view.cellH : 1) : 2, view.maxScale ?? 2);
      let png = await shoot(view, clip, scale);
      // A picture that goes to the terminal whole, too big for it: taken again
      // smaller (1x, then MIN_SCALE). Bands (iTerm2) are cut from it here,
      // whatever its size; queueStrips keeps their sum in bounds.
      while (png.length > MAX_IMAGE_BYTES && !inlineStrips(view) && scale > MIN_SCALE) {
        scale = scale > 1 ? 1 : MIN_SCALE;
        png = await shoot(view, clip, scale);
      }
      if (stale()) {
        view.again = true;
        return;
      }
      const hash = createHash("sha1").update(png).update(`${top}/${scale}`).digest("hex");
      if (hash === view.hash && rows === view.rows) return;
      view.hash = hash;
      view.rows = rows;
      view.version++;
      changed = true;
      const totalRows = Math.ceil(heightPx / view.cellH);
      view.lastImage = {
        png,
        cols,
        rows,
        scroll: totalRows > rows ? { top: Math.round(top / view.cellH), rows, total: totalRows } : undefined,
      };
      view.lastScale = scale;
      sendImage(view);
      return;
    }
    // The text read before and after the screenshot must agree: an app that
    // re-renders in between (new data arriving) gave a frame of old pixels
    // and new text, cells out of step with the numbers, which the cell
    // memory then kept. Such a frame is dropped and taken again.
    // Unless nothing but a canvas changed since the page's text was last read
    // (a live chart, a 3D scene): its DOM text then stands, and only the
    // canvas's own text and the page's DOM counter are read again, before
    // and after, instead of two walks of the DOM.
    const [domBefore, canvasBefore] = await appEval(view, CANVAS_TEXT).catch(() => [-1, []]);
    // Not on the backstop's capture (it looks for what nothing announced),
    // nor just after input (a hover or focus can show text with no DOM change).
    const cache = backstop || Date.now() - (view.inputAt ?? 0) <= TEXT_AFTER_INPUT_MS ? undefined : view.textCache;
    const reuse = typeof domBefore === "number" && domBefore >= 0 && cache?.dom === domBefore && cache.gen === gen;
    let textBefore = reuse ? JSON.stringify([...cache.domLines, ...canvasBefore]) : JSON.stringify(await appEval(view, `(${EXTRACT_TEXT})()`));
    const png = await inTurn(view, async () => {
      const wanted = wantedViewport(view);
      if (wanted.height > Math.ceil(view.maxRows * view.cellH)) await fitViewport(view, true);
      return view.page.screenshot({
      // Viewport coordinates: the page is scrolled to `top` already. CSS
      // scale: the cell renderer works at one pixel per CSS pixel, also for a
      // view that started as an image and was sent back to cells.
      clip,
      caret: "initial",
      animations: "allow",
      scale: "css",
    });
    });
    // Debug: keep the screenshot the cells are fitted from.
    // MCP_APPS_CLI_DUMP_ALL keeps every frame (numbered) instead of the last.
    const dumpName = process.env.MCP_APPS_CLI_DUMP_ALL ? `${view.id}-${String(view.version + 1).padStart(4, "0")}` : view.id;
    if (process.env.MCP_APPS_CLI_DUMP) fs.writeFileSync(path.join(process.env.MCP_APPS_CLI_DUMP, `${dumpName}.png`), png);
    let lines;
    let photoRects;
    let domAfter = -1;
    const [domNow, canvasNow] = reuse ? await appEval(view, CANVAS_TEXT).catch(() => [-1, []]) : [-1, []];
    if (reuse && domNow === domBefore) {
      lines = [...cache.domLines, ...canvasNow];
      photoRects = cache.photoRects;
      domAfter = domNow;
    } else {
      // The DOM changed meanwhile: what was read before can't vouch for it.
      if (reuse) textBefore = undefined;
      // One round trip: the page's text, its photo regions, and the counter.
      [lines, photoRects, domAfter] = await appEval(
        view,
        `[(${EXTRACT_TEXT})(), window.__cliPhotoRects ? window.__cliPhotoRects() : [], window.__cliDom ? window.__cliDom() : -1]`,
      );
    }
    if (stale()) {
      view.again = true;
      return;
    }
    // Text that never holds still (a running timer) is taken as it is after
    // a few tries.
    if (JSON.stringify(lines) !== textBefore && (view.dropped ?? 0) < 3) {
      view.dropped = (view.dropped ?? 0) + 1;
      view.again = true;
      return;
    }
    view.dropped = 0;
    view.textCache =
      typeof domAfter === "number" && domAfter >= 0
        ? { dom: domAfter, gen, domLines: lines.filter((line) => line.source !== "canvas"), photoRects }
        : undefined;
    const texts = lines.map((line) => ({
      ...line,
      cy: line.cy - top,
      top: line.top == null ? undefined : line.top - top,
      bottom: line.bottom == null ? undefined : line.bottom - top,
    }));
    const photos = photoRects.map((p) => ({ ...p, y: p.y - top }));
    if (process.env.MCP_APPS_CLI_DUMP) {
      fs.writeFileSync(
        path.join(process.env.MCP_APPS_CLI_DUMP, `${dumpName}.json`),
        JSON.stringify({ texts, photos, cols: view.cols, rows, cellHeight: view.cellH, background: view.background }),
      );
    }
    const hash = createHash("sha1")
      .update(png)
      .update(JSON.stringify(texts))
      .update(String(top))
      .digest("hex");
    if (hash === view.hash && rows === view.rows) return;
    // Glyph memory for photo cells, per view; a scroll starts it afresh.
    if (!view.cellMemory || view.cellMemoryTop !== top) {
      view.cellMemory = {};
      view.cellMemoryTop = top;
    }
    // Long edges onto the cell grid first (see snap.mjs).
    let fitted = { img: decodePng(png), texts, photos };
    const anchors = SNAP_ON ? planSnap(fitted.img, Math.round(view.cellH), texts, photos) : null;
    if (anchors) fitted = applySnap(anchors, fitted.img, texts, photos);
    const frame = composeFrame(fitted.img, fitted.texts, {
      cols,
      rows,
      cellWidth: CELL_WIDTH,
      cellHeight: view.cellH,
      pageBackground: view.background,
      photos: fitted.photos,
      memory: view.cellMemory,
      // Kept for the view's life: its photo palette and a mirror of Claude
      // Code's pair slots for its Raster.
      painter: (view.painter ??= {}),
      sextants: SEXTANTS,
      truecolor: TRUECOLOR,
      lines: TRUECOLOR || Boolean(process.env.MCP_APPS_CLI_LINES),
    });
    if (TRUECOLOR) {
      // Rows of styled runs for the mod to draw as text: [text, fg, bg, flags].
      frame.styled = frame.lines;
      delete frame.lines;
      delete frame.cells;
    }
    view.hash = hash;
    view.rows = rows;
    view.version++;
    changed = true;
    const totalRows = Math.ceil(heightPx / view.cellH);
    frame.scroll =
      totalRows > rows
        ? { top: Math.round(top / view.cellH), rows, total: totalRows }
        : undefined;
    emit({ type: "frame", viewId: view.id, gen: view.gen, v: view.version, frame });
    if (process.env.MCP_APPS_CLI_DEBUG && view.version % 10 === 0) log(`view ${view.id}: frame ${view.version}`);
  } catch (error) {
    if (views.has(view.id)) log(`capture ${view.id}:`, error.message);
  } finally {
    view.busy = false;
    view.ownPaintUntil = Date.now() + OWN_PAINT_MS;
    // Paints that keep bringing captures of nothing new (a capture's own
    // repaint, late on a heavy page): not heeded for a while.
    if (paintLed && !changed) {
      view.idlePaints = (view.idlePaints ?? 0) + 1;
      if (view.idlePaints >= 3) {
        view.idlePaints = 0;
        view.ownPaintUntil = Date.now() + PAINT_REST_MS;
      }
    } else if (changed) view.idlePaints = 0;
    // The backstop found a change no paint came for: Chrome stopped saying,
    // and the backstop goes back to its own pace.
    if (backstop && changed && !hinted && paints === 0) view.painting = false;
    // A change no input led to: the page animates by itself.
    if (changed && Date.now() - (view.inputAt ?? 0) > 800) {
      view.idleChangeAt = Date.now();
      view.motion = [...(view.motion ?? []).filter((t) => view.idleChangeAt - t < 1000), view.idleChangeAt];
    }
    // The backstop found a change nothing announced (an animated GIF, a
    // caret): it looks more often for a while.
    if (backstop && changed && !hinted) view.boostUntil = Date.now() + BOOST_MS;
    if (view.again || changed) {
      view.again = false;
      clearTimeout(view.soon);
      const pace = view.mode !== "image" ? ANIMATION_MS : IMAGE_FILES ? IMAGE_FILE_PACE_MS : IMAGE_ANIMATION_MS;
      // Counted from when this capture started: a capture's own time is part
      // of the pace, not added to it.
      const wait = changed ? Math.max(1, view.captureStarted + pace - Date.now()) : 20;
      view.paced = true;
      view.soon = setTimeout(() => {
        view.paced = false;
        void capture(view);
      }, wait);
    }
  }
}

const KEYS = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  space: " ",
  escape: "Escape",
  insert: "Insert",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/**
 * Keys Claude Code passes on as the terminal sent them (it names F1-F4 and
 * the rest only in some terminals): the function keys, as xterm sends them.
 */
const RAW_KEYS = {
  "\u001bOP": "F1", "\u001bOQ": "F2", "\u001bOR": "F3", "\u001bOS": "F4",
  "\u001b[11~": "F1", "\u001b[12~": "F2", "\u001b[13~": "F3", "\u001b[14~": "F4",
  "\u001b[15~": "F5", "\u001b[17~": "F6", "\u001b[18~": "F7", "\u001b[19~": "F8",
  "\u001b[20~": "F9", "\u001b[21~": "F10", "\u001b[23~": "F11", "\u001b[24~": "F12",
  "\u001b[2~": "Insert",
};

/** Presses that make a double click: this soon after the last, this close to it (CSS px). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 6;

/** A key Playwright presses by name (Enter, ArrowUp, F5, ...), not text. */
function isKeyName(name) {
  return Object.values(KEYS).includes(name) || /^F([1-9]|1[0-2])$/.test(name) || ["Insert", "Escape"].includes(name);
}

function input(view, event) {
  view.inputAt = Date.now();
  // A click or a key, as a browser's user activation: what lets the app copy
  // once (see "copy"). A hover, a move or the wheel doesn't.
  if (event.kind === "key" || (event.kind === "pointer" && (event.type === "down" || event.type === "up"))) {
    view.activatedAt = view.inputAt;
  }
  describeSoon(view, ALT_INPUT_MS);
  view.inputs = view.inputs.then(async () => {
    const { mouse, keyboard } = view.page;
    if (event.kind === "pointer") {
      const x = (event.fine?.x ?? event.x + 0.5) * CELL_WIDTH;
      // Input goes in viewport coordinates: the host page itself is scrolled,
      // because headless Chrome drops input outside its real window.
      const y = (event.fine?.y ?? event.y + 0.5) * view.cellH;
      const docY = y + view.scrollY;
      // Where that is in the page as it stands. A view scrolled down (PgDn)
      // whose page is laid out at its full height (to capture it whole; see
      // shootNow) can't scroll, and a click aimed as if it had landed that
      // far up: the input goes where the point really is.
      const at = view.scrollY ? await pageScroll(view) : 0;
      const vy = docY - at;
      // Inside the app's frame, which may be drawn smaller (shrunk to fit).
      const fx = x / (view.scale ?? 1);
      const fy = docY / (view.scale ?? 1);
      const button = event.button ?? "left";
      // A <select>'s native popup is never drawn in a screenshot and would
      // take the keys, so a click on one focuses it instead; ↑/↓ then pick.
      if ((event.type === "down" || event.type === "up") && button === "left") {
        if (process.env.MCP_APPS_CLI_DEBUG) {
          const hit = await view.frame.evaluate(([px, py]) => {
            const el = document.elementFromPoint(px, py);
            return el ? `${el.tagName}#${el.id} "${(el.textContent ?? "").trim().slice(0, 30)}"` : "nothing";
          }, [fx, fy]);
          log(`pointer ${event.type} at ${Math.round(fx)},${Math.round(fy)} (scroll ${view.scrollY}) → ${hit}${view.lastPress?.count > 1 && event.type === "up" ? ` ×${view.lastPress.count}` : ""}`);
        }
        const isSelect = await view.frame.evaluate(
          ([px, py]) => {
            const select = document.elementFromPoint(px, py)?.closest("select");
            if (!select || select.disabled) return false;
            select.focus();
            return true;
          },
          [fx, fy],
        );
        if (isSelect) {
          setTimeout(() => void capture(view), 50);
          return;
        }
      }
      if (event.type === "down") {
        view.pointerHeld = true;
        // A second (or third) press soon, in the same place: a double (or
        // triple) click, as a browser counts them, so dblclick fires.
        const last = view.lastPress;
        const now = Date.now();
        const count =
          last && last.button === button && now - last.at < MULTI_CLICK_MS && Math.hypot(x - last.x, y - last.y) <= MULTI_CLICK_PX
            ? Math.min(last.count + 1, 3)
            : 1;
        view.lastPress = { at: now, x, y, button, count };
        await mouse.move(x, vy);
        await mouse.down({ button, clickCount: count });
      } else if (event.type === "up") {
        view.pointerHeld = false;
        await mouse.move(x, vy);
        await mouse.up({ button, clickCount: view.lastPress?.count ?? 1 });
        // Full detail once the drag ends (a page that animates stays at 1x).
        if (view.mode === "image") setTimeout(() => void capture(view), HOVER_REST_MS + 10);
      } else if (event.type === "move") {
        await mouse.move(x, vy);
        if (!event.button && view.mode === "image") {
          const now = Date.now();
          // Decided as a hover starts (none in the last second), for all of
          // it: a page that changes by itself (an animation) keeps drawing.
          if (now - (view.hoverAt ?? 0) > 1000) view.holdForRest = now - (view.idleChangeAt ?? 0) > 1500;
          view.hoverAt = now;
          if (view.holdForRest) {
            // The first move after a rest is drawn at once (a hop onto the
            // next control), then a long sweep a few times a second.
            if (!(view.restUntil > now)) view.heldSince = now - HOVER_SWEEP_MS;
            view.restUntil = now + HOVER_REST_MS;
            clearTimeout(view.restTimer);
            view.restTimer = setTimeout(() => void capture(view), HOVER_REST_MS + 10);
            if (now - view.heldSince >= HOVER_SWEEP_MS) {
              view.heldSince = now;
              view.sweep = true;
              void capture(view);
            }
            return;
          }
        }
      }
    } else if (event.kind === "wheel") {
      // A wheel tick is a row in the terminal; about three lines in a page.
      await mouse.wheel(0, Number(event.by ?? 0) * 3 * view.cellH);
      setTimeout(() => void capture(view), 50);
      setTimeout(() => void capture(view), 250);
      return;
    } else if (event.kind === "key") {
      if (process.env.MCP_APPS_CLI_DEBUG) log(`key ${JSON.stringify(event.key)}${event.ctrl ? " +ctrl" : ""}${event.shift ? " +shift" : ""}${event.meta ? " +meta" : ""}`);
      const window = view.maxRows * view.cellH;
      if ((event.key === "pagedown" || event.key === "pageup") && view.heightPx > window) {
        const step = (view.maxRows - 2) * view.cellH;
        view.scrollY += event.key === "pagedown" ? step : -step;
        await clampScroll(view);
        setTimeout(() => void capture(view), 10);
        return;
      }
      const handled = await view.frame.evaluate((key) => {
        const select = document.activeElement;
        if (!(select instanceof HTMLSelectElement)) return false;
        const step = key === "up" || key === "left" ? -1 : key === "down" || key === "right" ? 1 : 0;
        if (!step) return key === "return" || key === "space" || key === " ";
        let index = select.selectedIndex;
        do index += step;
        while (index >= 0 && index < select.options.length && select.options[index].disabled);
        if (index < 0 || index >= select.options.length) return true;
        select.selectedIndex = index;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, event.key);
      if (handled) {
        setTimeout(() => void capture(view), 50);
        setTimeout(() => void capture(view), 300);
        return;
      }
      const name = RAW_KEYS[event.key] ?? KEYS[event.key] ?? event.key;
      const modifiers = [event.ctrl && "Control", event.meta && "Meta", event.shift && name.length > 1 && "Shift"]
        .filter(Boolean)
        .join("+");
      if (HELD_KEYS.has(name) && !(await editableFocused(view))) await holdKey(view, name, modifiers);
      // One character (an emoji is one, of two UTF-16 units): typed, or
      // pressed with its modifiers (ctrl+a).
      else if ([...name].length === 1) await (modifiers ? keyboard.press(`${modifiers}+${name}`) : keyboard.type(name));
      else if (isKeyName(name)) await keyboard.press(modifiers ? `${modifiers}+${name}` : name);
      // A control sequence Claude Code passed on as it came, that isn't a
      // key we know: dropped, never typed into the app as text.
      else if (/[\u0000-\u001f\u007f]/.test(name)) log(`key ${JSON.stringify(name)}: not a key we know, dropped`);
      // More than one character (an input method's text, an emoji with a
      // modifier): entered as text, as a browser does.
      else await keyboard.insertText(name);
    }
    setTimeout(() => void capture(view), 50);
    setTimeout(() => void capture(view), 250);
  }).catch((error) => log(`input ${view.id}:`, error.message));
  return { ok: true };
}

// A terminal reports key presses, never releases: holding a key repeats it
// (after a delay, then about 10-30 a second). A game reads arrows as held:
// walking in DOOM, a ship's thrust. So outside a text field an arrow goes
// down and stays down while presses keep coming, and up a moment after the
// last: a tap is a short step, a held key walks (after the terminal's repeat
// delay; until then it's a tap).
const HELD_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const HOLD_FIRST_MS = 150;
const HOLD_REPEAT_MS = 160;

/** Whether the app's focused element takes text (arrows then move a caret). */
async function editableFocused(view) {
  return view.frame
    .evaluate(() => {
      const el = document.activeElement;
      return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
    })
    .catch(() => false);
}

/** Puts `name` down (with its modifiers), or keeps it down, until presses stop. */
async function holdKey(view, name, modifiers) {
  view.held ??= new Map();
  const held = view.held.get(name);
  if (held) {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => releaseKey(view, name), HOLD_REPEAT_MS);
    return;
  }
  const mods = modifiers ? modifiers.split("+") : [];
  for (const mod of mods) await view.page.keyboard.down(mod);
  await view.page.keyboard.down(name);
  view.held.set(name, { mods, timer: setTimeout(() => releaseKey(view, name), HOLD_FIRST_MS) });
}

function releaseKey(view, name) {
  const held = view.held?.get(name);
  if (!held) return;
  view.held.delete(name);
  view.inputs = view.inputs
    .then(async () => {
      await view.page.keyboard.up(name);
      for (const mod of [...held.mods].reverse()) await view.page.keyboard.up(mod);
    })
    .catch(() => {});
}

/**
 * The page is the view's size; while the app is shrunk to fit, also as big as
 * its frame before the shrink. Chrome draws only the part of a frame inside
 * the page's viewport, measured before the transform, so the bottom of a
 * shrunk app came out blank. The app's own size is its frame's, unchanged.
 */
async function fitViewport(view, again = false) {
  const { width, height } = wantedViewport(view);
  // The page's own size, not one remembered: a view left with a narrower
  // viewport than its layout drew its right side blank (cells: blocks out of
  // step with the numbers). And Chrome sometimes leaves a page 87 px shorter
  // after a screenshot (its window's toolbar, taken off), which cut off the
  // bottom of a shrunk app (the cohort heatmap's legend).
  const actual = await view.page.evaluate(() => [innerWidth, innerHeight]).catch(() => null);
  if (actual && actual[0] === width && actual[1] === height) return;
  // Put back as it was (`again`), the layout hasn't changed: captures stand.
  if (!again) view.layoutGen = (view.layoutGen ?? 0) + 1;
  await view.page.setViewportSize({ width, height }).catch(() => {});
}

/** Runs `launch` with temporary files (Chrome's profile) in this helper's own folder. */
async function inOwnTmp(launch) {
  const before = process.env.TMPDIR;
  if (fs.existsSync(OWN_TMP)) process.env.TMPDIR = OWN_TMP;
  try {
    return await launch();
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
}

/** The viewport a view needs: its own size, or its frame's before a shrink, if larger. */
function wantedViewport(view) {
  const scale = view.scale ?? 1;
  return {
    width: Math.ceil((view.cols * CELL_WIDTH) / scale),
    height: Math.max(Math.ceil(view.maxRows * view.cellH), Math.ceil((view.heightPx ?? 0) / scale)),
  };
}

/**
 * Runs `work` on the view when nothing else of its kind is: changes to its
 * layout (size, viewport, scroll) and its screenshots take turns, in the
 * order asked. Chrome's screenshot at a scale sets the page's metrics for
 * the shot and puts back the ones it found after, so a viewport set during
 * one was undone (the app laid out wider than the picture, its right side
 * blank).
 */
function inTurn(view, work) {
  const run = (view.turn ?? Promise.resolve()).then(work, work);
  view.turn = run.catch(() => {});
  return run;
}
const inLayout = inTurn;

/**
 * Scrolls the host page to where the view is scrolled, as far as it goes,
 * and says where it stands: 0 when the page is laid out at its full height.
 */
async function pageScroll(view) {
  return view.page
    .evaluate((top) => {
      if (Math.round(window.scrollY) !== top) window.scrollTo(0, top);
      return Math.round(window.scrollY);
    }, view.scrollY)
    .catch(() => view.scrollY);
}

async function clampScroll(view) {
  const window = view.maxRows * view.cellH;
  const max = Math.max(0, view.heightPx - window);
  view.scrollY = Math.max(0, Math.min(max, Math.round(view.scrollY / view.cellH) * view.cellH));
  await view.page.evaluate((top) => window.scrollTo(0, top), view.scrollY).catch(() => {});
}

function resize(view, cols, maxRows, display) {
  return inLayout(view, async () => {
    view.cols = clamp(cols, 20, 240);
    if (maxRows) view.maxRows = clamp(maxRows, 4, 80);
    if (display) view.display = display;
    view.maxScale = 2;
    view.cellH = rowHeight(view.mode);
    view.layoutGen = (view.layoutGen ?? 0) + 1;
    await view.page.setViewportSize({
      width: view.cols * CELL_WIDTH,
      height: Math.ceil(view.maxRows * view.cellH),
    });
    await view.page.evaluate(
      ([w, h, mode, fit]) => window.__setContainer?.(mode, w, h, fit),
      [view.cols * CELL_WIDTH, Math.floor(view.maxRows * view.cellH), view.display ?? "inline", view.mode === "image"],
    );
    await clampScroll(view);
    view.hash = "";
    setTimeout(() => void capture(view), 60);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- alt text

// What a picture view shows, as text: Claude Code reads an Image's alt to a
// screen reader, and draws it where no picture can be. Taken from the app's
// accessibility tree (see alt.mjs) once it has settled after opening, after
// its result, and after the person's input, not as it animates (a new alt
// draws the picture again).
const ALT_SETTLE_MS = 1500;
const ALT_INPUT_MS = 2000;
function describeSoon(view, ms) {
  clearTimeout(view.describeTimer);
  view.describeTimer = setTimeout(() => void describe(view), ms);
}

/**
 * What the view shows, as text: its page's title (any view, for its header)
 * and, for a picture, its alt from the accessibility tree.
 */
async function describe(view) {
  if (!views.has(view.id) || !view.frame || view.offscreen || view.paused) return;
  const title = plainText(await view.frame.evaluate(() => document.title).catch(() => "")).slice(0, MAX_TITLE_CHARS);
  // Chrome's accessibility tree of the app's frame, over CDP: Playwright's
  // aria snapshot evaluates in the page, as if the person had just acted.
  let text = "";
  if (view.mode === "image") {
    try {
      view.cdp ??= await view.page.context().newCDPSession(view.page);
      const { frameTree } = await view.cdp.send("Page.getFrameTree");
      const app = (frameTree.childFrames ?? []).find((child) => child.frame.url.startsWith(`${view.origins.view}/view/`));
      if (app) text = altFromTree(await view.cdp.send("Accessibility.getFullAXTree", { frameId: app.frame.id }));
    } catch {}
  }
  if (!views.has(view.id)) return;
  const message = { type: "describe", viewId: view.id, gen: view.gen };
  if (text && text !== view.alt) message.text = view.alt = text;
  if (title !== (view.title ?? "")) message.title = view.title = title;
  if (message.text !== undefined || message.title !== undefined) emit(message);
}

/** Stops a view's timers and what it waits on; it's no longer in `views`. */
function forgetView(view) {
  views.delete(view.id);
  // A paused page resumes as its debugger sessions go (crash, close, Chrome stopping).
  void settleShown(view);
  clearTimeout(view.describeTimer);
  clearInterval(view.timer);
  clearInterval(view.storeTimer);
  clearTimeout(view.storeSoon);
  clearTimeout(view.soon);
  worker?.postMessage({ drop: view.id });
  if (imageFolder) {
    for (let k = 0; k < 3; k++) {
      fs.rmSync(path.join(imageFolder, `${view.fileStem}-${k}-tty-graphics-protocol.png`), { force: true });
    }
  }
  // What it asked and is still waiting on is refused: a later yes does nothing.
  for (const [id, waiting] of pending) {
    if (waiting.viewId !== view.id) continue;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.reject(new Error("the view closed"));
  }
  noteViews();
}

/**
 * A view whose page or browser died: forgotten, with no teardown (nothing
 * to run it in) and its store as last saved, and the mod is told why.
 */
function dropView(view, reason) {
  if (views.get(view.id) !== view) return;
  forgetView(view);
  emit({ type: "closed", viewId: view.id, gen: view.gen, reason });
}

/**
 * Closes a view: the app's teardown, then its store saved. `discard`: a view
 * whose call never ran (it opened while Claude wrote the call and the person
 * said no) keeps nothing.
 */
async function closeView(viewId, discard = false) {
  const view = views.get(viewId);
  if (!view) return { ok: true };
  forgetView(view);
  // The app gets its teardown, but not for long: one that never answers it
  // held the close for a minute (the SDK's request timeout).
  await Promise.race([view.page.evaluate(() => window.__teardown()).catch(() => {}), sleep(TEARDOWN_MS)]);
  // After the teardown: what the app saved as it closed is kept too.
  if (discard) {
    if (view.storeFile) fs.rmSync(view.storeFile, { force: true });
  } else await saveStore(view, true);
  await view.context.close().catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------- socket

/**
 * Routes the helper answers without the view's page, which a view paused out
 * of sight needn't wake for (see whileAwake). /shown wakes or pauses it
 * itself; /reply only settles a promise, and what follows it waits for the
 * page to come back, as a paused tab's tasks do.
 */
const PAGELESS_ROUTES = new Set(["/ping", "/discover", "/prewarm", "/shown", "/reply", "/inline-png", "/refresh"]);

const routes = {
  "/ping": async () => ({ ok: true, views: [...views.keys()], rowHeights: [...views.values()].map((v) => v.cellH) }),
  "/discover": async ({ server, refresh }) => ({ ok: true, ...(await discover(server, refresh)) }),
  "/open": openView,
  "/input": async ({ viewId, event }) => {
    const view = views.get(viewId);
    // Input means it's in sight, whatever the transcript said last.
    if (view?.offscreen) await setShown(view, true);
    return view ? input(view, event) : { ok: false, error: "no such view" };
  },
  // The mod saw the view scroll out of (or back into) the transcript's
  // viewport: an unseen view isn't captured and its app isn't drawn.
  "/shown": async ({ viewId, shown }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    await setShown(view, Boolean(shown));
    return { ok: true };
  },
  "/resize": async ({ viewId, cols, maxRows, display }) => {
    const view = views.get(viewId);
    return view ? resize(view, cols, maxRows, display) : { ok: false, error: "no such view" };
  },
  "/reply": async (body) => reply(body),
  "/theme": async ({ viewId, theme }) => {
    const view = views.get(viewId);
    return view ? setTheme(view, theme) : { ok: false, error: "no such view" };
  },
  // The view opened while Claude wrote its call: the arguments so far
  // (partial, tool-input-partial), then all of them (tool-input).
  "/args": async ({ viewId, arguments: args, partial }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "arguments must be an object" };
    if (process.env.MCP_APPS_CLI_DEBUG) log(`view ${viewId}: arguments ${partial ? "so far" : "whole"}, ${JSON.stringify(args).length} chars`);
    await view.page.evaluate(([a, p]) => window.__toolArgs(a, p), [args, Boolean(partial)]);
    setTimeout(() => void capture(view), 60);
    return { ok: true };
  },
  // The view opened as its tool started: the result, or why there is none.
  "/result": async ({ viewId, result }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    await view.page.evaluate((r) => window.__toolResult(r), normalizeResult(result));
    setTimeout(() => void capture(view), 60);
    describeSoon(view, ALT_SETTLE_MS);
    return { ok: true };
  },
  "/cancel": async ({ viewId, reason }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    await view.page.evaluate((r) => window.__toolCancelled(r), String(reason ?? "cancelled"));
    setTimeout(() => void capture(view), 60);
    return { ok: true };
  },
  // An MCP tool started to run: Chrome starts now, in case it has an app.
  "/prewarm": async () => {
    await browser();
    noteViews();
    return { ok: true };
  },
  "/inline-png": async ({ viewId }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    view.files = false;
    return { ok: sendImage(view) };
  },
  "/refresh": async ({ viewId }) => {
    const view = views.get(viewId);
    return { ok: Boolean(view && view.mode === "image" && sendImage(view, true)) };
  },
  "/close": async ({ viewId, discard }) => closeView(viewId, Boolean(discard)),
  // Debug and test aid: where an element with this exact text sits, in the
  // view's cells. Lets a test or demo driver click controls in image mode.
  "/locate": async ({ text }) => {
    if (!process.env.MCP_APPS_CLI_DEBUG) return { ok: false, error: "debug only" };
    for (const view of [...views.values()].reverse()) {
      if (view.paused) continue;
      const hit = await view.frame
        .evaluate((wanted) => {
          let best = null;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          for (let el = walker.nextNode(); el; el = walker.nextNode()) {
            const label =
              el.tagName === "SELECT"
                ? el.selectedOptions[0]?.text
                : el.tagName === "INPUT" || el.tagName === "TEXTAREA"
                  ? el.value
                  : (el.innerText ?? "").trim();
            if (label !== wanted && el.getAttribute("title") !== wanted && el.getAttribute("aria-label") !== wanted) continue;
            const r = el.getBoundingClientRect();
            if (r.width && r.height) best = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          return best;
        }, text)
        .catch(() => null);
      if (hit) {
        return {
          ok: true,
          viewId: view.id,
          cellX: Math.floor((hit.x * (view.scale ?? 1)) / CELL_WIDTH),
          cellY: Math.floor((hit.y * (view.scale ?? 1) - view.scrollY) / view.cellH),
        };
      }
    }
    return { ok: false, error: "not found" };
  },
  "/mode": async ({ viewId, mode }) => {
    const view = views.get(viewId);
    if (!view) return { ok: false, error: "no such view" };
    view.mode = mode === "image" ? "image" : "cells";
    return resize(view, view.cols, view.maxRows);
  },
};

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not authorized" }));
    req.resume();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const route = routes[req.url ?? ""];
    let status = 200;
    let result;
    try {
      if (!route) {
        status = 404;
        result = { ok: false, error: "not found" };
      } else {
        const input = body ? JSON.parse(body) : {};
        // A view paused out of sight is woken for whatever is asked of its
        // page; not for what the helper answers itself (a picture sent
        // again comes about a dozen times a second in iTerm2).
        // Anything about a view for another open of it than its page's is
        // refused: a close of an earlier one closes nothing of this one.
        const held = req.url === "/open" || req.url === "/reply" ? undefined : views.get(input.viewId);
        if (held && !sameOpen(held.gen, input)) result = req.url === "/close" ? { ok: true } : { ok: false, error: "another open of this view" };
        else {
          const view = PAGELESS_ROUTES.has(req.url) ? undefined : views.get(input.viewId);
          result = await whileAwake(view, () => route(input));
        }
      }
    } catch (error) {
      status = 500;
      result = { ok: false, error: error.message };
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
});

try {
  sweepOldTmp();
} catch (error) {
  log("temporary files:", error.message);
}
if (!TCP) {
  try {
    fs.unlinkSync(socketPath);
  } catch {}
}
const ready = () => {
  if (!TCP) fs.chmodSync(socketPath, 0o600);
  const where = TCP ? { url: `http://127.0.0.1:${server.address().port}`, token: TOKEN } : { socket: socketPath, token: TOKEN };
  emit({
    type: "ready",
    ...where,
    pid: process.pid,
    images: imageCapable(),
    swapEveryDraw: swapEveryDraw(),
    truecolor: TRUECOLOR,
  });
  if (process.env.MCP_APPS_CLI_SOCKET_FILE && !TCP) {
    // A test aid (bench/session.py): the socket and its token, for the person only.
    fs.writeFileSync(process.env.MCP_APPS_CLI_SOCKET_FILE, `${socketPath}\n${TOKEN}\n`, { mode: 0o600 });
  }
};
if (TCP) server.listen(0, "127.0.0.1", ready);
else server.listen(socketPath, ready);

// Leave with the claude process that started us.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    void shutdown();
  }
}, 3000).unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of [...views.keys()]) await closeView(id);
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  fs.rmSync(OWN_TMP, { recursive: true, force: true });
  for (const client of sideClients.values()) (await client.catch(() => null))?.close();
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// The terminal closed (or Claude Code went with it): close Chrome too, which
// removes its temporary profile; dying of the signal left it behind.
process.on("SIGHUP", shutdown);
process.stdout.on("error", () => void shutdown());

// ---------------------------------------------------------------- utils

function parseArgs(list) {
  const out = { mcpConfig: [] };
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--socket") out.socket = list[++i];
    else if (list[i] === "--cwd") out.cwd = list[++i];
    else if (list[i] === "--mcp-config") out.mcpConfig.push(list[++i]);
  }
  return out;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
