#!/usr/bin/env bash
# The recording behind the README's demo: one real, interactive Claude Code session
# with the mod, against Hugging Face's public MCP server (https://huggingface.co/mcp),
# which serves 25 skills over the extension and needs no account.
#
#   1. /mcp-skills: the skills the server serves.
#   2. A question one of them fits. Claude finds the skill in its listing and loads
#      it; Claude Code asks once; Claude reads the skill's files and answers.
#
# Usage: live/take-demo.sh <out-dir>
#   PTY_PYTHON   a python3 that has pyte (pip install pyte)
# Output: <out>/cast.jsonl (everything the session wrote to its terminal, with timing)
# and the screen at each step as text.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$1"; OUT="$(cd "$1" && pwd)"
PY="${PTY_PYTHON:-python3}"
PROJECT="${DEMO_PROJECT:-$OUT/project}"; mkdir -p "$PROJECT/.claude"
# The project's own settings approve its .mcp.json servers only where the folder's trust question was
# answered for it: give it a folder outside any folder Claude Code already trusts (the default is
# inside <out-dir>), so the run answers that question itself.

cat > "$PROJECT/.mcp.json" <<'JSON'
{ "mcpServers": { "huggingface": { "type": "http", "url": "https://huggingface.co/mcp" } } }
JSON
echo '{ "enableAllProjectMcpServers": true, "spinnerTipsEnabled": false, "promptSuggestionEnabled": false }' > "$PROJECT/.claude/settings.json"

ROOT="$ROOT" OUT="$OUT" PROJECT="$PROJECT" python3 - <<'PYEOF'
import json, os
root, out, project = (os.environ[k] for k in ("ROOT", "OUT", "PROJECT"))
env = {"MCP_SKILLS_SOURCES": "project", "MCP_SKILLS_STATE": out + "/state"}
cmd = ["claude", "--plugin-dir", root + "/mod", "--setting-sources", "project", "--permission-mode", "default"]
# A folder Claude Code has not seen is asked about once: the script made it (two files, above) and says yes.
trust = [{"wait": "trust this folder|❯", "timeout": 40},
         {"when": "trust this folder", "steps": [{"sleep": 1.5}, {"key": "down", "after": 0.8}, {"key": "enter", "after": 3}]}]
say = lambda text, delay=0.04: [{"keys": text, "delay": delay}, {"sleep": 0.7}, {"key": "enter", "after": 2}]
steps = [
    *trust, {"wait": "❯", "timeout": 60}, {"sleep": 8},
    # Start with nothing approved, so the one question a new user gets is in the recording.
    *say("/mcp-skills forget"), {"wait": "approval", "timeout": 30}, {"sleep": 1},
    *say("/clear"), {"sleep": 4}, {"snap": "00-start"},
    *say("/mcp-skills", 0.09), {"wait": "Have Claude use one", "timeout": 60}, {"sleep": 3}, {"snap": "01-skills"},
    *say("Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?", 0.06),
    {"wait": "Do you want to proceed", "timeout": 180}, {"sleep": 3}, {"snap": "02-approval"},
    {"key": "enter", "after": 2},
    {"wait": "Which GGUF(.|\\n)*· done |Q[4-8]_K(.|\\n)*· done ", "timeout": 300}, {"sleep": 6}, {"snap": "03-answer"},
    {"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 2},
]
json.dump({"cmd": cmd, "cwd": project, "env": env, "cols": 88, "rows": 28, "steps": steps}, open(out + "/scenario.json", "w"), indent=1, ensure_ascii=False)
PYEOF

"$PY" "$ROOT/tools/pty-drive.py" "$OUT/scenario.json" "$OUT" || true
# What is kept of a run is made fit to share: no plan name, usage line or local path.
python3 "$ROOT/tools/scrub-run.py" "$OUT" "$ROOT"
status=0; [ -f "$OUT/03-answer.txt" ] || status=1
echo "done: $OUT (exit $status)"
exit $status
