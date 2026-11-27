"""Manage this checkout's named A2A connections in a host profile."""

import argparse
import asyncio
import json
import shlex
import subprocess
import sys
from pathlib import Path

from agentpolyfill_a2a.agent import AdapterError, origin
from agentpolyfill_a2a.server import INFO, REV, serve
from configure import (
    HERE, HOSTS, Config, SetupError, argv_of, credential_args, host_path,
    owned_agent, profile_lock, remove, section, setup,
)

AUTH_FLAGS = ("--serve-credentials", "--bearer-file", "--bearer-env")


def named_connections(host, base, path):
    """List only adapter-owned names and destinations. Never read credentials."""
    entries = Config(path).data.get(section(host), {})
    result = []
    for name, entry in sorted(entries.items()):
        if owned_agent(entry, base, name):
            argv = argv_of(entry)
            url = option(argv, "--url")
            origin(url)
            result.append({"name": name, "url": url})
    return result


def option(args, flag):
    if args.count(flag) != 1 or args.index(flag) + 1 >= len(args):
        raise SetupError(f"Expected a single {flag} value in the managed agent entry.")
    return args[args.index(flag) + 1]


def edit(host, name, url, credentials=None, token_file=None, clear_auth=False):
    base, path = host_path(host)
    config = Config(path)
    entry = config.data.get(section(host), {}).get(name)
    if not owned_agent(entry, base, name):
        raise SetupError(f"No connection named {name!r} belongs to this installation.")
    argv = list(argv_of(entry))
    previous = option(argv, "--url")
    destination = previous if url is None else url
    origin(destination)
    new_auth = credential_args(credentials, token_file)
    old_flags = [flag for flag in AUTH_FLAGS if flag in argv]
    moved = previous.rstrip("/") != destination.rstrip("/")
    if moved or clear_auth or new_auth:
        for flag in old_flags:
            option(argv, flag)
            index = argv.index(flag)
            del argv[index:index + 2]
        argv.extend(new_auth)
    argv[argv.index("--url") + 1] = destination
    if isinstance(entry["command"], list):
        entry["command"] = argv
    else:
        entry["args"] = argv[1:]
    config.save()
    print(f"Saved {name} for {host} at {destination}. Reload the host to use the change.")
    if moved and old_flags and not new_auth:
        print("The previous destination's credentials were disconnected.")


def settings_command(host, base, path):
    # A command copied from chat must target that chat's profile, including overrides.
    roots = {"codex": "CODEX_HOME", "pi": "PI_CODING_AGENT_DIR", "hermes": "HERMES_HOME",
             "copilot": "COPILOT_HOME", "antigravity": "ANTIGRAVITY_CONFIG_DIR"}
    if host == "claude":
        env = ([f"CLAUDE_CONFIG_DIR={base}"] if path.parent == base
               else ["-u", "CLAUDE_CONFIG_DIR", f"HOME={path.parent}"])
    elif host == "antigravity" and base.parts[-2:] == (".gemini", "config"):
        env = [f"HOME={base.parent.parent}", f"ANTIGRAVITY_CONFIG_DIR={base}"]
    elif host == "opencode":
        env = [f"XDG_CONFIG_HOME={base.parent}", f"OPENCODE_CONFIG={path}"]
    else:
        env = [f"{roots[host]}={base}"]
    return shlex.join(["env", *env, str(HERE / "agents"), host])


class Directory:
    """A read-only MCP catalog. Configuration changes belong to the local user."""
    legacy_initialized = False

    def __init__(self, host, base, path, marketplace=False):
        self.marketplace = marketplace
        self.host, self.base, self.path = host, base, path

    async def dispatch(self, method, params):
        version = params.get("_meta", {}).get("io.modelcontextprotocol/protocolVersion")
        if version is not None and version != REV:
            raise AdapterError("Unsupported protocol version.", -32022, {"supported": [REV], "requested": version})
        if method == "initialize":
            self.legacy_initialized = True
            return {"protocolVersion": "2025-11-25", "serverInfo": INFO, "capabilities": {"tools": {}}}
        if method == "server/discover":
            return {"supportedVersions": [REV], "capabilities": {"tools": {}}, "ttlMs": 0, "cacheScope": "private"}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [{
                "name": "list_agents", "description": "List the A2A agents configured for this host.",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
                "annotations": {"readOnlyHint": True},
            }]}
        if method == "tools/call" and params.get("name") == "list_agents":
            if params.get("arguments", {}) != {}:
                raise AdapterError("list_agents takes no arguments.")
            agents = named_connections(self.host, self.base, self.path)
            settings = (shlex.quote(str(Path(sys.executable).parent / "a2a-agents")) if self.marketplace
                        else settings_command(self.host, self.base, self.path))
            return {"content": [{"type": "text", "text": json.dumps({
                "agents": agents, "manageLocally": settings,
            })}]}
        raise AdapterError("Unknown directory method or tool.", -32601)


def show(host):
    agents = named_connections(host, *host_path(host))
    if not agents:
        print("No A2A agents configured.")
    for agent in agents:
        print(f"{agent['name']}\t{agent['url']}")


def credentials(parser, editing=False):
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--serve-credentials", metavar="EXECUTABLE")
    auth.add_argument("--bearer-file", metavar="PATH")
    if editing:
        auth.add_argument("--clear-auth", action="store_true", help="Remove the stored credential reference")


def apply(args, marketplace=False):
    if args.action == "list":
        show(args.host)
        return
    with profile_lock(args.host):
        if args.action == "add":
            setup(args.host, args.name, args.url, "existing" if marketplace else None,
                  args.serve_credentials, args.bearer_file, marketplace=marketplace)
        elif args.action == "edit":
            if not any((args.url, args.serve_credentials, args.bearer_file, args.clear_auth)):
                raise SetupError("Choose a URL or a credential change to save.")
            edit(args.host, args.name, args.url, args.serve_credentials, args.bearer_file, args.clear_auth)
        elif args.action == "remove":
            remove(args.host, args.name)


def interactive(host, parser, marketplace=False):
    while True:
        show(host)
        action = input("Add, edit, remove, or quit? ").strip().lower()
        if action in ("q", "quit", ""):
            return
        if action not in ("add", "edit", "remove"):
            continue
        name = input("Agent name: ").strip()
        # Everything entered here goes through the same validation as the scripted commands.
        command = [host, action, name]
        if action in ("add", "edit"):
            url = input("Agent URL" + (" (blank to keep)" if action == "edit" else "") + ": ").strip()
            if url or action == "add":
                command.extend(["--url", url])
            choice = input("Credentials (bearer, serve, none, or blank for default): ").strip().lower()
            if choice in ("bearer", "serve"):
                flag = "--bearer-file" if choice == "bearer" else "--serve-credentials"
                command.extend([flag, input("Local file path: ").strip()])
            elif choice == "none" and action == "edit":
                command.append("--clear-auth")
            elif choice not in ("", "none"):
                print("Unknown credential choice.")
                continue
        elif input(f"Remove {name}? [y/N] ").strip().lower() != "y":
            continue
        try:
            apply(parser.parse_args(command), marketplace)
        except (SetupError, AdapterError, OSError, ValueError, subprocess.CalledProcessError) as exc:
            print(f"Could not save: {exc}", file=sys.stderr)


def main():
    if sys.argv[1:] == ["--marketplace-directory"]:
        base, path = host_path("codex")
        asyncio.run(serve(Directory("codex", base, path, marketplace=True)))
        return
    marketplace = sys.argv[1:3] == ["--marketplace-settings", "codex"]
    if marketplace:
        del sys.argv[1]
    if sys.argv[1:2] == ["--catalog"] and len(sys.argv) == 6:
        _, _, host, base, path, _mode = sys.argv
        asyncio.run(serve(Directory(host, Path(base), Path(path))))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=HOSTS)
    actions = parser.add_subparsers(dest="action")
    actions.add_parser("list", help="Show configured names and destinations")
    add = actions.add_parser("add", help="Connect another agent")
    add.add_argument("name")
    add.add_argument("--url", required=True)
    credentials(add)
    change = actions.add_parser("edit", help="Update an existing connection")
    change.add_argument("name")
    change.add_argument("--url")
    credentials(change, editing=True)
    delete = actions.add_parser("remove", help="Disconnect one named agent")
    delete.add_argument("name")
    args = parser.parse_args()
    try:
        if args.action:
            apply(args, marketplace)
        elif sys.stdin.isatty():
            interactive(args.host, parser, marketplace)
        else:
            show(args.host)
            parser.print_help()
    except (KeyboardInterrupt, EOFError):
        return
    except (SetupError, AdapterError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Agent settings: {exc}\n")


if __name__ == "__main__":
    main()
