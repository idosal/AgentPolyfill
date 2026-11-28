"""Review and apply a Codex marketplace connection change in the selected profile."""
import hashlib
import io
import json
import re
import shlex
import sys
from contextlib import redirect_stdout
from pathlib import Path

from agentpolyfill_a2a.agent import AdapterError, origin
from agentpolyfill_a2a.server import plugin_enabled
from configure import Config, SetupError, argv_of, host_path, owned_agent, profile_lock, remove, setup
from manage import edit, named_connections, option


def change(request):
    base, path = host_path("codex")
    if not plugin_enabled(path):
        raise SetupError("A2A is disabled in this profile.")
    action = request["action"]
    if action == "list_agents":
        return {"agents": named_connections("codex", base, path),
                "manageLocally": shlex.quote(str(Path(sys.executable).parent / "a2a-agents"))}
    args = request.get("arguments")
    if action not in {"add_agent", "edit_agent", "remove_agent"} or not isinstance(args, dict):
        raise SetupError("Unknown settings action.")
    if args.keys() - ({"name"} if action == "remove_agent" else {"name", "url", "auth"}):
        raise SetupError("Unexpected agent setting.")
    name, url, auth = args.get("name"), args.get("url"), args.get("auth")
    if (not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", name)
            or name in {"mcp-tasks", "a2a-directory"}):
        raise SetupError("Choose a short lowercase agent name. The plugin server names are reserved.")
    if action == "add_agent" or "url" in args:
        if not isinstance(url, str) or len(url) > 2048 or not url.isascii():
            raise SetupError("Use an ASCII agent URL of up to 2048 characters. Encode international names and paths.")
        origin(url)
    if ("auth" in args and auth not in ("none", "serve")) or (action == "edit_agent" and url is None and auth is None):
        raise SetupError("Choose a destination or an authentication change.")
    with profile_lock("codex"):
        entry = Config(path).data.get("mcp_servers", {}).get(name)
        if action == "add_agent" and entry is not None:
            raise SetupError("That name is already in use.")
        if action != "add_agent" and not owned_agent(entry, base, name):
            raise SetupError("That connection does not belong to this A2A installation.")
        previous = option(argv_of(entry), "--url") if entry else None
        description = [f"{action.split('_')[0].capitalize()} A2A connection {name}."]
        if previous:
            description.append(f"Current destination: {ascii(previous)}")
        if action != "remove_agent":
            description.append(f"New destination: {ascii(url or previous)}")
            moved = previous and url and previous.rstrip("/") != url.rstrip("/")
            auth_note = ("use the local A2A Serve pairing" if auth == "serve" else
                         "no credentials" if auth == "none" or moved or not previous else "keep current credentials")
            description.append(f"Authentication: {auth_note}.")
        digest = hashlib.sha256(json.dumps([action, args, entry], sort_keys=True).encode()).hexdigest()
        if "review" not in request:
            return {"review": digest, "message": "\n".join(description)}
        if request["review"] != digest:
            raise SetupError("This connection changed while the form was open. Review the current settings again.")
        helper = "a2a-serve" if auth == "serve" else None
        # This private command accepts no credential paths or executable names from chat.
        with redirect_stdout(io.StringIO()):
            if action == "add_agent":
                setup("codex", name, url, "existing", helper, marketplace=True)
            elif action == "edit_agent":
                edit("codex", name, url, helper, clear_auth=auth == "none")
            else:
                remove("codex", name)
        return {"message": f"Connection {name} {'removed' if action == 'remove_agent' else 'saved'}."}


if __name__ == "__main__":
    try:
        print(json.dumps(change(json.load(sys.stdin))))
    except (SetupError, AdapterError, ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}))
