"""Register one A2A agent in a host profile, using that host's Tasks integration."""

import argparse
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


def setup(host, name, url, mode, credentials=None, token_file=None):
    origin(url)
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", name) or name == "mcp-tasks":
        raise SetupError("Choose a short lowercase agent name starting with a letter; mcp-tasks is reserved.")
    native = mode in {"native", "existing"} or (mode == "auto" and host in {"claude", "copilot"})
    adapter_args = ["--url", url]
    if credentials:
        binary = shutil.which(credentials)
        if not binary or not Path(binary).is_file():
            raise SetupError("Provide the path to the installed A2A Serve executable.")
        adapter_args += ["--serve-credentials", str(Path(binary).absolute())]
    if token_file:
        path = Path(token_file).expanduser().resolve(strict=True)
        if not path.is_file() or path.stat().st_mode & 0o077:
            raise SetupError("Use an owner-only file containing the agent bearer token.")
        adapter_args += ["--bearer-file", str(path)]
    # Keep task handles isolated even for two different host profiles using the same agent.
    configs = []
    actions = []

    def config(path):
        file = Config(path)
        configs.append(file)
        return file.data

    if host == "claude" and mode == "polyfill":
        raise SetupError("Claude Code uses native Tasks. Use the native or auto setting.")
    base, path = host_path(host)
    adapter_args += ["--state-dir", str(base / "agentpolyfill-a2a" / name)]
    entry = {"command": str(Path(sys.executable).parent / "agentpolyfill-a2a"), "args": adapter_args}
    data = config(path)
    if host == "codex":
        servers = table(data, "mcp_servers")
        register(servers, name, entry)
        plugins = data.get("plugins", {})
        if not native and not plugins.get("mcp-tasks@agent-polyfill", {}).get("enabled"):
            helper = json.loads((TASKS / "codex/plugin/.mcp.json").read_text())["mcpServers"]["mcp-tasks"]
            helper["cwd"] = str(TASKS / "codex/plugin")
            helper["args"] = [str(TASKS / "codex/plugin/dist/helper.js")]
            register(servers, "mcp-tasks", helper)
    elif host == "opencode":
        register(table(data, "mcp"), name, {"type": "local", "command": [entry["command"], *entry["args"]]})
        if not native:
            include(data, "plugins", str(TASKS / "opencode/plugin"))
    elif host == "hermes":
        register(table(data, "mcp_servers"), name, entry)
        if not native:
            plugins = table(data, "plugins")
            include(plugins, "enabled", "mcp-tasks")
            dep = table(table(plugins, "entries"), "mcp-tasks")
            if dep.get("allow_gateway_injection") is False:
                raise SetupError("The Hermes profile explicitly disables Tasks notifications.")
            dep["allow_gateway_injection"] = True
            include(table(dep, "settings"), "servers", name)
            link = base / "plugins/mcp-tasks"
            source = TASKS / "hermes/plugin"
            if link.resolve() != source:
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
        if host == "copilot":
            entry["type"] = "local"
            entry["tools"] = ["delegate"]
            if not native:
                actions.append(copilot_tasks)
        if host == "antigravity" and not native:
            entry["args"].append("--antigravity")
            actions.append(antigravity_hook(base, name, entry))
        if host == "claude":
            entry["type"] = "stdio"
        register(table(data, "mcpServers"), name, entry)
        if host in {"pi", "t3"} and not native:
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
    section = {"codex": "mcp_servers", "hermes": "mcp_servers", "opencode": "mcp"}.get(host, "mcpServers")
    servers = file.data.get(section, {})
    if name not in servers:
        print(f"{name} is already absent from {path}.")
        return
    entry = servers[name]
    binary = str(Path(sys.executable).parent / "agentpolyfill-a2a")
    run = entry.get("command") if isinstance(entry, dict) else None
    argv = run if isinstance(run, list) else [run, *entry.get("args", [])] if isinstance(entry, dict) else []
    expected = ["--state-dir", str(base / "agentpolyfill-a2a" / name)]
    if not argv or argv[0] != binary or not any(argv[i : i + 2] == expected for i in range(len(argv))):
        raise SetupError(f"{name} belongs to a different installation.")
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
        subprocess.run(["agy", "plugin", "uninstall", f"a2a-review-{name}"], check=True)
    file.save()
    print(f"Removed {name} from {path}. Shared Tasks support and local history are retained.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=HOSTS)
    parser.add_argument("--name", required=True, help="Local MCP server name for this agent")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--remove", action="store_true", help="Disconnect this checkout's named agent")
    action.add_argument("--url", help="Configured A2A base URL")
    parser.add_argument("--tasks", choices=["auto", "native", "existing", "polyfill"], default="auto")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--bearer-file", metavar="PATH", help="Read a bearer token from this owner-only file")
    auth.add_argument("--serve-credentials", metavar="EXECUTABLE", help="Use this A2A Serve pairing helper")
    args = parser.parse_args()
    try:
        if args.remove:
            remove(args.host, args.name)
            return
        setup(args.host, args.name, args.url, args.tasks, args.serve_credentials, args.bearer_file)
    except (AdapterError, SetupError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Setup failed: {exc}\n")


if __name__ == "__main__":
    main()
