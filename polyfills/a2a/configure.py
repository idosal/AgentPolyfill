"""Install A2A in a host profile, optionally registering the first agent."""

import argparse
import fcntl
import io
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import tomlkit
from agentpolyfill_a2a.agent import AdapterError, origin
from ruamel.yaml import YAML

HERE = Path(__file__).resolve().parent
TASKS = HERE.parent / "tasks"
REPO = HERE.parent.parent
HOSTS = ("codex", "pi", "t3", "opencode", "hermes", "copilot", "claude", "antigravity")


class SetupError(Exception):
    pass


def profile(variable, default):
    return Path(os.environ.get(variable) or default).expanduser().absolute()


class Config:
    """Round-trip the selected profile. Check for concurrent host writes before replacing it."""

    def __init__(self, path):
        self.path = path.resolve()
        self.before = self.path.read_bytes() if self.path.exists() else None
        raw = (self.before or b"").decode()
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
        if path.suffix == ".toml":
            self.data = tomlkit.parse(raw)
        elif path.suffix == ".yaml":
            self.data = self.yaml.load(raw) if raw.strip() else {}
        else:
            self.data = json.loads(raw) if raw.strip() else {}
        if not isinstance(self.data, dict):
            raise SetupError(f"Expected a configuration object in {path}")
        self.initial = self.render()

    def render(self):
        if self.path.suffix == ".toml":
            return tomlkit.dumps(self.data)
        if self.path.suffix == ".yaml":
            stream = io.StringIO()
            self.yaml.dump(self.data, stream)
            return stream.getvalue()
        return json.dumps(self.data, ensure_ascii=False, indent=2) + "\n"

    def save(self):
        new = self.render()
        if new == self.initial:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=self.path.parent, delete=False) as dest:
            tmp = Path(dest.name)
        try:
            tmp.write_text(new)
            if self.path.exists():
                tmp.chmod(stat.S_IMODE(self.path.stat().st_mode))
            current = self.path.read_bytes() if self.path.exists() else None
            if current != self.before:
                raise SetupError(f"{self.path} changed during setup. Rerun the installer.")
            tmp.replace(self.path)
        finally:
            tmp.unlink(missing_ok=True)


def table(parent, name):
    value = parent.setdefault(name, {})
    if not isinstance(value, dict):
        raise SetupError(f"Expected an object for {name}")
    return value


def register(entries, name, value):
    if name in entries:
        if entries[name] == value:
            return
        raise SetupError(f"The entry {name!r} already exists with other settings. Choose a new name.")
    entries[name] = value


def include(parent, key, value):
    items = parent.setdefault(key, [])
    if not isinstance(items, list):
        raise SetupError(f"Expected an array for {key}")
    if value not in items:
        items.append(value)


def copilot_tasks():
    cli = shutil.which("copilot")
    if not cli:
        raise SetupError("Install GitHub Copilot CLI to enable its Tasks extension.")

    def query(*args):
        return json.loads(subprocess.check_output([cli, "plugin", *args, "--json"], text=True))

    for plugin in query("list"):
        if (
            plugin["name"] == "mcp-tasks"
            and plugin.get("marketplace") == "agent-polyfill"
            and plugin.get("enabled")
        ):
            return
    market = next((m for m in query("marketplace", "list") if m["name"] == "agent-polyfill"), None)
    if market and market["source"] != f"Local: {REPO}":
        raise SetupError("Enable mcp-tasks in your existing AgentPolyfill marketplace, then rerun setup.")
    if not market:
        subprocess.run([cli, "plugin", "marketplace", "add", str(REPO)], check=True)
    subprocess.run([cli, "plugin", "install", "mcp-tasks@agent-polyfill"], check=True)


def antigravity_hook(base, name, entry):
    # agy plugin install/uninstall selects its target from HOME, even if MCP config is overridden.
    if base.resolve() != (Path.home() / ".gemini/config").resolve():
        raise SetupError("Select the target Antigravity HOME before managing its approval plugins.")
    node = shutil.which("node")
    if not node:
        raise SetupError("Antigravity's permission hook needs Node 22.18 or newer.")
    version = subprocess.check_output([node, "-p", "process.versions.node"], text=True).strip()
    if tuple(int(part) for part in version.split(".")[:2]) < (22, 18):
        raise SetupError(f"Antigravity's permission hook needs Node 22.18 or newer. Found {version}.")
    js = str(HERE / "antigravity/approval.mjs")
    state = base / "agentpolyfill-a2a" / name
    command = [node, js]
    entry["args"] += ["--approval-hook", *command, "--agent-name", name]
    # Antigravity loads eager tools and runs these hooks in its CLI and App.
    tools = ("confirm_delegation", "answer_delegation")
    entry["tools"] = {tool: {"eager": True} for tool in ("delegate", "resume_delegation", *tools)}
    plugin = f"a2a-review-{name}"
    folder = base / "plugins" / plugin

    def hook(mode):
        return {"type": "command", "command": shlex.join([*command, mode, name, str(state)]), "timeout": 15}

    files = {
        "plugin.json": {
            "name": plugin,
            "version": "0.1.0",
            "displayName": f"A2A approvals for {name}",
            "description": f"Review outgoing messages and answers for {name} in Antigravity.",
        },
        "hooks.json": {
            plugin: {
                "PreToolUse": [{"matcher": f"mcp_{name}_({'|'.join(tools)})", "hooks": [hook("check")]}],
                "PreInvocation": [hook("stop")],
                "Stop": [hook("stop")],
            }
        },
    }
    # The CLI's local install creates exactly this directory. Never adopt another plugin's files.
    if folder.exists() and not all(
        (folder / key).is_file() and json.loads((folder / key).read_text()) == value
        for key, value in files.items()
    ):
        raise SetupError(f"A different Antigravity approval plugin already exists at {folder}.")

    def install():
        if folder.exists():
            return
        if not shutil.which("agy"):
            raise SetupError("Install the Antigravity CLI to register its approval plugin.")
        with tempfile.TemporaryDirectory() as tmp:
            for key, value in files.items():
                (Path(tmp) / key).write_text(json.dumps(value, indent=2))
            subprocess.run(["agy", "plugin", "install", tmp], check=True)
        if not (folder / "hooks.json").is_file():
            raise SetupError("Antigravity installed into a different profile. Select the target host's HOME.")

    return install


def host_path(host):
    home = Path.home()
    if host == "claude":
        base = profile("CLAUDE_CONFIG_DIR", home / ".claude")
        path = base / ".claude.json" if os.environ.get("CLAUDE_CONFIG_DIR") else home / ".claude.json"
    elif host in {"pi", "t3"}:
        base = profile("PI_CODING_AGENT_DIR", home / ".pi/agent")
        path = base / "mcp.json"
    elif host == "opencode":
        base = profile("XDG_CONFIG_HOME", home / ".config") / "opencode"
        path = profile("OPENCODE_CONFIG", base / "opencode.json")
        alternatives = [base / "opencode.jsonc", base / "config.json"]
        if not os.environ.get("OPENCODE_CONFIG") and any(p.exists() for p in alternatives):
            raise SetupError(
                "Set OPENCODE_CONFIG to the active JSON profile to avoid shadowing another configuration."
            )
    else:
        roots = {
            "codex": ("CODEX_HOME", home / ".codex", "config.toml"),
            "copilot": ("COPILOT_HOME", home / ".copilot", "mcp-config.json"),
            "hermes": ("HERMES_HOME", home / ".hermes", "config.yaml"),
            "antigravity": ("ANTIGRAVITY_CONFIG_DIR", home / ".gemini/config", "mcp_config.json"),
        }
        var, default, filename = roots[host]
        base = profile(var, default)
        path = base / filename

    return base, path


def section(host):
    return {"codex": "mcp_servers", "hermes": "mcp_servers", "opencode": "mcp"}.get(host, "mcpServers")


@contextmanager
def profile_lock(host):
    base, _ = host_path(host)
    folder = base / "agentpolyfill-a2a"
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (folder / ".settings.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def credential_args(credentials, token_file):
    if credentials and token_file:
        raise SetupError("Select one credential source.")
    if credentials:
        binary = shutil.which(credentials)
        if not binary or not Path(binary).is_file():
            raise SetupError("Provide the path to the installed A2A Serve executable.")
        return ["--serve-credentials", str(Path(binary).absolute())]
    if token_file:
        path = Path(token_file).expanduser().resolve(strict=True)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise SetupError("Use an owner-only file containing the agent bearer token.")
        return ["--bearer-file", str(path)]
    return []


def local_entry(host, command, args, tools):
    if host == "opencode":
        return {"type": "local", "command": [command, *args]}
    entry = {"command": command, "args": args}
    if host == "copilot":
        entry.update(type="local", tools=tools)
    elif host == "claude":
        entry["type"] = "stdio"
    return entry


def argv_of(entry):
    if not isinstance(entry, dict):
        return []
    command = entry.get("command")
    if isinstance(command, list):
        return command
    args = entry.get("args", [])
    if isinstance(command, str) and isinstance(args, list):
        return [command, *args]
    return []


def owned_agent(entry, base, name):
    argv = argv_of(entry)
    binary = str(Path(sys.executable).parent / "agentpolyfill-a2a")
    expected = ["--state-dir", str(base / "agentpolyfill-a2a" / name)]
    return (argv[:1] == [binary] and "--url" in argv and
            any(argv[i:i + 2] == expected for i in range(len(argv))))


MODES = ("auto", "native", "existing", "polyfill")


def directory_command(host, base, path):
    # T3's Pi provider shares Pi's actual config, including this directory.
    return [sys.executable, str(HERE / "manage.py"), "--catalog",
            "pi" if host == "t3" else host, str(base), str(path)]


def directory_settings(host, servers, base, path):
    command = directory_command(host, base, path)
    for key, entry in servers.items():
        argv = argv_of(entry)
        if argv[:-1] == command and argv[-1] in MODES:
            return key, argv[-1]
    return None, None


def setup(host, name, url, mode, credentials=None, token_file=None, *, install_directory=False, marketplace=False):
    if name is not None:
        origin(url)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", name) or name == "mcp-tasks" or (marketplace and name == "a2a-directory"):
            raise SetupError("Choose a short lowercase agent name starting with a letter; choose a name other than the plugin servers.")
    # Keep task handles isolated even for two different host profiles using the same agent.
    configs = []
    actions = []

    def config(path):
        file = Config(path)
        configs.append(file)
        return file.data

    base, path = host_path(host)
    data = config(path)
    servers = table(data, section(host))
    directory, saved_mode = directory_settings(host, servers, base, path)
    mode = mode or saved_mode or "auto"
    if host == "claude" and mode == "polyfill":
        raise SetupError("Claude Code uses native Tasks. Use the native or auto setting.")
    native = mode in {"native", "existing"} or (mode == "auto" and host in {"claude", "copilot"})
    prepare_host = install_directory or directory is None
    if install_directory:
        if directory is None:
            directory = "a2a-directory"
            n = 1
            while directory in servers or directory == name:
                n += 1
                directory = f"a2a-directory-{n}"
            cmd = directory_command(host, base, path)
            servers[directory] = local_entry(host, cmd[0], [*cmd[1:], mode], ["list_agents"])
        elif name is None and mode != saved_mode:
            field = "command" if host == "opencode" else "args"
            servers[directory][field][-1] = mode
    if name is not None:
        args = ["--url", url, *credential_args(credentials, token_file),
                "--state-dir", str(base / "agentpolyfill-a2a" / name)]
        if marketplace:
            # Named entries remain in user config when the marketplace plugin is disabled.
            args += ["--codex-plugin-config", str(path)]
        entry = local_entry(host, str(Path(sys.executable).parent / "agentpolyfill-a2a"), args, ["delegate"])
        if host == "antigravity" and not native:
            entry["args"].append("--antigravity")
            actions.append(antigravity_hook(base, name, entry))
        register(servers, name, entry)
    if host == "codex":
        plugins = data.get("plugins", {})
        if prepare_host and not native and not plugins.get("mcp-tasks@agent-polyfill", {}).get("enabled"):
            helper = json.loads((TASKS / "codex/plugin/.mcp.json").read_text())["mcpServers"]["mcp-tasks"]
            helper["cwd"] = str(TASKS / "codex/plugin")
            helper["args"] = [str(TASKS / "codex/plugin/dist/helper.js")]
            register(servers, "mcp-tasks", helper)
    elif host == "opencode":
        if prepare_host and not native:
            include(data, "plugins", str(TASKS / "opencode/plugin"))
    elif host == "hermes":
        if not native:
            plugins = table(data, "plugins")
            if prepare_host:
                include(plugins, "enabled", "mcp-tasks")
            dep = table(table(plugins, "entries"), "mcp-tasks")
            if dep.get("allow_gateway_injection") is False:
                raise SetupError("The Hermes profile explicitly disables Tasks notifications.")
            if prepare_host:
                dep["allow_gateway_injection"] = True
            allowed = table(dep, "settings")
            if name is not None:
                include(allowed, "servers", name)
            else:
                allowed.setdefault("servers", [])
            link = base / "plugins/mcp-tasks"
            source = TASKS / "hermes/plugin"
            if prepare_host and link.resolve() != source:
                if link.exists() or link.is_symlink():
                    # An installed copy must match the shipped plugin before granting it access.
                    if not all(
                        (link / p.relative_to(source)).is_file()
                        and (link / p.relative_to(source)).read_bytes() == p.read_bytes()
                        for p in source.rglob("*")
                        if p.is_file() and "__pycache__" not in p.parts
                    ):
                        raise SetupError("Hermes already has a different mcp-tasks plugin.")
                else:

                    def install_plugin():
                        link.parent.mkdir(parents=True, exist_ok=True)
                        link.symlink_to(source, target_is_directory=True)

                    actions.append(install_plugin)
    else:
        if prepare_host and host == "copilot" and not native:
            actions.append(copilot_tasks)
        if prepare_host and host in {"pi", "t3"} and not native:
            settings = config(base / "settings.json")
            source = str(TASKS / "pi/extension")
            installed = settings.get("packages", [])
            bundled = {
                "git:github.com/idosal/agentpolyfill",
                "https://github.com/idosal/agentpolyfill",
                str(REPO).lower(),
            }
            if not any(
                isinstance(item, str) and item.lower().removesuffix(".git") in bundled for item in installed
            ):
                include(settings, "packages", source)
    for action in actions:
        action()
    for file in reversed(configs):
        file.save()
    if install_directory:
        print(f"A2A is installed for {host}. Manage connections with {shlex.join([str(HERE / 'agents'), host])}.")
    if name is None:
        return
    print(f"Registered {name} for {host} in {path}. Agent destination: {url}")
    if host == "copilot" and not native:
        print("Start the interactive CLI with MCP_TASKS_FALLBACK=1 copilot --experimental.")
    elif host == "t3":
        print("Select Pi in T3 with this Pi agent directory, then open a chat.")
    elif host == "hermes":
        print(
            f"Restart the gateway, then use /mcp-tasks start {name} delegate "
            + json.dumps({"message": "Hello"})
        )
    else:
        print(f"Open a new chat and ask it to delegate a message to {name}.")


def remove(host, name):
    base, path = host_path(host)
    file = Config(path)
    servers = file.data.get(section(host), {})
    if name not in servers:
        print(f"{name} is already absent from {path}.")
        return
    if not owned_agent(servers[name], base, name):
        raise SetupError(f"{name} belongs to a different installation.")
    argv = argv_of(servers[name])
    del servers[name]
    if host == "hermes":
        allow = (
            file.data.get("plugins", {})
            .get("entries", {})
            .get("mcp-tasks", {})
            .get("settings", {})
            .get("servers", [])
        )
        if name in allow:
            allow.remove(name)
    if host == "antigravity" and "--approval-hook" in argv:
        folder = base / "plugins" / f"a2a-review-{name}"
        if folder.exists():
            # Only uninstall this checkout's original hook; preserve user customizations.
            antigravity_hook(base, name, {"args": []})
            if folder.is_symlink() or {p.name for p in folder.iterdir()} != {"plugin.json", "hooks.json"}:
                raise SetupError(f"The approval plugin at {folder} contains other files.")
            subprocess.run(["agy", "plugin", "uninstall", f"a2a-review-{name}"], check=True)
    file.save()
    print(f"Removed {name} from {path}. Shared Tasks support and local history are retained.")


def remove_directory(host):
    base, path = host_path(host)
    config = Config(path)
    servers = config.data.get(section(host), {})
    name, _ = directory_settings(host, servers, base, path)
    if name is None:
        print(f"The A2A directory is already absent from {path}.")
        return
    if any(owned_agent(entry, base, key) for key, entry in servers.items()):
        raise SetupError("Disconnect the named agents before removing their directory.")
    del servers[name]
    config.save()
    print(f"Removed the A2A directory for {host}. Shared Tasks support is retained.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=HOSTS)
    parser.add_argument("--name", help="Local MCP server name for this agent")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--remove", action="store_true", help="Disconnect an agent, or remove an empty directory")
    action.add_argument("--url", help="Configured A2A base URL")
    parser.add_argument("--tasks", choices=MODES)
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--bearer-file", metavar="PATH", help="Read a bearer token from this owner-only file")
    auth.add_argument("--serve-credentials", metavar="EXECUTABLE", help="Use this A2A Serve pairing helper")
    args = parser.parse_args()
    try:
        if (args.url and not args.name) or (args.name and not args.url and not args.remove):
            parser.error("Use a host alone to install, or supply --name with --url or --remove.")
        if (args.bearer_file or args.serve_credentials) and not args.url:
            parser.error("Credential options require an agent URL.")
        with profile_lock(args.host):
            if args.remove:
                if args.name:
                    remove(args.host, args.name)
                else:
                    remove_directory(args.host)
            else:
                setup(args.host, args.name, args.url, args.tasks, args.serve_credentials,
                      args.bearer_file, install_directory=True)
    except (AdapterError, SetupError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Setup failed: {exc}\n")


if __name__ == "__main__":
    main()
