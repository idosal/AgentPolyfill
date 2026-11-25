"""Drive a real Hermes over its stdio gateway (tui_gateway/entry.py): JSON-RPC requests both ways."""
import itertools
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path


# What a Hermes under test may inherit from the environment it is started from: the system's basics,
# nothing else. Its HOME and HERMES_HOME are its own; no token, key or sign-in of the person running
# the tests reaches it, whatever their shell holds.
PASSED = ("PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TZ")


def clean_env(home: Path, extra: dict | None = None) -> dict:
    e = {k: os.environ[k] for k in PASSED if k in os.environ}
    e.update({"HOME": str(home / "home"), "HERMES_HOME": str(home / "hermes"), "PYTHONUNBUFFERED": "1"})
    e.update(extra or {})
    return e


class Gateway:
    def __init__(self, python: str, hermes_src: str, home: Path, env: dict | None = None,
                 answer=None, log_path: Path | None = None, cwd: Path | None = None):
        self.home = home
        e = clean_env(home, env)
        self.answer = answer or (lambda method, params: {"choice": "deny"})
        self.events: list[dict] = []
        self.requests: list[dict] = []
        self._pending: dict = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self.log = open(log_path or (home / "gateway-stderr.log"), "ab")
        # The gateway's folder is every session's working folder: a throwaway one, not Hermes's source.
        work = cwd or (home / "work")
        work.mkdir(parents=True, exist_ok=True)
        e["PYTHONPATH"] = os.pathsep.join(p for p in (e.get("PYTHONPATH"), hermes_src) if p)
        self.proc = subprocess.Popen([python, "-m", "tui_gateway.entry"], cwd=work, env=e,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        threading.Thread(target=self._read, daemon=True).start()

    def _write(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode())
        self.proc.stdin.flush()

    def _read(self):
        for raw in self.proc.stdout:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if "method" in m and "id" in m:  # server -> client request
                with self._cv:
                    self.requests.append(m)
                    self._cv.notify_all()
                try:
                    result = self.answer(m["method"], m.get("params") or {})
                    self._write({"jsonrpc": "2.0", "id": m["id"], "result": result})
                except Exception as exc:  # noqa: BLE001
                    self._write({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": str(exc)}})
                continue
            with self._cv:
                if "id" in m and m["id"] in self._pending:
                    self._pending[m["id"]] = m
                elif m.get("method") == "event":
                    self.events.append(m.get("params") or {})
                self._cv.notify_all()

    def request(self, method: str, params: dict | None = None, timeout: float = 60):
        rid = next(self._ids)
        with self._cv:
            self._pending[rid] = None
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        with self._cv:
            while self._pending[rid] is None:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(method)
                self._cv.wait(left)
            m = self._pending.pop(rid)
        if "error" in m:
            raise RuntimeError(f"{method}: {m['error']}")
        return m.get("result")

    def wait_event(self, pred, timeout: float = 60, start: int = 0):
        deadline = time.time() + timeout
        with self._cv:
            while True:
                for i, ev in enumerate(self.events[start:], start):
                    if pred(ev):
                        return i, ev
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError("event")
                self._cv.wait(left)

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(5)
        for f in (self.proc.stdout, self.log):
            try:
                f.close()
            except Exception:
                pass
