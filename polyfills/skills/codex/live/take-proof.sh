#!/usr/bin/env bash
# The recording behind the README's proof: one real, interactive Codex session with
# the plugin, against Hugging Face's public MCP server (https://huggingface.co/mcp),
# which serves 25 skills over the extension and needs no account.
#
#   1. `$mcp-skills:huggingface:huggingface-local-models` in Codex's skill picker;
#   2. a question for it: Codex calls load_skill, and shows the plugin's question;
#   3. "Show me its SKILL.md first", then "Load it";
#   4. the answer, from the skill and a reference file it reads.
#
# It runs in a throwaway HOME and CODEX_HOME, made here and deleted at the end, with only
# your Codex sign-in copied in (auth.json from CODEX_AUTH_FROM, default ~/.codex). Your own
# ~/.codex and ~/.agents are not read or changed. A first, short `codex exec` lets the plugin
# write its stubs, which Codex lists from the next session on.
#
# Usage: live/take-proof.sh <out-dir>
#   PTY_PYTHON   a python3 that has pyte (pip install pyte)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../../.." && pwd)"
mkdir -p "$1"; OUT="$(cd "$1" && pwd)"
PY="${PTY_PYTHON:-python3}"
# A throwaway HOME too: the plugin writes its stubs into ~/.agents/skills/mcp-skills-served.
BASE="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() {
    CODEX_HOME="$BASE/c" HOME="$BASE/h" codex app-server daemon stop < /dev/null > /dev/null 2>&1 || true
    pkill -f "$BASE/" 2>/dev/null || true # anything Codex started from the throwaway home
    rm -rf "$BASE"
}
trap cleanup EXIT
mkdir -p "$BASE/h" "$BASE/c"
cp "${CODEX_AUTH_FROM:-$HOME/.codex}/auth.json" "$BASE/c/auth.json"; chmod 600 "$BASE/c/auth.json"
export HOME="$BASE/h" CODEX_HOME="$BASE/c"
PROJECT="$OUT/project"; mkdir -p "$PROJECT"; (cd "$PROJECT" && git init -q . 2>/dev/null || true)

codex plugin marketplace add "$REPO" < /dev/null
codex plugin add mcp-skills@agent-polyfill < /dev/null
printf '\n[mcp_servers.huggingface]\nurl = "https://huggingface.co/mcp"\n\n[projects."%s"]\ntrust_level = "trusted"\n' "$PROJECT" >> "$CODEX_HOME/config.toml"
(cd "$PROJECT" && codex exec -s read-only 'Reply with OK.' < /dev/null > "$OUT/warm-up.txt" 2>&1)

cat > "$OUT/scenario.json" <<JSON
{
  "cmd": ["codex", "--no-alt-screen", "-s", "read-only", "-c", "model_reasoning_effort=\"low\""],
  "cwd": "$PROJECT",
  "env": {"CODEX_HOME": "$CODEX_HOME"},
  "cols": 140, "rows": 60,
  "steps": [
    {"wait": "Ask Codex|Trust this folder", "timeout": 90},
    {"sleep": 6},
    {"when": "Trust this folder", "steps": [{"key": "enter"}, {"sleep": 3}]},
    {"wait": "Ask Codex", "timeout": 60},
    {"sleep": 8},
    {"snap": "00-start"},
    {"type": "\$mcp-skills:huggingface:huggingface-local-models"},
    {"sleep": 2},
    {"snap": "01-skill-list"},
    {"type": " Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?"},
    {"sleep": 1},
    {"key": "enter"},
    {"wait": "Do not load it", "timeout": 240},
    {"sleep": 2},
    {"snap": "02-question"},
    {"key": "down"}, {"sleep": 1}, {"key": "enter"},
    {"wait": "shown to you only", "timeout": 120},
    {"sleep": 2},
    {"snap": "03-preview"},
    {"key": "down"}, {"sleep": 1},
    {"snap": "04-choose-load"},
    {"key": "enter"},
    {"wait": "Worked for", "timeout": 400},
    {"sleep": 3},
    {"snap": "05-answer"}
  ]
}
JSON
"$PY" "$ROOT/../claude-code/tools/pty-drive.py" "$OUT/scenario.json" "$OUT"
cp "$CODEX_HOME/mcp-skills/mcp-skills.log" "$OUT/mcp-skills.log"
