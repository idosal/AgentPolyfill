"""Run the checked-in fixture through an isolated stock Pi TUI. Requires POSIX and Python 3."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

here = Path(__file__).resolve().parent
node, cli = sys.argv[1], str(Path(sys.argv[2]).resolve())
with tempfile.TemporaryDirectory(prefix="pi-app-session-") as directory:
    home = Path(directory)
    profile = home / "agent"
    profile.mkdir()
    calls, observations = home / "calls", home / "model"
    server = {"command": node, "args": [str(here / "session-server.mjs"), str(calls)], "exposure": "direct"}
    cancelled = "--cancel" in sys.argv[3:]
    live = "--live" in sys.argv[3:] or cancelled
    if live:
        server["args"].append("cancel" if cancelled else "live")
    http = None
    if "--oauth" in sys.argv:
        http = subprocess.Popen([node,str(here / "http-session.mjs"),str(calls)],stdout=subprocess.PIPE,text=True)
        url = http.stdout.readline().strip()
        assert url.startswith("http://127.0.0.1:")
        server = {"type":"http","url":url,"exposure":"direct","oauth":{"clientId":"fixture-app"}}
        state = {"serverUrl":url,"clientInformation":{"client_id":"fixture-app"},
                 "tokens":{"access_token":"fixture-initial","refresh_token":"fixture-refresh","token_type":"Bearer"}}
        (profile / "mcp-auth.json").write_text(json.dumps({url:state}))
    (profile / "mcp.json").write_text(json.dumps({"mcpServers": {"fixture": server}}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 104, 0, 0))
    def terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    env = {"PATH": os.environ["PATH"], "HOME": directory, "TERM": "xterm-256color",
           "PI_IMAGE_PROTOCOL":"none", "PI_CODING_AGENT_DIR": str(profile), "PI_APPS_OBSERVATIONS": str(observations)}
    if os.environ.get("MCP_APPS_CLI_CHROME"):
        env["MCP_APPS_CLI_CHROME"] = os.environ["MCP_APPS_CLI_CHROME"]
    proc = subprocess.Popen([node, cli, "--offline", "--no-session", "--provider", "session-test",
        "--model", "offline", "-e", str(here / "session-provider.ts"), "-e", str(here.parent / "index.ts")],
        cwd=directory, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
    os.close(slave)
    buffer = bytearray()
    ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
    def see(text):
        buffer.clear()
        end = time.monotonic() + 25
        while time.monotonic() < end and proc.poll() is None:
            if not select.select([master], [], [], .15)[0]:
                continue
            data = os.read(master, 65536)
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in data:
                os.write(master, b"\x1b[?1;2c")
            buffer.extend(data)
            if text.encode() in ansi.sub(b"", buffer):
                print("Pi displayed " + text, flush=True)
                return
        raise AssertionError("Pi did not show " + text + "\n" + ansi.sub(b"",buffer)[-1200:].decode(errors="replace"))
    def key(value):
        time.sleep(.15)
        os.write(master, value)
    try:
        see("Pi can explain")
        key(b"Open the fixture\r")
        see('fixture/start' if live else "Public receipt ready")
        time.sleep(.6)
        key(b"/mcp-app\r")
        for prompt in ["Inspect MCP App", "External destinations"]:
            see(prompt)
            key(b"\r")
        if cancelled:
            see("Active call cancelled")
            key(b"\x1b")
            assert [json.loads(line).get("tool") for line in calls.read_text().splitlines()].count("start") == 1
            sys.exit(0)
        see("Private result received")
        key(b"\x0c")
        see("Private diagnostic from the view")
        key(b"\x1b")
        key(b"\x07")
        see("Run a tool provided by this app")
        key(b"\r")
        see("Arguments for echo")
        key(b"{}")
        key(b"\r")
        see("View tool completed")
        key(b"\t")
        key(b"\r")
        see("Copy app text to your clipboard?")
        key(b"\x1b")
        see("Call this MCP tool")
        key(b"\r")
        see("Open link in your browser?")
        key(b"\x1b")
        for prompt in ["Save to your Downloads folder?", "Previous selection", "Latest selection"]:
            see(prompt)
            key(b"\r")
        see("Y to include this image")
        key(b"y")
        see("Send this message")
        key(b"\r")
        see("Session checks passed")
        key(b"\x1b")
        time.sleep(.8)
        assert (home / "Downloads" / "session-note.txt").read_text() == "Verified Pi download"
        wire = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len({m["pid"] for m in wire if "pid" in m}) == 1
        if http is not None:
            assert sum(bool(m.get("refresh")) for m in wire) == 1
        assert any(m.get("negotiated") is True for m in wire)
        assert [m["tool"] for m in wire if "tool" in m] == ["start","view_action"]
        model = [json.loads(line) for line in observations.read_text().splitlines()]
        assert all(not m["private"] and not m["previous"] for m in model)
        assert model[-1]["message"] and model[-1]["latest"] and model[-1]["public"] and model[-1]["image"]
    finally:
        if http is not None:
            http.terminate()
            http.wait(timeout=4)
        os.close(master)
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
