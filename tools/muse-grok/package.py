"""Build the private Grok discovery upload, or the install kit for both hosts."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[2]
DISCOVERY = Path("polyfills/server-cards/grok-bot")
GROK_FILES = [
    "skills/server-card-connector/SKILL.md",
    "skills/server-card-connector/scripts/card-to-connector.mjs",
]


def kit_files():
    paths = [
        Path("LICENSE"), Path("SECURITY.md"), Path("docs/muse-grok.md"),
        Path("tools/muse-grok/config.ts"), Path("tools/muse-grok/install-muse.mjs"), Path("tools/muse-grok/package.py"), Path("tools/muse-grok/select-muse-sources.mjs"),
        Path("polyfills/tasks/codex/test/fixture-tasks-server.mjs"),
        Path("polyfills/events/grok-bot/dist/watch.mjs"),
        Path("polyfills/events/grok-bot/config.example.json"), Path("polyfills/events/grok-bot/README.md"),
        Path("polyfills/events/grok-bot/SECURITY.md"),
        Path("polyfills/events/grok-bot/THIRD_PARTY_LICENSES.txt"),
        DISCOVERY / "package.json", *(DISCOVERY / path for path in GROK_FILES),
    ]
    model = Path("tools/muse-grok/model")
    paths.extend(model / name for name in ("README.md", "check.mjs", "lost-ack.json", "RoutineDelivery.tla", "SkillApproval.tla",
                                         "WatchConfirmation.tla", "TaskHandles.tla", "DiscoveryHandoff.tla"))
    for feature in ("server-cards", "ard", "skills", "events", "tasks"):
        shared = feature in ("server-cards", "ard")
        plugin = Path("polyfills") / feature / ("codex" if shared else "muse") / "plugin"
        manifest_path = plugin / ".muse-plugin/plugin.json"
        manifest = json.loads((ROOT / manifest_path).read_text())
        paths.append(manifest_path)
        for server in manifest["capabilities"]["mcpServers"] + manifest["capabilities"].get("hooks", []):
            command, entry = server["command"]
            if command != "node":
                raise ValueError(f"Unsupported launcher in {manifest_path}")
            paths.append(plugin / entry)
        paths.extend(plugin / skill["path"] for skill in manifest["capabilities"]["skills"])
        if not shared:
            paths.append(plugin / "THIRD_PARTY_LICENSES.txt")
    return [("agentpolyfill-hosts/" + str(path), (ROOT / path).read_bytes()) for path in paths]


def discovery_files():
    version = json.loads((ROOT / DISCOVERY / "package.json").read_text())["version"]
    manifest = {"name": "server-card-connector", "version": version,
                "description": "Find a publisher's Server Cards and ARD entries and prepare its Grok connector fields."}
    return [
        (".claude-plugin/plugin.json", (json.dumps(manifest, indent=2) + "\n").encode()),
        ("LICENSE", (ROOT / "LICENSE").read_bytes()),
        *((name, (ROOT / DISCOVERY / name).read_bytes()) for name in GROK_FILES),
    ]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New ZIP file")
    parser.add_argument("--kit", action="store_true", help="Package all five integrations for both hosts")
    args = parser.parse_args()
    files = kit_files() if args.kit else discovery_files()
    with ZipFile(args.output, "x") as archive:
        for name, data in sorted(files):
            member = ZipInfo(name)  # fixed timestamp makes the archive reproducible
            member.create_system = 3
            member.external_attr = 0o100644 << 16
            archive.writestr(member, data, compress_type=ZIP_DEFLATED)
    print(args.output)
