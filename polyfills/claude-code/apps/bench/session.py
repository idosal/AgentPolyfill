"""Drive a real Claude Code CLI session with the mcp-apps-cli plugin in a
pseudo-terminal and record everything it writes.

    python3 session.py <out-dir> <scenario.json>

Writes <out-dir>/<cast> (JSON lines): a header, then [t, "o", base64 bytes]
for all terminal output, [t, "click", col, row] and [t, "key", name] for
input, and a debug log when the scenario sets "debug". The pseudo-terminal
answers as iTerm2 3.5, kitty 0.50 or Ghostty 1.4 ("terminal"), so Claude Code
draws real images the way it would there. Needs `claude` on PATH and pyte
(`pip install pyte`). See README.md for scenarios and what to read from a cast.
"""

import base64
import fcntl
import json
import os
import pty
import re
import select
import socket
import struct
import sys
import termios
import time

import pyte

S = os.path.abspath(sys.argv[1])
SCENARIO = os.path.abspath(sys.argv[2])
CFG = json.load(open(SCENARIO))
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(S, exist_ok=True)
COLS, ROWS = CFG.get("cols", 140), CFG.get("rows", 52)
CELL_W, CELL_H = CFG.get("cell_w", 8), CFG.get("cell_h", 16)
# This polyfill's folder (polyfills/claude-code/apps in the repository), which
# holds mod/, the plugin; the session starts here unless a scenario names "cwd".
POLYFILL = os.path.abspath(os.path.join(HERE, ".."))
SOCKET_FILE = f"{S}/demo-helper.sock.txt"

_report = pyte.Screen.report_device_status
pyte.Screen.report_device_status = lambda self, mode=0, *a, **k: None if k.get("private") else _report(self, mode)

CMD = [
    "claude", "--model", CFG.get("model", "sonnet"),
    # "plugin_dir" runs another copy of the plugin (an installed package, say),
    # relative to the scenario file; this polyfill's mod/ by default.
    "--plugin-dir", os.path.join(os.path.dirname(SCENARIO), CFG["plugin_dir"]) if CFG.get("plugin_dir") else f"{POLYFILL}/mod",
    # Relative to the scenario file.
    "--mcp-config", os.path.join(os.path.dirname(SCENARIO), CFG["mcp_config"]), "--strict-mcp-config",
    # "setting_sources" lets a scenario read the user's settings too; null reads
    # every source, and no "tools" sets no allowlist: /tui refuses to restart a
    # session launched with either restriction.
    *(["--setting-sources", CFG.get("setting_sources", "project")] if CFG.get("setting_sources", "project") else []),
    *([f"--allowed-tools={','.join(CFG['tools'])}"] if CFG.get("tools") else []),
    *CFG.get("extra_args", []),
    *(["--debug-file", f"{S}/{CFG.get('cast', 'demo.cast')[:-5]}-debug.log"] if CFG.get("debug") else []),
]
ENV = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "CLAUDECODE"))}
TERMINAL = CFG.get("terminal", "iterm")
ITERM = TERMINAL == "iterm"
# What each identity answers to XTVERSION (CSI > q).
XTVERSION = {"iterm": b"iTerm2 3.5.14", "kitty": b"kitty(0.50.0)", "ghostty": b"ghostty 1.4.0"}.get(TERMINAL)
# Like the real kitty 0.50 (and Ghostty): it reports a cell size and offers
# pixel mouse reports (mode 1016), which Claude Code then turns on.
CELL_PX = (14, 25) if TERMINAL in ("kitty", "ghostty") else None
pixel_mouse = False
image_rows = 0  # rows of the last kitty image Claude Code placed
image_sends = 0  # kitty images Claude Code started sending
ENV.update(
    TERM="xterm-256color", COLORTERM="truecolor", CLAUDE_CODE_NO_FLICKER="1",
    MCP_APPS_CLI_DEBUG="1", MCP_APPS_CLI_TIMINGS="1", MCP_APPS_CLI_SOCKET_FILE=SOCKET_FILE,
)
for k in ("TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LC_TERMINAL", "LC_TERMINAL_VERSION", "ITERM_SESSION_ID", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "TMUX"):
    ENV.pop(k, None)
if ITERM:
    ENV.update(TERM_PROGRAM="iTerm.app", TERM_PROGRAM_VERSION="3.5.14", LC_TERMINAL="iTerm2", LC_TERMINAL_VERSION="3.5.14")
elif TERMINAL == "kitty":
    ENV.update(TERM="xterm-kitty", KITTY_WINDOW_ID="1")
elif TERMINAL == "ghostty":
    ENV.update(TERM="xterm-ghostty", TERM_PROGRAM="ghostty", TERM_PROGRAM_VERSION="1.1.3")
for k, v in CFG.get("env", {}).items():
    # null drops a variable the runner sets.
    if v is None:
        ENV.pop(k, None)
    else:
        ENV[k] = str(v)
if os.path.exists(SOCKET_FILE):
    os.remove(SOCKET_FILE)

pid, fd = pty.fork()
if pid == 0:
    # "cwd" (relative to the scenario file) starts the session in another folder.
    os.chdir(os.path.join(os.path.dirname(SCENARIO), CFG["cwd"]) if CFG.get("cwd") else POLYFILL)
    os.execvpe(CMD[0], CMD, ENV)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, COLS * CELL_W, ROWS * CELL_H))

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
cast = open(f"{S}/{CFG.get('cast', 'demo.cast')}", "w")
cast.write(json.dumps({"version": 2, "width": COLS, "height": ROWS}) + "\n")
t0 = time.time()
tail = b""


apc_open = False


def strip_apc(data):
    """Drops APC strings (kitty graphics) before the screen model, which would print them."""
    global apc_open
    out = bytearray()
    i = 0
    while i < len(data):
        if apc_open:
            end = data.find(b"\x1b\\", i)
            if end < 0:
                return bytes(out)
            apc_open = False
            i = end + 2
            continue
        start = data.find(b"\x1b_", i)
        if start < 0:
            out += data[i:]
            break
        out += data[i:start]
        apc_open = True
        i = start + 2
    return bytes(out)


utf8_carry = b""


def model_bytes(data):
    global utf8_carry
    data = utf8_carry + data
    cut = len(data)
    for back in range(1, min(4, len(data)) + 1):
        b = data[-back]
        if b & 0xC0 == 0x80:
            continue
        need = 4 if b >= 0xF0 else 3 if b >= 0xE0 else 2 if b >= 0xC0 else 1
        if need > back:
            cut = len(data) - back
        break
    utf8_carry = data[cut:]
    text = data[:cut].decode("utf-8", "replace").replace("\U0010eeee", " ")
    # Drop the diacritics that number placeholder rows and columns.
    text = "".join(ch for ch in text if not ("\u0300" <= ch <= "\u036f" or "\u0483" <= ch <= "\u0487" or "\u0591" <= ch <= "\u05c7" or "\u0610" <= ch <= "\u065f" or "\u06d6" <= ch <= "\u06ed" or "\u0711" <= ch <= "\u074a" or "\u07eb" <= ch <= "\u07f3" or "\u0816" <= ch <= "\u082d" or "\u0951" <= ch <= "\u0954" or "\u0f82" <= ch <= "\u0f87" or "\u135d" <= ch <= "\u135f" or "\u17dd" == ch or "\u193a" == ch or "\u1a17" == ch or "\u1a75" <= ch <= "\u1a7c" or "\u1b6b" <= ch <= "\u1b73" or "\u1dc0" <= ch <= "\u1dff" or "\u20d0" <= ch <= "\u20f0" or "\u2cef" <= ch <= "\u2cf1" or "\u2de0" <= ch <= "\u2dff" or "\ua66f" <= ch <= "\ua67d" or "\ua69e" <= ch <= "\ua6f1" or "\ua8e0" <= ch <= "\ua8f1" or "\uaab0" <= ch <= "\uaac1" or "\ufe20" <= ch <= "\ufe2f" or "\U00010a0f" == ch or "\U00010a38" <= ch <= "\U00010a3f" or "\U0001d185" <= ch <= "\U0001d1ad" or "\U0001d242" <= ch <= "\U0001d244" or "\U0001e000" <= ch <= "\U0001e02a" or "\U0001e8d0" <= ch <= "\U0001e8d6" or "\U0001e944" <= ch <= "\U0001e94a"))
    return text.encode()


def record(kind, *payload):
    cast.write(json.dumps([round(time.time() - t0, 3), kind, *payload]) + "\n")


def pump(seconds):
    global tail
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.03)
        if not ready:
            continue
        try:
            data = os.read(fd, 1 << 20)
        except OSError:
            return False
        if not data:
            return False
        record("o", base64.b64encode(data).decode())
        # kitty's image placeholder cells (U+10EEEE): one blank cell each for
        # the model, which gives them two; a character split across reads waits.
        stream.feed(model_bytes(strip_apc(data)))
        window = tail + data
        global image_rows, image_sends
        image_sends += data.count(b"_Ga=T")
        for m in re.finditer(rb"a=T[^;]*?r=(\d+)", window):
            image_rows = int(m.group(1))
        tail = data[-16:]
        if XTVERSION and (b"\x1b[>0q" in window or b"\x1b[>q" in window):
            os.write(fd, b"\x1bP>|" + XTVERSION + b"\x1b\\")
            tail = b""
        if TERMINAL in ("kitty", "ghostty"):
            # The kitty graphics probe (a=q): answer OK for its image id.
            for m in re.finditer(rb"\x1b_G([^;\x1b]*a=q[^;\x1b]*)", window):
                ident = re.search(rb"i=(\d+)", m.group(1))
                if ident:
                    os.write(fd, b"\x1b_Gi=" + ident.group(1) + b";OK\x1b\\")
        if CELL_PX:
            global pixel_mouse
            if b"\x1b[?1016h" in window:
                pixel_mouse = True
            if b"\x1b[?1016l" in window:
                pixel_mouse = False
            for m in re.finditer(rb"\x1b\[\?(\d+)\$p", window):
                known = m.group(1) in (b"1016", b"2026")
                os.write(fd, b"\x1b[?" + m.group(1) + (b";2$y" if known else b";0$y"))
            if b"\x1b[16t" in window:
                os.write(fd, f"\x1b[6;{CELL_PX[1]};{CELL_PX[0]}t".encode())
        if b"\x1b[6n" in data:
            os.write(fd, f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R".encode())
        if b"\x1b[c" in data:
            os.write(fd, b"\x1b[?62;22c")
    return True


def lines():
    # Not screen.display: pyte crashes on a cell holding only a combining
    # mark, which Claude Code's image placeholders produce.
    return ["".join((screen.buffer[y][x].data or " ")[:1] for x in range(screen.columns)) for y in range(screen.lines)]


def text():
    return "\n".join(lines())


def wait_for(pattern, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if not pump(0.2):
            return False
        if re.search(pattern, text()):
            return True
    return False


def find(pattern):
    hits = [(m.start(), y) for y, line in enumerate(lines()) for m in re.finditer(pattern, line)]
    return hits[-1] if hits else None


def helper(route, body):
    path, token = open(SOCKET_FILE).read().split()[:2]
    payload = json.dumps(body).encode()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.sendall(
        f"POST {route} HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nx-mcp-apps-cli-token: {token}\r\n"
        f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode() + payload
    )
    data = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data.split(b"\r\n\r\n", 1)[1])


def click(col, row):
    record("click", col, row)
    if pixel_mouse:
        # Mode 1016: the middle of the cell, in pixels (1-based).
        x, y = col * CELL_PX[0] + CELL_PX[0] // 2 + 1, row * CELL_PX[1] + CELL_PX[1] // 2 + 1
    else:
        x, y = col + 1, row + 1
    os.write(fd, f"\x1b[<0;{x};{y}M".encode())
    pump(0.09)
    os.write(fd, f"\x1b[<0;{x};{y}m".encode())


KEYS = {
    "down": b"\x1b[B", "up": b"\x1b[A", "left": b"\x1b[D", "right": b"\x1b[C",
    "escape": b"\x1b", "return": b"\r", "space": b" ", "pagedown": b"\x1b[6~", "pageup": b"\x1b[5~",
}


def paste_text(s):
    os.write(fd, b"\x1b[200~" + s.encode() + b"\x1b[201~")
    pump(0.8)
    os.write(fd, b"\r")


def type_text(s):
    for ch in s:
        os.write(fd, ch.encode())
        pump(0.035)
    pump(0.4)
    os.write(fd, b"\r")


turns = 0
result = {}
wait_for(r"❯", 60)
pump(1.5)
for i, step in enumerate(CFG["steps"]):
    name = step.get("name", f"step{i}")
    if "prompt" in step:
        done_before = len(re.findall(r"for \d+s · done", text()))
        (paste_text if step.get("paste") else type_text)(step["prompt"])
        ok = wait_for(step["expect"], step.get("timeout", 150)) if "expect" in step else True
        # Let the turn finish before the next step.
        end = time.time() + step.get("turn_timeout", 120)
        while time.time() < end and len(re.findall(r"for \d+s · done", text())) <= done_before:
            pump(0.3)
        result[name] = ok
    if "locate" in step:
        header = find(step["view"])
        hit = helper("/locate", {"text": step["locate"]})
        result[name + "_locate"] = hit
        if header and hit.get("ok"):
            click(header[0] + hit["cellX"] + step.get("dx", 0), header[1] + 1 + hit["cellY"])
            if step.get("double"):
                # A second click soon after, in the same place: a double click.
                pump(0.12)
                click(header[0] + hit["cellX"] + step.get("dx", 0), header[1] + 1 + hit["cellY"])
            pump(0.6)
    if "locate_below" in step:
        # Click an element of a picture whose top may be scrolled off the
        # screen: placed from its scroll hint line, the row right under it.
        hint = find(r"[↑↓] .*PgUp/PgDn to scroll")
        hit = helper("/locate", {"text": step["locate_below"]})
        rows = image_rows
        result[name + "_locate"] = {**hit, "hint": hint, "picture_rows": rows, "picture_top": hint[1] - rows if hint else None}
        if hint and hit.get("ok"):
            click(hint[0] + hit["cellX"] + step.get("dx", 0), hint[1] - rows + hit["cellY"])
            pump(0.8)
    if "hover_hops" in step:
        # Hops of the pointer between cells of a picture, like a hand: a few
        # motion reports over 40 ms, then still. Each hop is timed against the
        # next image Claude Code starts sending.
        header = find(step["view"])
        hit = helper("/locate", {"text": step["hover_hops"]})
        result[name + "_locate"] = hit
        hops = []
        if header and hit.get("ok"):
            for k in range(step.get("count", 6)):
                dx, dy = step.get("offsets", [[0, 0], [11, 0]])[k % len(step.get("offsets", [[0, 0], [11, 0]]))]
                col, row = header[0] + hit["cellX"] + dx, header[1] + 1 + hit["cellY"] + dy
                at = time.time()
                sent_before = image_sends
                for j in range(4):
                    x = col * CELL_PX[0] + CELL_PX[0] // 2 + 1 + j - 3 if pixel_mouse else col + 1
                    y = row * CELL_PX[1] + CELL_PX[1] // 2 + 1 if pixel_mouse else row + 1
                    os.write(fd, f"\x1b[<35;{x};{y}M".encode())
                    pump(0.013)
                record("hop", col, row)
                while image_sends == sent_before and time.time() - at < 4:
                    pump(0.005)
                hops.append(round(time.time() - at, 3) if image_sends > sent_before else None)
                pump(step.get("gap", 1.5))
        result[name + "_hops"] = hops
    if "hover_sweep" in step:
        # A hand moving the pointer steadily across cells, reported at kitty's
        # rate (about 45 a second, in pixels), then still: "sweep" and "stop"
        # are recorded, for the images after them to be timed.
        header = find(step["view"])
        hit = helper("/locate", {"text": step["hover_sweep"]})
        result[name + "_locate"] = hit
        if header and hit.get("ok") and pixel_mouse:
            for k in range(step.get("count", 3)):
                (fx, fy), (tx, ty) = step.get("path", [[0, 0], [22, 0]])
                if k % 2:
                    (fx, fy), (tx, ty) = (tx, ty), (fx, fy)
                x0 = (header[0] + hit["cellX"] + fx) * CELL_PX[0] + CELL_PX[0] // 2
                y0 = (header[1] + 1 + hit["cellY"] + fy) * CELL_PX[1] + CELL_PX[1] // 2
                x1 = (header[0] + hit["cellX"] + tx) * CELL_PX[0] + CELL_PX[0] // 2
                y1 = (header[1] + 1 + hit["cellY"] + ty) * CELL_PX[1] + CELL_PX[1] // 2
                n = int(step.get("seconds", 1.5) * step.get("hz", 45))
                record("sweep", k, time.time())
                for j in range(n + 1):
                    x, y = round(x0 + (x1 - x0) * j / n), round(y0 + (y1 - y0) * j / n)
                    os.write(fd, f"\x1b[<35;{x};{y}M".encode())
                    pump(1 / step.get("hz", 45))
                record("stop", k, time.time())
                pump(step.get("gap", 3.0))
    if "drag_view" in step:
        # A drag with the button held, as a person orbiting a 3D scene does:
        # press inside the view, move "cells" columns over "seconds" at "hz"
        # moves a second (whole cells, or pixels with pixel mouse), release.
        header = find(step["drag_view"])
        if header:
            col0, row0 = header[0] + step.get("dx", 30), header[1] + step.get("dy", 8)
            span, n = step.get("cells", 30), int(step.get("seconds", 3) * step.get("hz", 18))

            def at(col, row):
                if pixel_mouse:
                    return round(col * CELL_PX[0] + CELL_PX[0] // 2 + 1), round(row * CELL_PX[1] + CELL_PX[1] // 2 + 1)
                return round(col) + 1, round(row) + 1

            x, y = at(col0, row0)
            record("drag", "down", time.time())
            os.write(fd, f"\x1b[<0;{x};{y}M".encode())
            pump(1 / step.get("hz", 18))
            for j in range(1, n + 1):
                x, y = at(col0 + span * j / n, row0)
                os.write(fd, f"\x1b[<32;{x};{y}M".encode())
                pump(1 / step.get("hz", 18))
            os.write(fd, f"\x1b[<0;{x};{y}m".encode())
            record("drag", "up", time.time())
    if "click_view" in step:
        header = find(step["click_view"])
        if header:
            click(header[0] + step.get("dx", 10), header[1] + step.get("dy", 5))
            pump(0.4)
    if "paste_text" in step:
        # Pasted while the view has the keyboard (bracketed, as a terminal does).
        record("paste", step["paste_text"])
        paste_text(step["paste_text"])
        pump(0.5)
    if "wait" in step:
        # Text to wait for before the step's keys (a question that comes on its own).
        result[name + "_wait"] = wait_for(step["wait"], step.get("timeout", 60))
    for key in step.get("keys", []):
        record("key", key)
        os.write(fd, KEYS.get(key) or key.encode())  # a name above, or a character as typed
        pump(step.get("key_pause", 0.5))
    pump(step.get("hold", 1.0))
    with open(f"{S}/{CFG.get('cast', 'demo.cast')[:-5]}-{name}.txt", "w") as f:
        f.write(text())

result["pixel_mouse"] = pixel_mouse
print(result)
record("end")
os.write(fd, b"\x03")
pump(0.4)
os.write(fd, b"\x03")
pump(0.6)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
