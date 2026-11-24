"""Pictures Claude Code wrote to the terminal, from a cast made by session.py.

    python3 bursts.py <file.cast>

Groups iTerm2 inline images (OSC 1337 File=) into bursts (images less than
0.15 s apart) and prints, per burst: when it started, how many images, their
total size, how long Claude Code took to write them, their pixel widths and
PNG colour types (3 = 256-colour palette, 6 = full colour). For kitty and
Ghostty casts it counts graphics commands (APC _G) instead, which are short
when the terminal reads pictures from files.
"""

import base64
import bisect
import json
import re
import struct
import sys

events = [json.loads(line) for line in open(sys.argv[1]) if line.startswith("[")]
out = bytearray()
marks = []
for event in events:
    if event[1] == "o":
        marks.append((len(out), event[0]))
        out += base64.b64decode(event[2])
offsets = [m[0] for m in marks]
data = bytes(out)


def time_at(index):
    return marks[bisect.bisect_right(offsets, index) - 1][1]


sends = []
for m in re.finditer(rb"\x1b\]1337;File=([^:]*):(.*?)(?:\x07|\x1b\\)", data, re.S):
    args = dict(kv.split("=", 1) for kv in m.group(1).decode().split(";") if "=" in kv)
    png = base64.b64decode(m.group(2))
    width = struct.unpack(">I", png[16:20])[0] if png[:4] == b"\x89PNG" else 0
    colour = png[25] if png[:4] == b"\x89PNG" else -1
    sends.append((time_at(m.start()), int(args.get("size", len(png))), width, colour))

if sends:
    bursts = []
    for send in sends:
        if bursts and send[0] - bursts[-1][-1][0] < 0.15:
            bursts[-1].append(send)
        else:
            bursts.append([send])
    for b in bursts:
        print(
            "burst at %.2fs: %d images, %d KB, over %.2fs, widths %s, colour types %s"
            % (b[0][0], len(b), sum(s[1] for s in b) // 1024, b[-1][0] - b[0][0],
               sorted({s[2] for s in b}), sorted({s[3] for s in b}))
        )
else:
    kitty = [(time_at(m.start()), len(m.group(0))) for m in re.finditer(rb"\x1b_G.*?\x1b\\", data, re.S)]
    print("no inline images; kitty graphics commands: %d, %d KB in all" % (len(kitty), sum(n for _, n in kitty) // 1024))
