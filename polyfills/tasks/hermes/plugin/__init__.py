"""User-operated SEP-2663 tasks. Hermes binds the choice UI to the command thread."""
import json
import os
from pathlib import Path
from queue import Queue, Empty
from threading import Event, Lock
from uuid import NAMESPACE_URL, uuid4, uuid5

from . import _helper, _servers

USAGE = ('/mcp-tasks servers | list | start SERVER TOOL {"arg":"value"} | '
         'get ID | result ID | cancel ID | input ID [JSON answer]')
COMMANDS = {"servers": "list_task_servers", "list": "list_tasks", "start": "start_task",
            "get": "get_task", "result": "get_task_result", "input": "provide_task_input", "cancel": "cancel_task"}


def parse(raw):
    action, _, rest = raw.strip().partition(" ")
    if action not in COMMANDS:
        raise ValueError(USAGE)
    if action == "start":
        server, tool, *tail = rest.split(maxsplit=2)
        args = json.loads(tail[0]) if tail else {}
        if not isinstance(args, dict):
            raise ValueError("Task arguments must be a JSON object.")
        return COMMANDS[action], {"server": server, "tool": tool, "arguments": args}, None
    if action in ("servers", "list") and not rest:
        return COMMANDS[action], {}, None
    tid, _, answer = rest.strip().partition(" ")
    if not tid or (answer and action != "input"):
        raise ValueError(USAGE)
    return COMMANDS[action], {"task": tid}, json.loads(answer) if answer else None


def register(ctx):
    if os.environ.get("MCP_TASKS_OFF") == "1":
        return
    from gateway.session_context import get_session_env
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    sessions = {}
    requests = {}
    lock = Lock()
    stopping = Event()

    def grants():
        _servers.check_profile(home)
        config = _servers.raw_config()
        raw = config.get("mcp_servers") or {}
        entry = ((config.get("plugins") or {}).get("entries") or {}).get("mcp-tasks") or {}
        stored = _servers.names((entry.get("settings") or {}).get("servers"))
        granted = [name for name in _servers.names(ctx.get_config("servers", [])) if name in stored]
        servers, skipped = _servers.read_servers("mcp-tasks", granted, servers=raw)
        # A configured tool filter belongs to the host and also applies to a second connection.
        for name in list(servers):
            if any(k in raw.get(name, {}) for k in ("tools", "enabled_tools", "disabled_tools", "include_tools", "exclude_tools")):
                del servers[name]
                skipped[name] = "This server has a host tool filter."
        return {"servers": servers, "skipped": skipped}

    def drop_revoked(**kwargs):
        try:
            table = grants()
        except Exception:
            table = None
        with lock:
            retired = [sessions.pop(key)[0] for key in list(sessions) if sessions[key][1] != table]
        for child in retired:
            child.close()

    def helper(key):
        table = grants()
        drop_revoked()
        with lock:
            old = sessions.get(key)
            if old and not old[0].closed and old[1] == table:
                return old[0]
            def host(method, params):
                if grants() != table:
                    return {"unavailable": "MCP server grants changed."} if method == "ask" else False
                if method == "wake":
                    if not _servers.injection_allowed(_servers.raw_config(), "mcp-tasks"):
                        return False
                    return bool(ctx.inject_message(params["text"] + "\nUse /mcp-tasks input or result with the local task ID.",
                                                   role="user", session_key=key))
                if method != "ask":
                    raise ValueError("Unknown Tasks request")
                with lock:
                    request = requests.get((key, params["id"]))
                if request is None:
                    return {"action": "cancel"}
                reply = Queue(maxsize=1)
                request.put(("ask", (params, reply)))
                try:
                    decision = reply.get(timeout=110)
                except Empty:
                    return {"action": "cancel"}
                return decision if grants() == table else {"unavailable": "MCP server grants changed."}
            node, why = _helper.find_node()
            if not node:
                raise ValueError(why)
            child = _helper.Helper(Path(__file__).parent / "dist" / "helper.mjs", node=node,
                                   env=_helper.helper_env(), on_request=host)
            thread = str(uuid5(NAMESPACE_URL, "hermes-session:" + key))
            try:
                child.request("initialize", {"base": str(home / "mcp-tasks" / thread), "thread": thread, "table": table})
            except Exception:
                child.close()
                raise
            sessions[key] = (child, table)
            return child

    def command(raw):
        key = get_session_env("HERMES_SESSION_KEY", "")
        if not key:
            return "Hermes did not identify this session."
        try:
            tool, args, typed = parse(raw)
            child = helper(key)
        except Exception as exc:
            return str(exc)
        rid = uuid4().hex
        events = Queue()
        with lock:
            requests[(key, rid)] = events
        def call():
            try:
                result = child.request("call", {"tool": tool, "args": args, "id": rid}, timeout=122)
                events.put(("done", result["text"] + "".join("\n" + json.dumps(b, ensure_ascii=False) for b in result.get("content", []))))
            except Exception as exc:
                events.put(("done", str(exc)))
        _helper.spawn(call, name="hermes-mcp-task-call")
        try:
            while True:
                event, value = events.get(timeout=125)
                if event == "done":
                    return value
                question, reply = value
                kind = question["kind"]
                message = question["message"]
                if kind == "input":
                    if not isinstance(typed, dict):
                        reply.put({"unavailable": message + "\n" + json.dumps(question["schema"]) +
                                   "\nUse /mcp-tasks input " + args["task"] + " followed by a JSON object."})
                        continue
                    message += "\nYour answer: " + json.dumps(typed, ensure_ascii=True)
                try:
                    choice = ctx.ask_choice(_servers.shown(message, 6000), ["Decline", "Approve"])
                except Exception:
                    choice = None
                if choice != "Approve":
                    reply.put({"action": "decline" if choice == "Decline" else "cancel"})
                else:
                    content = typed if kind == "input" else {"decision": "start" if kind == "start" else "accept"}
                    reply.put({"action": "accept", "content": content})
                if kind == "input":
                    typed = None
        except Empty:
            return "Hermes did not complete the task request."
        finally:
            with lock:
                requests.pop((key, rid), None)

    def resume(**kwargs):
        drop_revoked()
        key = get_session_env("HERMES_SESSION_KEY", "") or kwargs.get("session_id")
        if not key or kwargs.get("parent_session_id"):
            return
        thread = str(uuid5(NAMESPACE_URL, "hermes-session:" + key))
        if (home / "mcp-tasks" / thread / "threads" / thread).is_dir():
            helper(key)

    def watch_config():
        last = None
        while not stopping.wait(1):
            try:
                stat = (home / "config.yaml").stat()
                stamp = (stat.st_ino, stat.st_mtime_ns)
            except OSError:
                stamp = ()
            if last != stamp:
                drop_revoked()
                last = stamp

    def close():
        stopping.set()
        with lock:
            children = list(sessions.values())
            sessions.clear()
        for child, _ in children:
            child.close()
    ctx.register_command("mcp-tasks", command, description="Run and answer MCP tasks", args_hint=USAGE)
    ctx.register_hook("pre_llm_call", resume)
    ctx.register_hook("on_session_open", resume)
    _helper.spawn(watch_config, name="hermes-mcp-task-grants")
    ctx.on_unload(close)
