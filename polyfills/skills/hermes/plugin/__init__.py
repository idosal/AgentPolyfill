"""mcp-skills for Hermes: the MCP Skills extension (SEP-2640).

The Hermes half of the plugin. It registers the four tools and, with ``ctx.register_skill``,
one short SKILL.md per served skill, so Hermes lists them with the user's own skills as
``mcp-skills:<server>-<name>``. It runs the helper (``dist/helper.mjs``: the Codex form's
client rules over the shared Skills core) in the gateway, and it asks through Hermes's own
approval (a ``pre_tool_call`` approve directive):

- before ``load_skill`` loads a skill, naming it, its server and its files; the approval's
  rule key holds the skill's manifest digest, so "always" covers that version only;
- before a session that loaded a skill from one server reads a resource from another
  (rule X8), naming both servers, every time; where it can't tell what a session loaded, before
  every resource read.

Where Hermes approves without asking (``--yolo``, ``/yolo``, ``hermes -z``, ``approvals.mode: off``),
or the plugin can't tell, loads and cross-server reads are refused: they need a person's yes. ``/mcp-skills show <server> <uri>``
shows a skill's SKILL.md to the person, not the model, before they decide (rule X13b). A skill
the user turned off in Hermes (``skills.disabled``) is refused. Which servers the plugin may use is
read again at every turn and tool call; when that changes, the helper starts again with the new set.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Optional

from . import _helper, _servers

logger = logging.getLogger("mcp-skills")

PLUGIN_ID = "mcp-skills"
HERE = Path(__file__).resolve().parent
WORDS = json.loads((HERE / "dist" / "words.json").read_text(encoding="utf-8"))
READ_RESOURCE = re.compile(r"^mcp__(.+)__read_resource$")
SKILL_TOOLS = {"load_skill", "read_skill_file", "list_skill_directory"}


def _session_key(kwargs: dict) -> str:
    try:
        from gateway.session_context import get_session_env  # public plugin API
        key = get_session_env("HERMES_SESSION_KEY", "")
    except Exception:  # noqa: BLE001
        key = ""
    return key or str(kwargs.get("session_id") or kwargs.get("conversation_id") or "")


def _sanitize(name: str) -> str:
    """How Hermes names a server in its tools (``mcp__<server>__<tool>``)."""
    return re.sub(r"[^A-Za-z0-9_]", "_", name)


_TOOL_NAME_MAX = 64
_TOOL_NAME_HASH = 8


def hermes_tool_name(server: str, tool: str) -> str:
    """Hermes's name for an MCP server's tool, as ``tools/mcp_tool_schema.py``'s ``mcp_prefixed_tool_name``
    makes it: ``mcp__<server>__<tool>``, sanitized, and past 64 characters cut to 55 with ``_`` and the
    first 8 hex digits of its SHA-256."""
    full = f"mcp__{_sanitize(server)}__{_sanitize(tool)}"
    if len(full) <= _TOOL_NAME_MAX:
        return full
    suffix = "_" + hashlib.sha256(full.encode("utf-8")).hexdigest()[:_TOOL_NAME_HASH]
    return full[:_TOOL_NAME_MAX - len(suffix)] + suffix


def resource_read_servers(name: str, known, args: Optional[dict] = None) -> Optional[list]:
    """Which servers a tool call reads a resource from (Hermes's ``mcp__<server>__read_resource``).

    None: it isn't a resource read. A list of server names: it is, from one of those (more than one
    where names sanitize alike, ``a.b`` and ``a_b``). An empty list: it is, or may be, from a server
    this plugin doesn't know (one another plugin brings, or a shortened name it can't place)."""
    if not name.startswith("mcp__"):
        return None
    hits = sorted({s for s in known if hermes_tool_name(s, "read_resource") == name})
    if hits:
        return hits
    if READ_RESOURCE.match(name):
        return []
    if len(name) == _TOOL_NAME_MAX and re.search(r"_[0-9a-f]{8}$", name):
        head = name[:_TOOL_NAME_MAX - _TOOL_NAME_HASH - 1]
        # A shortened name that starts as a known server's tools do is that server's other tool, or a
        # resource read from a server it doesn't know whose name starts the same way (``<known>__…``).
        # A resource read always passes a ``uri``: with one, it may be a read, and it is asked about.
        if isinstance(args, dict) and "uri" in args:
            return []
        for s in known:
            prefix = f"mcp__{_sanitize(s)}__"
            if head.startswith(prefix) or prefix.startswith(head):
                return None  # another, shortened, tool of a server it knows
        return []
    return None


def _disabled_names() -> set[str]:
    try:
        skills = _servers.raw_config().get("skills") or {}
    except Exception:  # noqa: BLE001
        return set()
    out: set[str] = set()
    for key in ("disabled",):
        v = skills.get(key)
        if isinstance(v, list):
            out |= {str(x) for x in v}
    for v in (skills.get("platform_disabled") or {}).values() if isinstance(skills.get("platform_disabled"), dict) else []:
        if isinstance(v, list):
            out |= {str(x) for x in v}
    return out


def approvals_bypassed(session_key: str) -> str:
    """Why Hermes would approve this session's approvals without asking, or "" (``_servers``)."""
    return _servers.approvals_bypassed(session_key)


def _no_requests(method: str, params: dict) -> Any:
    raise ValueError(f"no method {method}")


class Runtime:
    def __init__(self, ctx: Any, home: Optional[Path]):
        self.ctx = ctx
        self.home = home
        self._lock = threading.Lock()
        self.helper: Optional[_helper.Helper] = None
        self.unavailable = ""
        self.servers: dict = {}
        self.registered: dict[str, Any] = {}
        self.stubs: list[dict] = []
        self.started_with: Optional[tuple] = None
        # Which servers' skills each session loaded (rule X8). Kept by this half, in Hermes's plugin
        # state (``ctx.state``, profile-scoped, written atomically), not in the helper: the skill's text
        # stays in the conversation when the helper or the gateway restarts. Also in memory, for when
        # the state can't be written.
        self._held_lock = threading.Lock()
        self._held_mem: dict[str, dict] = {}
        # Set when something a session loaded couldn't be saved: until a save succeeds, the plugin can't
        # tell (a restart would forget it), so it asks before every resource read.
        self._unsaved = False

    MAX_HELD = 4096
    HELD = "held"

    def _held_saved(self) -> Optional[dict]:
        """What is saved, or None when it can't be told (unreadable, or something loaded wasn't saved):
        then the plugin asks."""
        return None if self._unsaved else self._held_read()

    def _held_read(self) -> Optional[dict]:
        try:
            raw = self.ctx.state.get(self.HELD, {})
        except Exception as exc:  # noqa: BLE001
            logger.warning("mcp-skills: what sessions loaded can't be read (%s); every resource read is asked about", exc)
            return None
        if not isinstance(raw, dict):
            return None
        out: dict[str, dict] = {}
        for k, v in raw.items():
            if not isinstance(v, dict) or not isinstance(v.get("servers"), list):
                return None
            roots = v.get("roots") if isinstance(v.get("roots"), list) else []
            out[str(k)] = {"servers": [str(x) for x in v["servers"]],
                           "roots": [[str(r[0]), str(r[1])] for r in roots if isinstance(r, list) and len(r) == 2],
                           "at": float(v.get("at") or 0)}
        return out

    def held_servers(self, key: str) -> Optional[list[str]]:
        """The servers whose skills this session loaded; None when that can't be told."""
        with self._held_lock:
            saved = self._held_saved()
            if saved is None:
                return None
            servers = list(saved.get(key, {}).get("servers", []))
            return servers + [s for s in self._held_mem.get(key, {}).get("servers", []) if s not in servers]

    def held_roots(self, key: str) -> list[tuple[str, str]]:
        """(server, root) of each skill this session loaded: its files are read with read_skill_file only."""
        with self._held_lock:
            saved = self._held_saved() or {}
            return [tuple(r) for e in (saved.get(key, {}), self._held_mem.get(key, {})) for r in e.get("roots", [])]

    def known_servers(self, key: str) -> set:
        """Every MCP server name this plugin can see: Hermes's ``mcp_servers``, the servers it lists
        skills from, and those this session loaded skills from."""
        names = {str(st.get("server") or "") for st in self.stubs}
        names.update((self.held_servers(key) or []) if key else [])
        try:
            names.update(str(k) for k in (_servers.raw_config().get("mcp_servers") or {}))
        except Exception:  # noqa: BLE001
            pass
        names.discard("")
        return names

    def anything_held(self) -> bool:
        """Whether any session may hold a served skill (True when that can't be told)."""
        with self._held_lock:
            saved = self._held_saved()
            return saved is None or bool(saved) or bool(self._held_mem)

    def hold(self, key: str, server: str, uri: str = "") -> None:
        root = [server, uri.rsplit("/", 1)[0] + "/"] if "/" in uri else None

        def add(held: dict, k: str, servers: list, roots: list, at: float) -> None:
            entry = held.setdefault(k, {"servers": [], "roots": [], "at": 0})
            entry["servers"] += [s for s in servers if s not in entry["servers"]]
            entry["roots"] = (entry.get("roots", []) + [r for r in roots if r not in entry.get("roots", [])])[-64:]
            entry["at"] = max(entry["at"], at)

        with self._held_lock:
            now = time.time()
            add(self._held_mem, key, [server], [root] if root else [], now)
            saved = self._held_read()
            if saved is None:
                return  # unreadable: the plugin already can't tell, and asks
            # Everything held in memory goes with it: what an earlier failed save left out is saved too.
            for k, e in self._held_mem.items():
                add(saved, k, e["servers"], e.get("roots", []), e["at"])
            for old in sorted(saved, key=lambda k: saved[k]["at"])[: max(0, len(saved) - self.MAX_HELD)]:
                del saved[old]
            try:
                self.ctx.state.set(self.HELD, saved)
                self._unsaved = False
            except Exception as exc:  # noqa: BLE001
                self._unsaved = True
                logger.warning("mcp-skills: what this session loaded could not be saved (%s); until a save works, "
                               "every resource read is asked about", exc)

    def state(self) -> Path:
        home = self.home
        if home is None:
            from hermes_constants import get_hermes_home  # published (hermes_constants)
            home = Path(get_hermes_home())
        return Path(home) / PLUGIN_ID

    # ---- the skills Hermes lists ----

    def register_stubs(self, stubs: list) -> None:
        """Registers what is new, lets go of what is gone. Hermes lists a skill added while it runs from the next session."""
        root = (self.state() / "stubs").resolve()
        wanted: dict[str, dict] = {}
        for s in stubs if isinstance(stubs, list) else []:
            if not isinstance(s, dict) or not isinstance(s.get("name"), str) or not isinstance(s.get("path"), str):
                continue
            path = Path(s["path"]).resolve()
            if path.parent.parent != root or not path.is_file():  # only the helper's own stubs
                continue
            wanted[s["name"]] = {**s, "path": str(path)}
        with self._lock:
            for name in list(self.registered):
                if name not in wanted:
                    try:
                        self.registered.pop(name).dispose()
                    except Exception:  # noqa: BLE001
                        pass
            for name, s in wanted.items():
                if name in self.registered:
                    continue
                try:
                    self.registered[name] = self.ctx.register_skill(name, Path(s["path"]), str(s.get("description") or ""))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("mcp-skills: the skill %s could not be registered: %s", name, exc)
            self.stubs = list(wanted.values())

    def register_saved(self) -> None:
        try:
            self.register_stubs(json.loads((self.state() / "stubs" / "index.json").read_text("utf-8")))
        except (OSError, ValueError):
            pass

    def stub_for(self, server: str, uri: str) -> Optional[dict]:
        return next((s for s in self.stubs if s.get("server") == server and s.get("uri") == uri), None)

    # ---- the helper ----

    def wanted(self) -> tuple[dict, dict]:
        """The servers the plugin may use now: config.yaml as it is now, and the servers named in this
        plugin's settings (``ctx.get_config("servers")``)."""
        return _servers.read_servers(PLUGIN_ID, _servers.names(self.ctx.get_config("servers", [])))

    def restart_if_changed(self) -> bool:
        """Ends a running helper whose servers are no longer the ones the plugin may use."""
        with self._lock:
            helper = self.helper
            if helper is None or helper.closed:
                return False
            try:
                if self.wanted() == self.started_with:
                    return False
            except Exception as exc:  # noqa: BLE001 - an unreadable config ends nothing
                logger.warning("mcp-skills: the configuration could not be read again (%s)", exc)
                return False
            self.helper = None
        logger.info("mcp-skills: the servers it may use changed; the helper starts again with the new set")
        helper.close()
        return True

    def ensure(self) -> Optional[_helper.Helper]:
        self.restart_if_changed()
        with self._lock:
            if self.helper is not None and not self.helper.closed:
                return self.helper
            node, why = _helper.find_node()
            if not node:
                self.unavailable = why
                logger.warning("mcp-skills: %s", why)
                return None
            try:
                _servers.check_profile(self.home)
            except Exception as exc:  # noqa: BLE001
                self.unavailable = str(exc)
                logger.warning("mcp-skills: %s", exc)
                return None
            state = self.state()
            state.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                servers, skipped = self.wanted()
            except Exception as exc:  # noqa: BLE001
                self.unavailable = f"Hermes's config.yaml could not be read ({exc})"
                return None
            self.servers = servers
            helper = _helper.Helper(HERE / "dist" / "helper.mjs", node=node, env=_helper.helper_env(),
                                    on_request=_no_requests,
                                    log_path=state / "helper-stderr.log")
            try:
                helper.request("initialize", {"state": str(state), "servers": servers, "skipped": skipped}, timeout=30)
            except Exception as exc:  # noqa: BLE001
                helper.close()
                self.unavailable = f"the helper did not start ({exc})"
                return None
            self.helper = helper
            self.started_with = (servers, skipped)
            self.unavailable = ""
        _helper.spawn(self.refresh)
        return helper

    def refresh(self) -> None:
        helper = self.helper
        if helper is None:
            return
        try:
            r = helper.request("stubs", {"waitMs": 30000}, timeout=60)
            self.register_stubs((r or {}).get("stubs") or [])
        except Exception as exc:  # noqa: BLE001
            logger.debug("mcp-skills: stubs not refreshed: %s", exc)

    def request(self, method: str, params: dict, timeout: float = 120) -> Any:
        helper = self.ensure()
        if helper is None:
            raise RuntimeError(f"mcp-skills cannot run: {self.unavailable}")
        return helper.request(method, params, timeout=timeout)

    def call(self, name: str, args: dict, kwargs: dict) -> str:
        key = _session_key(kwargs)
        try:
            r = self.request("call", {"name": name, "arguments": args, "session": key})
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": str(exc)})
        if name == "load_skill" and not (r or {}).get("isError") and key:
            self.hold(key, str(args.get("server") or ""), str(args.get("uri") or ""))
        if isinstance((r or {}).get("stubs"), list):
            self.register_stubs(r["stubs"])
        text = str((r or {}).get("text", ""))
        return json.dumps({"error": text} if (r or {}).get("isError") else {"result": text}, ensure_ascii=False)

    def show(self, raw_args: str) -> str:
        """``/mcp-skills show <server> <uri>``: the skill's SKILL.md for the person, checked against its
        digest. A slash command's answer goes to the person; the model never sees it (rule X13b)."""
        parts = (raw_args or "").split()
        if len(parts) != 3 or parts[0] != "show":
            return ("Usage: /mcp-skills show <server> <skill URI>. It shows a served skill's SKILL.md to you, "
                    "not to the model, before you decide whether to load it. list_skills names each skill's server and URI.")
        try:
            r = self.request("preview", {"server": parts[1], "uri": parts[2]}, timeout=60)
        except Exception as exc:  # noqa: BLE001
            return f"mcp-skills can't show it: {exc}."
        if not isinstance(r, dict) or not isinstance(r.get("text"), str):
            return f"mcp-skills can't show it: {(r or {}).get('refuse') if isinstance(r, dict) else 'no answer'}."
        return r["text"]

    def close(self) -> None:
        with self._lock:
            helper, self.helper = self.helper, None
        if helper is not None:
            helper.close()


def register(ctx) -> None:
    try:
        from hermes_constants import get_hermes_home  # published (hermes_constants); the profile being loaded
        home: Optional[Path] = Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        home = None
    rt = Runtime(ctx, home)
    # The skills found the last time the gateway ran: listed from the first session on.
    rt.register_saved()

    for tool in WORDS["tools"]:
        name = tool["name"]
        schema = {"name": name, "description": tool["description"], "parameters": tool["parameters"]}

        def handler(params, _name=name, **kwargs):
            return rt.call(_name, params if isinstance(params, dict) else {}, kwargs)

        if ctx.register_tool(name=name, toolset=PLUGIN_ID, schema=schema, handler=handler, emoji="🧩") is None:
            logger.warning("mcp-skills: the tool name %s is taken; that tool is not available", name)

    def pre_tool_call(tool_name=None, args=None, **kwargs):
        a = args if isinstance(args, dict) else {}
        def turned_off(server: str, uri: str) -> Optional[dict]:
            stub = rt.stub_for(server, uri)
            if stub is not None:
                disabled = _disabled_names()
                if stub["name"] in disabled or f"{PLUGIN_ID}:{stub['name']}" in disabled:
                    return {"action": "block", "message": (f"The user turned off the skill {PLUGIN_ID}:{stub['name']} in Hermes "
                                                           "(skills.disabled), so it is not loaded and none of its files is read.")}
            return None

        if tool_name in SKILL_TOOLS:
            server = str(a.get("server") or "")
            uri = str(a.get("uri") if tool_name == "load_skill" else a.get("skill") or "")
            off = turned_off(server, uri)
            if off:
                return off
            if tool_name != "load_skill":
                return None
            key = _session_key(kwargs)
            if not key:
                return {"action": "block", "message": ("The skill is not loaded: Hermes did not say which session this call "
                                                       "is from, so what it loads couldn't be tracked (rule X8).")}
            bypass = approvals_bypassed(key)
            if bypass:
                return {"action": "block", "message": (f"The skill is not loaded: {bypass}, and a served skill is loaded only "
                                                       "with the user's own yes (rule X5). This needs a session where Hermes "
                                                       "asks the user: not --yolo, /yolo, hermes -z or approvals.mode: off.")}
            try:
                r = rt.request("prepare_load", {"session": key, "server": server, "uri": uri}, timeout=25)
            except Exception as exc:  # noqa: BLE001
                return {"action": "block", "message": f"The skill is not loaded: {exc}."}
            if not isinstance(r, dict) or r.get("refuse"):
                why = (r or {}).get("refuse") if isinstance(r, dict) else "no answer"
                return {"action": "block", "message": f"The skill is not loaded: {why}."}
            # The skill the server resolved that URI to: one the user turned off, spelled another way, stays off.
            off = turned_off(server, str(r.get("uri") or uri))
            if off:
                return off
            return {"action": "approve", "message": str(r.get("message") or ""), "rule_key": str(r.get("rule_key") or "")}

        key = _session_key(kwargs)
        targets = resource_read_servers(str(tool_name or ""), rt.known_servers(key), a)
        if targets is not None:
            uri = str(a.get("uri") or "")
            if len(targets) == 1:
                target = "the MCP server " + json.dumps(targets[0], ensure_ascii=False)
            elif targets:
                target = ("one of the MCP servers " + ", ".join(json.dumps(t, ensure_ascii=False) for t in targets)
                          + " (Hermes gives their tools the same name)")
            else:
                target = f"an MCP server mcp-skills can't tell from the tool's name ({tool_name})"
            # A served skill's own files are read with load_skill and read_skill_file, which ask the user
            # and check every file against the server's digests. Hermes's generic resource tool does
            # neither, so it doesn't read them: a skill:// URI, or one under a skill the server lists.
            served = [st for st in rt.stubs if str(st.get("server") or "") in targets]
            roots = [str(st.get("uri") or "").rsplit("/", 1)[0] + "/" for st in served]
            # And every skill this session loaded, listed or not (one loaded by its URI alone).
            roots += [root for server, root in (rt.held_roots(key) if key else []) if server in targets]
            if uri.startswith("skill://") or any(uri == st.get("uri") for st in served) or any(uri.startswith(root) for root in roots):
                return {"action": "block", "message": (
                    "That resource is part of a skill an MCP server serves. Load the skill with load_skill (Hermes asks the "
                    "user first) and read its files with read_skill_file, which checks each against the server's digests.")}
            # A resource read while this session has a served skill loaded (rule X8): another server's needs a
            # yes. Where the plugin can't tell what the session loaded, every read does.
            held = rt.held_servers(key) if key else (None if rt.anything_held() else [])
            resource = json.dumps(str(a.get("uri") or ""), ensure_ascii=False)
            if held is None:
                question = (f"mcp-skills can't tell which served skills this session loaded, so it asks before every "
                            f"resource read. The model wants to read the resource {resource} from {target}. "
                            "Allow this one read?")
            else:
                # Not asked only where the read is surely from the server the session's skills came from.
                same = len(targets) == 1 and all(s == targets[0] for s in held)
                names = ", ".join(json.dumps(s, ensure_ascii=False) for s in held)
                question = (f"This session loaded a skill served by the MCP server {names}. The model now wants to read "
                            f"the resource {resource} from {target}, which may be a different MCP server. Allow this "
                            "one read?") if held and not same else ""
            if question:
                bypass = approvals_bypassed(key)
                if bypass:
                    return {"action": "block", "message": (f"This read is refused: {bypass}, and while a served skill is loaded "
                                                           "a read from another server needs the user's own yes (rule X8).")}
                try:
                    message = _servers.shown(question)
                except ValueError as exc:
                    return {"action": "block", "message": f"This read can't be put to the user: {exc}."}
                return {"action": "approve",
                        "message": message,
                        # A fresh random key for each call: no kept approval can match another read.
                        "rule_key": f"{PLUGIN_ID}:cross:{secrets.token_hex(16)}"}
        return None

    def on_session_open(**kwargs):
        # A local session opened: start the helper (once), which looks at the servers and refreshes the skill list.
        _helper.spawn(rt.ensure if rt.helper is None else rt.refresh)

    def pre_llm_call(**kwargs):
        # A turn starts: the configuration is read again (a server granted or revoked is picked up). Where no
        # session open was seen (Hermes's stdio gateway fires none), the first turn starts the helper.
        if rt.restart_if_changed() or rt.helper is None:
            _helper.spawn(rt.ensure)
        return None

    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    try:
        ctx.register_command(PLUGIN_ID, rt.show, description="Show a served skill's SKILL.md to you, not the model",
                             args_hint="show <server> <skill URI>")
    except Exception as exc:  # noqa: BLE001
        logger.warning("mcp-skills: no /%s command (%s)", PLUGIN_ID, exc)
    ctx.register_hook("on_session_open", on_session_open)
    try:
        ctx.register_system_prompt_section("mcp-skills", WORDS["instructions"])
    except Exception as exc:  # noqa: BLE001
        logger.debug("mcp-skills: no system prompt section (%s)", exc)
    ctx.on_unload(rt.close)
    return rt
