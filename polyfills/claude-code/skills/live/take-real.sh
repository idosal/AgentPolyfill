#!/usr/bin/env bash
# One recorded run of the mod in a real, interactive Claude Code session, against
# real public MCP servers that serve skills over the extension:
#
#   huggingface   https://huggingface.co/mcp            (25 skills)
#   togomcp       https://togomcp.rdfportal.org/mcp     (5 skills)
#
# Neither needs credentials. The project's .mcp.json names both, as a user's would.
# None of the mod's tools is allowed in advance: every question in the recording
# is one Claude Code really asks.
#
#   1. /mcp-skills forget, so the run starts with nothing approved; /mcp-skills.
#   2. /mcp-skills show huggingface-local-models: the skill, in a panel, before
#      anything is loaded.
#   3. A question that skill fits. Claude finds it in its skill listing and loads
#      it; Claude Code asks once (the approval); Claude reads the files the skill
#      refers to, with nothing more asked, and answers from them.
#   4. A shell command (Bash is allowed by rule): it runs with nothing asked,
#      because the loaded skill was approved.
#   5. A second question, for a skill of the other server.
#
# Usage: live/take-real.sh <out-dir>
#   PTY_PYTHON   a python3 that has pyte (pip install pyte)
# Output: <out>/cast.jsonl (terminal output with timing), <out>/*.txt (the screen at
# each step), <out>/transcript.txt, <out>/state/mcp-skills.log (the helper's log).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$1"; OUT="$(cd "$1" && pwd)"
PY="${PTY_PYTHON:-python3}"
PROJECT="${DEMO_PROJECT:-$OUT/project}"; mkdir -p "$PROJECT/.claude"
# The project's own settings approve its .mcp.json servers only where the folder's trust question was
# answered for it: give it a folder outside any folder Claude Code already trusts (the default is
# inside <out-dir>), so the run answers that question itself.

cat > "$PROJECT/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "huggingface": { "type": "http", "url": "https://huggingface.co/mcp" },
    "togomcp": { "type": "http", "url": "https://togomcp.rdfportal.org/mcp" }
  }
}
JSON
echo '{ "enableAllProjectMcpServers": true, "spinnerTipsEnabled": false, "promptSuggestionEnabled": false }' > "$PROJECT/.claude/settings.json"

ROOT="$ROOT" OUT="$OUT" PROJECT="$PROJECT" python3 - <<'PYEOF'
import json, os
root, out, project = (os.environ[k] for k in ("ROOT", "OUT", "PROJECT"))
env = {"MCP_SKILLS_SOURCES": "project", "MCP_SKILLS_STATE": out + "/state"}
cmd = ["claude", "--plugin-dir", root + "/mod", "--setting-sources", "project", "--permission-mode", "default", "--allowedTools", "Bash"]
# A folder Claude Code has not seen is asked about once: the script made it (two files, above) and says yes.
trust = [{"wait": "trust this folder|❯", "timeout": 40},
         {"when": "trust this folder", "steps": [{"sleep": 1.5}, {"key": "down", "after": 0.8}, {"key": "enter", "after": 3}]}]
say = lambda text: [{"keys": text, "delay": 0.03}, {"sleep": 0.6}, {"key": "enter", "after": 2}]
steps = [
    *trust, {"wait": "❯", "timeout": 60}, {"sleep": 8},
    *say("/mcp-skills forget"), {"wait": "approval", "timeout": 30}, {"sleep": 1},
    *say("/mcp-skills"), {"wait": "Have Claude use one", "timeout": 60}, {"sleep": 2}, {"snap": "01-status"},
    *say("/mcp-skills show huggingface-local-models"), {"wait": "Claude has not read this", "timeout": 60}, {"sleep": 3}, {"snap": "02-preview"},
    {"key": "esc", "after": 2},
    *say("I have a Mac with 16 GB of memory. Which GGUF quantization should I pick to run a 7B model with llama.cpp, and what command starts it? Use a skill if one fits."),
    {"wait": "Do you want to proceed", "timeout": 180}, {"sleep": 3}, {"snap": "03-approval"},
    {"key": "enter", "after": 2},
    {"wait": "Q4_K_M(.|\\n)*· done ", "timeout": 300}, {"sleep": 6}, {"expect_absent": "Do you want to proceed"}, {"snap": "04-answer"},
    *say("Now run this in the shell: echo approved-skill-runs"),
    {"wait": "approved-skill-runs(.|\\n)*approved-skill-runs(.|\\n)*approved-skill-runs", "timeout": 120}, {"sleep": 5}, {"expect_absent": "Do you want to proceed"}, {"snap": "05-command"},
    *say("One more: which TogoMCP skill should I start from before using any of its tools? Load it and tell me its first instruction in one sentence."),
    {"wait": "Do you want to proceed", "timeout": 180}, {"sleep": 3}, {"snap": "06-second-approval"},
    {"key": "enter", "after": 2},
    {"wait": "One more: which TogoMCP skill(.|\\n)*· done ", "timeout": 300}, {"sleep": 6}, {"snap": "07-second-answer"},
    {"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 2},
]
json.dump({"cmd": cmd, "cwd": project, "env": env, "cols": 120, "rows": 50, "steps": steps}, open(out + "/scenario.json", "w"), indent=1, ensure_ascii=False)
PYEOF

# The driver reports a failure when Claude Code has already quit at the last key press: what
# counts is that every step up to the last picture of the screen was reached.
"$PY" "$ROOT/tools/pty-drive.py" "$OUT/scenario.json" "$OUT" || true
# What is kept of a run is made fit to share: no plan name, usage line or local path.
python3 "$ROOT/tools/scrub-run.py" "$OUT" "$ROOT"
status=0; [ -f "$OUT/07-second-answer.txt" ] || status=1
echo "done: $OUT (exit $status)"
exit $status
