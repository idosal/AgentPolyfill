"""Makes a recorded run fit to share: python3 scrub-run.py <run-dir> <repo-root>

The screen pictures (*.txt) and the scenario of a run are kept in the repository; the raw
recording is not. This takes out of them what is the recorder's own and no part of the
demonstration: the plan named beside the model in Claude Code's banner, any line about
their usage, and the absolute paths of their machine.
"""

import json
import os
import re
import sys

run, root = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
home = os.path.expanduser("~")
# Claude Code's banner shows the folder it runs in with the home folder as "~".
root_short = "~" + root[len(home):] if root.startswith(home + os.sep) else root
for name in sorted(os.listdir(run)):
    path = os.path.join(run, name)
    if name.endswith(".txt"):
        text = open(path, encoding="utf-8").read()
        text = re.sub(r"(?m)^(.*▝▜█+▀ .*?) · Claude \w+\s*$", r"\1", text)
        text = re.sub(r"(?m)^.*You've used \d+% of your .*$\n?", "", text)
        text = text.replace(root, "<repo>").replace(root_short, "<repo>").replace(home, "~")
        open(path, "w", encoding="utf-8").write(text)
    elif name == "scenario.json":
        text = open(path, encoding="utf-8").read().replace(root, "<repo>").replace(home, "~")
        json.loads(text)
        open(path, "w", encoding="utf-8").write(text)
