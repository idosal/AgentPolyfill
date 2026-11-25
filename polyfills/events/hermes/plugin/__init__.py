"""mcp-events for Hermes: MCP Events (SEP-3415) by poll and push.

The Hermes half of the plugin. It registers the six tools, asks Hermes's own approval before a
watch starts or stops (a ``pre_tool_call`` approve directive), and runs the helper
(``dist/helper.mjs``, the shared Events client) in the gateway. The helper connects to the MCP
servers this plugin may use, runs the watches, stores every event, and asks this half to wake a
session; this half hands the message to Hermes with ``ctx.inject_message``.

Servers with ``events: true`` are left to Hermes, which delivers their events by webhook itself.
Which servers the plugin may use is read again at every turn and tool call; when that changes, the
helper is started again with the new set (saved watches resume, on the servers still in it).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

from . import _helper, _servers

logger = logging.getLogger("mcp-events")

PLUGIN_ID = "mcp-events"
HERE = Path(__file__).resolve().parent
WORDS = json.loads((HERE / "dist" / "words.json").read_text(encoding="utf-8"))
WAKE_PREFIX = "[mcp-events]"
GATED = {"watch_event", "unwatch_event"}


def standdown(name: str, cfg: dict) -> Optional[str]:
    """Hermes speaks Events with this server itself (webhook delivery): the plugin leaves it alone."""
    if _servers.boolish(cfg.get("events"), False):
        return ("Hermes handles this server's events itself (events: true): use the server's own "
                "list_event_types and subscribe_event tools")
    return None


def _session_key(kwargs: dict) -> str:
    """The calling session's key, as Hermes binds it for the turn (``HERMES_SESSION_KEY``)."""
    try:
        from gateway.session_context import get_session_env  # public plugin API
        key = get_session_env("HERMES_SESSION_KEY", "")
    except Exception:  # noqa: BLE001
        key = ""
    return key or str(kwargs.get("session_id") or "")


class Runtime:
    """The helper, started the first time a session needs it, and what it asks of Hermes."""

    def __init__(self, ctx: Any, home: Optional[Path]):
        self.ctx = ctx
        self.home = home
        self._lock = threading.Lock()
        # The approvals put to Hermes, by session and key: a gated call runs only as it was asked about.
        self._asked: dict[tuple[str, str], float] = {}
        self.helper: Optional[_helper.Helper] = None
        self.unavailable = ""
        self.started_with: Optional[tuple] = None

    def wanted(self) -> tuple[dict, dict]:
        """The servers the plugin may use now, and why each other one is left out: from config.yaml as
        it is now, and the servers named in this plugin's settings (``ctx.get_config("servers")``)."""
        granted = _servers.names(self.ctx.get_config("servers", []))
        return _servers.read_servers(PLUGIN_ID, granted, standdown=standdown)

    def restart_if_changed(self) -> bool:
        """Ends a running helper whose servers are no longer the ones the plugin may use (a server
        granted, revoked, changed, or now left to Hermes with ``events: true``). Returns whether it did."""
        with self._lock:
            helper = self.helper
            if helper is None or helper.closed:
                return False
            try:
                if self.wanted() == self.started_with:
                    return False
            except Exception as exc:  # noqa: BLE001 - an unreadable config ends nothing
                logger.warning("mcp-events: the configuration could not be read again (%s)", exc)
                return False
            self.helper = None
        logger.info("mcp-events: the servers it may use changed; the helper starts again with the new set")
        helper.close()
        return True

    def _state(self) -> Path:
        home = self.home
        if home is None:
            from hermes_constants import get_hermes_home  # published (hermes_constants)
            home = Path(get_hermes_home())
        return Path(home) / "mcp-events"

    def has_saved_watches(self) -> bool:
        try:
            root = self._state() / "watch-sessions"
            return any((d / "watches.json").is_file() and '"server"' in (d / "watches.json").read_text("utf-8")
                       for d in root.iterdir())
        except Exception:  # noqa: BLE001 - a hook must never fail because of this
            return False

    def ensure(self) -> Optional[_helper.Helper]:
        self.restart_if_changed()
        with self._lock:
            if self.helper is not None and not self.helper.closed:
                return self.helper
            node, why = _helper.find_node()
            if not node:
                self.unavailable = why
                logger.warning("mcp-events: %s; the plugin's tools say so and do nothing else", why)
                return None
            try:
                _servers.check_profile(self.home)
            except Exception as exc:  # noqa: BLE001
                self.unavailable = str(exc)
                logger.warning("mcp-events: %s", exc)
                return None
            state = self._state()
            state.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                servers, skipped = self.wanted()
            except Exception as exc:  # noqa: BLE001
                self.unavailable = f"Hermes's config.yaml could not be read ({exc})"
                return None
            helper = _helper.Helper(HERE / "dist" / "helper.mjs", node=node, env=_helper.helper_env(),
                                    on_request=self._on_request, log_path=state / "helper-stderr.log")
            try:
                helper.request("initialize", {"state": str(state), "servers": servers, "skipped": skipped}, timeout=30)
            except Exception as exc:  # noqa: BLE001
                helper.close()
                self.unavailable = f"the helper did not start ({exc})"
                logger.warning("mcp-events: %s", self.unavailable)
                return None
            self.helper = helper
            self.started_with = (servers, skipped)
            self.unavailable = ""
            return helper

    def _on_request(self, method: str, params: dict) -> Any:
        if method != "wake":
            raise ValueError(f"no method {method}")
        key, text = params.get("session"), params.get("text")
        if not isinstance(key, str) or not key or not isinstance(text, str):
            return {"ok": False, "why": "a wake without a session or text"}
        try:
            ok = bool(self.ctx.inject_message(text, role="user", session_key=key))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "why": f"Hermes refused the message ({exc})"}
        if ok:
            return {"ok": True}
        why = "Hermes did not take the message (the session may not be open; the gateway log says why)"
        try:
            if not _servers.injection_allowed(_servers.raw_config(), PLUGIN_ID):
                why = ("Hermes does not let this plugin start turns: set "
                       f"plugins.entries.{PLUGIN_ID}.allow_gateway_injection: true in config.yaml")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "why": why}

    def entry_of(self, server: Any) -> Optional[dict]:
        """The server's entry as the plugin would connect to it now, or None."""
        try:
            return self.wanted()[0].get(str(server))
        except Exception:  # noqa: BLE001
            return None

    def asked(self, key: str, rule: str) -> None:
        with self._lock:
            now = time.monotonic()
            self._asked = {k: t for k, t in self._asked.items() if t > now - 600}
            if len(self._asked) < 256:
                self._asked[(key, rule)] = now

    def was_asked(self, key: str, rule: str) -> bool:
        with self._lock:
            t = self._asked.pop((key, rule), None)
            return t is not None and t > time.monotonic() - 600

    def call(self, name: str, args: dict, kwargs: dict) -> str:
        key = _session_key(kwargs)
        if name in GATED:
            # Hermes applies another plugin's change to a call after the question; the watch started
            # (or stopped) is the one asked about, or none.
            rule = _rule(name, args, self.entry_of(args.get("server")) if name == "watch_event" else None)
            if not self.was_asked(key, rule):
                return json.dumps({"error": ("This call isn't the one Hermes asked the user about (it, or the server's "
                                             "configuration, changed after the question), so nothing was done. Ask again.")})
        helper = self.ensure()
        if helper is None:
            return json.dumps({"error": f"mcp-events cannot run: {self.unavailable}."})
        try:
            r = helper.request("call", {"name": name, "arguments": args, "session": key}, timeout=120)
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": f"mcp-events: {exc}"})
        text = str((r or {}).get("text", ""))
        return json.dumps({"error": text} if (r or {}).get("isError") else {"result": text}, ensure_ascii=False)

    def spoke(self, key: str) -> None:
        helper = self.helper
        if helper is None or helper.closed or not key:
            return
        try:
            helper.request("spoke", {"session": key}, timeout=10)
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        with self._lock:
            helper, self.helper = self.helper, None
        if helper is not None:
            helper.close()


def _describe(name: str, args: dict) -> str:
    """What the approval prompt says: the whole of what is about to be watched or stopped, with
    nothing cut and nothing hidden (raises if it can't be shown in full)."""
    if name == "watch_event":
        filters = json.dumps(args.get("arguments") or {}, ensure_ascii=False, sort_keys=True)
        note = str(args.get("note") or "")
        replay = f" When it resumes after Hermes was stopped, it replays at most {args['maxAgeMs']} ms of missed events." if args.get("maxAgeMs") is not None else ""
        return _servers.shown(
            f"Start watching the event type {json.dumps(str(args.get('event')))} on the MCP server "
            f"{json.dumps(str(args.get('server')))}, with the filters {filters}. Its events will wake this session"
            + (f", with the note {json.dumps(note, ensure_ascii=False)}" if note else ", with no note") + f".{replay}")
    return _servers.shown(f"Stop the event watch {json.dumps(str(args.get('watch')))} and end its subscription.")


def _rule(name: str, args: dict, entry: Optional[dict] = None) -> str:
    """The approval's key: the whole action, so a kept approval ("session", "always") covers this
    exact watch (server, event type, filters, note, replay) on the server as it is configured now
    (its entry in config.yaml: pointed elsewhere, it is asked about again), and nothing else."""
    if name == "watch_event":
        what = {**{k: args.get(k) for k in ("server", "event", "arguments", "note", "maxAgeMs")}, "entry": entry}
        digest = hashlib.sha256(json.dumps(what, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
        server = "".join(c for c in str(args.get("server")) if c.isalnum() or c in "-_.")[:64]
        return f"{PLUGIN_ID}:watch:{server}:{digest}"
    digest = hashlib.sha256(json.dumps(str(args.get("watch"))).encode()).hexdigest()[:32]
    return f"{PLUGIN_ID}:unwatch:{digest}"


def register(ctx) -> None:
    try:
        from hermes_constants import get_hermes_home  # published (hermes_constants); the profile being loaded
        home: Optional[Path] = Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        home = None
    rt = Runtime(ctx, home)

    for tool in WORDS["tools"]:
        name = tool["name"]
        schema = {"name": name, "description": tool["description"], "parameters": tool["parameters"]}

        def handler(params, _name=name, **kwargs):
            return rt.call(_name, params if isinstance(params, dict) else {}, kwargs)

        if ctx.register_tool(name=name, toolset=PLUGIN_ID, schema=schema, handler=handler, emoji="📡") is None:
            logger.warning("mcp-events: the tool name %s is taken; that tool is not available", name)

    def pre_tool_call(tool_name=None, args=None, **kwargs):
        if tool_name not in GATED:
            return None
        a = args if isinstance(args, dict) else {}
        if tool_name == "watch_event":
            # Hermes would answer the question itself here. A watch starts turns later, by itself,
            # so it starts only with the user's own yes; stopping one is still put to Hermes.
            bypass = _servers.approvals_bypassed(_session_key(kwargs))
            if bypass:
                return {"action": "block", "message": (f"The watch isn't started: {bypass}, and a watch starts turns "
                                                       "later by itself, so it starts only with the user's own yes. "
                                                       "This needs a session where Hermes asks the user: not --yolo, "
                                                       "/yolo, hermes -z or approvals.mode: off.")}
        try:
            message = _describe(tool_name, a)
        except ValueError as exc:
            return {"action": "block", "message": f"This watch can't be put to the user: {exc}. Ask with shorter filters or note."}
        rule = _rule(tool_name, a, rt.entry_of(a.get("server")) if tool_name == "watch_event" else None)
        rt.asked(_session_key(kwargs), rule)
        return {"action": "approve", "message": message, "rule_key": rule}

    def pre_llm_call(user_message=None, **kwargs):
        # The person wrote (not one of this plugin's own messages): waking starts again if it had stopped.
        text = user_message if isinstance(user_message, str) else ""
        if text.lstrip().startswith(WAKE_PREFIX):
            return None
        key = _session_key(kwargs)
        # Read the configuration again: a server granted, revoked or left to Hermes since the last turn
        # (``events: true`` and /reload-mcp) is picked up before the model acts, so no server is watched twice.
        rt.restart_if_changed()
        # A delegated child agent's turn (delegate_task) carries the parent's session key, and its
        # message is what the model wrote for it: that isn't the person writing.
        if key and not kwargs.get("parent_session_id"):
            _helper.spawn(rt.spoke, key)
        if rt.helper is None and rt.has_saved_watches():
            _helper.spawn(rt.ensure)
        return None

    def on_session_open(**kwargs):
        # A local session opened. If watches were saved before the gateway last stopped, start the
        # helper, which resumes them; otherwise it starts at the first tool call.
        if rt.helper is None and rt.has_saved_watches():
            _helper.spawn(rt.ensure)

    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("on_session_open", on_session_open)
    try:
        ctx.register_system_prompt_section("mcp-events", WORDS["instructions"])
    except Exception as exc:  # noqa: BLE001
        logger.debug("mcp-events: no system prompt section (%s)", exc)
    ctx.on_unload(rt.close)
    return rt
