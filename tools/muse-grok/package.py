"""Build the private Grok discovery upload, or the install kit for both hosts."""
import argparse
import json
import hashlib
import re
import subprocess
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
        Path("tools/muse-grok/skill-trace.mjs"), Path("tools/muse-grok/grok-draft.ts"), Path("tools/muse-grok/config.ts"), Path("tools/muse-grok/install-muse.mjs"), Path("tools/muse-grok/package.py"), Path("tools/muse-grok/select-muse-sources.mjs"),
        Path("polyfills/tasks/codex/test/fixture-tasks-server.mjs"),
        Path("polyfills/events/grok-bot/dist/watch.mjs"),
        Path("polyfills/events/grok-bot/config.example.json"), Path("polyfills/events/grok-bot/README.md"),
        Path("polyfills/events/grok-bot/SECURITY.md"),
        Path("polyfills/events/grok-bot/THIRD_PARTY_LICENSES.txt"),
        DISCOVERY / "package.json", *(DISCOVERY / path for path in GROK_FILES),
    ]
    model = Path("tools/muse-grok/model")
    paths.extend(model / name for name in ("README.md", "check.mjs", "lost-ack.json", "RoutineDelivery.tla", "SkillApproval.tla",
                                         "WatchConfirmation.tla", "TaskHandles.tla", "DiscoveryHandoff.tla", "NativeSkillRead.tla"))
    for feature in ("server-cards", "ard", "skills", "events", "tasks"):
        shared = feature in ("server-cards", "ard")
        plugin = Path("polyfills") / feature / ("codex" if shared else "muse") / "plugin"
        manifest_path = plugin / ".muse-plugin/plugin.json"
        manifest = json.loads((ROOT / manifest_path).read_text())
        paths.append(manifest_path)
        for server in manifest["capabilities"]["mcpServers"] + manifest["capabilities"].get("hooks", []):
            command, entry, *_ = server["command"]
            if command != "node":
                raise ValueError(f"Unsupported launcher in {manifest_path}")
            paths.append(plugin / entry)
        paths.extend(plugin / skill["path"] for skill in manifest["capabilities"]["skills"])
        if not shared:
            paths.append(plugin / "THIRD_PARTY_LICENSES.txt")
    return [("agentpolyfill-hosts/" + str(path), (ROOT / path).read_bytes()) for path in dict.fromkeys(paths)]


def discovery_files():
    version = json.loads((ROOT / DISCOVERY / "package.json").read_text())["version"]
    manifest = {"name": "server-card-connector", "version": version,
                "description": "Find a publisher's Server Cards and ARD entries and prepare its Grok connector fields."}
    return [
        (".claude-plugin/plugin.json", (json.dumps(manifest, indent=2) + "\n").encode()),
        ("LICENSE", (ROOT / "LICENSE").read_bytes()),
        *((name, (ROOT / DISCOVERY / name).read_bytes()) for name in GROK_FILES),
    ]


def grok_skills(args):
    if not args.source or (args.reference and not args.snapshot_skill):
        raise ValueError("Choose --source NAME. A --reference requires an explicit --snapshot-skill URI.")
    reader = ROOT / "polyfills/skills/muse/plugin/dist/server.mjs"
    cmd = ["node", str(reader), "--grok-export", "--config", str(args.grok_skills_config.resolve()), "--source", args.source]
    if args.snapshot_skill:
        cmd.extend(["--snapshot-skill", args.snapshot_skill])
    if args.reference:
        cmd.extend(["--reference", args.reference])
    entries = json.loads(subprocess.check_output(cmd))
    if not entries:
        raise ValueError("No fingerprinted native skills to package")
    # Independent publisher catalogs and snapshots must coexist in the team library.
    identity = json.dumps([args.source, args.snapshot_skill], ensure_ascii=True).encode()
    source_slug = re.sub("[^a-z0-9]+", "-", args.source.lower()).strip("-")[:30] or "source"
    package_name = "publisher-skills-" + source_slug + "-" + hashlib.sha256(identity).hexdigest()[:12]
    manifest = {"name": package_name, "version": "0.3.0", "description": "Native publisher skills from " + args.source}
    files = [(".claude-plugin/plugin.json", json.dumps(manifest).encode())]
    for entry in entries:
        suffix = hashlib.sha256((args.source + "\0" + entry["uri"]).encode()).hexdigest()[:12]
        slug = re.sub("[^a-z0-9]+", "-", entry["name"].lower()).strip("-")[:45].rstrip("-") or "publisher"
        name = slug + "-" + suffix
        directory = "skills/" + name + "/"
        header = "---\nname: " + name + "\ndescription: " + json.dumps(entry["description"][:900],ensure_ascii=True) + "\n---\n"
        if "body" in entry:
            content = entry["body"]
            if "file" in entry:
                reference = entry["file"]
                files.append((directory + reference["path"], reference["text"].encode()))
        else:
            inputs = json.dumps({"source": args.source, "uri": entry["uri"]},ensure_ascii=True)
            content = ("This native skill gets its current instructions from the connected publisher. "
                       "Call the configured publisher reader's read_skill with " + inputs + ". "
                       "For a detailed question, include one exact listed path as reference in the same request. "
                       "Wait for the owner to approve. A declined or unavailable read leaves the guide closed. "
                       "Answer from files already present for follow-ups. If they do not answer the question, say which detail is missing.\n"
                       + "\n".join("Supporting file: " + ref for ref in entry["references"]))
        files.append((directory + "SKILL.md", (header+"\n"+content).encode()))
    if sum(len(data) for _,data in files) > 15*1024*1024:
        raise ValueError("Skill package exceeds the Grok upload size budget")
    return files


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New ZIP file")
    parser.add_argument("--kit", action="store_true", help="Package all five integrations for both hosts")
    parser.add_argument("--grok-skills-config", type=Path, help="Build native Grok skills using the named publisher in this connector config")
    parser.add_argument("--source", help="Publisher label used by the live connector")
    parser.add_argument("--snapshot-skill", help="Explicitly fetch this verified guide into the portable native ZIP")
    parser.add_argument("--reference", help="Also fetch this single listed text reference into the snapshot")
    args = parser.parse_args()
    if (args.kit and args.grok_skills_config) or (not args.grok_skills_config and any([args.source,args.snapshot_skill,args.reference])):
        parser.error("Choose one package mode. Source and snapshot options require --grok-skills-config.")
    files = kit_files() if args.kit else grok_skills(args) if args.grok_skills_config else discovery_files()
    import os
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output, ZipFile(output, "w") as archive:
        for name, data in sorted(files):
            member = ZipInfo(name)  # fixed timestamp makes the archive reproducible
            member.create_system = 3
            member.external_attr = 0o100644 << 16
            archive.writestr(member, data, compress_type=ZIP_DEFLATED)
    print(args.output)
