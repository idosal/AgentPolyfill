"""Which MCP servers a polyfill may connect to, read from Hermes's own configuration.

Shared by the Hermes forms of the polyfills (copied into each plugin folder by its build; the
copies are checked to be identical). The plugin opens its own connection to each server it
uses, so it never reaches further than Hermes would, and further than the user granted:

- only servers in ``mcp_servers`` of the profile's ``config.yaml``, as written there, read with
  ``hermes_cli.config.read_raw_config`` (``hermes_cli.config`` is on Hermes's published plugin
  API, ``hermes_cli/data/plugin_api.json``; no plugin call lists the MCP servers);
- only servers the user named in the plugin's own settings,
  ``plugins.entries.<plugin>.settings.servers``, which the plugin reads with ``ctx.get_config``
  (Hermes's documented place for a plugin's settings);
- a value that takes ``${VAR}`` from Hermes's ``.env`` is never filled in: ``.env`` is where
  Hermes keeps secrets, and the plugin doesn't read them. Such a server is left alone, with the
  reason;
- a server switched off (``enabled: false``) stays off;
- a server that signs in through Hermes (``auth: oauth``) is left alone: Hermes keeps that
  sign-in to itself, and the plugin never reads Hermes's stored tokens;
- a server that needs a client certificate is left alone, as is any transport but stdio and
  streamable HTTP.

``standdown(name, cfg)`` lets a polyfill leave a server to Hermes where Hermes speaks the
extension with it itself (Events: ``events: true``).

``approvals_bypassed(session_key)`` says why Hermes would approve a plugin's approval itself (or
why that can't be told), or "": a step that must have the person's own yes is refused then.
"""

from __future__ import annotations

import os
import re
from typing import Any, Callable, Optional

_SERVER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$")
_UNRESOLVED = re.compile(r"\$\{[^}]+\}")
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def boolish(value: Any, default: bool) -> bool:
    """A yes/no setting as Hermes reads one (``true``, ``"on"``, ``1`` …)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in _TRUE:
            return True
        if v in _FALSE:
            return False
    return default


def _strings(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)}


_HIDDEN = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\U000e0000-\U000e007f]")


def shown(value: Any, limit: int = 2000) -> str:
    """Text for an approval prompt: no control, direction or invisible characters (a terminal could
    act on one, or it could hide what is approved). Raises if it would have to be cut: a question
    must show the whole of what it asks about."""
    text = _HIDDEN.sub("\ufffd", str(value))
    if len(text) > limit:
        raise ValueError(f"it is too long to show in full for approval ({len(text)} characters, at most {limit})")
    return text


def check_profile(home: Any) -> None:
    """Refuses to go on outside the Hermes profile the plugin was loaded for: its config, grants and
    secrets are another profile's."""
    if home is None:
        return
    from pathlib import Path
    from hermes_constants import get_hermes_home  # published (hermes_constants)
    if Path(get_hermes_home()).resolve() != Path(home).resolve():
        raise RuntimeError("called outside the Hermes profile this plugin was loaded for; nothing was read")


def names(value: Any) -> list[str]:
    """The servers named for this plugin (``ctx.get_config("servers")``): a list of names; ``[]`` otherwise."""
    return [str(v) for v in value if isinstance(v, (str, int))] if isinstance(value, list) else []


def raw_config() -> dict:
    """The profile's config.yaml as written: no defaults, no ``${VAR}`` filled in (public
    ``hermes_cli.config.read_raw_config``)."""
    from hermes_cli.config import read_raw_config  # published plugin API (hermes_cli.config)
    raw = read_raw_config()
    return raw if isinstance(raw, dict) else {}


def approvals_bypassed(session_key: str) -> str:
    """Why Hermes would approve a plugin's approval itself here, or "": then a step that needs the
    person's own yes is refused instead.

    Hermes's gate approves a ``pre_tool_call`` approve directive unasked when
    ``_yolo_active() or approval_context._get_approval_mode() == "off"`` (``tools/approval.py``,
    ``_run_approval_gate``). ``_yolo_active()`` is ``--yolo``, the session's ``/yolo`` and an unattended
    turn (``hermes -z``). The hook runs in the same turn's context just before that gate, so the same
    expression is evaluated here, with the named session's ``/yolo`` as well. None of it is on Hermes's
    published plugin API. When it can't be evaluated (another Hermes version, or the plugin running in
    Hermes's plugin host process, which doesn't see the gateway's sessions), the answer is that it can't
    be told, and the step is refused too."""
    if os.environ.get("HERMES_PLUGIN_HOST_PROCESS") == "1":
        return ("this plugin runs in Hermes's plugin host process (plugins.isolation: host), where it can't "
                "tell whether Hermes would approve without asking")
    try:
        from tools import approval, approval_context  # unpublished; see the READMEs
        unasked = bool(approval._yolo_active()) or approval_context._get_approval_mode() == "off" \
            or (bool(session_key) and bool(approval.is_approval_bypass_active_for_session(session_key)))
    except Exception:  # noqa: BLE001
        return "this plugin can't tell, with this version of Hermes, whether Hermes would approve without asking"
    return ("Hermes approves without asking here (--yolo, /yolo, hermes -z or approvals.mode: off)"
            if unasked else "")


def injection_allowed(config: dict, plugin_id: str) -> bool:
    """Whether the user let this plugin start turns (``allow_gateway_injection: true``)."""
    entry = ((config or {}).get("plugins") or {}).get("entries") or {}
    entry = entry.get(plugin_id) if isinstance(entry, dict) else None
    return isinstance(entry, dict) and entry.get("allow_gateway_injection") is True


def parse_server(name: str, cfg: Any) -> dict | str:
    """One ``mcp_servers`` entry as the polyfill's client takes it, or why it is left out."""
    if not isinstance(cfg, dict):
        return "its configuration is not a mapping"
    if not boolish(cfg.get("enabled"), True) or boolish(cfg.get("disabled"), False):
        return "it is switched off in Hermes (enabled: false)"
    auth = cfg.get("auth")
    if (isinstance(auth, str) and auth.strip().lower() == "oauth") or isinstance(cfg.get("oauth"), dict):
        return ("it signs in through Hermes (auth: oauth), and this plugin has no access to Hermes's sign-in; "
                "a server that takes a header can be given one in `headers` instead")
    if cfg.get("client_cert") or cfg.get("client_key"):
        return "it needs a client certificate (mTLS), which this plugin's own connection does not present"
    if isinstance(cfg.get("command"), str) and cfg["command"].strip():
        args = [str(a) for a in cfg.get("args") or [] if isinstance(a, (str, int, float))]
        out: dict[str, Any] = {"command": str(cfg["command"]), "args": args}
        env = _strings(cfg.get("env"))
        if env:
            out["env"] = env
        if isinstance(cfg.get("cwd"), str) and cfg["cwd"].strip():
            out["cwd"] = cfg["cwd"]
        unresolved = sorted({m.group(0) for v in [out["command"], *args, *env.values()] for m in _UNRESOLVED.finditer(v)})
        if unresolved:
            return (f"its command or env takes {', '.join(unresolved)} from Hermes's .env, where Hermes keeps secrets, "
                    "and this plugin doesn't read them; Hermes's own connection still works")
        return out
    if isinstance(cfg.get("url"), str) and cfg["url"].strip():
        url = str(cfg["url"]).strip()
        transport = str(cfg.get("transport") or "").strip().lower()
        if transport in ("sse", "legacy_sse") or (not transport and url.rstrip("/").endswith("/sse")):
            return "it uses the legacy SSE transport; only streamable HTTP and stdio are supported"
        headers = _strings(cfg.get("headers"))
        ident = cfg.get("identity_header")
        if isinstance(ident, dict):
            if ident.get("value_from", "static") == "static" and isinstance(ident.get("name"), str) and isinstance(ident.get("value"), str):
                headers[ident["name"]] = ident["value"]
            else:
                return "it sends a per-user identity header Hermes fills in itself, which this plugin cannot"
        unresolved = sorted({m.group(0) for v in [url, *headers.values()] for m in _UNRESOLVED.finditer(v)})
        if unresolved:
            return (f"its url or headers take {', '.join(unresolved)} from Hermes's .env, where Hermes keeps secrets, "
                    "and this plugin doesn't read them; Hermes's own connection still works")
        out = {"url": url}
        if headers:
            out["headers"] = headers
        return out
    return "its transport is not supported (only stdio and streamable HTTP are)"


def read_servers(plugin_id: str, granted: list[str], *,
                 standdown: Optional[Callable[[str, dict], Optional[str]]] = None,
                 servers: Optional[dict] = None) -> tuple[dict, dict]:
    """``(servers, skipped)``: the servers this plugin may connect to, and why each other one is left out.

    ``granted`` is ``settings.servers`` (``ctx.get_config("servers")``). ``servers`` is for tests;
    by default it is ``mcp_servers`` of the profile's config.yaml as written. Servers that portable
    plugin packages or a managed overlay bring are not in it, and are not used."""
    if servers is None:
        raw = raw_config().get("mcp_servers")
        servers = raw if isinstance(raw, dict) else {}
    allowed = set(granted)
    out: dict[str, dict] = {}
    skipped: dict[str, str] = {}
    for name, cfg in (servers or {}).items():
        if not isinstance(name, str) or not _SERVER_NAME.match(name):
            continue
        if isinstance(cfg, dict) and standdown is not None:
            why = standdown(name, cfg)
            if why:
                skipped[name] = why
                continue
        if name not in allowed:
            skipped[name] = (f"it is not named for this plugin: add it to plugins.entries.{plugin_id}.settings.servers "
                             "in Hermes's config.yaml")
            continue
        parsed = parse_server(name, cfg)
        if isinstance(parsed, str):
            skipped[name] = parsed
        else:
            out[name] = parsed
    return out, skipped
