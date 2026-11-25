"""Drive a real Hermes over its shared gateway, the one ``hermes``, ``hermes --tui`` and Desktop attach to.

``hermes gateway attach --json --start`` (with the World's own HOME and HERMES_HOME) starts the
profile's gateway and mints a ticket; this dials the WebSocket it names and speaks the same
JSON-RPC as ``gateway.Gateway`` (requests both ways). Used by the Events form's test/e2e_shared_gateway.py; the other e2e tests use
the stdio gateway, which needs no daemon.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import subprocess
import threading
import time
from pathlib import Path


class SharedGateway:
    def __init__(self, python: str, hermes_src: str, home: Path, answer, env: dict | None = None):
        from gateway import clean_env
        self.env = clean_env(home, env)
        self.python, self.src = python, hermes_src
        self.answer = answer
        self.events: list[dict] = []
        self._pending: dict = {}
        self._ids = itertools.count(1)
        self._cv = threading.Condition()
        out = subprocess.run([python, "-m", "hermes_cli.main", "gateway", "attach", "--json", "--start", "--timeout", "90"],
                             cwd=hermes_src, env=self.env, capture_output=True, text=True, timeout=150)
        if out.returncode != 0:
            raise RuntimeError(f"gateway attach failed: {out.stdout[-800:]} {out.stderr[-800:]}")
        self.attach = json.loads(out.stdout.strip().splitlines()[-1])
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()
        if not self._ready.wait(30):
            raise RuntimeError("could not dial the gateway")

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._main())

    async def _main(self):
        import websockets
        async with websockets.connect(self.attach["url"], subprotocols=self.attach["protocols"], origin=None,
                                      max_size=8 * 1024 * 1024) as ws:
            self.ws = ws
            self._ready.set()
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if "method" in m and "id" in m:
                    try:
                        reply = {"jsonrpc": "2.0", "id": m["id"], "result": self.answer(m["method"], m.get("params") or {})}
                    except Exception as exc:  # noqa: BLE001
                        reply = {"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": str(exc)}}
                    await ws.send(json.dumps(reply))
                    continue
                if os.environ.get("AGENTPOLYFILL_GW_DEBUG"):
                    print("<<", json.dumps(m)[:300], flush=True)
                params = m.get("params") or {}
                if m.get("method") == "event" and params.get("type") == "approval.request":
                    # The shared gateway puts an approval to its viewers as an event, answered with approval.respond.
                    payload = params.get("payload") or {}
                    choice = self.answer("approval", payload)["choice"]
                    asyncio.ensure_future(ws.send(json.dumps({"jsonrpc": "2.0", "id": f"ap-{next(self._ids)}", "method": "approval.respond", "params": {
                        "session_id": params.get("session_id"), "execution_generation": params.get("execution_generation"),
                        "prompt_id": payload.get("prompt_id") or payload.get("request_id"), "choice": choice}})))
                with self._cv:
                    if "id" in m and m["id"] in self._pending:
                        self._pending[m["id"]] = m
                    elif m.get("method") == "event":
                        self.events.append(params)
                    self._cv.notify_all()

    def request(self, method: str, params: dict | None = None, timeout: float = 60):
        rid = next(self._ids)
        with self._cv:
            self._pending[rid] = None
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})), self.loop)
        end = time.time() + timeout
        with self._cv:
            while self._pending[rid] is None:
                if time.time() > end:
                    raise TimeoutError(method)
                self._cv.wait(end - time.time())
            m = self._pending.pop(rid)
        if "error" in m:
            raise RuntimeError(f"{method}: {m['error']}")
        return m.get("result")

    def wait_event(self, pred, timeout: float = 60, start: int = 0):
        end = time.time() + timeout
        with self._cv:
            while True:
                for i, ev in enumerate(self.events[start:], start):
                    if pred(ev):
                        return i, ev
                if time.time() > end:
                    raise TimeoutError("event")
                self._cv.wait(end - time.time())

    def close(self):
        try:
            asyncio.run_coroutine_threadsafe(self.ws.close(), self.loop).result(5)
        except Exception:  # noqa: BLE001
            pass
        subprocess.run([self.python, "-m", "hermes_cli.main", "gateway", "stop"], cwd=self.src, env=self.env,
                       capture_output=True, text=True, timeout=60)
        # An unmanaged gateway may outlive `gateway stop`: end every process that runs with this World's own home.
        mine = f"HERMES_HOME={self.env['HERMES_HOME']}"
        for _ in range(20):
            out = subprocess.run(["ps", "eww", "-ax", "-o", "pid=,command="], capture_output=True, text=True).stdout
            pids = [int(line.split(None, 1)[0]) for line in out.splitlines() if mine + " " in line + " " and line.split(None, 1)[0].isdigit()]
            pids = [p for p in pids if p != os.getpid()]
            if not pids:
                return
            for pid in pids:
                try:
                    os.kill(pid, 15 if _ < 10 else 9)
                except OSError:
                    pass
            time.sleep(1)
