"""The plugin's Node helper: started once in the Hermes gateway, spoken to over its stdin/stdout.

Shared by the Hermes forms of the polyfills (copied into each plugin folder by its build; the
copies are checked to be identical). The line is newline-delimited JSON-RPC 2.0, requests both
ways: the plugin asks the helper (``initialize``, ``call`` …) and the helper may ask the plugin
(``wake`` …), which ``on_request`` answers. Nothing here understands an extension; the helper,
built from the polyfill's shared TypeScript client, does.
"""

from __future__ import annotations

import contextvars
import itertools
import json
import queue
import logging
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("agentpolyfill")

MIN_NODE = 20
MAX_QUEUED = 64


def spawn(target: Callable, *args: Any, name: str = "agentpolyfill") -> threading.Thread:
    """A daemon thread that runs ``target`` in a copy of the caller's context.

    Hermes keeps the active profile (its home, its config, its secrets) in context variables, and a
    plain thread starts with none: it would read the gateway's main profile instead of the one the
    plugin was loaded for. Every thread a Hermes form starts goes through here."""
    ctx = contextvars.copy_context()
    t = threading.Thread(target=ctx.run, args=(target, *args), name=name, daemon=True)
    t.start()
    return t


def find_node(env: Optional[dict] = None) -> tuple[Optional[str], str]:
    """``(path, why_not)``: Node 20 or newer, from ``AGENTPOLYFILL_NODE`` or the gateway's PATH."""
    env = env if env is not None else os.environ
    candidate = env.get("AGENTPOLYFILL_NODE") or shutil.which("node", path=env.get("PATH"))
    if not candidate:
        return None, f"Node {MIN_NODE} or newer is needed on the PATH of the Hermes gateway, and none was found"
    try:
        out = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"{candidate} could not be run ({exc})"
    m = re.match(r"v(\d+)\.", out)
    if not m or int(m.group(1)) < MIN_NODE:
        return None, f"Node {MIN_NODE} or newer is needed, and {candidate} is {out or 'unknown'}"
    return candidate, ""


class HelperGone(RuntimeError):
    pass


class Helper:
    """One helper process. Thread-safe; ``request`` blocks the calling thread until the answer."""

    def __init__(self, script: Path, *, node: str, env: dict, on_request: Callable[[str, dict], Any],
                 log_path: Optional[Path] = None):
        self._ids = itertools.count(1)
        self._pending: dict[int, list] = {}
        self._lock = threading.Lock()
        self._on_request = on_request
        self.closed = False
        # Writes go through one thread: a helper that stops reading fills the pipe, and a write then
        # blocks. Callers only queue, with a deadline, so none is held past it.
        self._out: queue.Queue = queue.Queue(maxsize=MAX_QUEUED)
        stderr = open(log_path, "ab") if log_path else subprocess.DEVNULL
        self.proc = subprocess.Popen([node, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=stderr, env=env, close_fds=True)
        spawn(self._read, name="agentpolyfill-helper-read")
        spawn(self._write, name="agentpolyfill-helper-write")

    def _write(self) -> None:
        while True:
            data = self._out.get()
            if data is None or self.proc.stdin is None:
                return
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except Exception:  # noqa: BLE001 - a gone or killed helper: the line is closed
                self._gone()
                return

    def _send(self, message: dict, timeout: float = 10) -> None:
        if self.closed or self.proc.stdin is None:
            raise HelperGone("the helper has stopped")
        data = (json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode()
        try:
            self._out.put(data, timeout=max(0.01, timeout))
        except queue.Full:
            # It has stopped reading: end it, so every caller fails now rather than at its deadline.
            self.kill()
            raise HelperGone("the helper stopped reading its input and was ended")

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(m, dict):
                continue
            if isinstance(m.get("method"), str):
                # A request from the helper: answered on a thread of its own (in the plugin's
                # context), so a slow answer never holds up the replies the plugin is waiting for.
                spawn(self._answer, m, name="agentpolyfill-helper-answer")
                continue
            rid = m.get("id")
            with self._lock:
                slot = self._pending.get(rid)
            if slot is not None:
                slot[1] = m
                slot[0].set()
        self._gone()

    def _answer(self, m: dict) -> None:
        try:
            result = self._on_request(m["method"], m.get("params") if isinstance(m.get("params"), dict) else {})
            reply = {"id": m.get("id"), "result": result}
        except Exception as exc:  # noqa: BLE001
            logger.warning("agentpolyfill: answering the helper's %s failed: %s", m.get("method"), exc)
            reply = {"id": m.get("id"), "error": {"code": -32603, "message": str(exc)}}
        if m.get("id") is not None:
            try:
                self._send(reply)
            except HelperGone:
                pass

    def _gone(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            pending = list(self._pending.values())
        for slot in pending:
            slot[0].set()

    def request(self, method: str, params: dict, timeout: float = 60) -> Any:
        """Asks the helper, and waits at most ``timeout`` in all: queueing, writing and the answer."""
        import time
        deadline = time.monotonic() + timeout
        rid = next(self._ids)
        slot = [threading.Event(), None]
        with self._lock:
            if self.closed:
                raise HelperGone("the helper has stopped")
            self._pending[rid] = slot
        try:
            self._send({"id": rid, "method": method, "params": params}, timeout=deadline - time.monotonic())
            if not slot[0].wait(max(0.0, deadline - time.monotonic())):
                raise TimeoutError(f"the helper did not answer {method} within {timeout:.0f} s")
            m = slot[1]
            if m is None:
                raise HelperGone("the helper has stopped")
            if isinstance(m.get("error"), dict):
                raise RuntimeError(str(m["error"].get("message") or "error"))
            return m.get("result")
        finally:
            with self._lock:
                self._pending.pop(rid, None)

    def kill(self) -> None:
        try:
            self.proc.kill()
            self.proc.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                if pipe:
                    pipe.close()
            except (OSError, ValueError):
                pass  # unflushed bytes to a dead process: nothing to deliver
        self._gone()

    def close(self) -> None:
        try:
            self._out.put_nowait(None)
        except queue.Full:
            pass
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self._gone()


# What the helper may inherit from the gateway: the system's basics (Hermes's own baseline for stdio
# MCP servers, tools/mcp_tool_config.py _SAFE_ENV_KEYS), what Node needs to reach a server (CA
# certificates, a proxy), and the plugins' own settings. Nothing else: no provider key, token or
# credential, under whatever name.
_HELPER_ENV = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "HERMES_HOME",
    "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_ENV_PROXY",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"})
_HELPER_PREFIXES = ("MCP_EVENTS_", "MCP_SKILLS_", "AGENTPOLYFILL_", "XDG_", "LC_")


def helper_env(base: Optional[dict] = None) -> dict:
    """The environment the helper runs with: an allowlist of the gateway's (``_HELPER_ENV``).

    The helper passes a local MCP server only the MCP SDK's default environment and what the server's
    configuration gives it; it has no use for anything else of the gateway's."""
    env = base if base is not None else os.environ
    return {k: v for k, v in env.items() if k in _HELPER_ENV or k.startswith(_HELPER_PREFIXES)}