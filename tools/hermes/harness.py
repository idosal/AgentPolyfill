"""A real Hermes for the Hermes forms' end-to-end tests: pinned, isolated, and with a scripted model.

- Hermes itself comes from a source checkout of its release tag, set up by ``setup.sh`` (never the
  curl installer) into ``.hermes-test/`` here: ``HERMES_PYTHON`` and ``HERMES_SRC`` point at it.
- Every run gets its own ``HOME`` and ``HERMES_HOME`` in a temporary folder, never the user's.
- The model is ``fake_model.py``: an OpenAI-compatible endpoint on loopback answering by rules
  the test sets, so no API key is used and every turn is deterministic.
- Hermes is driven over its stdio gateway (``tui_gateway.entry``), the JSON-RPC its TUI speaks.
- By default Hermes may reach loopback only (``offline/sitecustomize.py``): it checks for releases
  in the background, and a test should not depend on the network. The interop runs opt out.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fake_model  # noqa: E402
from gateway import Gateway  # noqa: E402

PINNED_TAG = "v0.23.4"
PINNED_COMMIT = "8fc0374447313e276f6b9a2764bfc750190c966a"


def hermes_paths() -> tuple[str, str]:
    """``(python, source)`` of the pinned Hermes, from the environment or ``.hermes-test/``."""
    py = os.environ.get("HERMES_PYTHON") or str(HERE / ".hermes-test" / "venv" / "bin" / "python")
    src = os.environ.get("HERMES_SRC") or str(HERE / ".hermes-test" / "src")
    if not Path(py).exists() or not (Path(src) / "tui_gateway").is_dir():
        raise RuntimeError("No pinned Hermes: run tools/hermes/setup.sh, or set HERMES_PYTHON and HERMES_SRC")
    return py, src


def yaml_dump(obj, indent: int = 0) -> str:
    """Enough YAML for a config.yaml (JSON scalars are valid YAML)."""
    pad = "  " * indent
    if isinstance(obj, dict):
        lines = []
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.append(yaml_dump(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {json.dumps(v)}")
        return "\n".join(lines)
    if isinstance(obj, list):
        lines = []
        for v in obj:
            if isinstance(v, dict) and v:
                inner = yaml_dump(v, indent + 1).lstrip()
                lines.append(f"{pad}- {inner}")
            else:
                lines.append(f"{pad}- {json.dumps(v)}")
        return "\n".join(lines)
    return pad + json.dumps(obj)


class World:
    """An isolated Hermes home with plugins installed, the scripted model, and a gateway when started."""

    def __init__(self, plugins: dict[str, Path], *, mcp_servers: Optional[dict] = None,
                 entries: Optional[dict] = None, extra_config: Optional[dict] = None,
                 tool_search: str = "off", model: Optional[dict] = None):
        self.dir = Path(tempfile.mkdtemp(prefix="agentpolyfill-hermes-"))
        (self.dir / "home").mkdir()
        self.hermes_home = self.dir / "hermes"
        (self.hermes_home / "plugins").mkdir(parents=True)
        for name, src in plugins.items():
            shutil.copytree(src, self.hermes_home / "plugins" / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.model = fake_model.serve()
        fake_model.RULES.clear()
        fake_model.REQUESTS.clear()
        port = self.model.server_address[1]
        config = {
            # The scripted stub, unless the test passes a model of its own.
            "model": model or {"default": "scripted", "provider": "custom", "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "none"},
            "tools": {"tool_search": {"enabled": tool_search}},
            "plugins": {"enabled": list(plugins), "entries": entries or {}},
        }
        if mcp_servers:
            config["mcp_servers"] = mcp_servers
        for k, v in (extra_config or {}).items():
            config[k] = v
        self.write_config(config)
        self.gw: Optional[Gateway] = None
        self.answers: list[tuple[str, dict]] = []
        self.approve: Callable[[str, dict], str] = lambda method, params: "once"

    def write_config(self, config: dict) -> None:
        self.config = config
        (self.hermes_home / "config.yaml").write_text(yaml_dump(config) + "\n")

    def rules(self, *rules: dict) -> None:
        fake_model.RULES.extend(rules)

    def _answer(self, method: str, params: dict):
        self.answers.append((method, params))
        if method == "approval":
            return {"choice": self.approve(method, params)}
        if method == "clarify":
            return {}
        raise Exception(f"{method} is not answered by the test host")

    def start(self, env: Optional[dict] = None, *, offline: bool = True) -> Gateway:
        py, src = hermes_paths()
        env = dict(env or {})
        if offline:
            env.update(PYTHONPATH=str(HERE / "offline"), AGENTPOLYFILL_OFFLINE="1")
        self.gw = Gateway(py, src, self.dir, env=env, answer=self._answer, log_path=self.dir / "gateway-stderr.log")
        self.gw.wait_event(lambda e: e.get("type") == "gateway.ready", 120)
        self.gw.request("client.capabilities", {"server_requests": True})
        return self.gw

    def session(self) -> str:
        assert self.gw is not None
        return self.gw.request("session.create", {}, timeout=180)["session_id"]

    def turn(self, sid: str, text: str, timeout: float = 180) -> dict:
        """Sends ``text`` and waits for the turn's final message."""
        assert self.gw is not None
        n = len(self.gw.events)
        self.gw.request("prompt.submit", {"session_id": sid, "text": text}, timeout=timeout)
        return self.gw.wait_event(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid,
                                  timeout, start=n)[1]

    def wait_turn(self, sid: str, start: int, timeout: float = 60) -> dict:
        """Waits for a turn nobody here started (an injected one) to finish."""
        assert self.gw is not None
        return self.gw.wait_event(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid,
                                  timeout, start=start)[1]

    def oneshot(self, text: str, env: Optional[dict] = None, *, offline: bool = True, timeout: float = 180):
        """Runs ``hermes -z <text>`` in this home: one unattended turn, Hermes's own one-shot command,
        with the same environment as the gateway's (``clean_env``) and the same network fence."""
        import subprocess
        from gateway import clean_env
        py, src = hermes_paths()
        e = clean_env(self.dir, env)
        if offline:
            e.update(PYTHONPATH=str(HERE / "offline"), AGENTPOLYFILL_OFFLINE="1")
        e["PYTHONPATH"] = os.pathsep.join(p for p in (e.get("PYTHONPATH"), src) if p)
        work = self.dir / "work"
        work.mkdir(parents=True, exist_ok=True)
        with open(self.dir / "oneshot-stderr.log", "ab") as log:
            return subprocess.run([py, "-c", "import sys; from hermes_cli.main import main; sys.argv = ['hermes', '-z', sys.argv[1]]; sys.exit(main())", text],
                                  cwd=work, env=e, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log,
                                  timeout=timeout, check=False)

    def requests(self) -> list[dict]:
        return list(fake_model.REQUESTS)

    def tool_results(self, name_hint: str = "") -> list[str]:
        """Every tool result the model was shown, in order."""
        out = []
        for rq in fake_model.REQUESTS:
            for m in rq["messages"]:
                if m.get("role") == "tool":
                    out.append(fake_model._content_text(m.get("content")))
        seen, uniq = set(), []
        for t in out:
            if t not in seen:
                seen.add(t)
                uniq.append(t)
        return [t for t in uniq if name_hint in t]

    def tool_texts(self, hint: str = "") -> list[str]:
        """The tool results as text: a plugin's ``{"result": ...}`` / ``{"error": ...}`` unwrapped."""
        out = []
        for raw in self.tool_results():
            try:
                j = json.loads(raw)
                text = j.get("result", j.get("error", raw)) if isinstance(j, dict) else raw
            except ValueError:
                text = raw
            text = text if isinstance(text, str) else json.dumps(text)
            if hint in text:
                out.append(text)
        return out

    def user_messages(self) -> list[str]:
        seen, out = set(), []
        for rq in fake_model.REQUESTS:
            for m in rq["messages"]:
                if m.get("role") == "user":
                    t = fake_model._content_text(m.get("content"))
                    if t not in seen:
                        seen.add(t)
                        out.append(t)
        return out

    def stop(self) -> None:
        if self.gw is not None:
            self.gw.close()
            self.gw = None

    def close(self, keep: bool = False) -> None:
        self.stop()
        self.model.shutdown()
        self.model.server_close()
        if not keep and not os.environ.get("AGENTPOLYFILL_KEEP"):
            shutil.rmtree(self.dir, ignore_errors=True)


def wait_for(fn: Callable, timeout: float = 30, what: str = "condition", every: float = 0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise TimeoutError(f"timed out waiting for {what}")
