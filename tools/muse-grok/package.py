"""Build the private Grok Bot discovery skill archive from this checkout."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="New ZIP file for team administrator review")
output = parser.parse_args().output
folder = Path(__file__).resolve().parents[2] / "polyfills/server-cards/grok-bot"
manifest = {"name": "server-card-connector", "version": "0.1.0",
            "description": "Find a publisher's Server Cards and ARD entries and prepare its Grok connector fields."}
with ZipFile(output, "x", compression=ZIP_DEFLATED) as archive:
    archive.writestr(".claude-plugin/plugin.json", json.dumps(manifest, indent=2) + "\n")
    for file in ["skills/server-card-connector/SKILL.md", "skills/server-card-connector/scripts/card-to-connector.mjs"]:
        archive.write(folder / file, file)
    archive.write(folder.parents[2] / "LICENSE", "LICENSE")
print(output)
