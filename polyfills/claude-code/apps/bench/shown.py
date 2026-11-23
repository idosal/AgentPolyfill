"""How much of each inline picture is still on screen, from a cast made by
session.py (iTerm2 identity).

    python3 shown.py <file.cast> [seconds]

iTerm2 draws an inline image over the cells it covers, and text or an erase
written to those cells later wipes that part of it. This replays the cast in
a screen model (pyte) with each image's cells filled with a marker, so later
writes wipe markers the same way, and prints how many marker cells are left
(before the session's exit, or at `seconds` into the cast). Needs pyte.
"""

import base64
import json
import re
import sys

import pyte

# Cursor and status reports (CSI ? n) would be answered; there is no one to answer.
_report = pyte.Screen.report_device_status
pyte.Screen.report_device_status = lambda self, mode=0, *a, **k: None if k.get("private") else _report(self, mode)
MARK = "▣"
cast = sys.argv[1]
until = float(sys.argv[2]) if len(sys.argv) > 2 else float("inf")
lines = open(cast).read().splitlines()
header = json.loads(lines[0])
screen = pyte.Screen(header["width"], header["height"])
stream = pyte.Stream(screen)
image = re.compile(rb"\x1b\]1337;File=([^:]*):.*?(?:\x07|\x1b\\)", re.S)
images = 0


def feed(data):
    global images
    pos = 0
    for m in image.finditer(data):
        stream.feed(data[pos:m.start()].decode("utf-8", "replace"))
        args = dict(kv.split("=", 1) for kv in m.group(1).decode().split(";") if "=" in kv)
        w, h = int(args.get("width", "0")), int(args.get("height", "0"))
        # The image covers w x h cells from the cursor, which it doesn't move.
        y, x = screen.cursor.y, screen.cursor.x
        for row in range(y, min(y + h, screen.lines)):
            for col in range(x, min(x + w, screen.columns)):
                screen.buffer[row][col] = screen.default_char._replace(data=MARK)
        images += 1
        pos = m.end()
    stream.feed(data[pos:].decode("utf-8", "replace"))


# A session made by session.py ends with Ctrl-C, and Claude Code redraws the
# screen as it exits: read it as it was before that, unless told a time.
if until == float("inf"):
    for line in lines[1:]:
        event = json.loads(line)
        if event[1] == "o" and b"Press Ctrl-C again" in base64.b64decode(event[2]):
            until = event[0] - 0.05
            break

carry = b""
for line in lines[1:]:
    event = json.loads(line)
    if event[0] > until:
        break
    if event[1] == "o":
        data = carry + base64.b64decode(event[2])
        # An image escape split across two writes waits for its end.
        start = data.rfind(b"\x1b]1337;File=")
        if start >= 0 and not image.match(data, start):
            data, carry = data[:start], data[start:]
        else:
            carry = b""
        feed(data)

shown = sum(1 for row in range(screen.lines) for col in range(screen.columns) if screen.buffer[row][col].data == MARK)
print(f"{images} images written; picture cells still on screen: {shown}")
