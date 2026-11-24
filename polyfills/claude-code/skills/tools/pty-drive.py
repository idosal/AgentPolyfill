"""Drive an interactive `claude` session in a pseudo-terminal from a JSON
scenario and save screen snapshots.

    python3 pty-drive.py <scenario.json> <out-dir>

Scenario:
  {
    "cmd": ["claude", "--mcp-config", "..."],   # argv; relative paths stay as given
    "cwd": "/tmp/x",                              # optional working folder
    "env": {"K": "V"},                            # added to the environment
    "cols": 140, "rows": 48,
    "steps": [
      {"wait": "regex", "timeout": 60},          # wait until the screen matches
      {"type": "text"},                           # type characters (one write)
      {"keys": "text", "delay": 0.05},           # type characters one at a time
      {"key": "enter"|"esc"|"tab"|"up"|"down"|"ctrl-c"|"ctrl-d"},
      {"sleep": 2},
      {"snap": "name"},                           # save screen to <out>/<name>.txt
      {"expect_absent": "regex"},                 # fail if the screen matches
      {"run": "shell command"},                   # run a command on this machine (e.g. emit an event)
      {"when": "regex", "steps": [...]}           # run these steps next, only if the screen matches now
    ]
  }

Writes <out>/transcript.txt (every snapshot plus the final screen) and exits
non-zero if a wait times out. Needs pyte (`pip install pyte` in a venv).
CLAUDE*/CLAUDECODE variables are removed so a nested run behaves like a
fresh terminal session.
"""

import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import fcntl
import subprocess
import time

import pyte

KEYS = {
    "enter": b"\r",
    "esc": b"\x1b",
    "tab": b"\t",
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "right": b"\x1b[C",
    "left": b"\x1b[D",
    "ctrl-c": b"\x03",
    "ctrl-d": b"\x04",
    "backspace": b"\x7f",
    "space": b" ",
}


def main():
    scenario = json.load(open(sys.argv[1]))
    out = os.path.abspath(sys.argv[2])
    os.makedirs(out, exist_ok=True)
    cols, rows = scenario.get("cols", 140), scenario.get("rows", 48)
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "CLAUDECODE"))}
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
    env.update(scenario.get("env", {}))

    pid, fd = pty.fork()
    if pid == 0:
        if scenario.get("cwd"):
            os.chdir(scenario["cwd"])
        os.execvpe(scenario["cmd"][0], scenario["cmd"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    transcript = open(os.path.join(out, "transcript.txt"), "w")
    raw = open(os.path.join(out, "raw.bin"), "wb")
    # The same output with its timing, for replaying the session as it happened:
    # a header line, then [seconds, "o", base64 bytes] and [seconds, "i", text typed].
    import base64
    cast = open(os.path.join(out, "cast.jsonl"), "w")
    t0 = time.time()
    cast.write(json.dumps({"cols": cols, "rows": rows, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "epoch": t0, "cmd": scenario["cmd"]}) + "\n")

    def record(kind, payload):
        cast.write(json.dumps([round(time.time() - t0, 3), kind, payload]) + "\n")
        cast.flush()

    def pump(seconds):
        end = time.time() + seconds
        while True:
            left = end - time.time()
            if left <= 0:
                return
            r, _, _ = select.select([fd], [], [], min(left, 0.05))
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                raw.write(data)
                record("o", base64.b64encode(data).decode())
                # Answer cursor-position / device-attribute queries so the TUI starts.
                if b"\x1b[6n" in data:
                    os.write(fd, f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R".encode())
                if b"\x1b[c" in data or b"\x1b[0c" in data:
                    os.write(fd, b"\x1b[?62;22c")
                stream.feed(data)

    def text():
        return "\n".join(line.rstrip() for line in screen.display)

    def snap(name):
        record("snap", name)
        t = text()
        open(os.path.join(out, f"{name}.txt"), "w").write(t + "\n")
        transcript.write(f"===== {name} @ {time.strftime('%H:%M:%S')}\n{t}\n")
        transcript.flush()

    failed = None

    def write(b):
        try:
            os.write(fd, b)
            return True
        except OSError:
            return False

    # Steps run in order; a {"when": regex, "steps": [...]} step runs its own steps next, but
    # only if the screen matches at that moment (e.g. a question that is asked only once).
    queue = list(scenario["steps"])
    i = -1
    while queue:
        step = queue.pop(0)
        i += 1
        if "when" in step:
            if re.search(step["when"], text(), re.S):
                queue[0:0] = step["steps"]
            continue
        if "wait" in step:
            pat = re.compile(step["wait"], re.S)
            deadline = time.time() + step.get("timeout", 60)
            while time.time() < deadline and not pat.search(text()):
                pump(0.2)
            if not pat.search(text()):
                failed = f"step {i}: timed out waiting for {step['wait']!r}"
                snap(f"timeout-step{i}")
                if not step.get("optional"):
                    break
                failed = None
        elif "type" in step:
            if not write(step["type"].encode()):
                failed = f"step {i}: process gone"
                break
            pump(step.get("after", 0.3))
        elif "keys" in step:
            for ch in step["keys"]:
                if not write(ch.encode()):
                    break
                pump(step.get("delay", 0.05))
        elif "key" in step:
            if not write(KEYS[step["key"]]):
                failed = f"step {i}: process gone"
                break
            pump(step.get("after", 0.3))
        elif "sleep" in step:
            pump(step["sleep"])
        elif "snap" in step:
            pump(0.3)
            snap(step["snap"])
        elif "run" in step:
            record("run", step.get("label", step["run"]))
            r = subprocess.run(step["run"], shell=True, capture_output=True, text=True)
            transcript.write(f"===== run @ {time.strftime('%H:%M:%S')}: {step['run']}\n{r.stdout}{r.stderr}\n")
            transcript.flush()
            pump(step.get("after", 0.3))
        elif "expect_absent" in step:
            if re.search(step["expect_absent"], text(), re.S):
                failed = f"step {i}: screen unexpectedly matched {step['expect_absent']!r}"
                snap(f"unexpected-step{i}")
                break

    snap("final")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    pump(1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if failed:
        print(failed, file=sys.stderr)
        sys.exit(1)
    print(f"ok: {out}")


if __name__ == "__main__":
    main()
