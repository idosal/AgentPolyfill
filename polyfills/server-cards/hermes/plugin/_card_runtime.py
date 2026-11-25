"""Hermes approval adapter shared by Server Cards and ARD (copied by builds)."""
from __future__ import annotations
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit
from . import _helper, _servers
from ._card_config import Config


def session_key(kwargs):
    try:
        from gateway.session_context import get_session_env
        key = get_session_env("HERMES_SESSION_KEY", "")
    except ImportError:
        key = ""
    return key or str(kwargs.get("session_id") or "")


def display(value):
    # Paths and identifiers may come from the host too. Never render invisible controls.
    return "".join(c for c in str(value) if c >= " " and not ("\x7f" <= c <= "\x9f") and c not in "\u200b\u200c\u200d\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff")


def entry_lines(entry: dict) -> str:
    """The whole entry as it would be written: every header with its value (a secret is a ${VAR}
    reference, never a value), the transport and every other setting."""
    headers = entry.get("headers") or {}
    lines = [f'URL: {entry.get("url")}',
             "Headers: " + ("; ".join(f"{k}: {v}" for k, v in headers.items()) or "none"),
             "Transport: " + str(entry.get("transport") or "streamable HTTP")]
    other = {k: v for k, v in entry.items() if k not in {"url", "headers", "transport"}}
    if other:
        lines.append("Other settings: " + ", ".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in other.items()))
    return "\n".join(lines)


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Runtime:
    def __init__(self, ctx, here: Path, plugin: str, home: Path, words: dict):
        self.ctx, self.here, self.plugin, self.home, self.words = ctx, here, plugin, home, words
        self.config = Config(home, plugin)
        self.helper = None
        self.lock = threading.RLock()
        self.pending = {}
        self.add = "ard_add_mcp_server" if plugin == "ard-discovery" else "add_mcp_server"
        self.remove = "ard_remove_mcp_server" if plugin == "ard-discovery" else "remove_mcp_server"
        self.registered = set()

    def ensure(self):
        with self.lock:
            if self.helper is not None and not self.helper.closed:
                return self.helper
            node, why = _helper.find_node()
            if not node:
                raise RuntimeError(why)
            # The helper reads public documents only. Pass no host credentials or
            # arbitrary MCP environment variables to this separate process.
            env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "HERMES_HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"}}
            helper = _helper.Helper(self.here / "dist" / "helper.mjs", node=node, env=env,
                                    on_request=lambda *_: (_ for _ in ()).throw(ValueError("Unexpected helper request")))
            try:
                helper.request("initialize", {"registry": os.environ.get("ARD_DISCOVERY_REGISTRY", "")}, timeout=10)
            except Exception:
                helper.close()
                raise
            self.helper = helper
            return helper

    def request(self, method, key, **params):
        if not key:
            raise ValueError("No calling session is available; nothing was changed or sent.")
        return self.ensure().request(method, {"session": key, **params}, timeout=22 if method.startswith("prepare") else 120)

    def _key(self, name, args, session):
        return session, name, json.dumps(args, sort_keys=True, separators=(",", ":"))

    def pre(self, tool_name=None, args=None, **kwargs):
        if tool_name not in self.registered or tool_name not in {self.add, self.remove, "ard_search"}:
            return None
        a = args if isinstance(args, dict) else {}
        key = session_key(kwargs)
        pending_key = self._key(tool_name, a, key)
        with self.lock:
            self.pending.pop(pending_key, None)
        if tool_name != self.remove:
            # Hermes would answer the question itself here. A search sends the user's words to a
            # third party and an addition trusts a new server: both need the user's own yes.
            bypass = _servers.approvals_bypassed(key)
            if bypass:
                what = "Nothing was sent" if tool_name == "ard_search" else "Nothing was added"
                return {"action": "block", "message": display(f"{what}: {bypass}, and this step is taken only with the "
                                                              "user's own yes. This needs a session where Hermes asks "
                                                              "the user: not --yolo, /yolo, hermes -z or approvals.mode: off.")}
        try:
            if tool_name == self.add:
                plan = self.request("prepare_add", key, arguments=a)
                self.config.check_add(plan["name"])
                entry = plan["entry"]
                message = (f'Add MCP server "{plan["name"]}" to Hermes?\nHost: {urlsplit(entry["url"]).netloc}\n'
                           f'{entry_lines(entry)}\n'
                           f'From Server Card {plan["card"]}, {plan["provenance"]}.\n'
                           f'Written to {self.home / "config.yaml"}. Ownership record: {self.config.record}.\n'
                           'After approval, an anonymous initialize request may check for an OAuth challenge and set auth: oauth; no tokens are handled.\n'
                           f'To undo: {self.remove}(name="{plan["name"]}") or hermes mcp remove {plan["name"]}; then /reload-mcp.')
                # The whole of what the question shows: a kept approval covers this exact addition only.
                target = plan["name"] + ":" + digest({k: plan.get(k) for k in ("name", "entry", "card", "provenance")})
                action = "add"
            elif tool_name == self.remove:
                if not key:
                    raise ValueError("No calling session is available.")
                name = str(a.get("name") or "")
                entry = self.config.removable(name)
                plan = {"name": name, "entry": entry}
                message = (f'Remove MCP server "{name}" from {self.home / "config.yaml"}?\n{entry_lines(entry)}\n'
                           f'Only the unchanged entry recorded by {self.plugin} is removed.\n'
                           f'To undo: discover the card again and approve {self.add}. Run /reload-mcp to disconnect.')
                target = name + ":" + digest({"name": name, "entry": entry})
                action = "remove"
            else:
                plan = self.request("prepare_search", key, arguments=a)
                host = urlsplit(plan["endpoint"]).netloc
                # The key is the whole request: a kept approval covers these words to this endpoint, nothing else.
                sent = {k: plan.get(k) for k in ("endpoint", "query", "referral", "additional")}
                target = host + ":" + hashlib.sha256(json.dumps(sent, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
                message = (f'{host}: send this query to {plan["endpoint"]}?\nQuery: "{plan["query"]}"\n'
                           'This third-party registry sees these words. Referrals need separate approval. Nothing is written to config.yaml. A sent query cannot be recalled. '
                           f'Choosing "session" or "always" covers this exact query to {plan["endpoint"]} only; any other words are asked about again.')
                action = "search"
            with self.lock:
                self.pending = {k: v for k, v in self.pending.items() if v[0] > time.monotonic() - 600}
                if len(self.pending) >= 256:
                    raise ValueError("Too many pending approvals; retry later.")
                self.pending[pending_key] = (time.monotonic(), plan)
            return {"action": "approve", "message": "\n".join(display(l) for l in message.splitlines()), "rule_key": f"{self.plugin}:{action}:{target}"}
        except Exception as exc:
            return {"action": "block", "message": display(exc)}

    def call(self, name, args, kwargs):
        key = session_key(kwargs)
        try:
            if name in {self.add, self.remove, "ard_search"}:
                with self.lock:
                    prepared = self.pending.pop(self._key(name, args, key), None)
                if not prepared or prepared[0] < time.monotonic() - 600:
                    raise ValueError("No current approval preparation for this exact call. Retry through Hermes's approval gate.")
                plan = prepared[1]
                if name == self.add:
                    auth = self.request("probe_auth", key, plan=plan)
                    if auth.get("oauth"):
                        plan["entry"]["auth"] = "oauth"
                    self.config.add(plan)
                    text = f'Added "{plan["name"]}" ({plan["entry"]["url"]}) to {self.home / "config.yaml"}. To undo: {self.remove}(name="{plan["name"]}") or hermes mcp remove {plan["name"]}.'
                    if plan.get("envVars"):
                        text += f' Put these secret variables in {self.home / ".env"}: ' + ", ".join(v["name"] for v in plan["envVars"]) + '. Never send their values to the model. Config contains only ${VAR} references.'
                    if auth.get("oauth"):
                        text += f' OAuth: run hermes mcp login {plan["name"]} in a terminal. Hermes holds the tokens; this plugin never handles them.'
                    if auth.get("note"):
                        text += " " + auth["note"]
                    text += ' Run /reload-mcp (or start a new Hermes session) to connect and load its tools. Saving configuration alone does not prove the connection works.'
                elif name == self.remove:
                    self.config.remove(plan["name"], plan["entry"])
                    text = f'Removed "{plan["name"]}". Run /reload-mcp to disconnect it from open sessions. Discover and approve an addition to restore it.'
                else:
                    text = self.request("search", key, plan=plan)["text"]
            else:
                text = self.request("discover", key, arguments=args)["text"]
            return json.dumps({"result": text}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": display(exc)})

    def close(self):
        with self.lock:
            helper, self.helper = self.helper, None
            self.pending.clear()
        if helper is not None:
            helper.close()


def register_plugin(ctx, here: Path, plugin: str):
    flag = "ARD_DISCOVERY_DISABLED" if plugin == "ard-discovery" else "MCP_SERVER_CARDS_DISABLED"
    if os.environ.get(flag, "").lower() in {"1", "true", "yes", "on"}:
        return
    from hermes_constants import get_hermes_home  # published (hermes_constants)
    words = json.loads((here / "dist" / "words.json").read_text("utf-8"))
    rt = Runtime(ctx, here, plugin, Path(get_hermes_home()), words)
    for schema in words["tools"]:
        name = schema["name"]
        def handler(params, _name=name, **kwargs):
            return rt.call(_name, params if isinstance(params, dict) else {}, kwargs)
        if ctx.register_tool(name=name, toolset=plugin, schema=schema, handler=handler) is not None:
            rt.registered.add(name)
    ctx.register_hook("pre_tool_call", rt.pre)
    ctx.register_system_prompt_section(plugin, words["instructions"])
    ctx.on_unload(rt.close)
    return rt
