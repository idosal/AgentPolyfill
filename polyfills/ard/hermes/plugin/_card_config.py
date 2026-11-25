"""Raw, reference-preserving MCP config writes using Hermes's public config API.

Only ``hermes_cli.config`` (on Hermes's published plugin API): ``get_config_path``,
``require_readable_config_before_write`` and ``save_config``, which takes Hermes's own config
lock for each write. An addition is saved as that one entry with ``merge_existing=True``, so
Hermes merges it into the file as it is at that moment; a removal is a read, a change and a
save, as ``hermes mcp remove`` does it. No credential store or .env is opened by this module.
"""
from __future__ import annotations
import hashlib
import json
import os
import threading
from pathlib import Path

_SHARED = "agentpolyfill_hermes_config_lock"


def config_lock():
    """One lock for every copy of this module in the gateway (the Server Cards and the ARD forms
    each ship one), so their check-then-write steps don't interleave. Hermes's own writes take
    Hermes's lock inside ``save_config``."""
    import sys
    import types
    mod = sys.modules.setdefault(_SHARED, types.ModuleType(_SHARED))
    return mod.__dict__.setdefault("lock", threading.RLock())


# Hermes's own errors aren't passed on: its "can't be read" error quotes the parser's message
# (``Details:``), which can quote a line of config.yaml, a secret's value included, and these
# messages reach the model.
READ_FAILED = ("Hermes's config.yaml can't be read or parsed, so nothing was changed. "
               "Run `hermes config check` to see why, then try again.")
SAVE_FAILED = "Hermes couldn't save config.yaml, so nothing was changed."


def raw_config(home: Path) -> dict:
    from hermes_cli.config import get_config_path, require_readable_config_before_write
    if Path(get_config_path()).resolve() != (home / "config.yaml").resolve():
        raise ValueError("The active Hermes profile changed; nothing was written.")
    try:
        cfg = require_readable_config_before_write(home / "config.yaml")
    except Exception:  # noqa: BLE001
        raise ValueError(READ_FAILED) from None
    if not isinstance(cfg, dict):
        raise ValueError(READ_FAILED)
    return cfg


def _save(value: dict, **kw) -> None:
    from hermes_cli.config import save_config
    try:
        save_config(value, **kw)
    except Exception:  # noqa: BLE001
        raise ValueError(SAVE_FAILED) from None


def fingerprint(entry: dict) -> str:
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Config:
    def __init__(self, home: Path, plugin: str):
        self.home, self.plugin = home, plugin
        self.state = home / plugin
        self.record = self.state / "added.json"

    def _records(self) -> dict:
        if not self.record.exists():
            return {}
        data = json.loads(self.record.read_text("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("The ownership record is invalid; nothing was changed.")
        return data

    def _record(self, data: dict):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.record.with_suffix(".tmp")
        with temp.open("w", encoding="utf-8") as f:
            os.chmod(temp, 0o600)
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        temp.replace(self.record)

    @staticmethod
    def _servers(cfg: dict) -> dict:
        servers = cfg.setdefault("mcp_servers", {})
        if not isinstance(servers, dict):
            raise ValueError("mcp_servers is not a mapping; nothing was changed.")
        return servers

    def check_add(self, name: str):
        with config_lock():
            if name in self._servers(raw_config(self.home)):
                raise ValueError(f'A server named "{name}" already exists. Choose another name; nothing was changed.')

    def removable(self, name: str) -> dict:
        with config_lock():
            entry = self._servers(raw_config(self.home)).get(name)
            record = self._records().get(name)
            if not isinstance(entry, dict) or not record or fingerprint(entry) != record.get("fingerprint"):
                raise ValueError(f'Cannot remove "{name}": this plugin did not add it, or it has changed since the addition.')
            return entry

    def add(self, plan: dict):
        name, entry = plan["name"], plan["entry"]
        with config_lock():
            cfg = raw_config(self.home)
            servers = self._servers(cfg)
            if name in servers:
                raise ValueError(f'A server named "{name}" appeared before writing. Nothing was changed.')
            records = self._records()
            # Reserve the ownership record first. If saving fails it cannot grant
            # removal of an unrelated entry: only this exact fingerprint matches.
            old = dict(records)
            records[name] = {"fingerprint": fingerprint(entry), "card": plan["card"]}
            self._record(records)
            try:
                # Only this entry, merged by Hermes into the file as it is now, under Hermes's lock.
                _save({"mcp_servers": {name: entry}}, merge_existing=True)
                if self._servers(raw_config(self.home)).get(name) != entry:
                    raise ValueError("Hermes did not save the requested entry (the profile may be managed).")
            except Exception:
                self._record(old)
                raise

    def remove(self, name: str, expected: dict):
        with config_lock():
            current = self.removable(name)
            if current != expected:
                raise ValueError("The entry changed while approval was pending; nothing was removed.")
            cfg = raw_config(self.home)
            del cfg["mcp_servers"][name]
            _save(cfg)
            if name in self._servers(raw_config(self.home)):
                raise ValueError("Hermes did not remove the entry.")
            records = self._records()
            records.pop(name, None)
            self._record(records)
